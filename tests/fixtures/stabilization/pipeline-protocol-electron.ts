// One synthetic native protocol probe. No app main, DB, task or provider keys.
import assert from 'node:assert/strict';
import {app,BrowserWindow,net} from 'electron';
import {readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {recognizeWithAliyun} from '../../../src/main/ai/adapters.ts';
const guard=(globalThis as typeof globalThis&{__s10Guard?:{installedBeforeMain:boolean;blocked:string[];nativeProtocolSent?:number}}).__s10Guard;
assert.ok(guard?.installedBeforeMain);assert.ok(process.env.S10_POLICY_FILE&&process.env.RED_DATA_DIR);
const policy=JSON.parse(readFileSync(process.env.S10_POLICY_FILE,'utf8')),root=process.env.RED_DATA_DIR;
assert.equal(root,policy.dataRoot);app.setPath('userData',root);app.setName('S10 native protocol only');app.enableSandbox();
void app.whenReady().then(async()=>{
  const report={protocolOnly:true,businessStarted:false,identity:{pid:process.pid,executable:process.execPath,dataRoot:root,userData:app.getPath('userData'),electron:process.versions.electron},blocked:guard.blocked};
  Object.assign(globalThis,{__s10Dryrun:report,__s10RunNativeProtocol:async()=>{
    const route=policy.routes.find((row:{id:string})=>row.id==='ocr'),p=route.protocol;
    const result=await recognizeWithAliyun(Buffer.from('s10-owned-image-bytes'),{width:256,height:256},{accessKeyId:p.accessKeyId,accessKeySecret:p.accessKeySecret},new AbortController().signal,{fetch:(url,init)=>net.fetch(url instanceof URL?url.href:url,init),now:()=>new Date(p.now),nonce:()=>p.nonce,maxResponseBytes:1048576});
    assert.equal(result.output.kind,'ocr');assert.equal(result.requestId,'s10-native-ocr');
    let denied=0;for(const target of [route.publicUrl+'&Type=Commerce','http://127.0.0.1:1/protocol/ocr','https://outside.invalid/'])try{await net.fetch(target,{method:'POST'});throw Error('native protocol escaped');}catch(error){assert.match(String(error),/S10_NETWORK_BLOCKED/);denied++;}
    return {identity:report.identity,nativeProtocolSent:guard.nativeProtocolSent??0,requestId:result.requestId,denied};
  },__s10Drain:async()=>({drained:true})});
  app.on('quit',(_event,exitCode)=>appendFileSync(join(root,'s10-lifecycle.jsonl'),JSON.stringify({event:'exit',exitCode,pid:process.pid})+'\n'));
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('data:text/html,<p>S10 construction only; native protocol probe.</p>');
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
