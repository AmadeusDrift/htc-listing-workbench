import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {signOss4Put} from '../src/main/ai/oss4.ts';
import {reviewImageWithAliyun} from '../src/main/ai/aliyun-image-risk.ts';
import {AiError} from '../src/main/ai/errors.ts';
import {validateImageIpReview} from '../src/main/ai/image-validation.ts';

const bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(256,16);bytes.writeUInt32BE(256,20);
const candidate={id:randomUUID(),sha256:createHash('sha256').update(bytes).digest('hex'),width:256,height:256},planId=randomUUID();
const credentials={accessKeyId:'main-test-key-id',accessKeySecret:'main-test-key-secret'},now=new Date('2026-10-08T08:00:00.000Z');
const token={AccessKeyId:'STS.temporary-test-id',AccessKeySecret:'temporary-test-secret',SecurityToken:'temporary-test-token',FileNamePrefix:'upload/fixture/',OssInternetEndPoint:'https://oss-cn-shanghai.aliyuncs.com',BucketName:'oss-cip-test',Expiration:Math.floor(now.getTime()/1000)+1800};
function fixture(options:{riskLevel?:string;labels?:unknown[];token?:Record<string,unknown>;dataId?:string;code?:number;status?:number;quota?:boolean;uploadStatus?:number}={}) {
  const requests:{url:string;options:RequestInit}[]=[],reservations:Buffer[]=[];
  const context={now:()=>now,nonce:randomUUID,maxResponseBytes:100000,beforeSend:(body:string|Buffer)=>{if(options.quota)throw new AiError('QUOTA_EXCEEDED');reservations.push(Buffer.from(body));},fetch:async(url:any,input:RequestInit={})=>{
    requests.push({url:String(url),options:input});
    const action=new Headers(input.headers).get('x-acs-action');
    if(action==='DescribeUploadToken')return Response.json({Code:200,Data:{...token,...options.token}});
    if(input.method==='PUT')return new Response(null,{status:options.uploadStatus??200});
    if(action==='ImageModeration')return Response.json({Code:options.code??200,RequestId:'moderation-fixture',Data:{DataId:options.dataId??candidate.id,RiskLevel:options.riskLevel??'none',Result:options.labels??[{Label:'nonLabel',Description:'未检出风险'}]}},{status:options.status??200});
    throw new Error('Unexpected transport');
  }};
  return {requests,reservations,run:()=>reviewImageWithAliyun(bytes,candidate,planId,credentials,new AbortController().signal,context)};
}

test('OSS V4 signer matches the documented canonical request with the literal sample secret',()=>{
  const headers=signOss4Put({bucket:'examplebucket',objectName:'exampleobject',region:'cn-hangzhou',accessKeyId:'LTAI-test',accessKeySecret:'yourAccessKeySecret',now:new Date('2025-04-11T06:41:24Z'),headers:{'content-disposition':'attachment','content-length':'3','content-md5':'ICy5YqxZB1uWSwcVLSNLcA==','content-type':'text/plain'},additionalHeaders:['content-disposition','content-length']});
  // The doc's canonical hash is c46d9639...; its final signature uses an illustrative derived key,
  // not the public placeholder "yourAccessKeySecret". This value uses the literal published placeholder.
  assert.match(headers.authorization,/Signature=d3694c2dfc5371ee6acd35e88c4871ac95a7ba01d3a2f476768fe61218590097$/);
});

test('local candidate is uploaded with temporary credentials then bound to one moderation request',async()=>{
  const f=fixture(),result=await f.run();assert.equal(result.output.verdict,'PASS');assert.deepEqual(validateImageIpReview(result.output),result.output);
  assert.equal(result.usage.processedImages,1);assert.equal(f.requests.length,3);assert.deepEqual(f.reservations,[bytes]);
  const upload=f.requests[1]; assert.deepEqual(Buffer.from(upload.options.body as Uint8Array),bytes);
  assert.match(new Headers(upload.options.headers).get('authorization')!,/^OSS4-HMAC-SHA256 Credential=STS.temporary-test-id\//);
  assert.equal(new Headers(upload.options.headers).get('authorization')!.includes(credentials.accessKeyId),false);
  const body=new URLSearchParams(Buffer.from(f.requests[2].options.body as Uint8Array).toString());
  assert.equal(body.get('Service'),'aigcViolationDetection');const params=JSON.parse(body.get('ServiceParameters')!);
  assert.equal(params.dataId,candidate.id);assert.equal(new URL(upload.url).pathname,`/${params.ossObjectName}`);
  for(const request of f.requests)assert.equal(request.options.redirect,'error');
  for(const secret of [credentials.accessKeyId,credentials.accessKeySecret,token.AccessKeySecret,token.SecurityToken])assert.ok(!JSON.stringify(result).includes(secret));
});

test('official risk confidence uses strict threshold and independent high level',async()=>{
  for(const riskLevel of ['none','low','medium'])assert.equal((await fixture({riskLevel,labels:[{Label:'tm_goods',Confidence:30,Description:'疑似商标'}]}).run()).output.verdict,'PASS');
  for(const riskLevel of ['high'])assert.equal((await fixture({riskLevel,labels:[{Label:'tm_goods',Confidence:82,Description:'商标'}]}).run()).output.verdict,'BLOCKED');
  for(const label of ['nonLabel_lib','tm_goods'])assert.equal((await fixture({labels:[{Label:label,Confidence:90}]}).run()).output.verdict,'PASS');
});

test('unknown risk label is incomplete and allowlist similarity is never a risk score',async()=>{
 assert.equal((await fixture({labels:[{Label:'unknown_new_label',Confidence:99}]}).run()).output.verdict,'UNCERTAIN');
 assert.equal((await fixture({labels:[{Label:'nonLabel_lib',Confidence:99}]}).run()).output.verdict,'PASS');
 assert.equal((await fixture({riskLevel:'medium',labels:[{Label:'tm_goods'}]}).run()).output.verdict,'UNCERTAIN');
});

test('provider QPS and permission error codes are distinguished',async()=>{
  await assert.rejects(fixture({code:403}).run(), (error: unknown) => error instanceof AiError && error.code==='RATE_LIMITED');
  await assert.rejects(fixture({code:408}).run(), (error: unknown) => error instanceof AiError && error.code==='SERVICE_PERMISSION_REQUIRED');
});

test('invalid provider responses, failures and a foreign candidate never pass or retry',async()=>{
  for(const options of [{dataId:randomUUID()},{labels:[]},{riskLevel:'unexpected'},{labels:[{Label:'tm_goods',Confidence:101}]},{code:403},{status:503},{uploadStatus:307}]) {
    const f=fixture(options);await assert.rejects(f.run());assert.ok(f.requests.length<=3);
  }
});

test('temporary upload rejects expired tokens and non-Aliyun destinations before sending image bytes',async()=>{
  for(const changed of [{Expiration:1},{OssInternetEndPoint:'https://evil.test'},{OssInternetEndPoint:'http://oss-cn-shanghai.aliyuncs.com'},{BucketName:'test.evil'},{FileNamePrefix:'../'}]){
    const f=fixture({token:changed});await assert.rejects(f.run());assert.equal(f.requests.length,1);
  }
  const f=fixture({quota:true});await assert.rejects(f.run());assert.equal(f.requests.length,0);
});
