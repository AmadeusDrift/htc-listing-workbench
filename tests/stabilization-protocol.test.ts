import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const require=createRequire(import.meta.url),run=promisify(execFile),guard=resolve('tests/fixtures/stabilization/pipeline-network-guard.cjs');
const {createFakeProvider}=require(resolve('tests/fixtures/stabilization/fake-http-provider.mjs'));
const {writePolicy}=require(resolve('tests/fixtures/stabilization/pipeline-runtime.mjs'));
const now='2026-10-15T00:00:00.000Z',nonce='s10-protocol-nonce';
const ocrRoute=()=>({id:'ocr',method:'POST',path:'/protocol/ocr',publicUrl:'https://ocr-api.cn-hangzhou.aliyuncs.com/?Type=Commerce',protocol:{kind:'acs3',accessKeyId:'s10-acs-id',accessKeySecret:'s10-acs-secret',action:'RecognizeAllText',version:'2021-07-07',now,nonce,contentType:'application/octet-stream'},response:{json:{ok:true}}});
async function directory(){await mkdir(resolve('.test-data'),{recursive:true});return mkdtemp(resolve('.test-data/s10-protocol-'));}

test('actual Miaoshou/OCR adapters cross the installed guard and real owned HTTP, validating original bytes on server',async t=>{
  const root=await directory(),routes=[{id:'miaoshou-detail',method:'POST',path:'/protocol/miaoshou',publicUrl:'https://openapi-erp.91miaoshou.com/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail',protocol:{kind:'miaoshou',appKey:'s10-miaoshou-key',appSecret:'s10-miaoshou-secret',timestamp:'1792022400'},response:{json:{result:'success',code:'success',data:{ok:true}}}},
    {id:'ocr',method:'POST',path:'/protocol/ocr',publicUrl:'https://ocr-api.cn-hangzhou.aliyuncs.com/?Type=Commerce',protocol:{kind:'acs3',accessKeyId:'s10-acs-id',accessKeySecret:'s10-acs-secret',action:'RecognizeAllText',version:'2021-07-07',now,nonce,contentType:'application/octet-stream'},response:{json:{Code:'success',RequestId:'s10-ocr-1',Data:{Width:256,Height:256,Content:'',SubImageCount:0,SubImages:[]}}}}];
  const server=await createFakeProvider({directory:join(root,'server'),routes});t.after(()=>server.close());
  const policy=await writePolicy({directory:join(root,'worker'),provider:server,guardFile:guard});
  const code=`import assert from 'node:assert/strict';import {readMiaoshou} from './src/main/miaoshou/protocol.ts';import {recognizeWithAliyun} from './src/main/ai/adapters.ts';
    const signal=new AbortController().signal,now=new Date('${now}');
    const source=await readMiaoshou('detail',{commonCollectBoxDetailId:'91015000000000001'},{appKey:'s10-miaoshou-key',appSecret:'s10-miaoshou-secret'},fetch,now,signal);assert.equal(source.data.ok,true);
    const result=await recognizeWithAliyun(Buffer.from('s10-owned-image-bytes'),{width:256,height:256},{accessKeyId:'s10-acs-id',accessKeySecret:'s10-acs-secret'},signal,{fetch,now:()=>now,nonce:()=>'${nonce}',maxResponseBytes:1048576});assert.equal(result.output.kind,'ocr');assert.equal(result.output.text,'');
    console.log(JSON.stringify({source:true,ocr:result.requestId,guard:globalThis.__s10Guard}));`;
  const output=await run(process.execPath,['--require',guard,'--input-type=module','-e',code],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path},windowsHide:true});
  assert.equal(JSON.parse(output.stdout).ocr,'s10-ocr-1');
  const rows=server.ledger().filter((row:any)=>row.event==='request');assert.equal(rows.length,2);
  assert.ok(rows.every((row:any)=>row.protocolVerified===true&&row.bodyBytes>0&&/^[a-f0-9]{64}$/.test(row.bodySha256)));
  const raw=await readFile(server.ledgerPath,'utf8');assert.ok(!/s10-acs-secret|s10-miaoshou-secret|authorization|x-sign/.test(raw));
});

test('signed protocol mutations are denied before server arrival; getter/body snapshot is exactly what reaches server',async t=>{
  const root=await directory(),server=await createFakeProvider({directory:join(root,'server'),routes:[ocrRoute()]});t.after(()=>server.close());
  const policy=await writePolicy({directory:join(root,'worker'),provider:server,guardFile:guard});
  const code=`import assert from 'node:assert/strict';import {signAcs3} from './src/main/ai/acs3.ts';import {createHash} from 'node:crypto';
    const body=Buffer.from('s10-frozen-payload'),signed=signAcs3({host:'ocr-api.cn-hangzhou.aliyuncs.com',action:'RecognizeAllText',version:'2021-07-07',query:{Type:'Commerce'},body,contentType:'application/octet-stream',now:new Date('${now}'),nonce:'${nonce}',accessKeyId:'s10-acs-id',accessKeySecret:'s10-acs-secret'});
    const base={method:'POST',headers:signed.headers,body,redirect:'error'},denied=[];
    const bad=[['query-duplicate',signed.url+'&Type=Commerce',{}],['query-escape',signed.url.replace('Commerce','%43ommerce'),{}],['query-extra',signed.url+'&token=s10-token',{}],['wrong-host',signed.url.replace('aliyuncs.com','aliyuncs.com.evil.invalid'),{}],['wrong-path',signed.url.replace('/?','/other?'),{}],['userinfo',signed.url.replace('https://','https://s10-user@'),{}],['explicit-port',signed.url.replace('.com/','.com:443/'),{}],['loopback-alias','http://127.1:${server.port}/protocol/ocr',{}],['loopback-port','http://127.0.0.1:1/protocol/ocr',{}],['method',signed.url,{method:'PUT'}],['redirect',signed.url,{redirect:'follow'}],['body',signed.url,{body:'different'}],
      ...['host','x-acs-action','x-acs-version','x-acs-content-sha256','x-acs-date','x-acs-signature-nonce','authorization','content-type'].map(name=>['header-'+name,signed.url,{headers:{...signed.headers,[name]:'s10-wrong'}}]),['extra-key',signed.url,{headers:{...signed.headers,'x-api-key':'s10-extra'}}],['cookie',signed.url,{headers:{...signed.headers,cookie:'s10-cookie'}}],['dupe-auth',signed.url,{headers:[...Object.entries(signed.headers),['authorization',signed.headers.authorization]]}]];
    for(const name of ['content-length','transfer-encoding','connection'])bad.push(['transport-'+name,signed.url,{headers:{...signed.headers,[name]:'s10-wrong'}}]);
    for(const [id,url,override]of bad){try{await fetch(url,{...base,...override});denied.push({id,denied:false});}catch{denied.push({id,denied:true});}}
    assert.ok(denied.every(row=>row.denied));
    let methodReads=0,headerReads=0,bodyReads=0;const mutable=Buffer.from(body),headers={...signed.headers};
    const pending=fetch(signed.url,{get method(){methodReads++;return methodReads===1?'POST':'PUT';},get headers(){headerReads++;return headers;},get body(){bodyReads++;return mutable;},redirect:'error'});
    mutable.fill(1);headers.authorization='s10-mutated-after-call';const response=await pending;assert.equal(response.status,200);await response.text();assert.equal(methodReads,1);assert.equal(headerReads,1);assert.equal(bodyReads,1);
    console.log(JSON.stringify({denied,methodReads,headerReads,bodyReads,bodySha256:createHash('sha256').update(body).digest('hex'),guard:globalThis.__s10Guard}));`;
  const output=await run(process.execPath,['--require',guard,'--input-type=module','-e',code],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path},windowsHide:true});
  const result=JSON.parse(output.stdout),rows=server.ledger();assert.equal(result.denied.length,26);assert.ok(result.denied.every((row:any)=>row.denied));
  assert.equal(rows.filter((row:any)=>row.event==='arrival').length,1);const accepted=rows.filter((row:any)=>row.event==='request');assert.equal(accepted.length,1);assert.equal(accepted[0].bodySha256,result.bodySha256);assert.equal(accepted[0].protocolVerified,true);
});

test('owned server independently rejects a controller request with wrong signature and persists arrival/rejection across restart',async t=>{
  const root=await directory(),location=join(root,'server');let server=await createFakeProvider({directory:location,routes:[ocrRoute()]});t.after(()=>server.close());
  const response=await fetch(server.origin+'/protocol/ocr',{method:'POST',headers:{host:'ocr-api.cn-hangzhou.aliyuncs.com',authorization:'s10-wrong'},body:'wrong-bytes'});assert.equal(response.status,403);
  const ledger=server.ledger();assert.equal(ledger.filter((row:any)=>row.event==='arrival').length,1);assert.equal(ledger.filter((row:any)=>row.event==='rejected'&&row.reason==='protocol').length,1);assert.equal(ledger.filter((row:any)=>row.event==='request').length,0);
  await server.close();server=await createFakeProvider({directory:location,routes:[ocrRoute()]});assert.deepEqual(server.ledger(),ledger);
});
