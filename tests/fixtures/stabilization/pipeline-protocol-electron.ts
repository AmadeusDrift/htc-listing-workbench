// One synthetic native protocol probe. No app main, DB, task or provider keys.
import assert from 'node:assert/strict';
import {app,BrowserWindow,net,session} from 'electron';
import {readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {recognizeWithAliyun} from '../../../src/main/ai/adapters.ts';
import {signAcs3} from '../../../src/main/ai/acs3.ts';
const guard=(globalThis as typeof globalThis&{__s10Guard?:{installedBeforeMain:boolean;blocked:string[];nativeProtocolSent?:number;nodeProtocolSent?:number}}).__s10Guard;
assert.ok(guard?.installedBeforeMain);assert.ok(process.env.S10_POLICY_FILE&&process.env.RED_DATA_DIR);
const policy=JSON.parse(readFileSync(process.env.S10_POLICY_FILE,'utf8')),root=process.env.RED_DATA_DIR;
assert.equal(root,policy.dataRoot);app.setPath('userData',root);app.setName('S10 native protocol only');app.enableSandbox();
void app.whenReady().then(async()=>{
  const report={protocolOnly:true,businessStarted:false,identity:{pid:process.pid,executable:process.execPath,dataRoot:root,userData:app.getPath('userData'),electron:process.versions.electron},blocked:guard.blocked};
  Object.assign(globalThis,{__s10Dryrun:report,__s10RunNativeProtocol:async()=>{
    const route=policy.routes.find((row:{id:string})=>row.id==='ocr'),p=route.protocol;
    const result=await recognizeWithAliyun(Buffer.from('s10-owned-image-bytes'),{width:256,height:256},{accessKeyId:p.accessKeyId,accessKeySecret:p.accessKeySecret},new AbortController().signal,{fetch:(url,init)=>net.fetch(url instanceof URL?url.href:url,init),now:()=>new Date(p.now),nonce:()=>p.nonce,maxResponseBytes:1048576});
    assert.equal(result.output.kind,'ocr');assert.equal(result.requestId,'s10-native-ocr');
    const body=Buffer.from('s10-native-frozen-body'),signed=signAcs3({host:'ocr-api.cn-hangzhou.aliyuncs.com',action:p.action,version:p.version,query:{Type:'Commerce'},body,contentType:p.contentType,now:new Date(p.now),nonce:p.nonce,accessKeyId:p.accessKeyId,accessKeySecret:p.accessKeySecret});
    let denied=0;const deny=async(action:()=>unknown)=>{try{await action();throw Error('native protocol escaped');}catch(error){assert.match(String(error),/S10_NETWORK_BLOCKED/);denied++;}};
    for(const target of [route.publicUrl+'&Type=Commerce','http://127.0.0.1:1/protocol/ocr','https://outside.invalid/'])await deny(()=>net.fetch(target,{method:'POST'}));
    const base={method:'POST',headers:signed.headers,body:new Uint8Array(body),redirect:'error' as const};
    for(const override of [{headers:{...signed.headers,authorization:'s10-wrong'}},{headers:{...signed.headers,host:'outside.invalid'}},{headers:{...signed.headers,'x-acs-date':'2026-10-16T00:00:00Z'}},{headers:{...signed.headers,'x-s10-native-capability':'s10-forged'}},{body:new Uint8Array(Buffer.from('wrong'))},{method:'PUT'},{redirect:'follow' as const}])await deny(()=>net.fetch(signed.url,{...base,...override}));
    await deny(()=>session.defaultSession.fetch(signed.url,base));await deny(()=>net.request({url:signed.url,method:'POST'}));
    let methodReads=0,headerReads=0,bodyReads=0;const mutable=Buffer.from(body),headers={...signed.headers};
    const pending=net.fetch(signed.url,{get method(){methodReads++;return methodReads===1?'POST':'PUT';},get headers(){headerReads++;return headers;},get body(){bodyReads++;return new Uint8Array(mutable);},redirect:'error'});mutable.fill(0);headers.authorization='s10-mutated';const response=await pending;assert.equal(response.status,200);await response.text();assert.equal(methodReads,1);assert.equal(headerReads,1);assert.equal(bodyReads,1);
    return {identity:report.identity,nativeProtocolSent:guard.nativeProtocolSent??0,nodeProtocolSent:guard.nodeProtocolSent??0,requestId:result.requestId,denied,methodReads,headerReads,bodyReads};
  },__s10Drain:async()=>({drained:true})});
  app.on('quit',(_event,exitCode)=>appendFileSync(join(root,'s10-lifecycle.jsonl'),JSON.stringify({event:'exit',exitCode,pid:process.pid})+'\n'));
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('data:text/html,<p>S10 construction only; native protocol probe.</p>');
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
