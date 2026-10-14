import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {_electron as electron} from 'playwright';
await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/ai-network-'));
await build({entryPoints:['src/main/ai-network.ts'],bundle:true,platform:'node',format:'cjs',outfile:join(root,'network.cjs')});
await writeFile(join(root,'main.cjs'),`globalThis.fixtureRequire=require;const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'profile'))});app.whenReady().then(()=>new BrowserWindow({show:false}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;let app;
try{
 app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',join(root,'main.cjs')],env});
 const result=await app.evaluate(async({net,session},modulePath)=>{
  const http=globalThis.fixtureRequire('node:http'),{createSystemProxyFetch,createAiNetworkDiagnostics}=globalThis.fixtureRequire(modulePath),calls=[];
  const make=async name=>{const server=http.createServer((req,res)=>{calls.push({name,url:req.url,method:req.method,auth:!!req.headers.authorization,cookie:!!req.headers.cookie});res.writeHead(200,{'connection':'close'});res.end(name);});server.on('connect',(req,socket)=>{calls.push({name,url:req.url,method:'CONNECT'});socket.end('HTTP/1.1 403 Test blocked\r\nConnection: close\r\n\r\n');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server;};
  const a=await make('A'),b=await make('B');const fetcher=createSystemProxyFetch((url,init)=>net.fetch(url,init));
  try{
   for(const proxy of [a,b]){await session.defaultSession.setProxy({mode:'fixed_servers',proxyRules:'127.0.0.1:'+proxy.address().port,proxyBypassRules:'<-loopback>'});const response=await fetcher('http://proxy-fixture.invalid/',{method:'POST',body:'fake',redirect:'error'});if(await response.text()!==(proxy===a?'A':'B'))throw Error('wrong proxy');}
   const diagnostics=createAiNetworkDiagnostics({fetch:fetcher,resolveProxy:url=>session.defaultSession.resolveProxy(url),timeoutMs:3000});const report=await diagnostics();return {calls,report};
  }finally{await Promise.all([a,b].map(server=>new Promise(resolve=>server.close(resolve))));}
 },join(root,'network.cjs'));
 assert.deepEqual(result.calls.filter(c=>c.method==='POST').map(c=>c.name),['A','B']);
 const connections=result.calls.filter(c=>c.method==='CONNECT');assert.equal(new Set(connections.map(c=>c.url)).size,5);assert.ok(connections.every(c=>c.name==='B'));
 assert.ok(result.report.targets.every(t=>t.route==='PROXY [地址已隐藏]'&&t.state==='NETWORK_ERROR'));
 console.log(JSON.stringify({passed:true,localProxySwitch:true,diagnosticHosts:5,externalRequests:0}));
}finally{await app?.close();}
