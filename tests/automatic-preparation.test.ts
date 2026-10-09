import test from 'node:test';
import assert from 'node:assert/strict';
import type { AmazonDraft, AmazonTarget, PrepareAmazonDraftsInput } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import type { ImageWorkflowRun } from '../src/shared/image-workflow-contracts.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { createAutomaticPreparationPlan, plannedStockPieces, runAutomaticPreparation } from '../src/renderer/automatic-preparation.ts';
import type { AutomaticPreparationApi } from '../src/renderer/automatic-preparation.ts';

const target: AmazonTarget = { id: 'target', name: 'Synthetic target', mode: 'live', sellerId: 'seller', marketplaceId: 'ATVPDKIKX0DER', marketplaceName: 'US', region: 'na', locale: 'en_US', configured: true, paused: false, credentialUpdatedAt: null, lastError: null };
function product(id = 'product', count = 3): ProductDetail {
  return { id, title: `Product ${id}`, sourceUrl: '', description: '', status: 'draft', origin: 'manual', revision: 2, createdAt: '', updatedAt: '', facts: [], assets: [],
    variants: Array.from({ length: count }, (_, index) => ({ id: `${id}-variant-${index}`, sku: `${id}-SKU-${count - index}`, originalSpec: '', normalizedSpec: '', purchasePrice: '1', inventory: 99, sourceSpec: '', sourcePurchasePrice: '1' })) };
}
function draft(source: ProductDetail, index: number, patch: Partial<AmazonDraft> = {}): AmazonDraft {
  return { id: `draft-${source.variants[index].id}`, productId: source.id, productRevision: source.revision, variantId: source.variants[index].id, sku: source.variants[index].sku,
    targetId: target.id, targetName: target.name, sellerId: target.sellerId, marketplaceId: target.marketplaceId, mode: target.mode, revision: 1, listingProgram: 'haul',
    schema: { key: 'schema', targetId: target.id, productType: 'BAG', requirements: 'LISTING', parentageLevel: 'NONE', locale: target.locale, mode: target.mode,
      schema: {}, metaSchema: {}, checksum: 'checksum', version: 'version', propertyGroups: {}, fetchedAt: '', expiresAt: '', fromCache: true }, attributes: {},
    state: 'DRAFT', localIssues: [], previewIssues: [], listingIssues: [], statuses: [], submissionId: null, requestId: null, previewedAt: null, submittedAt: null, checkedAt: null, createdAt: '', updatedAt: '', events: [], ...patch };
}
function workflow(value: AmazonDraft, patch: Partial<ImageWorkflowRun> = {}): ImageWorkflowRun {
  return { id: `workflow-${value.id}`, draftId: value.id, productId: value.productId, productRevision: value.productRevision, variantId: value.variantId, sku: value.sku,
    status: 'COMPLETED', stage: 'complete', attempt: 1, maxAttempts: 2, contextSha256: 'a'.repeat(64), draftSha256: 'c'.repeat(64), referenceAssets: [], planResultIds: ['plan'], candidateIds: ['candidate'],
    ocrResultIds: ['ocr'], reviewResultIds: ['review'], approvedAssetId: 'approved', approvedSha256: 'b'.repeat(64), createdAt: '', updatedAt: '', error: null,
    slotPolicy:'seven-provisional-v1',slots:Array.from({length:7},(_,index)=>({index:index+1,purpose:index===0?'main':'detail',status:'PASSED',attempts:[],contextSha256:'a'.repeat(64),approvedAssetId:index===0?'approved':`approved-${index}`,approvedSha256:'b'.repeat(64),error:null})),...patch };
}
function fixture(sources: ProductDetail[], initial: AmazonDraft[] = []) {
  const saved = new Map(initial.map(value => [value.id, value]));
  const batches: PrepareAmazonDraftsInput[] = [], completed: string[] = [], cancelled: string[] = [];
  const sourceRequests: Parameters<AutomaticPreparationApi['prepareAutomaticProductSources']>[0][] = [], cancelledSources: string[] = [];
  const api: AutomaticPreparationApi = {
    async getImageRiskSettings(){return {enabled:true};},
    async saveImageRiskSettings(value){return value;},
    async getCopyReviewSettings(){return {enabled:true};},
    async saveCopyReviewSettings(value){return value;},
    async approveUnknownImageRetry(){throw Error('Unexpected unknown retry');},
    async getAutomaticImageCandidatePreview(){throw Error('Preparation must not read image previews');},
    async listAmazonDrafts(productId) { return [...saved.values()].filter(value => value.productId === productId); },
    async prepareAutomaticProductSources(input) {
      sourceRequests.push(structuredClone(input));
      return { product: structuredClone(sources.find(value => value.id === input.productId)!), missing: [] };
    },
    async cancelAutomaticProductSources(productId) { cancelledSources.push(productId); return { cancelled: true }; },
    async prepareAmazonDrafts(input) {
      batches.push(structuredClone(input));
      return { items: input.items.map(item => {
        const source = sources.find(value => value.id === item.productId)!;
        const value = draft(source, source.variants.findIndex(variant => variant.id === item.variantId), { productRevision: item.productRevision, listingProgram: input.listingProgram!, mode: input.listingProgram === 'haul' ? 'live' : 'demo' });
        saved.set(value.id, value);
        return { ...item, sku: value.sku, disposition: 'CREATED' as const, draft: value, issues: [], error: null };
      }) };
    },
    async completeAutomaticProduct(input) {
      completed.push(input.draftId);
      const value = { ...saved.get(input.draftId)!, revision: input.draftRevision + 1, state: 'AMAZON_VALIDATED' as const };
      saved.set(value.id, value);
      return { draft: value, aiCalls: 0, previewAttempts: 1, remaining: [], workflow: workflow(value) };
    },
    async getAutomaticProductProgress() { return null; },
    async cancelAutomaticProduct(id) { cancelled.push(id); return { cancelled: true }; },
  };
  const rules = defaultListingRules(); rules.product.variantLimit = 200;
  return { api, saved, batches, completed, cancelled, sourceRequests, cancelledSources, input: { plan: createAutomaticPreparationPlan(sources, rules), target, productType: 'BAG' } };
}

test('variant limits retain source order and omitted sources; stock is a separate bundle plan', async () => {
  const first = product('first', 4), second = product('second', 1), original = structuredClone([first, second]);
  const rules = defaultListingRules(); rules.product.variantLimit = 2; rules.product.stockSets = 5;
  const plan = createAutomaticPreparationPlan([first, second], rules);
  assert.deepEqual(plan.rows.map(row => row.sku), ['first-SKU-4', 'first-SKU-3', 'second-SKU-1']);
  assert.deepEqual(plan.products.map(value => [value.selected, value.omitted]), [[2, 2], [1, 0]]);
  assert.deepEqual([first, second], original);
  const f = fixture([first, second]); const rows = await runAutomaticPreparation(f.api, { ...f.input, plan });
  assert.equal(plannedStockPieces(rows[0]), null, 'no quote is not a confirmed piece plan');
  rows[0].draft!.businessRules = { revision: 0, fields: {}, notices: [], bundleQuantity: 4, quote: { price: 2, minimum: 1, roi: 2, deliveryFee: .5, commission: .3, upfrontCny: 2, dimensionalWeightGrams: 20, billableWeightGrams: 30, promotionPrice: null, promotionRoi: null } };
  assert.equal(plannedStockPieces(rows[0]), 20);
  rows[0].stockSets = 0; assert.equal(plannedStockPieces(rows[0]), 0);
});

test('preparation uses at most 50 items, completes sequentially, and never passes stock or inventory attributes', async () => {
  const source = product('many', 101), f = fixture([source]);
  let active = 0, peak = 0; const complete = f.api.completeAutomaticProduct;
  f.api.completeAutomaticProduct = async input => { active++; peak = Math.max(peak, active); await Promise.resolve(); const value = await complete(input); active--; return value; };
  const rows = await runAutomaticPreparation(f.api, f.input);
  assert.deepEqual(f.batches.map(batch => batch.items.length), [50, 50, 1]);
  assert.equal(peak, 1); assert.equal(rows.length, 101); assert.ok(rows.every(row => row.state === 'done'));
  assert.deepEqual(f.completed, source.variants.map(value => `draft-${value.id}`));
  assert.ok(f.batches.every(batch => batch.listingProgram === 'haul' && batch.parentageLevel === 'NONE' && batch.requirements === 'LISTING'));
  assert.ok(f.batches.every(batch => batch.items.every(item => Object.keys(item.attributes).length === 0)));
});

test('source images are prepared once per product before draft reuse, and refreshed revisions span all 50-item chunks', async () => {
  const source = product('source-download', 101), f = fixture([source], [draft(source, 0), draft(source, 75, { productRevision: 9 })]);
  const originalPlan = structuredClone(f.input.plan), calls: string[] = [], observed: string[] = [];
  const read = f.api.listAmazonDrafts, prepare = f.api.prepareAmazonDrafts, sync = f.api.prepareAutomaticProductSources;
  f.api.listAmazonDrafts = async id => { calls.push('read'); return read(id); };
  f.api.prepareAutomaticProductSources = async input => {
    calls.push('sources'); assert.equal(input.productRevision, 2);
    assert.deepEqual(input.variantIds, source.variants.map(variant => variant.id));
    const result = await sync(input); return { ...result, product: { ...result.product, revision: 9 } };
  };
  f.api.prepareAmazonDrafts = async input => { calls.push('drafts'); return prepare(input); };
  const rows = await runAutomaticPreparation(f.api, f.input, { onProgress: values => { observed.push(values[75].state); } });
  assert.deepEqual(calls, ['read', 'sources', 'drafts', 'drafts', 'drafts']);
  assert.equal(f.sourceRequests.length, 1);
  assert.ok(observed.includes('syncing'), 'source synchronization is visible even for later chunks');
  assert.ok(rows.every(row => row.productRevision === 9 && row.draft?.productRevision === 9 && row.state === 'done'));
  assert.ok(f.batches.every(batch => batch.items.every(item => item.productRevision === 9)));
  assert.equal(rows[0].reused, false, 'a draft from before the image download is stale');
  assert.equal(rows[75].reused, true, 'draft reuse is decided against the downloaded product revision');
  assert.deepEqual(f.input.plan, originalPlan, 'the caller plan stays immutable');
});

test('submitted and unknown SKUs are filtered before source preparation, including entirely submitted products', async () => {
  const first = product('all-submitted', 2), second = product('part-submitted', 3);
  const f = fixture([first, second], [draft(first, 0, { submittedAt: '2026-01-01' }), draft(first, 1, { state: 'UNKNOWN' }), draft(second, 1, { state: 'SUBMITTING' })]);
  const rows = await runAutomaticPreparation(f.api, f.input);
  assert.deepEqual(f.sourceRequests, [{ productId: second.id, productRevision: second.revision, variantIds: [second.variants[0].id, second.variants[2].id] }]);
  assert.deepEqual(rows.map(row => row.state), ['skipped', 'skipped', 'done', 'skipped', 'done']);
  assert.equal(f.completed.length, 2);
});

test('missing references block only affected SKUs before draft preparation or paid calls', async () => {
  const source = product('missing-reference', 52), f = fixture([source], [draft(source, 0), draft(source, 51)]), sync = f.api.prepareAutomaticProductSources;
  f.api.prepareAutomaticProductSources = async input => ({ ...await sync(input), missing: [
    { variantId: source.variants[0].id, message: '没有可用的来源图' }, { variantId: source.variants[51].id, message: '来源图片已失效' },
  ] });
  const rows = await runAutomaticPreparation(f.api, f.input);
  assert.equal(rows[0].state, 'blocked'); assert.match(rows[0].error!, /没有可用的来源图/);
  assert.equal(rows[51].state, 'blocked'); assert.match(rows[51].error!, /来源图片已失效/);
  assert.ok(rows.slice(1, 51).every(row => row.state === 'done'));
  assert.equal(f.sourceRequests.length, 1); assert.equal(f.completed.length, 50);
  assert.ok(f.batches.flatMap(batch => batch.items).every(item => ![source.variants[0].id, source.variants[51].id].includes(item.variantId)));
  assert.ok(f.completed.every(id => id !== `draft-${source.variants[0].id}` && id !== `draft-${source.variants[51].id}`));
});

test('source preparation failures are not retried across chunks and later products continue', async () => {
  const first = product('bad-source', 51), second = product('good-source', 1), f = fixture([first, second]);
  const sync = f.api.prepareAutomaticProductSources;
  f.api.prepareAutomaticProductSources = async input => { const result = await sync(input); if (input.productId === first.id) throw Error('来源下载失败'); return result; };
  const rows = await runAutomaticPreparation(f.api, f.input);
  assert.deepEqual(f.sourceRequests.map(value => value.productId), [first.id, second.id]);
  assert.ok(rows.slice(0, 51).every(row => row.state === 'failed' && row.error === '来源下载失败'));
  assert.equal(rows[51].state, 'done'); assert.equal(f.completed.length, 1);
});

test('cancelling a pending source download forwards cancellation once and starts no draft or paid work', async () => {
  const source = product('cancel-sources', 51), later = product('later', 1), f = fixture([source, later]), controller = new AbortController();
  let release!: () => void;
  f.api.cancelAutomaticProductSources = async id => { f.cancelledSources.push(id); release(); return { cancelled: true }; };
  const sync = f.api.prepareAutomaticProductSources;
  f.api.prepareAutomaticProductSources = async input => {
    const result = await sync(input), gate = new Promise<void>(resolve => { release = resolve; });
    controller.abort(); controller.abort(); await gate;
    return { ...result, product: { ...result.product, revision: 3 } };
  };
  const rows = await runAutomaticPreparation(f.api, f.input, { signal: controller.signal });
  assert.deepEqual(f.cancelledSources, [source.id]); assert.deepEqual(f.cancelled, []);
  assert.equal(f.sourceRequests.length, 1); assert.equal(f.batches.length, 0); assert.equal(f.completed.length, 0);
  assert.ok(rows.every(row => row.state === 'stopped')); assert.ok(rows.slice(0, 51).every(row => row.productRevision === 3));
});

test('fresh manual drafts are reused; stale or different categories are prepared; submitted and unknown listings are skipped', async () => {
  const source = product('reuse', 5);
  const manual = draft(source, 0, { attributes: { brand: [{ value: 'Kept manual brand' }] }, revision: 7 });
  const old = draft(source, 3, { productRevision: 1 });
  const otherCategory = draft(source, 4); otherCategory.schema.productType = 'OTHER';
  const f = fixture([source], [manual, draft(source, 1, { state: 'UNKNOWN' }), draft(source, 2, { targetId: 'target-alias', state: 'BLOCKED', submittedAt: '2026-01-01' }), old, otherCategory]);
  const rows = await runAutomaticPreparation(f.api, f.input);
  assert.deepEqual(rows.map(row => row.state), ['done', 'skipped', 'skipped', 'done', 'done']);
  assert.equal(rows[0].reused, true); assert.deepEqual(rows[0].draft!.attributes, manual.attributes);
  assert.deepEqual(f.batches[0].items.map(value => value.variantId), source.variants.slice(3).map(value => value.id));
  assert.equal(f.completed.length, 3);
});

test('item preparation errors and partial completion errors retain saved changes and continue with other SKUs', async () => {
  const source = product('failures', 3), f = fixture([source]); const prepare = f.api.prepareAmazonDrafts;
  f.api.prepareAmazonDrafts = async input => { const value = await prepare(input); value.items[0] = { ...value.items[0], disposition: 'REJECTED', draft: null, error: 'Needs source data' }; return value; };
  const complete = f.api.completeAutomaticProduct;
  f.api.completeAutomaticProduct = async input => {
    if (input.draftId.endsWith('variant-1')) { const value = f.saved.get(input.draftId)!; f.saved.set(value.id, { ...value, revision: 6, attributes: { brand: [{ value: 'Saved before failure' }] } }); throw new Error('Preview unavailable'); }
    return complete(input);
  };
  const rows = await runAutomaticPreparation(f.api, f.input);
  assert.deepEqual(rows.map(row => row.state), ['failed', 'failed', 'done']);
  assert.match(rows[0].error!, /Needs source data/); assert.match(rows[1].error!, /Preview unavailable/);
  assert.equal(rows[1].draft!.revision, 6); assert.deepEqual(rows[1].draft!.attributes.brand, [{ value: 'Saved before failure' }]);
});

test('failed draft reads and a failed preparation chunk do not stop later products or chunks', async () => {
  const first = product('unreadable', 1), second = product('readable', 51), f = fixture([first, second]);
  const read = f.api.listAmazonDrafts; f.api.listAmazonDrafts = async id => { if (id === first.id) throw new Error('Read unavailable'); return read(id); };
  const prepare = f.api.prepareAmazonDrafts; let calls = 0;
  f.api.prepareAmazonDrafts = async input => { if (++calls === 1) throw new Error('Schema unavailable'); return prepare(input); };
  const rows = await runAutomaticPreparation(f.api, f.input);
  assert.equal(rows[0].state, 'failed'); assert.match(rows[0].error!, /Read unavailable/);
  assert.ok(rows.slice(1, 50).every(row => row.state === 'failed'));
  assert.ok(rows.slice(50).every(row => row.state === 'done'));
});

test('cancel during preparation keeps saved drafts and stops completion and later chunks', async () => {
  const source = product('cancel-prepare', 51), f = fixture([source]), controller = new AbortController(); const prepare = f.api.prepareAmazonDrafts;
  f.api.prepareAmazonDrafts = async input => { const value = await prepare(input); controller.abort(); return value; };
  const rows = await runAutomaticPreparation(f.api, f.input, { signal: controller.signal });
  assert.equal(f.batches.length, 1); assert.equal(f.completed.length, 0); assert.equal(f.cancelled.length, 0);
  assert.ok(rows.every(row => row.state === 'stopped')); assert.ok(rows.slice(0, 50).every(row => row.draft));
});

test('cancel during an automatic request cancels its entire workflow once and does not start the next SKU', async () => {
  const source = product('cancel-complete', 2), f = fixture([source]), controller = new AbortController();
  let release!: () => void;
  f.api.cancelAutomaticProduct = async id => { f.cancelled.push(id); release(); return { cancelled: true }; };
  f.api.completeAutomaticProduct = async input => {
    f.completed.push(input.draftId); const gate = new Promise<void>(resolve => { release = resolve; });
    const value = f.saved.get(input.draftId)!; f.saved.set(value.id, { ...value, revision: 9 });
    controller.abort(); await gate; throw new Error('Cancelled automatic request');
  };
  const rows = await runAutomaticPreparation(f.api, f.input, { signal: controller.signal });
  assert.deepEqual(f.cancelled, [rows[0].draft!.id]); assert.equal(f.completed.length, 1);
  assert.deepEqual(rows.map(row => row.state), ['stopped', 'stopped']); assert.equal(rows[0].draft!.revision, 9);
});

test('an already cancelled run starts no work, and disabled targets cannot start', async () => {
  const source = product(), f = fixture([source]), controller = new AbortController(); controller.abort();
  const rows = await runAutomaticPreparation(f.api, f.input, { signal: controller.signal });
  assert.ok(rows.every(row => row.state === 'stopped')); assert.equal(f.batches.length, 0);
  await assert.rejects(runAutomaticPreparation(f.api, { ...f.input, target: { ...target, paused: true } }), /启用|暂停/);
  await assert.rejects(runAutomaticPreparation(f.api, { ...f.input, target: { ...target, configured: false } }), /配置|启用/);
});

test('demo runs use the standard program and preserve unresolved field results', async () => {
  const source = product('demo', 1), f = fixture([source]), complete = f.api.completeAutomaticProduct;
  f.api.completeAutomaticProduct = async input => ({ ...await complete(input), aiCalls: 2, previewAttempts: 3, remaining: ['需要确认 material'] });
  const rows = await runAutomaticPreparation(f.api, { ...f.input, target: { ...target, mode: 'demo' } });
  assert.equal(f.batches[0].listingProgram, 'standard'); assert.equal(rows[0].draft!.mode, 'demo');
  assert.deepEqual(rows[0].remaining, ['需要确认 material']); assert.equal(rows[0].aiCalls, 2); assert.equal(rows[0].previewAttempts, 3);
  assert.equal(rows[0].state, 'blocked'); assert.equal(rows[0].workflow?.status, 'COMPLETED', 'image completion remains distinct from unresolved listing fields');
});

test('only an adopted completed image workflow can finish a SKU; review rejection and interrupted steps stay blocked', async () => {
  const source = product('workflow-results', 5), f = fixture([source]), complete = f.api.completeAutomaticProduct;
  const results: Partial<ImageWorkflowRun>[] = [
    { status: 'BLOCKED', stage: 'reviewing', error: '图片文字含无事实依据的承诺', approvedAssetId: null, approvedSha256: null },
    { status: 'FAILED', stage: 'ocr', error: 'OCR unavailable', approvedAssetId: null, approvedSha256: null },
    { status: 'RUNNING', stage: 'generating', approvedAssetId: null, approvedSha256: null },
    { status: 'COMPLETED', stage: 'complete', approvedAssetId: null, approvedSha256: null },
    {},
  ];
  f.api.completeAutomaticProduct = async input => { const result = await complete(input); return { ...result, workflow: { ...result.workflow, ...results.shift() } }; };
  const rows = await runAutomaticPreparation(f.api, f.input);
  assert.deepEqual(rows.map(row => row.state), ['blocked', 'failed', 'blocked', 'blocked', 'done']);
  assert.match(rows[0].error!, /图片文字/); assert.equal(rows[1].workflow?.stage, 'ocr');
  assert.equal(rows[4].workflow?.approvedAssetId, 'approved');
});

test('in-flight automatic progress exposes the current stage and second image attempt before completion', { timeout: 5000 }, async () => {
  const source = product('progress', 1), f = fixture([source]), complete = f.api.completeAutomaticProduct;
  let release!: () => void, polls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.api.completeAutomaticProduct = async input => { await gate; return complete(input); };
  f.api.getAutomaticProductProgress = async id => {
    polls++;
    const current = workflow(f.saved.get(id)!, { status: 'RUNNING', stage: polls === 1 ? 'planning' : 'reviewing', attempt: polls, approvedAssetId: null, approvedSha256: null });
    if (polls === 2) setTimeout(release, 0);
    return current;
  };
  const observed: string[] = [];
  const rows = await runAutomaticPreparation(f.api, f.input, { onProgress: values => {
    const value = values[0]; if (value.workflow) observed.push(`${value.state}/${value.workflow.stage}/${value.workflow.attempt}`);
  } });
  assert.ok(observed.includes('completing/planning/1'));
  assert.ok(observed.includes('completing/reviewing/2'));
  assert.equal(rows[0].state, 'done'); assert.equal(rows[0].workflow?.stage, 'complete');
});

test('a workflow error refreshes its durable stage and retains saved draft edits', async () => {
  const source = product('durable-error', 1), f = fixture([source]);
  f.api.completeAutomaticProduct = async input => {
    const value = f.saved.get(input.draftId)!; f.saved.set(value.id, { ...value, revision: 8 });
    throw new Error('图片审核未通过');
  };
  f.api.getAutomaticProductProgress = async id => workflow(f.saved.get(id)!, { status: 'BLOCKED', stage: 'reviewing', attempt: 2, error: '图片文字仍与事实不符', approvedAssetId: null, approvedSha256: null });
  const rows = await runAutomaticPreparation(f.api, f.input);
  assert.equal(rows[0].state, 'blocked'); assert.equal(rows[0].draft?.revision, 8);
  assert.equal(rows[0].workflow?.attempt, 2); assert.match(rows[0].error!, /图片文字仍与事实不符/);
});

test('a late progress response cannot replace the final adopted workflow', async () => {
  const source = product('late-progress', 1), f = fixture([source]);
  let release!: (value: ImageWorkflowRun) => void;
  f.api.getAutomaticProductProgress = () => new Promise(resolve => { release = resolve; });
  const observed: string[] = [];
  const rows = await runAutomaticPreparation(f.api, f.input, { onProgress: values => { if (values[0].workflow) observed.push(values[0].workflow.stage); } });
  assert.equal(rows[0].state, 'done'); assert.equal(typeof release, 'function');
  release(workflow(rows[0].draft!, { status: 'RUNNING', stage: 'planning', approvedAssetId: null, approvedSha256: null }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows[0].workflow?.stage, 'complete'); assert.deepEqual(observed, ['complete']);
});
