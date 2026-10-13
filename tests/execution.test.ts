import { seedAuthorityHaulPricing } from './helpers/authority-haul-pricing.ts';
import { saveInput } from './fixtures/listing-ai.ts';
import { addSourceOriginalFixture,confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore } from '../src/main/store.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import type { JsonObject } from '../src/shared/amazon-contracts.ts';
import { imageWorkflowDraftStamp, validateImageWorkflowRun } from '../src/main/image-workflow/records.ts';
import { PRODUCT_IMAGE_POLICY_VERSION } from '../src/shared/image-ai-contracts.ts';

const implementation = await import('../src/main/execution/service.ts').catch(() => null);
const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };
async function fixture(t: test.TestContext, options: { holdUpload?: boolean; failVerify?: boolean; requireMain?: boolean; gallery?: boolean; sourceSpec?:string } = {}) {
  assert.ok(implementation?.ExecutionService, 'durable execution service must exist');
  const parent = resolve('.test-data'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'execution-'));
  const store = new WorkspaceStore(directory);
  const amazon = new AmazonService(directory, id => store.getProduct(id), safeStorage, { fetch: async () => { throw Error('Unexpected network'); } });
  let product = store.createProduct(); if(options.sourceSpec)product=store.saveProduct({...saveInput(product),variants:saveInput(product).variants.map(v=>({...v,originalSpec:options.sourceSpec!,normalizedSpec:options.sourceSpec!}))}); const variantId = product.variants[0].id;
  product=addSourceOriginalFixture(directory,store,product.id,[variantId]);
  const assetId=product.assets[0].id;
  if(options.gallery)product=addSourceOriginalFixture(directory,store,product.id,[variantId],'gallery',1);
  await confirmSourceConsistencyFixture(directory,store,product.id);
  const target = amazon.enableDemo();
  if(options.requireMain){const getSchema=amazon.getSchema.bind(amazon);amazon.getSchema=async input=>{const schema=await getSchema(input);schema.schema.required=[...new Set([...(schema.schema.required as string[] ?? []),'main_product_image_locator'])];return schema;};}
  let draft = await amazon.createDraft({ targetId: target.id, productId: product.id, variantId, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' });
  draft = amazon.saveDraft({ id: draft.id, revision: draft.revision, attributes: { ...draft.attributes,
    brand: [{ value: 'Verified Brand', marketplace_id: target.marketplaceId }], color: [{ value: 'Blue', marketplace_id: target.marketplaceId }],
    purchasable_offer: [{ marketplace_id: target.marketplaceId, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 12.5 }] }] }] } });
  let release = () => {}; const held = new Promise<void>(r => { release = r; });
  const uploaded = { id: randomUUID(), assetId, profileId: 'alpha', generation: 1, sha256: store.getAssetRecord(assetId)!.sha256, byteSize: 33, mimeType: 'image/png',
    batchId: randomUUID(), remotePath: '/test/image.png', publicUrl: 'https://images.example.com/test/image.png', status: 'AVAILABLE' as const, attempts: 1, errorCode: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let uploadCalls = 0, verifyCalls = 0, generation = 1;
  const hosting = {
    getProfile: () => ({ id: 'alpha', name: 'Alpha', host: 'ftp.example.com', port: 2121, secure: false, remoteRoot: '/', publicBaseUrl: 'https://images.example.com/', enabled: true, configured: true, generation }),
    upload: async (input: { assetId: string }) => { uploadCalls++; if (options.holdUpload) await held; return { ...structuredClone(uploaded), assetId: input.assetId, sha256: store.getAssetRecord(input.assetId)!.sha256 }; },
    verify: async () => { verifyCalls++; if (options.failVerify) throw Error('probe rejected'); return structuredClone(uploaded); },
  };
  let service = new implementation.ExecutionService(directory, store, amazon, hosting);
  t.after(async () => { release(); await service.close(); amazon.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, amazon, product, draft, release, hosting, get service() { return service; }, get uploadCalls() { return uploadCalls; }, get verifyCalls() { return verifyCalls; },
    rotateProfile() { generation++; }, async reopen() { await service.close(); service = new implementation!.ExecutionService(directory, store, amazon, hosting); },
    create() { return service.create({ draftIds: [draft.id], profileId: 'alpha' }); },
    start(id: string) { return service.startAuthorized(service.prepareStart(id)); } };
}

function saveLegacyImageApproval(f: Awaited<ReturnType<typeof fixture>>) {
  const draft=f.amazon.getDraft(f.draft.id),asset=f.product.assets[0],now=new Date().toISOString();
  const run=validateImageWorkflowRun({id:randomUUID(),draftId:draft.id,productId:draft.productId,productRevision:draft.productRevision,variantId:draft.variantId,sku:draft.sku,
    status:'COMPLETED',stage:'complete',attempt:1,maxAttempts:2,contextSha256:'b'.repeat(64),draftSha256:imageWorkflowDraftStamp(draft),referenceAssets:[{id:asset.id,sha256:f.store.getAssetRecord(asset.id)!.sha256}],
    planResultIds:[randomUUID()],candidateIds:[randomUUID()],ipReviewResultIds:[randomUUID()],ocrResultIds:[randomUUID()],reviewResultIds:[randomUUID()],
    approvedAssetId:randomUUID(),approvedSha256:f.store.getAssetRecord(asset.id)!.sha256,createdAt:now,updatedAt:now,error:null,imagePolicyVersion:PRODUCT_IMAGE_POLICY_VERSION});
  const db=new DatabaseSync(join(f.directory,'red.sqlite'));
  try{db.prepare('INSERT INTO image_workflow_runs(id,record_json) VALUES(?,?)').run(run.id,JSON.stringify(run));}finally{db.close();}
}

test('legacy single-image approval cannot create or start an unsubmitted sellable execution task',async t=>{
  const f=await fixture(t);saveLegacyImageApproval(f);assert.throws(()=>f.create(),/7|七/);
  const g=await fixture(t),task=g.create();saveLegacyImageApproval(g);
  assert.throws(()=>g.start(task.id),/7|七/);assert.equal(g.uploadCalls,0);
});

test('legacy single-image approval preserves readback of an already accepted submission',async t=>{
  const f=await fixture(t),task=f.create();let draft=await f.amazon.previewDraft({id:f.draft.id,revision:f.draft.revision});
  await f.amazon.submitDraft({id:draft.id,revision:draft.revision},true);saveLegacyImageApproval(f);
  f.start(task.id);await f.service.waitForIdle();assert.equal(f.service.get(task.id).status,'COMPLETED');
  assert.equal(f.uploadCalls,0);assert.equal(f.amazon.listCalls().filter(call=>call.operation==='putListingsItem').length,1);
});

test('automatic task uploads, injects verified images, validates, submits once and reads back', async t => {
  const f = await fixture(t); const task = f.create();
  assert.equal(task.status, 'CREATED'); assert.equal(f.uploadCalls, 0);
  f.start(task.id); await f.service.waitForIdle();
  const done = f.service.get(task.id);
  assert.equal(done.status, 'COMPLETED'); assert.ok(done.items[0].steps.every(step => step.status === 'DONE'));
  const draft = f.amazon.getDraft(f.draft.id);
  assert.equal(draft.state, 'BUYABLE'); assert.equal(f.verifyCalls, 2);
  assert.equal((draft.attributes.main_product_image_locator as JsonObject[])[0].media_location, 'https://images.example.com/test/image.png');
  assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 1);
  assert.throws(() => f.start(task.id), /完成|启动/);
});

test('missing non-image required fields fail validation before hosting and remain repairable', async t => {
  const f = await fixture(t);
  const attributes = structuredClone(f.draft.attributes); delete attributes.color;
  f.amazon.saveDraft({ id: f.draft.id, revision: f.draft.revision, attributes });
  const task = f.create(); f.start(task.id); await f.service.waitForIdle();
  const item = f.service.get(task.id).items[0];
  assert.equal(f.uploadCalls, 0); assert.equal(f.verifyCalls, 0);
  assert.equal(item.steps.find(step => step.name === 'validate')!.status, 'FAILED');
  assert.equal(item.steps.find(step => step.name === 'upload')!.status, 'PENDING');
  assert.ok(f.amazon.getDraft(f.draft.id).localIssues.some(issue => issue.attributeNames.includes('color')));
  assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 0);
  await f.reopen();
  assert.equal(f.service.get(task.id).items[0].steps.find(step => step.name === 'validate')!.status, 'FAILED');
});

test('required main URL waits for hosting but a missing color prevents upload first', async t => {
  const f=await fixture(t,{requireMain:true}),attributes=structuredClone(f.draft.attributes);delete attributes.color;
  f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes});
  const blocked=f.create();f.start(blocked.id);await f.service.waitForIdle();
  assert.equal(f.uploadCalls,0);assert.equal(f.service.get(blocked.id).items[0].steps.find(step=>step.name==='validate')!.status,'FAILED');
  f.service.cancel(blocked.id);
  const draft=f.amazon.getDraft(f.draft.id);f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,color:[{value:'Blue',marketplace_id:draft.marketplaceId}]}});
  const ready=f.create();f.start(ready.id);await f.service.waitForIdle();
  assert.equal(f.service.get(ready.id).status,'COMPLETED');assert.equal(f.uploadCalls,1);
});

test('snapshots reject profile rotation, changed draft and duplicate draft ownership', async t => {
  const f = await fixture(t); const task = f.create();
  assert.throws(() => f.create(), /任务|重复/);
  assert.throws(() => f.service.create({ draftIds: [f.draft.id], profileId: 'alpha', confirmed: true }), /字段/);
  f.rotateProfile(); assert.throws(() => f.start(task.id), /配置|变化/);
  const g = await fixture(t); const second = g.create();
  g.amazon.saveDraft({ id: g.draft.id, revision: g.draft.revision, attributes: { ...g.draft.attributes, color: [{ value: 'Changed' }] } });
  assert.throws(() => g.start(second.id), /草稿|变化/);
});

test('pause lets the current safe step settle but never starts validation or submit', async t => {
  const f = await fixture(t, { holdUpload: true }); const task = f.create();
  f.start(task.id); assert.throws(() => f.start(task.id), /运行|启动/);
  await new Promise(r => setImmediate(r)); f.service.pause(task.id); f.release(); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status, 'PAUSED'); assert.equal(f.amazon.getDraft(f.draft.id).state, 'DRAFT');
  assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 0);
  f.start(task.id); await f.service.waitForIdle(); assert.equal(f.service.get(task.id).status, 'COMPLETED');
});

test('failed external URL check transfers task to attention and cannot submit', async t => {
  const f = await fixture(t, { failVerify: true }); const task = f.create(); f.start(task.id); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status, 'NEEDS_ATTENTION');
  assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 0);
});

test('restart pauses in-flight tasks and reconciles an accepted submit without replaying it', async t => {
  const f = await fixture(t); const task = f.create(); f.start(task.id); await f.service.waitForIdle();
  const done = f.service.get(task.id); done.status = 'RUNNING'; done.items[0].steps.find(s => s.name === 'submit')!.status = 'RUNNING';
  done.items[0].steps.find(s => s.name === 'readback')!.status = 'PENDING'; done.items[0].status = 'RUNNING';
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  db.prepare('UPDATE execution_tasks SET record_json=? WHERE id=?').run(JSON.stringify(done), task.id); db.close();
  await f.reopen(); assert.equal(f.service.get(task.id).status, 'PAUSED');
  const priorCalls = f.amazon.listCalls().length; await f.service.waitForIdle(); assert.equal(f.amazon.listCalls().length, priorCalls);
  f.start(task.id); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status, 'COMPLETED');
  assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 1);
});

test('a cancellation is persisted and queued work cannot start afterward', async t => {
  const f = await fixture(t); const task = f.create(); f.service.cancel(task.id); await f.reopen();
  assert.equal(f.service.get(task.id).status, 'CANCELLED'); assert.throws(() => f.start(task.id), /取消|启动/); assert.equal(f.uploadCalls, 0);
});

test('pause during Amazon submit preflight prevents the write and can resume safely', async t => {
  const f = await fixture(t); const task = f.create(); const original = f.amazon.getSchema.bind(f.amazon);
  let entered = () => {}, release = () => {};
  const pending = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
  f.amazon.getSchema = async input => { if ((input as { forceRefresh?: boolean }).forceRefresh) { entered(); await held; } return original(input); };
  f.start(task.id); await pending; f.service.pause(task.id); release(); await f.service.waitForIdle();
  assert.equal(f.amazon.listCalls().filter(c => c.operation === 'putListingsItem').length, 0);
  assert.equal(f.service.get(task.id).items[0].submitStarted, false);
  f.start(task.id); await f.service.waitForIdle(); assert.equal(f.service.get(task.id).status, 'COMPLETED');
  assert.equal(f.amazon.listCalls().filter(c => c.operation === 'putListingsItem').length, 1);
});

test('unknown submission is read back and remains human attention across retry and restart', async t => {
  const f = await fixture(t); let writes = 0;
  f.amazon.submitDraft = async input => {
    writes++; const draft = f.amazon.getDraft((input as { id: string }).id);
    const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
    const row = db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(draft.id)!;
    const record = JSON.parse(String(row.record_json)); record.unresolvedWrite = true; record.draft.state = 'UNKNOWN'; record.preview = null;
    db.prepare("UPDATE listing_drafts SET record_json=?,state='UNKNOWN' WHERE id=?").run(JSON.stringify(record), draft.id); db.close();
    return f.amazon.getDraft(draft.id);
  };
  const task = f.create(); f.start(task.id); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status, 'NEEDS_ATTENTION'); assert.equal(f.service.get(task.id).items[0].listingState, 'UNKNOWN');
  await f.reopen(); f.start(task.id); await f.service.waitForIdle();
  assert.equal(writes, 1); assert.equal(f.service.get(task.id).status, 'NEEDS_ATTENTION');
});

test('a definitive INVALID response is released for field repair without replaying a write',async t=>{
  const f=await fixture(t);let writes=0;
  f.amazon.submitDraft=async input=>{
    writes++;const id=(input as {id:string}).id,db=new DatabaseSync(join(f.directory,'red.sqlite'));
    const record=JSON.parse(String(db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(id)!.record_json));
    record.draft.state='BLOCKED';record.preview=null;record.draft.previewedAt=null;
    record.submitResponse={sku:record.draft.sku,status:'INVALID',issues:[{code:'90220',message:'Invalid title',severity:'ERROR',attributeNames:['item_name']}]};
    db.prepare("UPDATE listing_drafts SET record_json=?,state='BLOCKED' WHERE id=?").run(JSON.stringify(record),id);db.close();return f.amazon.getDraft(id);
  };
  const task=f.create();f.start(task.id);await f.service.waitForIdle();
  assert.equal(writes,1);assert.equal(f.service.get(task.id).items[0].submitStarted,false);assert.equal(f.amazon.wasSubmissionRejected(f.draft.id),true);
  assert.equal(f.service.get(task.id).status,'NEEDS_ATTENTION');
});

test('source changes during upload prevent image injection and all Amazon writes', async t => {
  const f = await fixture(t, { holdUpload: true }); const task = f.create(); f.start(task.id); await new Promise(r => setImmediate(r));
  const product = f.store.getProduct(f.product.id);
  f.store.updateAsset({ productId: product.id, revision: product.revision, assetId: product.assets[0].id, role: 'main', variantIds: [] });
  f.release(); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status, 'NEEDS_ATTENTION'); assert.equal(f.amazon.getDraft(f.draft.id).attributes.main_product_image_locator, undefined);
  assert.equal(f.amazon.listCalls().filter(c => c.operation === 'putListingsItem').length, 0);
});

test('draft changes during the first upload prevent every subsequent image upload', async t => {
  const f = await fixture(t, { holdUpload: true, gallery: true }), task = f.create();
  assert.equal(task.items[0].assets.length, 2);
  f.start(task.id); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.uploadCalls, 1);
  f.amazon.saveDraft({ id: f.draft.id, revision: f.draft.revision, attributes: { ...f.draft.attributes, color: [{ value: 'Changed', marketplace_id: f.draft.marketplaceId }] } });
  f.release(); await f.service.waitForIdle();
  assert.equal(f.uploadCalls, 1, 'A stale task must not send the second image to FTP');
  const result = f.service.get(task.id), item = result.items[0];
  assert.equal(result.status, 'NEEDS_ATTENTION'); assert.equal(item.uploads.length, 1);
  assert.equal(item.steps.find(step => step.name === 'upload')!.status, 'FAILED');
  assert.match(item.steps.find(step => step.name === 'upload')!.error!, /草稿.*变化/);
  assert.ok(item.steps.filter(step => step.name !== 'upload').every(step => step.status === 'PENDING'));
  assert.equal(f.amazon.getDraft(f.draft.id).attributes.main_product_image_locator, undefined);
  assert.equal(f.amazon.listCalls().filter(call => call.operation === 'putListingsItem').length, 0);
});

test('start approval becomes stale if the task changes while its native dialog is open', async t => {
  const f = await fixture(t); const task = f.create(), approved = f.service.prepareStart(task.id);
  f.service.pause(task.id); assert.throws(() => f.service.startAuthorized(approved), /确认期间/); assert.equal(f.uploadCalls, 0);
});

test('pre-send task cancellation after intent is recorded permits a fresh preview and safe resume', async t => {
  const f = await fixture(t); const task = f.create();
  const internals = f.amazon as unknown as { persistence: { beginWrite: (...args: unknown[]) => void } };
  const original = internals.persistence.beginWrite.bind(internals.persistence); let once = true;
  internals.persistence.beginWrite = (...args) => { original(...args); if (once) { once = false; f.service.pause(task.id); } };
  f.start(task.id); await f.service.waitForIdle();
  assert.equal(f.amazon.listCalls().filter(c => c.operation === 'putListingsItem').length, 0);
  f.start(task.id); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status, 'COMPLETED'); assert.equal(f.amazon.listCalls().filter(c => c.operation === 'putListingsItem').length, 1);
});

test('readback-only recovery is independent of a subsequently rotated FTP profile', async t => {
  const f = await fixture(t); const task = f.create(); const read = f.amazon.readListing.bind(f.amazon);
  f.amazon.readListing = async () => { throw Error('Temporary read outage'); }; f.start(task.id); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status, 'NEEDS_ATTENTION'); assert.ok(f.amazon.getDraft(f.draft.id).submittedAt);
  f.rotateProfile(); f.amazon.readListing = read; f.start(task.id); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status, 'COMPLETED'); assert.equal(f.amazon.listCalls().filter(c => c.operation === 'putListingsItem').length, 1);
});

test('automatic tasks reject extra unverified image locators rather than silently carrying them', async t => {
  const f = await fixture(t);
  f.amazon.saveDraft({ id: f.draft.id, revision: f.draft.revision, attributes: { ...f.draft.attributes,
    swatch_product_image_locator: [{ marketplace_id: f.draft.marketplaceId, media_location: 'https://unverified.example.com/swatch.png' }] } });
  assert.throws(() => f.create(), /图片|托管/); assert.equal(f.uploadCalls, 0);
});

test('a manual submission made after task creation changes the task into readback only', async t => {
  const f = await fixture(t); const task = f.create(); let draft = await f.amazon.previewDraft({ id: f.draft.id, revision: f.draft.revision });
  draft = await f.amazon.submitDraft({ id: draft.id, revision: draft.revision }, true);
  f.start(task.id); await f.service.waitForIdle(); const done = f.service.get(task.id);
  assert.equal(done.status, 'COMPLETED'); assert.equal(f.uploadCalls, 0);
  assert.ok(done.items[0].steps.slice(0, -1).every(step => step.status === 'SKIPPED'));
  assert.equal(f.amazon.listCalls().filter(c => c.operation === 'putListingsItem').length, 1);
});

test('an image confirmed for another SKU cannot satisfy an unconfirmed current-SKU binding', async t => {
  const f = await fixture(t), other = randomUUID(), db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  db.prepare(`INSERT INTO variants(id,product_id,sku,original_spec,normalized_spec,purchase_price,inventory,source_spec,source_purchase_price,position)
    SELECT ?,product_id,'CONFIRMED-OTHER',original_spec,normalized_spec,purchase_price,inventory,source_spec,source_purchase_price,position+1 FROM variants WHERE id=?`).run(other, f.draft.variantId);
  db.prepare('UPDATE variant_assets SET confirmed=0 WHERE variant_id=?').run(f.draft.variantId);
  db.prepare('INSERT INTO variant_assets VALUES(?,?,1,?)').run(f.product.assets[0].id, other, new Date().toISOString()); db.close();
  assert.throws(() => f.create(), error=>(error as any).code==='SOURCE_CONSISTENCY_IDENTITY_INVALID'); assert.equal(f.uploadCalls, 0);
});

test('Haul cleanup saved before execution checkpoint resumes without stale hash or regenerated assets',async t=>{
  const f=await fixture(t),p=(f.amazon as any).persistence,r=p.record(f.draft.id);
  r.draft.listingProgram='haul';r.draft.attributes.item_name=[{value:'Plain storage bag',marketplace_id:r.draft.marketplaceId}];r.draft.attributes.brand=[{value:'Generic',marketplace_id:r.draft.marketplaceId}];r.draft.attributes.is_value_stores_item=[{value:true,marketplace_id:r.draft.marketplaceId}];r.draft.attributes.purchasable_offer[0].audience='BZR';r.draft.attributes.merchant_suggested_asin=[];
  r.draft.schema.schema.properties.is_value_stores_item={type:'array',items:{type:'object',properties:{value:{type:'boolean'},marketplace_id:{type:'string'}},required:['value']}};await seedAuthorityHaulPricing(f,r.draft);p.putRecord(r);
  f.amazon.getSchema=async()=>structuredClone(r.draft.schema);
  const task=f.create(),assets=structuredClone(task.items[0].assets),save=f.amazon.saveDraft.bind(f.amazon);let once=true;
  f.amazon.saveDraft=input=>{const result=save(input);if(once){once=false;throw Error('synthetic crash after save');}return result;};
  f.start(task.id);await f.service.waitForIdle();assert.equal(f.uploadCalls,0);assert.equal(f.amazon.getDraft(f.draft.id).attributes.merchant_suggested_asin,undefined);
  await f.reopen();f.start(task.id);await f.service.waitForIdle();
  const done=f.service.get(task.id);assert.equal(done.status,'COMPLETED',JSON.stringify(f.amazon.getDraft(f.draft.id).localIssues));assert.deepEqual(done.items[0].assets,assets);assert.equal(f.uploadCalls,1);
});

test('Haul field omission reaches preview after hosting and does not fail before upload',async t=>{
  const f=await fixture(t),p=(f.amazon as any).persistence,r=p.record(f.draft.id);
  r.draft.listingProgram='haul';r.draft.attributes.item_name=[{value:'Plain storage bag',marketplace_id:r.draft.marketplaceId}];r.draft.attributes.brand=[{value:'Generic',marketplace_id:r.draft.marketplaceId}];delete r.draft.attributes.color;
  r.draft.attributes.is_value_stores_item=[{value:true,marketplace_id:r.draft.marketplaceId}];r.draft.attributes.purchasable_offer[0].audience='BZR';
  r.draft.schema.schema.properties.is_value_stores_item={type:'array',items:{type:'object',properties:{value:{type:'boolean'},marketplace_id:{type:'string'}},required:['value']}};await seedAuthorityHaulPricing(f,r.draft);p.putRecord(r);
  f.amazon.getSchema=async()=>structuredClone(r.draft.schema);
  const task=f.create();f.start(task.id);await f.service.waitForIdle();const result=f.service.get(task.id);
  assert.equal(f.uploadCalls,1);assert.equal(result.items[0].steps.find(s=>s.name==='validate')!.status,'DONE');assert.equal(result.items[0].steps.find(s=>s.name==='preview')!.status,'FAILED');assert.equal(result.items[0].submitStarted,false);
  assert.ok(f.amazon.getDraft(f.draft.id).previewIssues.some(i=>i.source==='demo'));
});

async function oldExecutionColor(t:test.TestContext,color='Cherry Blossom Pink'){
 const f=await fixture(t,{sourceSpec:'樱花粉'}),p=(f.amazon as any).persistence,r=p.record(f.draft.id);
 r.draft.attributes.color=[{value:color,marketplace_id:r.draft.marketplaceId}];r.previewResponse={raw:'historical platform reply'};p.putRecord(r);
 return {...f,p,fixture:f};
}
for(const color of ['Cherry Blossom Pink','Sakura'])test(`old execution ${color} migrates under owned scope and completes after upload`,async t=>{
 const {fixture:f}=await oldExecutionColor(t,color),task=f.create();
 f.start(task.id);await f.service.waitForIdle();const done=f.service.get(task.id);
 assert.equal(done.status,'COMPLETED',done.error??'');assert.equal((f.amazon.getDraft(f.draft.id).attributes.color as any)[0].value,'Pink');assert.equal(f.uploadCalls,1);assert.equal(done.items[0].intendedAttributesHash,null);
});

test('owned color write interrupted before execution checkpoint resumes without duplicate upload',async t=>{
 const {fixture:f,p}=await oldExecutionColor(t),task=f.create(),validate=f.amazon.validateDraft.bind(f.amazon);let once=true;
 f.amazon.validateDraft=async input=>{const result=await validate(input);if(once){once=false;throw Error('color write checkpoint interruption');}return result;};
 f.start(task.id);await f.service.waitForIdle();assert.equal(f.uploadCalls,0);assert.equal((f.amazon.getDraft(f.draft.id).attributes.color as any)[0].value,'Pink');assert.ok(f.service.get(task.id).items[0].intendedAttributesHash);assert.deepEqual(p.record(f.draft.id).previewResponse,{raw:'historical platform reply'});
 await f.reopen();f.start(task.id);await f.service.waitForIdle();assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(f.uploadCalls,1);
});

test('external draft edits are not adopted as owned color migration',async t=>{
 const {fixture:f}=await oldExecutionColor(t),task=f.create(),draft=f.amazon.getDraft(f.draft.id);
 f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,color:[{value:'Red',marketplace_id:draft.marketplaceId}]}});
 assert.throws(()=>f.start(task.id),/已变化/);assert.equal(f.uploadCalls,0);assert.equal((f.amazon.getDraft(draft.id).attributes.color as any)[0].value,'Red');
});

test('unknown execution submission never migrates old color or uploads again',async t=>{
 const {fixture:f,p}=await oldExecutionColor(t),task=f.create(),record=p.record(f.draft.id);
 record.unresolvedWrite=true;record.draft.state='UNKNOWN';p.putRecord(record);
 f.start(task.id);await f.service.waitForIdle();assert.equal((f.amazon.getDraft(f.draft.id).attributes.color as any)[0].value,'Cherry Blossom Pink');assert.equal(f.uploadCalls,0);assert.equal(f.amazon.listCalls().filter(c=>c.operation==='putListingsItem').length,0);
});

test('old color execution resumes past completed upload and image steps without uploading again',async t=>{
 const {fixture:f}=await oldExecutionColor(t),hosted=await f.hosting.upload({assetId:f.product.assets[0].id}),draft=f.amazon.getDraft(f.draft.id);
 f.amazon.saveDraft({id:draft.id,revision:draft.revision,attributes:{...draft.attributes,main_product_image_locator:[{media_location:hosted.publicUrl,marketplace_id:draft.marketplaceId}]}});
 const task=f.create(),stored=(f.service as any).tasks.get(task.id),item=stored.items[0];
 item.uploads=[{assetId:hosted.assetId,uploadId:hosted.id,sha256:hosted.sha256,publicUrl:hosted.publicUrl}];
 for(const step of item.steps)if(['upload','images'].includes(step.name)){step.status='DONE';step.attempts=1;}
 (f.service as any).save(stored);await f.reopen();f.start(task.id);await f.service.waitForIdle();
 const done=f.service.get(task.id);assert.equal(done.status,'COMPLETED',done.error??'');assert.equal(f.uploadCalls,1);assert.equal((f.amazon.getDraft(draft.id).attributes.color as any)[0].value,'Pink');assert.equal(done.items[0].steps.find(s=>s.name==='upload')!.attempts,1);
});

test('color execution migration preserves platform brand error and raw receipt for manual handling',async t=>{
 const {fixture:f,p}=await oldExecutionColor(t),record=p.record(f.draft.id),issue={code:'5882',source:'amazon',severity:'ERROR',attributeNames:['color'],category:'field',autoFixable:false,message:'Brand conflict'};
 record.draft.listingProgram='haul';record.draft.attributes.brand=[{value:'Generic',marketplace_id:record.draft.marketplaceId}];record.draft.previewIssues=[issue];record.previewResponse={issues:[issue],raw:'original payload'};p.putRecord(record);
 const task=f.create();f.start(task.id);await f.service.waitForIdle();const stopped=f.service.get(task.id);
 assert.equal(stopped.status,'NEEDS_ATTENTION');assert.match(stopped.error??'',/5882.*人工/);assert.equal(f.uploadCalls,0);assert.deepEqual(p.record(f.draft.id).previewResponse,{issues:[issue],raw:'original payload'});assert.deepEqual(f.amazon.getDraft(f.draft.id).previewIssues,[issue]);assert.equal((f.amazon.getDraft(f.draft.id).attributes.color as any)[0].value,'Pink');
 await f.reopen();f.start(task.id);await f.service.waitForIdle();assert.match(f.service.get(task.id).error??'',/人工/);assert.equal(f.uploadCalls,0);
});

test('combined Haul and color cleanup has one owned revision and keeps later execution in scope',async t=>{
 const {fixture:f,p}=await oldExecutionColor(t),r=p.record(f.draft.id);
 r.draft.listingProgram='haul';r.draft.attributes.item_name=[{value:'Plain storage bag',marketplace_id:r.draft.marketplaceId}];r.draft.attributes.brand=[{value:'Generic',marketplace_id:r.draft.marketplaceId}];r.draft.attributes.is_value_stores_item=[{value:true,marketplace_id:r.draft.marketplaceId}];r.draft.attributes.purchasable_offer[0].audience='BZR';r.draft.attributes.merchant_suggested_asin=[];
 r.draft.schema.schema.properties.is_value_stores_item={type:'array',items:{type:'object',properties:{value:{type:'boolean'},marketplace_id:{type:'string'}},required:['value']}};await seedAuthorityHaulPricing(f,r.draft);p.putRecord(r);f.amazon.getSchema=async()=>structuredClone(r.draft.schema);
 const task=f.create(),validate=f.amazon.validateDraft.bind(f.amazon);let first=true;
 f.amazon.validateDraft=async input=>{const result=await validate(input);if(first){first=false;assert.equal(result.revision,r.draft.revision+1);assert.equal(result.attributes.merchant_suggested_asin,undefined);assert.equal((result.attributes.color as any)[0].value,'Pink');}return result;};
 f.start(task.id);await f.service.waitForIdle();assert.equal(f.service.get(task.id).status,'COMPLETED',f.service.get(task.id).error??'');assert.equal(f.uploadCalls,1);
});
