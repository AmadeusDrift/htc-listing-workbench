// Isolated Electron harness. This entry is never part of the shipped application.
import { app, BrowserWindow, safeStorage } from 'electron';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileSync, appendFileSync } from 'node:fs';
import { WorkspaceStore } from '../../src/main/store.ts';
import { AmazonService } from '../../src/main/amazon/service.ts';
import { HostingService } from '../../src/main/hosting/service.ts';
import { abortable } from '../../src/main/hosting/errors.ts';
import { ExecutionService } from '../../src/main/execution/service.ts';
import { installIpc } from '../../src/main/ipc.ts';
import { assertConsistencyView } from '../../src/main/source-image-consistency/proof.ts';
import { AiService } from '../../src/main/ai/service.ts';
import { ImageVersionService } from '../../src/main/image-versions/service.ts';
import { decodeArtifact } from '../../src/main/image-versions/decoder.ts';
import { ReviewedContentService } from '../../src/main/content/service.ts';
import { createLocalFtpServer } from '../helpers/ftp-server.ts';
import { AutomaticListingService } from '../../src/main/automatic-listing/service.ts';
import { FollowupService } from '../../src/main/followup/service.ts';
import { ProcurementService } from '../../src/main/procurement/service.ts';
import { CatalogService } from '../../src/main/catalog/service.ts';
import { ItemLabelService } from '../../src/main/item-labels/service.ts';
import { ItemLabelSettings } from '../../src/main/item-labels/settings.ts';
import { ShipmentDocumentService } from '../../src/main/procurement/shipment-documents.ts';
import { ListingRuleStore } from '../../src/main/listing-rules.ts';

const root = resolve(process.env.RED_DATA_DIR!); app.setPath('userData', root); app.enableSandbox();
void app.whenReady().then(async () => {
  const ftp = await createLocalFtpServer(), store = new WorkspaceStore(root);
  const amazon = new AmazonService(root, id => store.getProduct(id), safeStorage, { fetch: async () => { throw Error('Amazon network forbidden in harness'); } });
  let probes = 0;
  const hosting = new HostingService(root, store, safeStorage, { probe: async expected => {
    probes++; const path = new URL(expected.url).pathname.replace(/^\/AAA/, ''), bytes = ftp.files.get(path);
    if (!bytes || bytes.length !== expected.byteSize || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw Error('Isolated public mirror mismatch');
  } });
  let uploadGate: Promise<void> | null = null, releaseUploads = () => {}, activeUploads = 0, peakUploads = 0, uploadEntries = 0, verifyEntries = 0;
  const upload = hosting.upload.bind(hosting);
  hosting.upload = async (...args: Parameters<HostingService['upload']>) => {
    activeUploads++; uploadEntries++; peakUploads = Math.max(peakUploads, activeUploads);
    try {
      if (uploadGate) await abortable(uploadGate, args[1] ?? new AbortController().signal);
      return await upload(...args);
    } finally { activeUploads--; }
  };
  const verify = hosting.verify.bind(hosting);
  hosting.verify = async (...args: Parameters<HostingService['verify']>) => { verifyEntries++; return verify(...args); };
  const execution = new ExecutionService(root, store, amazon, hosting);
  const ai = new AiService(root, store, hosting, safeStorage, { fetch: async () => { throw Error('AI network forbidden in execution harness'); } });
  const images = new ImageVersionService(root, store, ai, { decode: decodeArtifact, download: async () => { throw Error('Artifact network forbidden'); } });
  const content = new ReviewedContentService(root, store, ai);
  const followup=new FollowupService(root,amazon),procurement=new ProcurementService(root,store,amazon),catalog=new CatalogService(root,amazon);
  const labels=new ItemLabelService(root,amazon,procurement),labelSettings=new ItemLabelSettings(root),shipmentDocuments=new ShipmentDocumentService(root,procurement);
  const proofs=new Map();
  // Image providers are covered by production-entry image tests. This harness
  // supplies their boundary result and exercises the real FTP/execution/batch code.
  const imageBoundary={
    prepareSources:async(input:{productId:string})=>({product:store.getProduct(input.productId),missing:[]}),
    getProgress:(id:string)=>proofs.get(id)??null,cancel:()=>({cancelled:true}),cancelSources:()=>({cancelled:true}),
    complete:async(input:{draftId:string})=>{const draft=amazon.getDraft(input.draftId),asset=store.getProduct(draft.productId).assets.find(value=>value.role==='main')!;
      const workflow={id:crypto.randomUUID(),status:'COMPLETED',stage:'complete',attempt:7,approvedAssetId:asset.id,approvedSha256:store.getAssetRecord(asset.id)!.sha256,
        slots:Array.from({length:7},(_,index)=>({index:index+1,status:'PASSED',approvedAssetId:crypto.randomUUID(),approvedSha256:store.getAssetRecord(asset.id)!.sha256}))};proofs.set(draft.id,workflow);return{draft,workflow};},
  };
  const automatic=new AutomaticListingService(root,{store,amazon,hosting,execution,followup,procurement,labels,images:imageBoundary as never,
    prepareSourceConsistency:async(input,_signal,fresh)=>{for(const variantId of input.variantIds){fresh();assertConsistencyView(ai.getSourceConsistency({productId:input.productId,productRevision:input.productRevision,variantId}));}},
    rules:()=>{const rules=new ListingRuleStore(root);try{return rules.get();}finally{rules.close();}},labelFormat:()=>labelSettings.get()});
  writeFileSync(join(root, 'ftp-test-config.json'), JSON.stringify({ id: 'alpha', host: ftp.host, port: ftp.port, secure: false,
    username: 'fixture-user', password: 'fixture-password-only', remoteRoot: '/', publicBaseUrl: 'https://images.example.com/AAA/' }));
  Object.assign(globalThis, { __executionHarness: {
    snapshot: () => ({ probes, files: ftp.files.size, stor: ftp.commands.filter(c => c === 'STOR').length, activeUploads, peakUploads, uploadEntries, verifyEntries }),
    holdUploads: () => { if (uploadGate) throw Error('Upload barrier is already held'); uploadGate = new Promise<void>(resolve => { releaseUploads = resolve; }); },
    releaseUploads: () => { const release = releaseUploads; uploadGate = null; release(); },
  } });
  const url = 'data:text/html;charset=utf-8,<html><head><meta http-equiv="Content-Security-Policy" content="default-src %27none%27"></head><body>Isolated HTC execution test</body></html>';
  const window = new BrowserWindow({ show: false, webPreferences: { preload: resolve(process.env.RED_E2E_PRELOAD??'dist-electron/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  installIpc(window, store, root, url, amazon, hosting, execution, ai, images, content, async () => { throw Error('Restore is tested in its dedicated harness'); },undefined,undefined,undefined,{followup,procurement,catalog,labels,labelSettings},undefined,undefined,undefined,automatic,{labels,labelSettings,shipmentDocuments,procurement});
  automatic.start();labels.resume();
  let closed = false, stopping = false;
  app.on('will-quit', event => {
    if (closed) return; event.preventDefault(); if (stopping) return; stopping = true;
    const log = (text: string) => appendFileSync(join(root, 'shutdown.log'), text + '\n');
    void (async () => {
      await automatic.close();await labels.close();labelSettings.close();shipmentDocuments.close();await followup.close();await catalog.close();procurement.close();
      await images.close(); content.close(); log('ai'); await ai.close(); log('execution'); await execution.close(); log('hosting'); await hosting.close(); log('database'); amazon.close(); store.close();
      log('ftp'); await ftp.close(); log('drained'); closed = true; setImmediate(() => { log('quit'); app.quit(); });
    })().catch(error => { log(String(error)); app.exit(1); });
  });
  await window.loadURL(url);
});
