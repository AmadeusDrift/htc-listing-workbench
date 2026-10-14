import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

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

test('actual Ali risk adapter performs token, exact candidate OSS4 upload and moderation as three owned verified effects',async t=>{
  const {materializeFixtures}=require(resolve('tests/fixtures/stabilization/pipeline-runtime.mjs')),root=await directory();
  const fixtures=await materializeFixtures(join(root,'fixtures')),bytes=await readFile(fixtures[0].absolutePath),sha256=createHash('sha256').update(bytes).digest('hex');
  const candidateId='01234567-89ab-4cde-8fab-0123456789ab',objectName='s10/'+candidateId+'.png',green='https://green-cip.cn-shanghai.aliyuncs.com/';
  const acs=(action:string)=>({kind:'acs3',accessKeyId:'s10-acs-id',accessKeySecret:'s10-acs-secret',action,version:'2022-03-02',now,nonce,contentType:'application/x-www-form-urlencoded'});
  const moderationBody=new URLSearchParams({Service:'aigcViolationDetection',ServiceParameters:JSON.stringify({ossBucketName:'s10-risk-bucket',ossObjectName:objectName,ossRegionId:'cn-shanghai',dataId:candidateId})}).toString();
  const routes=[{id:'risk-token',method:'POST',path:'/protocol/risk-token',publicUrl:green,protocol:{...acs('DescribeUploadToken'),bodySha256:createHash('sha256').update('').digest('hex')},response:{issueTokenFor:'risk-upload'}},
    {id:'risk-upload',method:'PUT',path:'/protocol/risk-upload',publicUrl:'https://s10-risk-bucket.oss-cn-shanghai.aliyuncs.com/'+objectName,protocol:{kind:'oss4',bucket:'s10-risk-bucket',objectName,region:'cn-shanghai',candidateId,bodySha256:sha256,contentType:'image/png',accessKeyId:'s10-temporary-id',accessKeySecret:'s10-temporary-secret',securityToken:'s10-temporary-token',now},response:{bytes:Buffer.alloc(0)}},
    {id:'risk-moderation',method:'POST',path:'/protocol/risk-moderation',publicUrl:green,protocol:{...acs('ImageModeration'),bodySha256:createHash('sha256').update(moderationBody).digest('hex')},response:{json:{Code:200,RequestId:'s10-risk-1',Data:{DataId:candidateId,RiskLevel:'none',Result:[{Label:'nonLabel',Description:'Synthetic none'}]}}}}];
  const server=await createFakeProvider({directory:join(root,'server'),routes});t.after(()=>server.close());const policy=await writePolicy({directory:join(root,'worker'),provider:server,guardFile:guard});
  const code=`import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {signOss4Put} from './src/main/ai/oss4.ts';import {reviewImageWithAliyun} from './src/main/ai/aliyun-image-risk.ts';
    const bytes=await readFile(${JSON.stringify(fixtures[0].absolutePath)}),meta=[],receipts=[];
    const output=await reviewImageWithAliyun(bytes,{id:'${candidateId}',sha256:'${sha256}',width:256,height:256},'11234567-89ab-4cde-8fab-0123456789ab',{accessKeyId:'s10-acs-id',accessKeySecret:'s10-acs-secret'},new AbortController().signal,{fetch,now:()=>new Date('${now}'),nonce:()=>'${nonce}',maxResponseBytes:1048576,onMetadata:value=>meta.push(value),onProviderReceipt:value=>receipts.push(value)});
    assert.equal(output.output.verdict,'PASS');for(const value of [output,meta,receipts])assert.ok(!JSON.stringify(value).includes('s10-temporary'));
    const url='https://s10-risk-bucket.oss-cn-shanghai.aliyuncs.com/${objectName}',headers=signOss4Put({bucket:'s10-risk-bucket',objectName:'${objectName}',region:'cn-shanghai',now:new Date('${now}'),accessKeyId:'s10-temporary-id',accessKeySecret:'s10-temporary-secret',headers:{'content-type':'image/png','content-md5':createHash('md5').update(bytes).digest('base64'),'x-oss-security-token':'s10-temporary-token'}});
    const bad=[...['authorization','x-oss-security-token','x-oss-date','x-oss-content-sha256','content-md5','content-type'].map(name=>[url,{headers:{...headers,[name]:'s10-wrong'}}]),[url.replace('${candidateId}','21234567-89ab-4cde-8fab-0123456789ab'),{}],[url.replace('s10-risk-bucket','s10-other-bucket'),{}],[url.replace('cn-shanghai','cn-hangzhou'),{}],[url+'?x=1',{}],[url.replace('/s10/','/s10%2F'),{}],[url,{body:Buffer.from('wrong')}],[url,{method:'POST'}],[url,{headers:{...headers,'x-oss-extra':'s10-extra'}}]];
    for(const [target,override]of bad)await assert.rejects(async()=>{const response=await fetch(target,{method:'PUT',headers,body:bytes,redirect:'error',...override});await response.text();});
    console.log(JSON.stringify({requestId:output.requestId,ossRejected:bad.length,guard:globalThis.__s10Guard}));`;
  const output=await run(process.execPath,['--require',guard,'--input-type=module','-e',code],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path},windowsHide:true});assert.equal(JSON.parse(output.stdout).requestId,'s10-risk-1');assert.equal(JSON.parse(output.stdout).ossRejected,14);
  const rows=server.ledger(),requests=rows.filter((row:any)=>row.event==='request');assert.deepEqual(requests.map((row:any)=>row.routeId),['risk-token','risk-upload','risk-moderation']);assert.ok(requests.every((row:any)=>row.protocolVerified));assert.equal(requests[1].bodySha256,sha256);assert.equal(rows.filter((row:any)=>row.event==='arrival').length,3);
  assert.ok(!/s10-temporary|AccessKeySecret|SecurityToken|authorization/.test(await readFile(server.ledgerPath,'utf8')));
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
