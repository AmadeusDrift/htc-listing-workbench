import test from 'node:test';
import assert from 'node:assert/strict';
import { signAcs3 } from '../src/main/ai/acs3.ts';
import { recognizeWithAliyun } from '../src/main/ai/adapters.ts';
import { postJson } from '../src/main/ai/transport.ts';
import { readErrorEvidence, recordErrorEvidence } from '../src/main/error-evidence.ts';

const credentials={accessKeyId:'fixture-key',accessKeySecret:'fixture-secret'};
const context={now:()=>new Date('2023-10-26T10:22:32Z'),nonce:()=> 'fixture-nonce',maxResponseBytes:10240};
const body=Buffer.from('fixture-image');
const signal=new AbortController().signal;
const signed=(host='ocr-api.cn-hangzhou.aliyuncs.com',action='RecognizeAllText')=>signAcs3({host,action,version:'2021-07-07',query:{Type:'Commerce'},body,contentType:'application/octet-stream',...credentials,now:context.now(),nonce:context.nonce()});
const reply={RequestId:'fixture-request',Data:{Content:'Cotton',Width:256,Height:256,SubImageCount:1,SubImages:[{SubImageId:0,BlockInfo:{BlockCount:1,BlockDetails:[{BlockId:0,BlockContent:'Cotton',BlockConfidence:98}]}}]}};

for(const generated of [false,true])test(`${generated?'generated':'source'} OCR omits wire Host while retaining original signature and exact body`,async()=>{
 const expected=signed();let calls=0,receipts=0;
 const result=await recognizeWithAliyun(body,{width:256,height:256},credentials,signal,{...context,...(generated?{onReviewEffect:()=>{},onProviderReceipt:()=>{receipts++;}}:{}),fetch:async(url,init)=>{
  calls++;assert.equal(url,expected.url);const headers=new Headers(init?.headers);
  assert.equal(headers.has('host'),false);assert.match(headers.get('authorization')!,/SignedHeaders=content-type;host;/);
  for(const [name,value] of Object.entries(expected.headers))if(name!=='host')assert.equal(headers.get(name),value);
  assert.deepEqual(Buffer.from(init?.body as Uint8Array),body);assert.equal(init?.redirect,'error');
  return Response.json(reply);
 }});
 assert.equal(result.output.kind,'ocr');assert.equal(calls,1);assert.equal(receipts,generated?1:0);
});

test('shared ACS3 transport removes mixed-case Host without mutating signing headers',async()=>{
 const request=signed('green-cip.cn-shanghai.aliyuncs.com','DescribeUploadToken');
 const headers:Record<string,string>={...request.headers,Host:request.headers.host};delete headers.host;
 const original={...headers};
 await postJson(request.url,headers,body,signal,{...context,fetch:async(_,init)=>{assert.equal(new Headers(init?.headers).has('host'),false);assert.equal(new Headers(init?.headers).get('authorization'),original.authorization);return Response.json({});}});
 assert.deepEqual(headers,original);
});

test('ACS3 target mismatch or unsafe URL fails before reservation or dispatch',async()=>{
 for(const url of ['https://other.invalid/?Type=Commerce','http://ocr-api.cn-hangzhou.aliyuncs.com/','https://user:pass@ocr-api.cn-hangzhou.aliyuncs.com/','https://ocr-api.cn-hangzhou.aliyuncs.com:444/']){
  let effects=0;await assert.rejects(postJson(url,signed().headers,body,signal,{...context,beforeSend:()=>{effects++;},beforePaidEffect:()=>{effects++;},fetch:async()=>{effects++;return Response.json({});}}),(e:any)=>e.code==='INVALID_CONFIG'&&e.certainty==='NOT_SENT');assert.equal(effects,0);
 }
});

test('local argument and nested network diagnostics survive fixed audit reader without exposing raw messages or unlocking UNKNOWN',async()=>{
 for(const [raw,reason,cause] of [[new Error('net::ERR_INVALID_ARGUMENT'),'TRANSPORT_INVALID_ARGUMENT','UNKNOWN'],[Object.assign(new Error('private fixture-secret URL'),{cause:{code:'ENOTFOUND'}}),undefined,'DNS'],[new Error('fixture-secret'),undefined,'UNKNOWN']] as const){
  let caught:any;await assert.rejects(postJson('https://offline.invalid',{},'{}',signal,{...context,fetch:async()=>{throw raw;}}),(e:any)=>{caught=e;return e.code==='NETWORK_ERROR';});
  assert.equal(caught.certainty,'SENT_UNKNOWN');assert.equal(caught.diagnosticReason,reason);assert.deepEqual(caught.networkDiagnostic,{cause,stage:'connect',receivedBytes:0});
  if(reason)assert.equal(caught.message,'AI请求参数未被本地网络组件接受，请核对调用记录；未自动重发');
  let record:any;recordErrorEvidence(detail=>{record=detail;},caught,{stage:'ocr'});assert.equal(readErrorEvidence(record)?.diagnosticReason,reason);assert.deepEqual(readErrorEvidence(record)?.networkDiagnostic,caught.networkDiagnostic);assert.ok(!JSON.stringify(record).includes('fixture-secret'));
 }
});
