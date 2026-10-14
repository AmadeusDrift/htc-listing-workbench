import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AmazonDraft, AmazonTarget } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import { ProcurementService } from '../src/main/procurement/service.ts';
import { procurementCsv, procurementHtml } from '../src/main/procurement/export.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { CatalogService } from '../src/main/catalog/service.ts';
import { FollowupService } from '../src/main/followup/service.ts';
import { installOperationsIpc } from '../src/main/operations-ipc.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { persistImport, getReceipt } from '../src/main/miaoshou/persistence.ts';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { detailFixture, mappingFor } from './helpers/miaoshou-fixture.ts';
import { demoDetail } from '../src/main/miaoshou/demo.ts';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { salesPurchaseComponents } from '../src/shared/sales-purchase.ts';
import type { ListingObservation } from '../src/shared/followup-contracts.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'htc-procurement-')), id = randomUUID(), variantId = randomUUID();
  const product = { id, title: '=未执行的公式', sourceUrl: 'https://detail.1688.com/offer/123456.html', revision: 1, origin: 'import', assets: [], facts: [],
    variants: [{ id: variantId, sku: 'HTC-ONE', originalSpec: '蓝色 <script>alert(1)</script>', sourceSpec: '蓝色', normalizedSpec: '', purchasePrice: '2.50', sourcePurchasePrice: '2.50', inventory: 999 }] } as unknown as ProductDetail;
  const draft = { id: randomUUID(), productId: id, productRevision: 1, variantId, sku: 'HTC-ONE', targetId: 'u2', targetName: 'U2', sellerId: 'seller', marketplaceId: 'ATVPDKIKX0DER', mode: 'live', listingProgram: 'haul',
    state: 'PROCESSING', schema: { parentageLevel: 'NONE' }, submittedAt: '2026-10-07T00:00:00.000Z', checkedAt: '2026-10-07T00:30:00.000Z', statuses: [], listingIssues: [], updatedAt: '2026-10-07T00:30:00.000Z' } as unknown as AmazonDraft;
  const target = { id: 'u2', mode: 'live', sellerId: 'seller', marketplaceId: 'ATVPDKIKX0DER' } as AmazonTarget;
  const observation = { draftId: draft.id, targetId: 'u2', sellerId: 'seller', marketplaceId: 'ATVPDKIKX0DER', sku: 'HTC-ONE', checkedAt: draft.checkedAt!, requestId: null, asin: 'B012345678', fnsku: null, statuses: [], issues: [] };
  const store = { listProducts: () => [{ id }], getProduct: () => product, getProductSnapshot: () => product };
  const amazon = { listDrafts: () => [draft], getDraft: () => draft, getTarget: () => target, getListingObservation: () => observation };
  return { dir, product, draft, target, observation, store, amazon };
}

test('procurement candidate reads never repair product source bindings', () => {
  const f=fixture(),baseline=new ProcurementService(f.dir,f.store,f.amazon);
  const expected=baseline.candidates();baseline.close();
  let snapshotReads=0;
  const store={...f.store,getProduct:()=>{throw Error('candidate query must not repair image history');},getProductSnapshot:()=>{snapshotReads++;return f.product;}};
  const service=new ProcurementService(f.dir,store,f.amazon);
  try {assert.deepEqual(service.candidates(),expected);assert.equal(snapshotReads,1);}
  finally {service.close();}
});

test('candidate sweep shares a product snapshot across SKUs but refreshes it for the next sweep', () => {
  const f=fixture(),secondVariant={...f.product.variants[0],id:randomUUID(),sku:'HTC-TWO'};
  f.product.variants.push(secondVariant);
  const drafts=[f.draft,{...f.draft,id:randomUUID(),variantId:secondVariant.id,sku:secondVariant.sku,state:'UNKNOWN' as const}];
  const amazon={...f.amazon,listDrafts:()=>drafts,getListingObservation:(id:string)=>({...f.observation,draftId:id,sku:drafts.find(draft=>draft.id===id)!.sku})};
  const baseline=new ProcurementService(f.dir,f.store,amazon),expected=baseline.candidates();baseline.close();
  let reads=0;
  const read=()=>{reads++;return structuredClone(f.product);};
  const store={...f.store,getProduct:read,getProductSnapshot:read},service=new ProcurementService(f.dir,store,amazon);
  try {
    assert.deepEqual(service.candidates(),expected);assert.equal(reads,1,'one snapshot per product, not per draft');
    f.product.revision++;f.product.variants[0].purchasePrice='3.75';
    const refreshed=service.candidates();assert.equal(reads,2,'cache must end with each sweep');
    assert.equal(refreshed[0].sourcePurchasePrice,'3.75');assert.equal(refreshed[0].basis?.productRevision,2);
    assert.equal(refreshed[1].eligible,false);assert.equal(refreshed[1].requiresAttention,true);
  } finally {service.close();}
});

test('manual price changes invalidate confirmation and retain the previous procurement revision', () => {
  const f=fixture(),service=new ProcurementService(f.dir,f.store,f.amazon);
  try {
    const first=service.create({name:'revision',draftIds:[f.draft.id]});
    const edit=(batch:typeof first,purchasePrice:string)=>service.update({id:batch.id,revision:batch.revision,lines:batch.lines.map(({id,purchaseQuantity,stockQuantity,purchaseUnit})=>({id,purchaseQuantity,stockQuantity,purchaseUnit,purchasePrice,priceConfirmed:true})),shipmentConfirmationId:''});
    const confirmed=edit(first,'2.50'),changed=edit(confirmed,'3.00');
    assert.equal(changed.lines[0].priceConfirmed,false);
    assert.equal(f.product.variants[0].purchasePrice,'2.50');
    const db=openDatabase(f.dir);
    try { const rows=db.prepare("SELECT * FROM audit_events WHERE action='procurement.revised'").all();assert.equal(rows.length,2);assert.equal(JSON.parse(String(rows[1].detail_json)).previous.lines[0].purchasePrice,'2.50'); } finally {db.close();}
  } finally {service.close();}
});
test('catalog-confirmed products can enter procurement before buyable; counts are never taken from supplier stock', () => {
  const f = fixture(), service = new ProcurementService(f.dir, f.store, f.amazon);
  const candidate = service.candidates()[0]; assert.equal(candidate.eligible, true);
  const batch = service.create({ name: '首批备货', draftIds: [f.draft.id] });
  assert.equal(batch.lines[0].sourceUrl, f.product.sourceUrl);
  assert.equal(batch.lines[0].stockQuantity, null); assert.equal(batch.lines[0].purchaseQuantity, null);
  assert.equal(batch.lines[0].labelStatus, 'NOT_REQUESTED'); assert.equal(batch.lines[0].asin, 'B012345678');
  assert.equal(batch.lines[0].basis?.productRevision,1);
  assert.match(batch.lines[0].basis?.observationHash ?? '',/^[a-f0-9]{64}$/);
  service.close();
  const reopened = new ProcurementService(f.dir, f.store, f.amazon); assert.deepEqual(reopened.get(batch.id), batch); reopened.close();
});

test('mixed sales recipe expands into supplier pieces while stock and labels remain sales sets',()=>{
  const f=fixture();f.product.title='普通收纳夹';
  f.product.variants=['红色','蓝色'].map((color,i)=>({...f.product.variants[0],id:i?randomUUID():f.product.variants[0].id,sku:`SOURCE-${i}`,purchasePrice:i?'0.2':'0.1',originalSpec:`颜色: ${color} / 尺寸: 小号`}));
  const recipe=buildSalesRecipes(f.product,null,defaultListingRules()).find(r=>r.components.length>1)!;
  f.draft.variantId=recipe.components[0].variantId;f.draft.sku='H2-261008-1-C';f.observation.sku=f.draft.sku;
  f.draft.salesPlan={namingGroupId:randomUUID(),sourceGroupKey:'test-source',collectedAt:'2026-10-08T01:00:00Z',collectionBasis:'first_import',sku:f.draft.sku,baseSku:'H2-261008-1',recipe,
    parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'测试独立销售组合',familyResolved:true,namingChildKey:recipe.key};
  const service=new ProcurementService(f.dir,f.store,f.amazon);
  try{
    const jobId=randomUUID(),batch=service.ensureAutomaticBatch(jobId,[f.draft.id],{[f.draft.id]:5})[0],line=batch.lines[0];
    assert.equal(line.stockQuantity,5);assert.equal(line.purchaseQuantity,5);assert.equal(line.purchasePrice,'1.5');
    const parts=salesPurchaseComponents(line.salesRecipe!,5);assert.deepEqual(parts.map(p=>p.pieces),[25,25]);assert.equal(parts.reduce((sum,p)=>sum+(p.costCny??0),0),7.5);
    assert.match(procurementCsv(batch),/25 件/);assert.match(procurementHtml(batch,new Map()),/拆包／混装/);
    assert.deepEqual(service.ensureAutomaticBatch(jobId,[f.draft.id],{[f.draft.id]:5})[0],batch);
  }finally{service.close();}
});

test('three-piece sale sent as ten sets exposes thirty pieces and original packs separately',()=>{
  const f=fixture(),recipe=buildSalesRecipes(f.product,null,defaultListingRules())[0];
  recipe.components[0].quantity=3;recipe.components[0].sourcePackPieces=12;recipe.totalPieces=3;recipe.totalCostCny=7.5;
  const [part]=salesPurchaseComponents(recipe,10);
  assert.equal(part.pieces,30);assert.equal(part.originalPacks,2.5);assert.equal(part.needsSplit,true);
});

test('a child with an ASIN still waits for its actual parent relationship before procurement',()=>{
  const f=fixture(),observation=f.observation as ListingObservation;
  const recipe=buildSalesRecipes(f.product,null,defaultListingRules())[0];
  f.draft.salesPlan={namingGroupId:randomUUID(),sourceGroupKey:'family',collectedAt:'2026-10-08T01:00:00Z',collectionBasis:'first_import',sku:f.draft.sku,baseSku:'PARENT',recipe,
    parentage:'CHILD',parentSku:'PARENT',variationTheme:'COLOR',relationReason:'Schema',familyResolved:true,namingChildKey:recipe.key};
  const service=new ProcurementService(f.dir,f.store,f.amazon);
  try{
    assert.equal(service.candidates()[0].eligible,false);assert.match(service.candidates()[0].reason,/父子体/);
    observation.familyRelationship={status:'MISMATCHED',parentSkus:['OTHER'],variationTheme:'COLOR'};assert.equal(service.candidates()[0].requiresAttention,true);
    observation.familyRelationship={status:'MATCHED',parentSkus:['PARENT'],variationTheme:'COLOR'};assert.equal(service.candidates()[0].eligible,true);
  }finally{service.close();}
});
test('parent, unknown write, blocking errors, changed identity and unsubmitted products cannot enter a batch', () => {
  const f = fixture(), service = new ProcurementService(f.dir, f.store, f.amazon);
  f.draft.schema.parentageLevel = 'PARENT'; assert.throws(() => service.create({ name: 'invalid', draftIds: [f.draft.id] }));
  f.draft.schema.parentageLevel = 'NONE'; f.draft.state = 'UNKNOWN'; assert.equal(service.candidates()[0].eligible, false);
  f.draft.state = 'PROCESSING'; f.target.sellerId = 'other'; assert.equal(service.candidates()[0].eligible, false);
  f.target.sellerId = 'seller'; f.draft.submittedAt = null; assert.equal(service.candidates()[0].eligible, false); service.close();
});

test('renamed or removed local SKU is marked for attention, not passive platform waiting', () => {
  const f = fixture(), service = new ProcurementService(f.dir, f.store, f.amazon);
  try {
    f.product.variants[0].sku = 'RENAMED';
    assert.equal(service.candidates()[0].eligible, false);
    assert.equal(service.candidates()[0].requiresAttention, true);
    f.product.variants = [];
    assert.equal(service.candidates()[0].requiresAttention, true);
  } finally { service.close(); }
});
test('batch edits are revision guarded, exports escape content and link the original item; shipment association is unverified', () => {
  const f = fixture(), service = new ProcurementService(f.dir, f.store, f.amazon);
  const first = service.create({ name: '供应商未命名也可以备货', draftIds: [f.draft.id] });
  const batch = service.update({ id: first.id, revision: first.revision, lines: [{ id: first.lines[0].id, purchaseQuantity: 200, stockQuantity: 20, purchasePrice: '2.50', purchaseUnit: '件', priceConfirmed: true }], shipmentConfirmationId: 'FBA123456789' });
  assert.equal(batch.lines[0].stockQuantity, 20); assert.equal(batch.shipment?.status, 'LINKED_UNVERIFIED');
  assert.throws(() => service.update({ id: first.id, revision: first.revision, lines: [], shipmentConfirmationId: '' }));
  assert.match(procurementCsv(batch), /'=未执行的公式/);
  const html = procurementHtml(batch, new Map()); assert.ok(html.includes('href="https://detail.1688.com/offer/123456.html"')); assert.ok(!html.includes('<script>alert'));
  assert.match(html, /未获取/); service.close();
});

test('stale observations cannot confirm a new submission, and unsent drafts do not hide a submitted SKU', () => {
  const f = fixture(), service = new ProcurementService(f.dir, f.store, f.amazon);
  f.observation.checkedAt = '2026-10-06T23:00:00.000Z'; f.draft.checkedAt = f.observation.checkedAt;
  assert.equal(service.candidates()[0].eligible, false);
  f.observation.checkedAt = '2026-10-07T00:30:00.000Z'; f.draft.checkedAt = f.observation.checkedAt;
  const fresh = { ...f.draft, id: randomUUID(), submittedAt: null, checkedAt: null, state: 'DRAFT' as const, updatedAt: '2026-10-08T00:00:00.000Z' };
  f.amazon.listDrafts = () => [f.draft, fresh];
  assert.equal(service.candidates()[0].draftId, f.draft.id);
  assert.throws(() => service.create({ name: 'stale', draftIds: [fresh.id] })); service.close();
});

test('high precision original prices leave the editable price pending instead of blocking or rounding a batch', () => {
  const f = fixture(); f.product.variants[0].purchasePrice = ''; f.product.variants[0].sourcePurchasePrice = '2.123456';
  const service = new ProcurementService(f.dir, f.store, f.amazon), batch = service.create({ name: '采购价待确认', draftIds: [f.draft.id] });
  assert.equal(batch.lines[0].purchasePrice, ''); assert.equal(batch.lines[0].priceConfirmed, false);
  assert.equal(f.product.variants[0].sourcePurchasePrice, '2.123456'); service.close();
});

test('actual Miaoshou demo source images do not prevent explicitly demo procurement', () => {
  const f = fixture(), store = new WorkspaceStore(f.dir), db = openDatabase(f.dir), at = new Date().toISOString();
  const snapshot = normalizeDetail(demoDetail('demo-single'), at, 'demo');
  const imported = persistImport(db, store, snapshot, mappingFor(snapshot), 'a'.repeat(64), 'demo', at), product = store.getProduct(imported.productId);
  const draft = { ...f.draft, mode: 'demo' as const, productId: product.id, variantId: product.variants[0].id, sku: product.variants[0].sku };
  const service = new ProcurementService(f.dir, store, { ...f.amazon, getTarget: () => ({ ...f.target, mode: 'demo' }), listDrafts: () => [draft], getListingObservation: () => ({ ...f.observation, sku: draft.sku }) });
  const batch = service.create({ name: '演示备货', draftIds: [draft.id] }); assert.equal(batch.mode, 'demo'); assert.match(procurementHtml(batch, new Map()), /本地演示/);
  service.close(); db.close(); store.close();
});

test('schema 14 encrypted backup retains procurement and catalog, but pauses restored followups', async () => {
  const f = fixture(), service = new ProcurementService(f.dir, f.store, f.amazon), batch = service.create({ name: '备货备份', draftIds: [f.draft.id] });
  const catalog = new CatalogService(f.dir, { getTarget: () => ({ ...f.target, locale: 'en_US' }), fetchProductTypeLibrary: async () => [{ name: 'COASTER', displayName: 'Coasters' }] });
  const library = await catalog.sync('u2'); await catalog.close(); service.close();
  const draft = { ...f.draft, targetId: randomUUID(), revision: 1, submissionId: 'submission-1' };
  const followup = new FollowupService(f.dir, { getDraft: () => draft, executionTargetScope: () => ({ target: { ...f.target, id: draft.targetId, configured: true, paused: false }, generation: 1 }), readListing: async () => { throw Error('no network'); } });
  followup.schedule(draft.id); await followup.close();
  const file = join(f.dir, 'operations.htcbackup'), target = join(f.dir, 'restored');
  await createWorkspaceBackup(f.dir, file, 'operations test password');
  await commitWorkspaceRestore(target, await prepareWorkspaceRestore(target, file, 'operations test password'));
  const db = openDatabase(target);
  try {
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT record_json FROM procurement_batches').get()!.record_json)), batch);
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT record_json FROM category_libraries').get()!.record_json)), library);
    const restored = JSON.parse(String(db.prepare('SELECT record_json FROM listing_followups').get()!.record_json));
    assert.equal(restored.status, 'NEEDS_ATTENTION'); assert.equal(restored.reason, 'TARGET_UNAVAILABLE'); assert.equal(restored.nextDueAt, null);
    assert.equal(restored.targetGeneration, 1);
  } finally { db.close(); }
});

test('legacy Miaoshou receipts with blank URL recover the exact purchase link without changing source fingerprints', () => {
  const f = fixture(), store = new WorkspaceStore(f.dir), db = openDatabase(f.dir), snapshot = normalizeDetail(detailFixture(), new Date().toISOString());
  snapshot.sources[0].sourceItemUrl = '';
  const imported = persistImport(db, store, snapshot, mappingFor(snapshot), 'a'.repeat(64), 'live', new Date().toISOString());
  const product = store.getProduct(imported.productId), before = getReceipt(db, product.id)!;
  const draft = { ...f.draft, productId: product.id, variantId: product.variants[0].id, sku: product.variants[0].sku };
  const service = new ProcurementService(f.dir, store, { ...f.amazon, listDrafts: () => [draft], getListingObservation: () => ({ ...f.observation, sku: draft.sku }) });
  const candidate = service.candidates()[0]; assert.equal(candidate.sourceUrl, 'https://detail.1688.com/offer/123456.html'); assert.equal(candidate.sourceUrlBasis, 'item-id');
  const batch = service.create({ name: '旧采集恢复链接', draftIds: [draft.id] }); assert.match(procurementCsv(batch), /https:\/\/detail.1688.com\/offer\/123456.html/);
  for (const wrong of ['https://detail.1688.com/offer/999999.html', 'https://detail.1688.com.evil.com/offer/123456.html']) {
    db.prepare('UPDATE products SET source_url=? WHERE id=?').run(wrong, product.id);
    assert.equal(service.candidates()[0].sourceUrl, 'https://detail.1688.com/offer/123456.html');
    assert.equal(service.candidates()[0].sourceUrlBasis, 'item-id');
  }
  assert.deepEqual(getReceipt(db, product.id), before); service.close(); db.close(); store.close();
});

test('export and source IPC use persisted row identities and cannot overwrite workspace data', async () => {
  const f = fixture(); f.product.assets = [{ id: randomUUID(), variantIds: [f.draft.variantId], role: 'main' }] as ProductDetail['assets'];
  const procurement = new ProcurementService(f.dir, f.store, f.amazon), batch = procurement.create({ name: 'IPC export', draftIds: [f.draft.id] });
  const catalog = new CatalogService(f.dir, { getTarget: () => ({ ...f.target, locale: 'en_US' }), fetchProductTypeLibrary: async () => [] });
  const followup = new FollowupService(f.dir, { getDraft: () => f.draft, executionTargetScope: () => ({ target: f.target, generation: 1 }), readListing: async () => f.draft });
  const handlers = new Map<string, (...args: unknown[]) => unknown>(); let destination = join(f.dir, 'cannot-overwrite.csv'), opened = '', preview: Buffer | null = null;
  installOperationsIpc(f.dir, { procurement, catalog, followup }, (name, _count, callback) => handlers.set(name, callback), {
    selectDestination: async () => ({ canceled: false, filePath: destination }), preview: async () => preview, openSource: async url => { opened = url; }, audit: () => {},
  });
  await assert.rejects(async () => handlers.get('red:procurement:export')!({ id: batch.id, format: 'csv' }), /数据文件夹/);
  destination = join(mkdtempSync(join(tmpdir(), 'htc-procurement-export-')), 'batch.csv');
  assert.deepEqual(await handlers.get('red:procurement:export')!({ id: batch.id, format: 'csv' }), { cancelled: false });
  assert.match(readFileSync(destination, 'utf8'), /https:\/\/detail.1688.com\/offer\/123456.html/);
  destination = destination.replace('.csv', '.html');
  await assert.rejects(async () => handlers.get('red:procurement:export')!({ id: batch.id, format: 'html' }), /第 1 行/);
  preview = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(65 * 1024)]);
  await assert.rejects(async () => handlers.get('red:procurement:export')!({ id: batch.id, format: 'html' }), /缩略图/);
  preview = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6gucAAAAASUVORK5CYII=', 'base64');
  await handlers.get('red:procurement:export')!({ id: batch.id, format: 'html' });
  assert.match(readFileSync(destination, 'utf8'), /data:image\/png;base64/); assert.ok(!readFileSync(destination, 'utf8').includes('图片未下载'));
  await handlers.get('red:procurement:source')!({ batchId: batch.id, lineId: batch.lines[0].id }); assert.equal(opened, batch.lines[0].sourceUrl);
  assert.throws(() => handlers.get('red:procurement:source')!({ batchId: batch.id, lineId: randomUUID() }));
  assert.throws(() => handlers.get('red:procurement:source')!({ batchId: batch.id, lineId: batch.lines[0].id, url: 'https://arbitrary.example.com' }));
  await followup.close(); await catalog.close(); procurement.close();
});
