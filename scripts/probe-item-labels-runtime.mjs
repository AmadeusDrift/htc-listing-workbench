// Authorized diagnostic bridge into the already-running HTC main process.
// Uses its safeStorage and file view; no credential leaves that process.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const pid=Number(process.argv[2]);if(!Number.isSafeInteger(pid)||pid<1)throw Error('Expected existing HTC main PID');
const root=resolve('.'),output=join(root,'artifacts','item-labels-live-2026-10-08');await mkdir(output,{recursive:true});
const original=await readFile(join(root,'scripts','probe-item-labels.mjs'),'utf8');
const prefix='const source = String.raw`',start=original.indexOf(prefix)+prefix.length,end=original.indexOf('\n`;\nconst file=',start);
if(start<prefix.length||end<start)throw Error('Probe source boundary mismatch');
let source=original.slice(start,end);
source=source.replace("const output = process.env.HTC_LABEL_PROBE_OUTPUT;",'const output = '+JSON.stringify(output)+';');
source=source.replace("const live = process.env.HTC_LABEL_SOURCE_WORKSPACE || join(app.getPath('appData'),'RED Workbench');","const live = app.getPath('userData');");
const initStart=source.indexOf("app.setName('HTC Workbench');"),initEnd=source.indexOf('await app.whenReady();',initStart)+'await app.whenReady();'.length;
source=source.slice(0,initStart)+'const existingProfile=true;\n'+source.slice(initEnd);
source=source.replace('app.exit(0);','return report;').replace('main().catch(()=>process.exit(2));','module.exports = { main };');
source=source.replace("const report = { at:","const report = { runtimePid:process.pid, runtimeVersion:app.getVersion(), at:");
const built=await build({stdin:{contents:source,resolveDir:root,sourcefile:'item-labels-runtime-entry.ts',loader:'ts'},write:false,bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron']});
const expression='(()=>{const loaded={exports:{}};new Function("require","module","exports",'+JSON.stringify(built.outputFiles[0].text)+')(process.mainModule.require.bind(process.mainModule),loaded,loaded.exports);return loaded.exports.main();})()';
let opened=false,ws,seq=0;const pending=new Map();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function targets(){try{return await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(1000)})).json();}catch{return null;}}
function command(method,params){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('Runtime label probe timed out'));},150000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
try{
 let list=await targets();if(!list){process._debugProcess(pid);opened=true;for(let i=0;i<30&&!list;i++){await pause(150);list=await targets();}}
 const target=list?.find(t=>t.title.includes('HTC'));if(!target)throw Error('Expected HTC runtime not found');
 const endpoint=new URL(target.webSocketDebuggerUrl);if(endpoint.protocol!=='ws:'||!['127.0.0.1','localhost'].includes(endpoint.hostname)||endpoint.port!=='9229')throw Error('Unsafe runtime endpoint');
 ws=new WebSocket(endpoint.href);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(Error('Local runtime connection failed'));});
 ws.onmessage=event=>{const data=JSON.parse(event.data),item=pending.get(data.id);if(!item)return;clearTimeout(item.timer);pending.delete(data.id);if(data.error||data.result?.exceptionDetails)item.reject(Error('Runtime label probe failed; raw exception suppressed'));else item.resolve(data.result?.result?.value);};
 const actualPid=await command('Runtime.evaluate',{expression:'process.pid',returnByValue:true});if(actualPid!==pid)throw Error('Runtime PID mismatch');
 const result=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
 await writeFile(join(output,'runtime-report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{
 if(ws?.readyState===WebSocket.OPEN&&opened){try{await command('Runtime.evaluate',{expression:"setTimeout(()=>process.mainModule.require('node:inspector').close(),200).unref(); true",returnByValue:true});}catch{}}
 ws?.close();for(const item of pending.values())clearTimeout(item.timer);
}
