import test from 'node:test';
import assert from 'node:assert/strict';
import { AmazonTransport, AmazonTransportError, type AmazonDependencies } from '../src/main/amazon/transport.ts';
import type { AmazonTarget } from '../src/shared/amazon-contracts.ts';

const target = { id: 'target', sellerId: 'SELLER', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en_US', mode: 'live', configured: true, paused: false } as AmazonTarget;
const credentials = { ...target, name: 'test', clientId: 'client-private', clientSecret: 'secret-private', refreshToken: 'refresh-private' };
const uri = 'https://test-labels.s3.amazonaws.com/document.pdf?X-Amz-Signature=private-signature';
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
function fixture(status = 200,dependencies:AmazonDependencies={}) {
  const calls: { url: string; init: RequestInit }[] = []; const pauses: string[] = [];
  const native = async (url: string, init: RequestInit) => { calls.push({ url, init }); if (url.includes('/auth/o2/token')) return Response.json({ access_token: 'access-private', token_type: 'bearer', expires_in: 3600 });
    if (url.includes('/items/labels')) return Response.json(status === 200 ? { documentDownloads: [{ uri, downloadType: 'URL' }] } : { errors: [{ code: 'AccessDenied' }] }, { status, headers: { 'x-amzn-requestid': 'labels-request-1' } });
    return new Response(pdf, { headers: { 'content-type': 'application/pdf' } }); };
  const transport = new AmazonTransport({ active: () => target, generation: () => 1, credentials: () => credentials, pause: (_id, reason) => pauses.push(reason), audit: () => {}, redact: value => value, remember: () => {} }, { fetch: async () => { throw Error('native proxy path required'); }, dataFetch: native, resolveAddresses: async () => ['52.1.2.3'],...dependencies });
  return { transport, calls, pauses };
}
test('labels use exact POST endpoint, native proxy, single-SKU quantity and uncredentialed download', async () => {
  const f = fixture(); assert.equal(typeof f.transport.createMarketplaceItemLabels, 'function');
  const result = await f.transport.createMarketplaceItemLabels(target, { marketplaceId: target.marketplaceId, mskuQuantities: [{ msku: 'SKU 1', quantity: 5 }], labelType: 'STANDARD_FORMAT', pageType: 'A4_21', localeCode: 'en_US' });
  assert.equal(result.requestId, 'labels-request-1'); const request = f.calls.find(call => call.url.includes('/items/labels'))!;
  assert.equal(request.url, 'https://sellingpartnerapi-na.amazon.com/inbound/fba/2024-03-20/items/labels'); assert.equal(request.init.method, 'POST');
  assert.equal((JSON.parse(String(request.init.body))).mskuQuantities[0].quantity, 5);
  assert.deepEqual(await f.transport.downloadItemLabel(uri), pdf);
  const download = f.calls.at(-1)!; assert.equal(new Headers(download.init.headers).has('x-amz-access-token'), false); assert.equal(download.init.credentials, 'omit');
});
test('an unresponsive label DNS lookup is bounded before any download starts',async()=>{
  const f=fixture(200,{timeoutMs:25,resolveAddresses:()=>new Promise(()=>{})});
  await f.transport.createMarketplaceItemLabels(target,{marketplaceId:target.marketplaceId,mskuQuantities:[{msku:'SKU',quantity:1}],labelType:'STANDARD_FORMAT',pageType:'A4_21',localeCode:'en_US'});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{const outcome=await Promise.race([f.transport.downloadItemLabel(uri).then(()=> 'unexpected success',()=> 'rejected'),new Promise<string>(resolve=>{timer=setTimeout(()=>resolve('unbounded DNS'),300);})]);assert.equal(outcome,'rejected');}
  finally{if(timer)clearTimeout(timer);}
  assert.equal(f.calls.filter(call=>call.url===uri).length,0);
});
test('labels permission denial is explicit and does not pause working listing credentials', async () => {
  const f = fixture(403); assert.equal(typeof f.transport.createMarketplaceItemLabels, 'function');
  await assert.rejects(f.transport.createMarketplaceItemLabels(target, { marketplaceId: target.marketplaceId, mskuQuantities: [{ msku: 'SKU', quantity: 1 }], labelType: 'STANDARD_FORMAT', pageType: 'A4_21', localeCode: 'en_US' }), error => error instanceof AmazonTransportError && error.status === 403);
  assert.equal(f.pauses.length, 0); assert.equal(f.calls.filter(call => call.url.includes('/items/labels')).length, 1);
});
test('arbitrary S3 URLs and invalid quantities never reach network', async () => {
  const f = fixture(); assert.equal(typeof f.transport.downloadItemLabel, 'function');
  await assert.rejects(f.transport.downloadItemLabel(uri), /授权|来源/); assert.equal(f.calls.length, 0);
  await assert.rejects(f.transport.createMarketplaceItemLabels(target, { marketplaceId: target.marketplaceId, mskuQuantities: [{ msku: 'SKU', quantity: 10001 }], labelType: 'STANDARD_FORMAT', pageType: 'A4_21', localeCode: 'en_US' })); assert.equal(f.calls.length, 0);
});

const labelRequest = { marketplaceId: target.marketplaceId, mskuQuantities: [{ msku: 'SKU', quantity: 1 }], labelType: 'STANDARD_FORMAT', pageType: 'A4_21', localeCode: 'en_US' };

test('persisted main-process capability restores exact unexpired download after transport restart',async()=>{
  const f=fixture(),context={targetId:target.id,sellerId:target.sellerId,marketplaceId:target.marketplaceId,mode:'live' as const,targetGeneration:1};
  f.transport.restoreItemLabelDownloads(target,context,[{uri,expiration:Date.now()+60000}]);
  assert.deepEqual(await f.transport.downloadItemLabel(uri),pdf);assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.method,'GET');
  await assert.rejects(f.transport.downloadItemLabel(uri.replace('private-signature','other')),/授权|来源/);
  f.transport.clear(target.id);await assert.rejects(f.transport.downloadItemLabel(uri),/授权|来源/);
});

test('real GET 503 is a safe transient transport error rather than an unknown POST',async()=>{
  const f=fixture(200,{dataFetch:async(url)=>url.includes('/auth/o2/token')?Response.json({access_token:'private',token_type:'bearer',expires_in:3600}):url.includes('/items/labels')?Response.json({documentDownloads:[{uri,downloadType:'URL'}]}):new Response('unavailable',{status:503})});
  await f.transport.createMarketplaceItemLabels(target,labelRequest);
  await assert.rejects(f.transport.downloadItemLabel(uri),error=>error instanceof AmazonTransportError&&error.status===503&&!error.unknownWrite);
});

test('restored capabilities still reject changed scope, expiry, unrelated origins and private DNS',async()=>{
  const context={targetId:target.id,sellerId:target.sellerId,marketplaceId:target.marketplaceId,mode:'live' as const,targetGeneration:1};
  const f=fixture();
  for(const scope of [{...context,targetGeneration:2},{...context,sellerId:'OTHER'},{...context,targetId:'OTHER'}])assert.throws(()=>f.transport.restoreItemLabelDownloads(target,scope,[{uri,expiration:Date.now()+60000}]),/身份|授权/);
  assert.throws(()=>f.transport.restoreItemLabelDownloads(target,context,[{uri,expiration:Date.now()-1}]),/过期/);
  assert.throws(()=>f.transport.restoreItemLabelDownloads(target,context,[{uri:'https://example.com/document.pdf',expiration:Date.now()+60000}]),/来源/);
  assert.equal(f.calls.length,0);
  const privateDns=fixture(200,{resolveAddresses:async()=>['127.0.0.1']});privateDns.transport.restoreItemLabelDownloads(target,context,[{uri,expiration:Date.now()+60000}]);
  await assert.rejects(privateDns.transport.downloadItemLabel(uri),/非公开/);assert.equal(privateDns.calls.length,0);
});

test('only the exact Amazon-authorized label URL can use native Fake-IP download', async () => {
  let now = Date.now();
  const f = fixture(200, { now: () => now, resolveAddresses: async () => ['198.18.0.91', '198.19.255.254'] });
  await f.transport.createMarketplaceItemLabels(target, labelRequest);
  for (const other of [uri.replace('document.pdf', 'other.pdf'), uri.replace('private-signature', 'another-signature'), uri.replace('test-labels', 'another-bucket')]) {
    await assert.rejects(f.transport.downloadItemLabel(other), /授权|来源/);
  }
  assert.deepEqual(await f.transport.downloadItemLabel(uri), pdf);
  const download = f.calls.at(-1)!;
  assert.equal(download.url, uri); assert.equal(download.init.redirect, 'manual'); assert.equal(download.init.credentials, 'omit');
  assert.equal(new Headers(download.init.headers).has('x-amz-access-token'), false);
  assert.equal(new Headers(download.init.headers).has('authorization'), false);
  now += 15 * 60_000;
  await assert.rejects(f.transport.downloadItemLabel(uri), /过期/);
  assert.equal(f.calls.filter(call => call.url === uri).length, 1);
});

test('Fake-IP label compatibility rejects mixed DNS, private addresses and missing native transport', async () => {
  for (const addresses of [[], ['127.0.0.1'], ['10.0.0.1'], ['::1'], ['::ffff:198.18.0.91'], ['198.18.0.91', '52.1.2.3'], ['198.18.0.91', '10.0.0.1']]) {
    const f = fixture(200, { resolveAddresses: async () => addresses });
    await f.transport.createMarketplaceItemLabels(target, labelRequest);
    await assert.rejects(f.transport.downloadItemLabel(uri), /非公开/);
    assert.equal(f.calls.filter(call => call.url === uri).length, 0);
  }
  let downloads = 0;
  const f = fixture(200, { dataFetch: undefined, resolveAddresses: async () => ['198.18.0.91'], fetch: async input => {
    const url = String(input);
    if (url.includes('/auth/o2/token')) return Response.json({ access_token: 'access-private', token_type: 'bearer', expires_in: 3600 });
    if (url.includes('/items/labels')) return Response.json({ documentDownloads: [{ uri, downloadType: 'URL' }] });
    downloads++; return new Response(pdf);
  } });
  await f.transport.createMarketplaceItemLabels(target, labelRequest);
  await assert.rejects(f.transport.downloadItemLabel(uri), /非公开/); assert.equal(downloads, 0);
});

test('label capability expiration is rechecked after asynchronous DNS', async () => {
  let now = Date.now();
  const f = fixture(200, { now: () => now, resolveAddresses: async () => { now += 15 * 60_000; return ['52.1.2.3']; } });
  await f.transport.createMarketplaceItemLabels(target, labelRequest);
  await assert.rejects(f.transport.downloadItemLabel(uri), /过期/);
  assert.equal(f.calls.filter(call => call.url === uri).length, 0);
});
