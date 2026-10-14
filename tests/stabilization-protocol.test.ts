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

test('Node HTTP cannot change the checked route through a custom agent or returned request mutation',async t=>{
  const root=await directory(),server=await createFakeProvider({directory:join(root,'server'),observeConnections:true,routes:[{id:'approved',method:'POST',path:'/approved'},{id:'unapproved',method:'POST',path:'/unapproved'}]});t.after(()=>server.close());
  const policy=await writePolicy({directory:join(root,'worker'),provider:server,guardFile:guard});
  const code=`import assert from 'node:assert/strict';import http from 'node:http';
    let agentCalled=0;const agent={addRequest(req,opts){agentCalled++;req.path='/unapproved';http.globalAgent.addRequest(req,opts);}};
    assert.throws(()=>http.request('${server.origin}/approved',{method:'POST',agent}),/S10_NETWORK_BLOCKED/);assert.equal(agentCalled,0);
    const req=http.request('${server.origin}/approved',{method:'POST'});req.on('error',()=>{});
    assert.throws(()=>{req.path='/unapproved';},/S10_NETWORK_BLOCKED/);assert.throws(()=>req.setHeader('authorization','Bearer s10-wrong'),/S10_NETWORK_BLOCKED/);req.destroy();console.log('route-frozen');`;
  await run(process.execPath,['--require',guard,'--input-type=module','-e',code],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path},windowsHide:true});
  assert.equal(server.ledger().filter((row:any)=>row.event==='request'||row.event==='rejected').length,0);
});

test('real source downloader accepts only the registered CDN image and exact synthetic resolver mapping',async t=>{
  const root=await directory(),{materializeFixtures}=require(resolve('tests/fixtures/stabilization/pipeline-runtime.mjs')),fixtures=await materializeFixtures(join(root,'fixtures')),bytes=await readFile(fixtures[0].absolutePath);
  const server=await createFakeProvider({directory:join(root,'server'),routes:[{id:'source-image',method:'GET',path:'/protocol/source-image',publicUrl:'https://cbu01.alicdn.com/s10/blue-coaster.png',protocol:{kind:'public-source'},response:{bytes,contentType:'image/png'}}]});t.after(()=>server.close());const policy=await writePolicy({directory:join(root,'worker'),provider:server,guardFile:guard});
  const code=`import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createSourceImageDownloader} from './src/main/miaoshou/images.ts';
    const download=createSourceImageDownloader({lookup:async host=>{assert.equal(host,'cbu01.alicdn.com');return [{address:'198.18.0.1',family:4}];},nativeFetch:fetch});const url='https://cbu01.alicdn.com/s10/blue-coaster.png';
    const bytes=await download(url,new AbortController().signal);assert.equal(createHash('sha256').update(bytes).digest('hex'),'${createHash('sha256').update(bytes).digest('hex')}');
    for(const target of [url+'?x=1',url.replace('/s10/','/other/'),url.replace('cbu01.alicdn.com','cbu01.alicdn.com.evil.invalid')])await assert.rejects(download(target,new AbortController().signal));console.log('source-byte-verified');`;
  await run(process.execPath,['--require',guard,'--input-type=module','-e',code],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path},windowsHide:true});assert.equal(server.ledger().filter((row:any)=>row.event==='arrival').length,1);
});

test('real DeepSeek/OpenRouter chat, decisions and image adapters use endpoint-bound fake keys and retain provider receipts',async t=>{
  const root=await directory(),{materializeFixtures}=require(resolve('tests/fixtures/stabilization/pipeline-runtime.mjs')),fixtures=await materializeFixtures(join(root,'fixtures')),bytes=await readFile(fixtures[0].absolutePath);
  const chat=(id:string)=>({id,choices:[{finish_reason:'stop',message:{content:JSON.stringify({answer:'s10-protocol'})}}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.001}});
  const routes=[{id:'deepseek',method:'POST',path:'/protocol/deepseek',publicUrl:'https://api.deepseek.com/chat/completions',credential:{header:'authorization',value:'Bearer s10-deepseek-key'},response:{json:chat('s10-ds-1')}},
    {id:'chat',method:'POST',path:'/protocol/chat',publicUrl:'https://openrouter.ai/api/v1/chat/completions',credential:{header:'authorization',value:'Bearer s10-openrouter-key'},response:{json:chat('s10-chat-1')}},
    {id:'decisions',method:'POST',path:'/protocol/decisions',publicUrl:'https://openrouter.ai/api/alpha/decisions',credential:{header:'authorization',value:'Bearer s10-openrouter-key'},response:{json:{id:'s10-decisions-1',answers:{category:{type:'choice',choice:'DRINK_COASTER'}},usage:{input_tokens:10,output_tokens:4,cost:0.001}}}},
    {id:'images',method:'POST',path:'/protocol/images',publicUrl:'https://openrouter.ai/api/v1/images',credential:{header:'authorization',value:'Bearer s10-openrouter-key'},response:{json:{id:'s10-image-1',created:1792022400,data:[{b64_json:bytes.toString('base64')}],usage:{cost:0.013}}}}];
  const server=await createFakeProvider({directory:join(root,'server'),routes});t.after(()=>server.close());const policy=await writePolicy({directory:join(root,'worker'),provider:server,guardFile:guard});
  const code=`import assert from 'node:assert/strict';import {requestDeepSeekJson} from './src/main/ai/adapters.ts';import {requestOpenRouterJson} from './src/main/ai/adapters/openrouter-chat.ts';import {requestOpenRouterDecisions} from './src/main/ai/adapters/openrouter-decisions.ts';import {OpenRouterImageAdapter} from './src/main/ai/adapters/openrouter-images.ts';
    const signal=new AbortController().signal,receipts=[],context={fetch,now:()=>new Date('${now}'),nonce:()=>'${nonce}',maxResponseBytes:1048576,onProviderReceipt:value=>receipts.push(value)};
    assert.equal((await requestDeepSeekJson({operation:'s10-protocol'},'Return the synthetic answer','deepseek-flash',{apiKey:'s10-deepseek-key'},signal,{...context,gateway:'deepseek'})).content.answer,'s10-protocol');
    assert.equal((await requestOpenRouterJson({operation:'s10-protocol'},'Return the synthetic answer','openai/gpt-6-luna',{apiKey:'s10-openrouter-key'},signal,context)).content.answer,'s10-protocol');
    const decision=await requestOpenRouterDecisions('openai/gpt-6-luna-decisions',{operation:'s10-protocol'},{category:{type:'choice',criteria:{DRINK_COASTER:'Drink coaster'},instructions:'Select the supplied synthetic category'}},{apiKey:'s10-openrouter-key'},signal,context);assert.equal(decision.answers.category.choice,'DRINK_COASTER');
    const image=await new OpenRouterImageAdapter({fetch}).generate({apiKey:'s10-openrouter-key',model:'openai/gpt-image-2.5-sunburst',prompt:'Synthetic protocol fixture',size:'auto',quality:'auto',background:'opaque',references:[]},signal,{onProviderReceipt:context.onProviderReceipt});assert.equal(image.requestId,'s10-image-1');assert.equal(image.width,256);
    for(const [url,key]of [['https://openrouter.ai/api/v1/images','s10-deepseek-key'],['https://api.deepseek.com/chat/completions','s10-openrouter-key'],['https://openrouter.ai/api/v1/images?x=1','s10-openrouter-key']])await assert.rejects(async()=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+key},body:'{}'}));
    assert.equal(receipts.length,4);assert.equal(receipts.find(row=>row.endpoint==='/api/v1/images').costUsd,0.013);console.log(JSON.stringify({receiptIds:receipts.map(row=>row.requestId),guard:globalThis.__s10Guard}));`;
  const output=await run(process.execPath,['--require',guard,'--input-type=module','-e',code],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path},windowsHide:true});assert.equal(JSON.parse(output.stdout).receiptIds.length,4);
  const rows=server.ledger();assert.equal(rows.filter((row:any)=>row.event==='request').length,4);assert.equal(rows.filter((row:any)=>row.event==='rejected').length,0);assert.equal(new Set(rows.filter((row:any)=>row.event==='request').map((row:any)=>row.requestId)).size,4);
});

test('FTP passive replies cannot redirect a guarded worker to another loopback port or public host',async t=>{
  const root=await directory(),bait=await createFakeProvider({directory:join(root,'bait'),observeConnections:true,routes:[{id:'bait',method:'GET',path:'/bait'}]});t.after(()=>bait.close());
  for(const kind of ['epsv-port','pasv-host']){
    const server=await createFakeProvider({directory:join(root,kind),ftp:true,passiveFault:{kind,port:bait.port},routes:[{id:'unused',method:'GET',path:'/unused'}]});t.after(()=>server.close());
    const policy=await writePolicy({directory:join(root,'worker-'+kind),provider:server,guardFile:guard});
    const code=`import assert from 'node:assert/strict';import {Client} from 'basic-ftp';import {Readable} from 'node:stream';const client=new Client(2000,{allowSeparateTransferHost:false});try{await client.access({host:'127.0.0.1',port:${server.ftp.port},user:'s10-user',password:'s10-password',secure:false});await assert.rejects(client.uploadFrom(Readable.from(Buffer.from('s10-passive-bait')),'/s10/bait.png'));console.log(JSON.stringify({guard:globalThis.__s10Guard}));}finally{client.close();}`;
    await run(process.execPath,['--require',guard,'--input-type=module','-e',code],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path},windowsHide:true});
    assert.equal(server.ledger().filter((row:any)=>row.event==='ftp-upload').length,0);assert.ok(server.ledger().some((row:any)=>row.event==='ftp-command'&&row.command===(kind==='pasv-host'?'PASV':'EPSV')));
  }
  assert.equal(bait.ledger().filter((row:any)=>row.event==='http-connection').length,0);
});

test('real HostingService FTP transport and public image probe verify the uploaded bytes and reuse remote version after reopen',async t=>{
  const root=await directory(),{materializeFixtures}=require(resolve('tests/fixtures/stabilization/pipeline-runtime.mjs')),fixtures=await materializeFixtures(join(root,'fixtures'));
  const bytes=await readFile(fixtures[0].absolutePath),sha256=createHash('sha256').update(bytes).digest('hex'),remotePath='/s10/references/'+sha256+'.png',publicUrl='https://htc.185858.xyz/AAA/references/'+sha256+'.png';
  const server=await createFakeProvider({directory:join(root,'server'),ftp:true,routes:[{id:'hosted',method:'GET',path:'/protocol/hosted',publicUrl,protocol:{kind:'public-image',remotePath,sha256},response:{fromFtpPath:remotePath,contentType:'image/png'}}]});t.after(()=>server.close());
  const policy=await writePolicy({directory:join(root,'worker'),provider:server,guardFile:guard});
  const code=`import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {WorkspaceStore} from './src/main/store.ts';import {HostingService} from './src/main/hosting/service.ts';import {createPublicImageProbe} from './src/main/hosting/public-probe.ts';import {testMiaoshouStorage} from './tests/helpers/miaoshou-fixture.ts';
    const store=new WorkspaceStore(process.env.RED_DATA_DIR),storage=testMiaoshouStorage(),bytes=await readFile(${JSON.stringify(fixtures[0].absolutePath)});
    const probe=createPublicImageProbe({lookup:async host=>{assert.equal(host,'htc.185858.xyz');return [{address:'198.18.0.1',family:4}];},nativeFetch:fetch}),make=()=>new HostingService(process.env.RED_DATA_DIR,store,storage,{probe});
    let service=make();service.importProfile({id:'alpha',host:'127.0.0.1',port:${server.ftp.port},secure:false,username:'s10-user',password:'s10-password',remoteRoot:'/s10',publicBaseUrl:'https://htc.185858.xyz/AAA/'});const profile=service.setEnabled({id:'alpha',enabled:true});
    const version={assetId:'01234567-89ab-4cde-8fab-0123456789ab',sha256:'${sha256}',sourceKind:'source',sourceVersion:'s10-protocol-source',originalPath:'assets/01234567-89ab-4cde-8fab-0123456789ab.png',byteSize:bytes.length,mimeType:'image/png'};
    try{assert.equal(await service.uploadReferenceVersion('alpha',profile.generation,version,bytes),'${publicUrl}');await service.close();service=make();assert.equal(await service.uploadReferenceVersion('alpha',profile.generation,version,bytes),'${publicUrl}');
      await assert.rejects(probe({url:'${publicUrl}',sha256:'0'.repeat(64),byteSize:bytes.length,mimeType:'image/png'},new AbortController().signal));
      for(const url of ['${publicUrl}?x=1','${publicUrl}'.replace('/AAA/','/BBB/'),'https://outside.invalid/image.png'])await assert.rejects(async()=>fetch(url));
      console.log(JSON.stringify({referenceProtocolOnly:true,normalPipeline:false,guard:globalThis.__s10Guard}));
    }finally{await service.close();store.close();}`;
  await run(process.execPath,['--require',guard,'--input-type=module','-e',code],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path},windowsHide:true});
  const rows=server.ledger();assert.equal(rows.filter((row:any)=>row.event==='ftp-upload').length,1);assert.equal(rows.filter((row:any)=>row.event==='request').length,3);assert.equal(rows.filter((row:any)=>row.event==='arrival').length,3);
  assert.ok(rows.filter((row:any)=>row.event==='body'&&row.routeId==='hosted').every((row:any)=>row.bodySha256===sha256));assert.deepEqual(await server.readFtp(remotePath),bytes);
});

test('actual AmazonTransport verifies LWA, exact preview/formal/readback queries and full-schema download checksum over owned HTTP',async t=>{
  const root=await directory(),{schemaFixture}=require(resolve('tests/fixtures/stabilization/pipeline-normal-draft.mjs')),fixture=await schemaFixture('drink-coaster-us');
  const body={productType:'DRINK_COASTER',requirements:'LISTING',attributes:{item_name:[{value:'Synthetic coaster',marketplace_id:'ATVPDKIKX0DER',language_tag:'en_US'}]}},bodySha256=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const base='https://sellingpartnerapi-na.amazon.com',path='/listings/2021-08-01/items/S10SELLER/S10-SKU',query={marketplaceIds:'ATVPDKIKX0DER',issueLocale:'en_US'},auth={kind:'amazon',sellerId:'S10SELLER',sku:'S10-SKU',accessToken:'s10-amazon-token',now};
  const url=(p:string,q:Record<string,string>)=>base+p+'?'+new URLSearchParams(q);
  const routes=[{id:'lwa',method:'POST',path:'/protocol/lwa',publicUrl:'https://api.amazon.com/auth/o2/token',protocol:{kind:'lwa',clientId:'s10-client-id',clientSecret:'s10-client-secret',refreshToken:'s10-refresh-token'},response:{json:{access_token:'s10-amazon-token',token_type:'bearer',expires_in:3600}}},
    {id:'library',method:'GET',path:'/protocol/library',publicUrl:url('/definitions/2020-09-01/productTypes',{marketplaceIds:'ATVPDKIKX0DER',locale:'en_US'}),protocol:{...auth,operation:'library'},response:{json:{productTypes:[{name:'DRINK_COASTER',displayName:'Drink coaster',marketplaceIds:['ATVPDKIKX0DER']}]}}},
    {id:'schema',method:'GET',path:'/protocol/schema',publicUrl:fixture.schema.url,protocol:{kind:'public-bytes'},response:{bytes:fixture.schema.bytes,contentType:'application/json'}},
    {id:'preview',method:'PUT',path:'/protocol/preview',publicUrl:url(path,{...query,mode:'VALIDATION_PREVIEW',includedData:'issues'}),protocol:{...auth,operation:'preview',bodySha256},response:{json:{sku:'S10-SKU',status:'VALID',submissionId:'s10-preview',issues:[]}}},
    {id:'submit',method:'PUT',path:'/protocol/submit',publicUrl:url(path,{...query,includedData:'issues'}),protocol:{...auth,operation:'submit',bodySha256},response:{json:{sku:'S10-SKU',status:'ACCEPTED',submissionId:'s10-submit',issues:[]}}},
    {id:'readback',method:'GET',path:'/protocol/readback',publicUrl:url(path,{...query,includedData:'summaries,issues,attributes,offers,fulfillmentAvailability,relationships'}),protocol:{...auth,operation:'readback'},response:{json:{sku:'S10-SKU',summaries:[{marketplaceId:'ATVPDKIKX0DER',status:['BUYABLE']}],issues:[]}}},
    {id:'definition',method:'GET',path:'/protocol/definition',publicUrl:url('/definitions/2020-09-01/productTypes/DRINK_COASTER',{sellerId:'S10SELLER',marketplaceIds:'ATVPDKIKX0DER',requirements:'LISTING',requirementsEnforced:'ENFORCED',parentageLevel:'NONE',locale:'en_US',productTypeVersion:'LATEST'}),protocol:{...auth,operation:'definitions',productType:'DRINK_COASTER',parentageLevel:'NONE'},response:{json:fixture.definition}}];
  const server=await createFakeProvider({directory:join(root,'server'),routes});t.after(()=>server.close());const policy=await writePolicy({directory:join(root,'worker'),provider:server,guardFile:guard});
  const code=`import assert from 'node:assert/strict';import {AmazonTransport} from './src/main/amazon/transport.ts';
    const target={id:'01234567-89ab-4cde-8fab-0123456789ab',sellerId:'S10SELLER',marketplaceId:'ATVPDKIKX0DER',region:'na',locale:'en_US',mode:'live'},events=[];
    const transport=new AmazonTransport({active:()=>target,generation:()=>1,credentials:()=>({clientId:'s10-client-id',clientSecret:'s10-client-secret',refreshToken:'s10-refresh-token'}),pause:()=>{throw Error('unexpected pause');},audit:value=>events.push(value),redact:value=>value,remember:()=>{}},{fetch,schemaFetch:fetch,now:()=>Date.parse('${now}'),resolveAddresses:async host=>{assert.equal(host,'selling-partner-definitions-prod-iad.s3.amazonaws.com');return ['198.18.0.1'];},sleep:async()=>{}});
    const library=await transport.api(target,'searchDefinitionsProductTypes','/definitions/2020-09-01/productTypes',{marketplaceIds:'ATVPDKIKX0DER',locale:'en_US'});assert.equal(library.data.productTypes[0].name,'DRINK_COASTER');
    const definition=await transport.api(target,'getDefinitionsProductType','/definitions/2020-09-01/productTypes/DRINK_COASTER',{sellerId:'S10SELLER',marketplaceIds:'ATVPDKIKX0DER',requirements:'LISTING',requirementsEnforced:'ENFORCED',parentageLevel:'NONE',locale:'en_US',productTypeVersion:'LATEST'});assert.equal(definition.data.productType,'DRINK_COASTER');
    const downloaded=await transport.schemaLink(target,${JSON.stringify(fixture.definition.schema)});assert.equal(Object.keys(downloaded.schema.properties).length,106);
    await assert.rejects(transport.schemaLink(target,{...${JSON.stringify(fixture.definition.schema)},checksum:'AAAAAAAAAAAAAAAAAAAAAA=='}),/checksum/);
    const path='${path}',query=${JSON.stringify(query)},body=${JSON.stringify(body)};
    assert.equal((await transport.api(target,'previewListingsItem',path,{...query,mode:'VALIDATION_PREVIEW',includedData:'issues'},body)).data.status,'VALID');
    assert.equal((await transport.api(target,'putListingsItem',path,{...query,includedData:'issues'},body)).data.status,'ACCEPTED');
    assert.deepEqual((await transport.api(target,'getListingsItem',path,{...query,includedData:'summaries,issues,attributes,offers,fulfillmentAvailability,relationships'})).data.summaries[0].status,['BUYABLE']);
    const preview=${JSON.stringify(routes[3].publicUrl)},headers={'x-amz-access-token':'s10-amazon-token','x-amz-date':'20261015T000000Z','content-type':'application/json'};
    const bad=[[preview+'&mode=VALIDATION_PREVIEW',{}],[preview.replace('mode=','%6Dode='),{}],[preview.replace('VALIDATION_PREVIEW','validation_preview'),{}],[preview,{headers:{...headers,'x-amz-access-token':'s10-other-token'}}],[preview,{headers:{...headers,'x-amz-date':'20261016T000000Z'}}],[preview,{headers:{...headers,authorization:'Bearer s10-other'}}],[preview,{body:'{}'}],[preview,{method:'PATCH'}]];
    for(const [url,override]of bad)await assert.rejects(async()=>fetch(url,{method:'PUT',headers,body:JSON.stringify(body),redirect:'error',...override}));
    const form=new URLSearchParams({grant_type:'refresh_token',client_id:'s10-client-id',client_secret:'s10-client-secret',refresh_token:'s10-refresh-token'}).toString();
    for(const body of [form+'&refresh_token=s10-refresh-token',form.replace('client_id=','%63lient_id='),form.replace('s10-client-id','s10-other-id')])await assert.rejects(async()=>fetch('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8'},body,redirect:'manual'}));
    console.log(JSON.stringify({rejected:bad.length+3,events:events.map(row=>row.operation),guard:globalThis.__s10Guard}));`;
  const output=await run(process.execPath,['--require',guard,'--input-type=module','-e',code],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path},windowsHide:true});assert.equal(JSON.parse(output.stdout).rejected,11);
  const rows=server.ledger(),requests=rows.filter((row:any)=>row.event==='request');assert.deepEqual(requests.map((row:any)=>row.routeId),['lwa','library','definition','schema','schema','preview','submit','readback']);assert.equal(rows.filter((row:any)=>row.event==='arrival').length,8);assert.ok(requests.every((row:any)=>row.protocolVerified));
});

test('signed protocol error/manual redirects never follow the owned bait route',async t=>{
  const root=await directory(),route=ocrRoute();Object.assign(route.response,{status:307,redirectToPath:'/bait'});
  const server=await createFakeProvider({directory:join(root,'server'),routes:[route,{id:'bait',method:'GET',path:'/bait',response:{json:{bait:true}}}]});t.after(()=>server.close());const policy=await writePolicy({directory:join(root,'worker'),provider:server,guardFile:guard});
  const code=`import assert from 'node:assert/strict';import {signAcs3} from './src/main/ai/acs3.ts';const body=Buffer.from('s10-redirect'),s=signAcs3({host:'ocr-api.cn-hangzhou.aliyuncs.com',action:'RecognizeAllText',version:'2021-07-07',query:{Type:'Commerce'},body,contentType:'application/octet-stream',now:new Date('${now}'),nonce:'${nonce}',accessKeyId:'s10-acs-id',accessKeySecret:'s10-acs-secret'});
    await assert.rejects(async()=>fetch(s.url,{method:'POST',headers:s.headers,body,redirect:'error'}),/S10_PROTOCOL_REDIRECT/);
    const response=await fetch(s.url,{method:'POST',headers:s.headers,body,redirect:'manual'});assert.equal(response.status,307);assert.equal(response.headers.get('location'),'${server.origin}/bait');await response.text();
    await assert.rejects(async()=>fetch(s.url,{method:'POST',headers:s.headers,body,redirect:'follow'}),/S10_NETWORK_BLOCKED/);console.log('redirects-contained');`;
  await run(process.execPath,['--require',guard,'--input-type=module','-e',code],{cwd:resolve('.'),env:{...process.env,NODE_OPTIONS:'',S10_POLICY_FILE:policy.path},windowsHide:true});
  const requests=server.ledger().filter((row:any)=>row.event==='request');assert.equal(requests.length,2);assert.ok(requests.every((row:any)=>row.routeId==='ocr'));assert.equal(server.ledger().filter((row:any)=>row.event==='arrival').length,2);
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
