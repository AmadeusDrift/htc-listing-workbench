// Explicitly authorized, windowless label permission/file probe. Never starts the app.
// Live SQLite is read-only; credentials stay in memory under the original Windows user.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.'), output = join(root,'artifacts','item-labels-live-2026-10-08');
mkdirSync(output,{recursive:true});
const source = String.raw`
import { app, net, safeStorage } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AmazonTransport, AmazonTransportError } from './src/main/amazon/transport.ts';
import { CredentialVault } from './src/main/amazon/vault.ts';
import { itemLabelDownloads } from './src/main/item-labels/adapter.ts';
async function main() {
const output = process.env.HTC_LABEL_PROBE_OUTPUT;
const live = process.env.HTC_LABEL_SOURCE_WORKSPACE || join(app.getPath('appData'),'RED Workbench');
app.setName('HTC Workbench');
const runtime=process.env.HTC_LABEL_PROBE_RUNTIME;
mkdirSync(join(runtime,'browser'),{recursive:true});
// Chromium's DPAPI-wrapped encryption key is profile-specific. Copy its envelope
// into an isolated temporary profile; never launch against the writable live profile.
if(existsSync(join(live,'browser','Local State'))) {copyFileSync(join(live,'browser','Local State'),join(runtime,'browser','Local State'));copyFileSync(join(live,'browser','Local State'),join(runtime,'Local State'));}
const existingProfile=process.env.HTC_LABEL_USE_EXISTING_PROFILE==='1';
app.setPath('userData',existingProfile?live:runtime);
app.setPath('sessionData',existingProfile?join(live,'browser'):join(runtime,'browser'));
if(existingProfile&&!app.requestSingleInstanceLock()) {writeFileSync(join(output,'report.json'),JSON.stringify({outcome:'PROBE_BLOCKED',error:'Original application is already running; no duplicate profile opened'},null,2));app.exit(0);return;}
app.enableSandbox();
await app.whenReady();
const report = { at:new Date().toISOString(), workspace:live, readonlyDatabase:true, existingEncryptionProfile:existingProfile, inventoryMutation:false, listingMutation:false, labelQuantity:1, credentialsReadable:false, calls:[] };
let db;
try {
  db = new DatabaseSync(join(live,'red.sqlite'),{readOnly:true});
  const targets = db.prepare('SELECT target_json,credential_generation FROM amazon_targets WHERE target_json IS NOT NULL').all().map(r=>({target:JSON.parse(String(r.target_json)),generation:Number(r.credential_generation)}));
  report.savedTargets=targets.map(({target,generation})=>({id:target.id,name:target.name,mode:target.mode,configured:target.configured,paused:target.paused,generation}));
  let selected = targets.find(r=>r.target.mode==='live' && r.target.configured && !r.target.paused) ?? targets.find(r=>r.target.mode==='live' && r.target.configured);
  const vault = new CredentialVault(live,safeStorage);
  if(!selected && targets.length===0) {
    const ids=vault.savedIds(); report.orphanedCredentialCount=ids.length;
    if(ids.length===1 && safeStorage.isEncryptionAvailable()) {
      const id=ids[0], envelope=JSON.parse(safeStorage.decryptString(readFileSync(join(live,'amazon-vault',id+'.bin'))));
      const generation=Number(envelope.generation), result=vault.inspect(id,generation);
      if(result.state==='readable') {const c=result.credentials;selected={generation,target:{id,name:c.name,sellerId:c.sellerId,marketplaceId:c.marketplaceId,region:c.region,locale:c.locale,mode:'live',configured:true,paused:false}};report.connectionSource='sole-existing-encrypted-vault-file; metadata used in memory only';}
    }
  }
  if(!selected) throw new Error('No configured live target');
  const {target,generation}=selected;
  const inspected=vault.inspect(target.id,generation);
  report.target={id:target.id,name:target.name,marketplaceId:target.marketplaceId,region:target.region,paused:target.paused}; report.credentialsReadable=inspected.state==='readable';
  if(inspected.state!=='readable') throw new Error('Saved credentials unavailable: '+inspected.state);
  const drafts = db.prepare('SELECT record_json FROM listing_drafts WHERE record_json IS NOT NULL').all().map(r=>JSON.parse(String(r.record_json)));
  const eligible=drafts.find(r=>{const d=r.draft;return d.mode==='live'&&d.targetId===target.id&&d.sellerId===target.sellerId&&d.marketplaceId===target.marketplaceId&&d.submittedAt&&!['UNKNOWN','SUBMITTING','BLOCKED'].includes(d.state)&&d.schema?.parentageLevel!=='PARENT'&&d.checkedAt>=d.submittedAt&&r.readResponse?.summaries?.some(s=>s.marketplaceId===target.marketplaceId&&(s.asin||s.status?.some(v=>['BUYABLE','DISCOVERABLE'].includes(v))))&&!d.listingIssues?.some(i=>i.severity==='ERROR');});
  const existing=drafts.find(r=>r.draft.mode==='live'&&r.draft.targetId===target.id&&r.draft.sku&&r.draft.schema?.parentageLevel!=='PARENT');
  const sku=eligible?.draft.sku ?? existing?.draft.sku ?? 'HTC-LABEL-PERMISSION-CHECK-NOT-A-PRODUCT';
  report.sku=sku; report.draftId=eligible?.draft.id ?? existing?.draft.id ?? null; report.eligibility=eligible?'local-readback-confirmed':existing?'existing-draft-unconfirmed':'controlled-missing-sku';
  const transport=new AmazonTransport({active:()=>target,generation:()=>generation,credentials:()=>vault.read(target.id,generation),pause:(_id,message)=>{report.authorizationNotice=message;},audit:event=>report.calls.push(event),redact:value=>vault.redact(value),remember:value=>vault.remember(value)}, {dataFetch:(url,init)=>net.fetch(url,{...init,bypassCustomProtocolHandlers:true}),timeoutMs:30000});
  try {
    const result=await transport.createMarketplaceItemLabels(target,{marketplaceId:target.marketplaceId,mskuQuantities:[{msku:sku,quantity:1}],labelType:'STANDARD_FORMAT',pageType:'A4_21',localeCode:target.locale});
    report.httpStatus=result.status; report.requestId=result.requestId; report.documentCount=result.data.documentDownloads?.length; report.files=[];
    for(const [index,doc] of itemLabelDownloads(result.data).entries()) {
      const url=new URL(doc.uri); const descriptor={index:index+1,origin:url.origin}; report.files.push(descriptor);
      try { const bytes=await transport.downloadItemLabel(doc.uri); descriptor.bytes=bytes.length; descriptor.pdfHeader=bytes.subarray(0,5).toString()==='%PDF-'; descriptor.pdfEOF=bytes.subarray(-2048).toString('latin1').includes('%%EOF'); descriptor.sha256=createHash('sha256').update(bytes).digest('hex');
        if(!descriptor.pdfHeader||!descriptor.pdfEOF) throw new Error('Downloaded content failed PDF markers');
        const fileName='label-'+String(index+1)+'.pdf'; writeFileSync(join(output,fileName),bytes,{flag:'wx'}); descriptor.fileName=fileName; descriptor.downloaded=true;
      } catch(error) {descriptor.downloaded=false; descriptor.error=String(vault.redact(error instanceof Error?error.message:'Download failed')).replace(/https?:\/\/\S+/g,'[URL REDACTED]');}
    }
    report.outcome=report.files.every(file=>file.downloaded)?'PDF_DOWNLOADED':'API_ACCEPTED_DOWNLOAD_INCOMPLETE';
  } catch(error) {report.httpStatus=error instanceof AmazonTransportError?error.status:null;report.requestId=error instanceof AmazonTransportError?error.requestId:null;report.error=String(vault.redact(error instanceof Error?error.message:'Probe failed')).replace(/https?:\/\/\S+/g,'[URL REDACTED]');report.errors=error instanceof AmazonTransportError&&Array.isArray(error.response?.errors)?error.response.errors.map(e=>({code:String(e.code).slice(0,100),message:String(vault.redact(e.message)).replace(/https?:\/\/\S+/g,'[URL REDACTED]').slice(0,1200)})):[];report.outcome='API_REJECTED';}
} catch(error) {report.outcome='PROBE_BLOCKED';report.error=error instanceof Error?error.message:'Probe failed';}
finally {db?.close();mkdirSync(output,{recursive:true});writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2));app.exit(0);}
}
main().catch(()=>process.exit(2));
`;
const file=join(output,'probe.cjs');
await build({stdin:{contents:source,resolveDir:root,sourcefile:'probe-item-labels-entry.ts',loader:'ts'},outfile:file,bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron']}).catch(error=>{throw error;});
const runtime=mkdtempSync(join(tmpdir(),'htc-label-probe-'));
const require=createRequire(import.meta.url),env={...process.env,HTC_LABEL_PROBE_OUTPUT:output,HTC_LABEL_PROBE_RUNTIME:runtime};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[file],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
let diagnostic=''; child.stdout.on('data',()=>{}); child.stderr.on('data',chunk=>{diagnostic+=chunk.toString().slice(0,2000);});
const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
rmSync(runtime,{recursive:true,force:true});
if(result!==0) {console.error('Windowless Electron probe failed (exit '+result+'). '+diagnostic.replace(/https?:\/\/\S+/g,'[URL REDACTED]').slice(0,1200));process.exitCode=1;}
else console.log(readFileSync(join(output,'report.json'),'utf8'));
