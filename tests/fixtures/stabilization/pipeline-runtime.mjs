import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
const {worktreeRoot,assertTrustedWithin}=createRequire(import.meta.url)('./trusted-path.cjs');
const owned=new WeakMap();
async function deadline(work,ms,code){let timer;try{return await Promise.race([work,new Promise((_done,reject)=>{timer=setTimeout(()=>reject(Error(code)),ms);})]);}finally{clearTimeout(timer);}}
export async function cleanupFailure({close,force,record,timeoutMs=2000},failure){
  assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=10000,'S10_INVALID_CLEANUP_TIMEOUT');let forced=false;
  try{await deadline(Promise.resolve().then(close),timeoutMs,'S10_FAILED_CLOSE_TIMEOUT');}catch{forced=true;}
  await deadline(Promise.resolve().then(()=>record({forced})),timeoutMs,'S10_FAILED_CLOSE_RECORD_TIMEOUT').catch(()=>{});
  if(forced){await deadline(Promise.resolve().then(force),timeoutMs,'S10_FAILED_FORCE_TIMEOUT').catch(()=>{});await deadline(Promise.resolve().then(close),timeoutMs,'S10_FAILED_CLOSE_TIMEOUT').catch(()=>{});}
  throw failure;
}
export async function writePolicy({directory,provider,guardFile}){
  directory=resolve(directory);assertTrustedWithin(join(worktreeRoot,'.test-data'),directory);assertTrustedWithin(join(worktreeRoot,'tests/fixtures/stabilization'),guardFile);
  await mkdir(directory,{recursive:true});assertTrustedWithin(worktreeRoot,directory);const dataRoot=join(directory,'workspace');await mkdir(dataRoot);
  provider.bindWorkspace?.(dataRoot);
  const policy={version:1,origin:provider.origin,routes:provider.routes,dataRoot,reportPath:join(directory,'guard-report'),ftp:provider.ftp?{port:provider.ftp.port,dataPort:provider.ftp.dataPort}:null};
  if(provider.permitAuthority)policy.permitAuthority=provider.permitAuthority;
  const path=join(directory,'policy.json');await writeFile(path,JSON.stringify(policy,null,2),{flag:'wx'});return {path,dataRoot,directory,origin:provider.origin};
}
export async function fixtureInventory(){
  const paths=['tests/fixtures/amazon/drink-coaster-us/schema.json','tests/fixtures/amazon/figurine-parent-us/schema.json','tests/fixtures/amazon/cleaning-agent-schema.json'];
  return Promise.all(paths.map(async path=>{const bytes=await readFile(join(worktreeRoot,path));const raw=JSON.parse(bytes.toString()),schema=raw.schema??raw;assert.ok(schema.properties&&typeof schema.properties==='object','Complete schema required');return {path,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length};}));
}
function sourcePng(rgb){
  const crc=bytes=>{let result=0xffffffff;for(const byte of bytes){result^=byte;for(let bit=0;bit<8;bit++)result=result&1?0xedb88320^(result>>>1):result>>>1;}return (result^0xffffffff)>>>0;};
  const chunk=(name,bytes)=>{const type=Buffer.from(name),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(bytes.length);checksum.writeUInt32BE(crc(Buffer.concat([type,bytes])));return Buffer.concat([length,type,bytes,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(256,0);header.writeUInt32BE(256,4);header[8]=8;header[9]=6;
  const pixels=Buffer.alloc(256*(256*4+1));for(let y=0;y<256;y++)for(let x=0;x<256;x++){const offset=y*(256*4+1)+1+x*4;const inside=x>32&&x<224&&y>32&&y<224;pixels[offset]=inside?rgb[0]:245;pixels[offset+1]=inside?rgb[1]:245;pixels[offset+2]=inside?rgb[2]:245;pixels[offset+3]=255;}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
export async function materializeFixtures(directory){
  assertTrustedWithin(join(worktreeRoot,'.test-data'),directory);await mkdir(directory);const output=[];
  for(const [name,rgb] of [['blue',[30,100,220]],['red',[210,40,30]]]){const bytes=sourcePng(rgb),absolutePath=join(directory,`source-${name}.png`);await writeFile(absolutePath,bytes,{flag:'wx'});output.push({kind:'source-image',absolutePath,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length});}
  const source=await fixtureInventory();for(let index=0;index<source.length;index++){const row=source[index],absolutePath=join(directory,`schema-${index+1}.json`);await writeFile(absolutePath,await readFile(join(worktreeRoot,row.path)),{flag:'wx'});output.push({kind:'full-schema',sourcePath:row.path,absolutePath,sha256:row.sha256,byteSize:row.byteSize});}
  await writeFile(join(directory,'inventory.json'),JSON.stringify(output,null,2),{flag:'wx'});return output;
}
export async function launchWorker({policy,guardFile,entry,args=[],executable=process.execPath}){
  assertTrustedWithin(join(worktreeRoot,'tests/fixtures/stabilization'),entry);assertTrustedWithin(join(worktreeRoot,'tests/fixtures/stabilization'),guardFile);assertTrustedWithin(join(worktreeRoot,'.test-data'),policy.path);
  assert.equal(executable,process.execPath,'S10 Node worker runtime must be the controller runtime');
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:worktreeRoot,encoding:'utf8',windowsHide:true}).trim();
  const nonce=randomUUID(),startedAt=new Date().toISOString(),env={...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path,S10_WORKER_NONCE:nonce,S10_SOURCE_COMMIT:sourceCommit};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,['--require',guardFile,entry,...args],{cwd:worktreeRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let stdout='',stderr='',identity=null,stopRequested=false,forced=false,readyDone,readyReject;
  const readiness=new Promise((done,reject)=>{readyDone=done;readyReject=reject;});readiness.catch(()=>{});
  const timer=setTimeout(()=>readyReject(Error('S10_WORKER_READY_TIMEOUT')),10000);
  child.on('message',message=>{try{assert.equal(message.nonce,nonce);assert.equal(message.pid,child.pid);assert.equal(message.executable,executable);assert.equal(message.dataRoot,policy.dataRoot);assert.equal(message.sourceCommit,sourceCommit);identity=message;clearTimeout(timer);readyDone(message);}catch(error){clearTimeout(timer);readyReject(error);}});
  child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
  const completion=new Promise((done,reject)=>{child.once('error',error=>{clearTimeout(timer);readyReject(error);reject(error);});child.once('close',async(exitCode,signal)=>{clearTimeout(timer);if(!identity)readyReject(Error('S10_WORKER_NO_IDENTITY'));
    const report={sourceCommit,node:process.version,startedAt,finishedAt:new Date().toISOString(),entry:relative(worktreeRoot,entry).replaceAll('\\','/'),pid:child.pid,identity,exitCode,signal,stopRequested,forced,...(forced?{stopFailureCode:'S10_WORKER_FORCED_STOP'}:{}),workerMode:args[0]??null,scope:'S10 foundation worker; no business acceptance'};
    const prefix=join(policy.directory,`worker-${child.pid}-${nonce}`);try{await writeFile(prefix+'.stdout.log',stdout,{flag:'wx'});await writeFile(prefix+'.stderr.log',stderr,{flag:'wx'});await writeFile(prefix+'.json',JSON.stringify(report,null,2),{flag:'wx'});done(report);}catch(error){reject(error);}
  });});completion.catch(()=>{});
  const handle={pid:child.pid,ready:()=>readiness,wait:()=>completion,stop:()=>stopWorker(handle)};
  owned.set(handle,{child,nonce,mark:()=>{stopRequested=true;},force:()=>{forced=true;},wasForced:()=>forced,readiness,completion});return handle;
}
export async function stopWorker(handle){
  const record=owned.get(handle);assert.ok(record,'S10_WORKER_NOT_OWNED');
  const finished=async()=>{let timer;try{const report=await Promise.race([record.completion,new Promise((_done,reject)=>{timer=setTimeout(()=>reject(Error('S10_WORKER_EXIT_TIMEOUT')),3000);})]);
    if(record.wasForced())throw Error('S10_WORKER_FORCED_STOP');await record.readiness;assert.equal(record.child.exitCode,0,'S10_WORKER_STOP_FAILED');assert.equal(record.child.signalCode,null,'S10_WORKER_STOP_FAILED');return report;
  }finally{clearTimeout(timer);}};
  if(record.child.exitCode!==null||record.child.signalCode!==null)return finished();
  await record.readiness;record.mark();if(record.child.connected)record.child.send({s10Stop:record.nonce},()=>{});
  let timer;try{await Promise.race([record.completion,new Promise(done=>{timer=setTimeout(()=>{if(record.child.exitCode===null&&record.child.signalCode===null){record.force();record.child.kill();}done();},3000);})]);}finally{clearTimeout(timer);}return finished();
}
export async function launchElectron({policy,guardFile,entry}){
  assertTrustedWithin(policy.directory,entry);assertTrustedWithin(join(worktreeRoot,'tests/fixtures/stabilization'),guardFile);assertTrustedWithin(join(worktreeRoot,'.test-data'),policy.path);
  const {_electron}=await import('playwright'),executable=createRequire(import.meta.url)('electron');
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:worktreeRoot,encoding:'utf8',windowsHide:true}).trim(),env={...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path,RED_DATA_DIR:policy.dataRoot};delete env.ELECTRON_RUN_AS_NODE;delete env.RED_DEV_SERVER_URL;
  let app,ownedMain;const forceOwned=async()=>{assert.ok(ownedMain,'S10_ELECTRON_IDENTITY_UNVERIFIED');assert.equal(ownedMain.executable.toLowerCase(),executable.toLowerCase());assert.equal(ownedMain.dataRoot,policy.dataRoot);
    const processHandle=app.process();if(processHandle.exitCode===null&&processHandle.signalCode===null){
      const lifecycle=await readFile(join(policy.dataRoot,'s10-lifecycle.jsonl'),'utf8').catch(()=> '');
      const mainExited=lifecycle.trim().split('\n').filter(Boolean).some(line=>{const row=JSON.parse(line);return row.event==='exit'&&row.pid===ownedMain.pid;});
      if(!mainExited){try{process.kill(ownedMain.pid);}catch{}}processHandle.kill();
    }};
  try{app=await _electron.launch({executablePath:executable,args:['--require',guardFile,entry],cwd:worktreeRoot,env,timeout:15000});
    const identity=await deadline(app.evaluate(({app})=>({pid:process.pid,executable:process.execPath,dataRoot:app.getPath('userData')})),10000,'S10_ELECTRON_IDENTITY_TIMEOUT');
    assert.equal(identity.executable.toLowerCase(),executable.toLowerCase());assert.equal(identity.dataRoot,policy.dataRoot);ownedMain=identity;
    const page=await app.firstWindow();await page.waitForFunction(()=>document.body.textContent.includes('S10 construction only'));
    const report=await app.evaluate(()=>globalThis.__s10Dryrun);assert.equal(report.identity.dataRoot,policy.dataRoot);assert.equal(report.identity.userData,policy.dataRoot);assert.equal(report.identity.executable.toLowerCase(),executable.toLowerCase());assert.deepEqual(report.blocked,[]);
    const prefix=join(policy.directory,`electron-${report.identity.pid}`);await writeFile(prefix+'.json',JSON.stringify({sourceCommit,entry:relative(worktreeRoot,entry),...report},null,2),{flag:'wx'});
    // Playwright 1.63 uses cmd.exe as the process handle on Windows. The actual
    // Electron identity above is read from its guarded main, not that wrapper PID.
    const processHandle=app.process();
    let stopped=false;return {report,async runNormalStage(stage){assert.equal(report.normalOnly,true,'S10_NORMAL_ONLY_ENTRY_REQUIRED');assert.ok(['source','queue','start','snapshot','guard'].includes(stage));return app.evaluate((_electron,name)=>globalThis.__s10NormalStage(name),stage);},async probeProtocol(){assert.equal(report.protocolOnly,true,'S10_PROTOCOL_ONLY_ENTRY_REQUIRED');return app.evaluate(()=>globalThis.__s10RunNativeProtocol());},async probeRejection(){const rejected=await app.evaluate(async({net,session,BrowserWindow},origin)=>{
      let nativeRejected=0;const attempts=[()=>net.fetch('https://outside.invalid/'),()=>net.fetch('http://127.0.0.1:1/foundation'),()=>net.request(origin+'/foundation'),()=>session.defaultSession.fetch('https://outside.invalid/'),()=>globalThis.__s10Guard.require('node:net').connect(Number(new URL(origin).port),'127.0.0.1')];
      for(const attempt of attempts){try{await attempt();throw Error('S10_GUARD_ESCAPED');}catch(error){if(!String(error).includes('S10_NETWORK_BLOCKED'))throw error;nativeRejected++;}}
      const before=globalThis.__s10Guard.blocked.length;
      await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("fetch('https://outside.invalid/').then(()=>false,()=>true)");
      return {nativeRejected,chromiumRejected:globalThis.__s10Guard.blocked.slice(before).includes('Chromium')};
    },policy.origin);await writeFile(prefix+'-guard-probe.json',JSON.stringify(rejected),{flag:'wx'});return rejected;},
    async stop(){if(stopped)return;const identity=await app.evaluate(({app})=>({pid:process.pid,executable:process.execPath,dataRoot:app.getPath('userData')}));assert.equal(identity.pid,report.identity.pid);assert.equal(identity.executable,report.identity.executable);assert.equal(identity.dataRoot,policy.dataRoot);stopped=true;
      let timer;const bounded=async work=>{try{return await Promise.race([work,new Promise((_done,reject)=>{timer=setTimeout(()=>reject(Error('S10_ELECTRON_SHUTDOWN_TIMEOUT')),10000);})]);}finally{clearTimeout(timer);}};
      try{assert.deepEqual(await bounded(app.evaluate(()=>globalThis.__s10Drain())),{drained:true});await bounded(app.close());assert.equal(processHandle.exitCode,0,'S10 Electron wrapper must exit normally');
        const lifecycle=(await readFile(join(policy.dataRoot,'s10-lifecycle.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.ok(lifecycle.some(row=>row.event==='exit'&&row.exitCode===0&&row.pid===report.identity.pid),'S10 actual main did not report normal exit');
        const result={drained:true,exitCode:processHandle.exitCode,forced:false};await writeFile(prefix+'-stop.json',JSON.stringify(result),{flag:'wx'});return result;
      }catch(error){return cleanupFailure({close:()=>app.close(),force:forceOwned,record:row=>writeFile(prefix+'-stop.json',JSON.stringify({drained:false,...row,errorCode:'S10_ELECTRON_STOP_FAILED'}),{flag:'wx'})},error);}
    }};
  }catch(error){if(!app)throw error;return cleanupFailure({close:()=>app.close(),force:forceOwned,record:row=>writeFile(join(policy.directory,`electron-launch-failed-${randomUUID()}.json`),JSON.stringify({sourceCommit,identity:ownedMain??null,...row,errorCode:'S10_ELECTRON_LAUNCH_FAILED'}),{flag:'wx'})},error);}
}
