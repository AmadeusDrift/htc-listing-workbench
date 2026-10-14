import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const {worktreeRoot,assertTrustedWithin}=require('../tests/fixtures/stabilization/trusted-path.cjs');
const data = resolve('.test-data');assertTrustedWithin(worktreeRoot,data);await mkdir(data,{recursive:true});
const root=await mkdtemp(join(data,'s02-electron-'));
process.env.HTC_STABILIZATION_DATA_DIR=root;
require('../tests/fixtures/stabilization/network-guard.cjs');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const worktreeStatus=execFileSync('git',['status','--short'],{encoding:'utf8',windowsHide:true}).trim();
await build({entryPoints:['src/main/ai/adapters/openrouter-chat.ts'],bundle:true,platform:'node',format:'cjs',outfile:join(root,'chat.cjs')});
await build({entryPoints:['src/main/ai-network.ts'],bundle:true,platform:'node',format:'cjs',outfile:join(root,'network.cjs')});
await writeFile(join(root,'main.cjs'),`globalThis.fixtureRequire=require;const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(()=>new BrowserWindow({show:false}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
let app;
const startedAt=new Date().toISOString();
try {
  app=await electron.launch({executablePath:require('electron'),args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',join(root,'main.cjs')],env});
  const result=await app.evaluate(async({net,session},paths)=>{
    const http=globalThis.fixtureRequire('node:http'),{requestOpenRouterJson}=globalThis.fixtureRequire(paths.chat),{createSystemProxyFetch}=globalThis.fixtureRequire(paths.network);
    const body=JSON.stringify({id:'gen_s02_electron',choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5,cost:.013}});
    let posts=0,netCalls=0;
    const server=http.createServer((req,res)=>{
      if(req.method!=='POST'||req.url!=='/api/v1/chat/completions'){res.writeHead(405);res.end();return;}
      posts++;req.resume();res.writeHead(200,{'content-type':'application/json','connection':'close'});res.flushHeaders();setTimeout(()=>res.end(body),31000);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    // This isolated profile has no user PAC/proxy or authenticated sessions.
    await session.defaultSession.setProxy({mode:'direct'});
    const fetcher=createSystemProxyFetch((url,init)=>{
      if(url!=='https://openrouter.ai/api/v1/chat/completions')throw Error('S02 unexpected external URL');
      netCalls++;return net.fetch(`http://127.0.0.1:${server.address().port}/api/v1/chat/completions`,init);
    });
    const receipts=[],events=[],begin=Date.now();
    try {
      const output=await requestOpenRouterJson({},'JSON','openai/gpt-6-luna',{apiKey:'or-s02-synthetic-key'},new AbortController().signal,{fetch:fetcher,now:()=>new Date(),nonce:()=>'',maxResponseBytes:10000,effectiveEffort:'none',responseDeadlineAt:Date.now()+40000,onProviderReceipt:r=>receipts.push(r),onRunEvidence:e=>events.push(e)});
      return {posts,netCalls,elapsedMs:Date.now()-begin,output:output.content,receipts,events,bodyBytes:Buffer.byteLength(body),raw:JSON.parse(body)};
    } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  },{chat:join(root,'chat.cjs'),network:join(root,'network.cjs')});
  assert.equal(result.posts,1);assert.equal(result.netCalls,1);assert.ok(result.elapsedMs>=31000);assert.deepEqual(result.output,{ok:true});
  assert.equal(result.receipts.length,1);assert.deepEqual(result.receipts[0].body,result.raw);assert.equal(result.receipts[0].costUsd,.013);
  assert.equal(result.events.find(e=>e.event==='BODY_COMPLETED').receivedBytes,result.bodyBytes);
  await writeFile(join(root,'report.json'),JSON.stringify({sourceCommit,worktreeStatus,startedAt,finishedAt:new Date().toISOString(),result,networkPolicy:'only fixed 127.0.0.1 mapping; all other Chromium DNS rejected; isolated profile',passed:true},null,2));
  console.log(JSON.stringify({passed:true,root,posts:result.posts,netCalls:result.netCalls,elapsedMs:result.elapsedMs}));
} finally {await app?.close();}
