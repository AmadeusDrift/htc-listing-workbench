import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {build} from 'esbuild';
const require=createRequire(import.meta.url),{createFakeProvider}=require(resolve('tests/fixtures/stabilization/fake-http-provider.mjs')),{writePolicy,launchElectron}=require(resolve('tests/fixtures/stabilization/pipeline-runtime.mjs'));
test('real Electron net.fetch preserves ACS3 wire authentication through the exact owned mapper without Node transport fallback',async()=>{
  await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s10-native-protocol-')),guardFile=resolve('tests/fixtures/stabilization/pipeline-network-guard.cjs');
  const provider=await createFakeProvider({directory:join(root,'server'),routes:[{id:'ocr',method:'POST',path:'/protocol/ocr',publicUrl:'https://ocr-api.cn-hangzhou.aliyuncs.com/?Type=Commerce',protocol:{kind:'acs3',accessKeyId:'s10-acs-id',accessKeySecret:'s10-acs-secret',action:'RecognizeAllText',version:'2021-07-07',now:'2026-10-15T00:00:00.000Z',nonce:'s10-protocol-nonce',contentType:'application/octet-stream'},response:{json:{Code:'success',RequestId:'s10-native-ocr',Data:{Width:256,Height:256,Content:'',SubImageCount:0,SubImages:[]}}}}]});
  let worker;try{const policy=await writePolicy({directory:join(root,'worker'),provider,guardFile}),entry=join(policy.directory,'native-protocol.cjs');
    await build({entryPoints:[resolve('tests/fixtures/stabilization/pipeline-protocol-electron.ts')],outfile:entry,bundle:true,platform:'node',target:'node24',format:'cjs',external:['electron'],logLevel:'silent'});
    worker=await launchElectron({policy,guardFile,entry});const probe=await worker.probeProtocol();assert.equal(probe.requestId,'s10-native-ocr');assert.equal(probe.nativeProtocolSent,1);assert.equal(probe.nodeProtocolSent,0);assert.equal(probe.denied,3);
    const rows=provider.ledger();assert.equal(rows.filter((row:any)=>row.event==='arrival').length,1);assert.equal(rows.filter((row:any)=>row.event==='request'&&row.protocolVerified).length,1);
    const stopped=await worker.stop();assert.equal(stopped.exitCode,0);assert.equal(stopped.forced,false);assert.equal(stopped.drained,true);
    await writeFile(join(root,'native-protocol-report.json'),JSON.stringify({scope:'One real native OCR adapter/owned HTTP only; no business acceptance',finalIntegrationPassed:false,probe,stopped,ledger:rows},null,2),{flag:'wx'});
  }finally{await worker?.stop();await provider.close();}
});
