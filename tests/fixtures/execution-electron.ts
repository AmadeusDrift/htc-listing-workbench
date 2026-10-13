// Isolated Electron harness. This entry is never part of the shipped application.
import { PDFDocument } from 'pdf-lib';
import { app, BrowserWindow, safeStorage } from 'electron';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileSync, appendFileSync, copyFileSync } from 'node:fs';
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
import { saveInput } from './listing-ai.ts';
import { seedAuthorityHaulPricing } from '../helpers/authority-haul-pricing.ts';
import { demoSchema } from '../../src/main/amazon/demo.ts';
import { ListingRuleStore } from '../../src/main/listing-rules.ts';

const root = resolve(process.env.RED_DATA_DIR!); app.setPath('userData', root); app.enableSandbox();
void app.whenReady().then(async () => {
  const ftp = await createLocalFtpServer(), store = new WorkspaceStore(root);
  let fixtureNow=Date.now();
  const fakeAmazonCalls: {method:string;path:string;preview:boolean}[]=[];
  const amazon = new AmazonService(root, id => store.getProduct(id), safeStorage, { now:()=>fixtureNow, resolveAddresses:async()=>['52.1.2.3'], sleep:async()=>{}, fetch: async (input,init={}) => {
    const url=new URL(String(input));
    if(url.href==='https://api.amazon.com/auth/o2/token')return Response.json({access_token:'isolated-access-token',token_type:'bearer',expires_in:3600});
    if(url.href==='https://labels.amazon.com/isolated.pdf'&&init.method==='GET'){fakeAmazonCalls.push({method:'GET',path:url.pathname,preview:false});const pdf=await PDFDocument.create();pdf.addPage([100,100]);return new Response(new Uint8Array(await pdf.save()),{headers:{'content-type':'application/pdf'}});}
    if(url.href==='https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/items/labels'&&init.method==='POST'){fakeAmazonCalls.push({method:'POST',path:url.pathname,preview:false});return Response.json({documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/isolated.pdf',expiration:new Date(fixtureNow+3600000).toISOString()}]});}
    if(url.hostname!=='sellingpartnerapi-na.amazon.com'||!url.pathname.startsWith('/listings/2021-08-01/items/'))throw Error('Amazon network forbidden outside isolated listing fixture');
    fakeAmazonCalls.push({method:init.method??'GET',path:url.pathname,preview:url.searchParams.has('mode')});
    const sku=decodeURIComponent(url.pathname.split('/').at(-1)!);
    if(init.method==='PUT')return Response.json({sku,status:url.searchParams.has('mode')?'VALID':'ACCEPTED',submissionId:'isolated-submission',issues:[]});
    if(init.method==='GET')return Response.json({sku,summaries:[{marketplaceId:'ATVPDKIKX0DER',asin:'B000000001',status:['BUYABLE','DISCOVERABLE']}],issues:[],attributes:{},fulfillmentAvailability:[{fulfillmentChannelCode:'AMAZON',quantity:0}]});
    throw Error('Unexpected fake listing method');
  } });
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
  const followup=new FollowupService(root,amazon,{now:()=>fixtureNow}),procurement=new ProcurementService(root,store,amazon),catalog=new CatalogService(root,amazon);
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
    snapshot: () => ({ fakeAmazonCalls, probes, files: ftp.files.size, stor: ftp.commands.filter(c => c === 'STOR').length, activeUploads, peakUploads, uploadEntries, verifyEntries }),
    seedHaul: async () => {
      const sample=store.listProducts().map(row=>store.getProduct(row.id)).find(row=>row.variants.length===3)!;
      let source=store.createProduct();source=store.saveProduct({...saveInput(source),title:'Cotton Storage Bag',sourceUrl:'https://detail.1688.com/offer/123.html',description:'Cotton storage bag.',variants:saveInput(source).variants.map(v=>({...v,originalSpec:'Blue',normalizedSpec:'Blue'})),facts:[{id:crypto.randomUUID(),name:'材质',value:'Cotton',source:'manual',sourceRef:'Synthetic E2E fixture',state:'human_confirmed'}]});
      const original=store.getAssetRecord(sample.assets.find(a=>a.role==='main')!.id)!,assetId=crypto.randomUUID(),path='assets/'+assetId+'.png';copyFileSync(join(root,original.originalPath),join(root,path));
      source=store.addAssets({productId:source.id,revision:source.revision},[{...original,id:assetId,originalPath:path,previewPath:path}]);source=store.updateAsset({productId:source.id,revision:source.revision,assetId,role:'main',variantIds:[source.variants[0].id]});const productId=source.id;
      const target=await amazon.importCredentials({name:'Isolated Haul contract',sellerId:'ISOLATED_SELLER',marketplaceId:'ATVPDKIKX0DER',region:'na',locale:'en_US',clientId:'isolated-client',clientSecret:'isolated-secret',refreshToken:'isolated-refresh'});
      amazon.getSchema=async selection=>{const schema=demoSchema(target,selection as never,Date.now());schema.mode='live';schema.schema.required=(schema.schema.required as string[]).filter(x=>x!=='fulfillment_availability');
        (schema.schema.properties as any).is_value_stores_item={type:'array',items:{type:'object',properties:{value:{type:'boolean'},marketplace_id:{type:'string'}},required:['value']}};return schema;};
      const product=store.getProduct(productId);
      const draft=await amazon.createDraft({productId,variantId:product.variants[0].id,targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US',listingProgram:'haul'});
      const persistence=(amazon as any).persistence,record=persistence.record(draft.id);
      await seedAuthorityHaulPricing({directory:root,store,amazon,product},record.draft);
      record.draft.attributes.item_name=[{value:'Cotton Storage Bag',marketplace_id:target.marketplaceId}];record.draft.attributes.product_description=[{value:'Cotton storage bag.',marketplace_id:target.marketplaceId}];record.draft.attributes.brand=[{value:'Generic',marketplace_id:target.marketplaceId}];record.draft.attributes.color=[{value:'Blue',marketplace_id:target.marketplaceId}];record.draft.attributes.material=[{value:'Cotton',marketplace_id:target.marketplaceId}];
      persistence.putRecord(record);return {target,draft:amazon.getDraft(draft.id),product:store.getProduct(productId)};
    },
    settleReadback: async()=>{fixtureNow=Math.max(fixtureNow,...followup.list().filter(r=>r.nextDueAt).map(r=>Date.parse(r.nextDueAt!)));await followup.runDue();await automatic.refreshWaiting();},
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
