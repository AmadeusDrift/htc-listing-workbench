import { sceneSet } from './fixtures/image-set.ts';
import { referenceMeasurementEvidence } from '../src/main/image-workflow/image-facts.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { importImageFiles } from '../src/main/assets.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { AiService } from '../src/main/ai/service.ts';
import { ListingAiService } from '../src/main/listing-ai/service.ts';
import { assertImageTextReview, imageRiskSourceSnapshot, validateProductImageContext } from '../src/main/ai/image-validation.ts';
import { validateAiResult } from '../src/main/ai/validation.ts';
import type { AiResult } from '../src/shared/ai-contracts.ts';
import type { CandidateImageIdentity, ImageTextReviewOutput, ProductImageContext } from '../src/shared/image-ai-contracts.ts';
import { PRODUCT_IMAGE_POLICY_VERSION } from '../src/shared/image-ai-contracts.ts';
import { openDatabase } from '../src/main/database.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { listingFingerprint } from '../src/main/listing-ai/validation.ts';
import { approvedWorkflowAsset, imageWorkflowDraftStamp, workflowRuns } from '../src/main/image-workflow/records.ts';
import { ImageWorkflowService } from '../src/main/image-workflow/service.ts';
import { ImageGenerationService } from '../src/main/image-generation/service.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { saveInput, mockStorage, chat } from './fixtures/listing-ai.ts';
import { LISTING_REVIEW_OUTPUT_RULES } from '../src/main/listing-ai/review-coverage.ts';
import { assertImageWorkflowHistory } from '../src/main/image-workflow/history.ts';
import type { AiCall } from '../src/shared/ai-contracts.ts';

const visualSummaryReview = JSON.parse(readFileSync(new URL('./fixtures/image-text-review-visual-summary.json', import.meta.url), 'utf8'));

const understanding = (payload: any) => ({ summary: 'A blue round coaster with a raised rim.', referenceAssetIds: payload.referenceImages.map((image: any) => image.assetId), uncertainties: ['Exact dimensions cannot be measured from the photo.'], sufficient: true });

function currentReview(payload: any) {
  return { kind: 'amazon-fields-review', verdict: 'PASS', checks: payload.candidate.candidates.flatMap((item: any) => item.items.map((value: any,index: number) => {
    const evidenceIds = payload.evidence.filter((evidence: any) => ['color','material'].includes(item.field) ? evidence.meaning === item.field : true).map((evidence: any) => evidence.id);
    return { field: item.field, index, verdict: 'SUPPORTED', evidenceIds, reason: 'Original evidence.', claims: [{ text: value.value, verdict: 'SUPPORTED', evidenceIds, reason: 'Original evidence.' }] };
  })), issues: [] };
}
async function fixture(t: test.TestContext, extraReference=false) {
  mkdirSync(resolve('.test-data'), { recursive: true });
  const directory = mkdtempSync(resolve('.test-data/image-ai-')), store = new WorkspaceStore(directory);
  let product = store.createProduct();
  product = store.saveProduct({ ...saveInput(product), title: 'Coaster', description:'Original brand illustration on the packaging.', variants: saveInput(product).variants.map(variant => ({ ...variant, originalSpec:'库洛米 蓝色', normalizedSpec: 'Blue' })), facts: [{ id: randomUUID(), name: 'Material', value: 'Silicone', source: 'manual', sourceRef: 'fixture', state: 'human_confirmed' }, {id:randomUUID(),name:'品牌',value:'三丽鸥',source:'1688',sourceRef:'fixture',state:'source_confirmed'}] });
  const bytes = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12); bytes.writeUInt32BE(256, 16); bytes.writeUInt32BE(256, 20);
  const source = join(directory, 'source.png'); writeFileSync(source, bytes);
  product = await importImageFiles(store, directory, { productId: product.id, revision: product.revision }, [source], value => value);
  product = store.updateAsset({ productId: product.id, revision: product.revision, assetId: product.assets[0].id, role: 'main', variantIds: [product.variants[0].id] });
  if (extraReference) {
    const second=Buffer.from(bytes); second[32]=1; const path=join(directory,'second.png'); writeFileSync(path,second);
    product=await importImageFiles(store,directory,{productId:product.id,revision:product.revision},[path],value=>value);
    const asset=product.assets.find(asset=>asset.role!=='main')!;
    product=store.updateAsset({productId:product.id,revision:product.revision,assetId:asset.id,role:'gallery',variantIds:[product.variants[0].id]});
  }
  const hosting = new HostingService(directory, store, mockStorage), amazon = new AmazonService(directory, id => store.getProduct(id), mockStorage), target = amazon.enableDemo();
  let draft = await amazon.createDraft({ productId: product.id, variantId: product.variants[0].id, targetId: target.id, productType: 'HTC_DEMO_STORAGE_BAG', parentageLevel: 'NONE', requirements: 'LISTING', locale: 'en_US' });
  draft = amazon.saveDraft({ id: draft.id, revision: draft.revision, attributes: { item_name: [{ value: 'Blue Silicone Coaster' }], material: [{ value: 'Silicone' }], color: [{ value: 'Blue' }] } });
  const requests: { operation: string; payload: any; body: any }[] = [];
  let respond: ((operation: string, payload: any) => Response | Promise<Response> | undefined) | undefined;
  const ai = new AiService(directory, store, hosting, mockStorage, { fetch: async (url,options) => {
    if (String(url).includes('green-cip.') || String(url).includes('.oss-cn-shanghai.')) {
      const operation = new Headers(options?.headers).get('x-acs-action') || 'ip-upload';
      const params = new URLSearchParams(Buffer.from(options!.body as Uint8Array).toString()), payload = operation === 'ImageModeration' ? JSON.parse(params.get('ServiceParameters')!) : null;
      requests.push({ operation, payload, body: null }); const custom = await respond?.(operation,payload); if (custom) return custom;
      if (operation === 'DescribeUploadToken') return new Response(JSON.stringify({ Code: 200, Data: { AccessKeyId: 'fixture-upload-id', AccessKeySecret: 'fixture-upload-secret', SecurityToken: 'fixture-upload-token', BucketName: 'oss-cip-shanghai', FileNamePrefix: 'upload/fixture/', OssInternetEndPoint: 'https://oss-cn-shanghai.aliyuncs.com', Expiration: Math.floor(Date.now()/1000)+1800 } }));
      if (operation === 'ip-upload') { assert.deepEqual(Buffer.from(options!.body as Uint8Array),bytes); return new Response(null,{status:200}); }
      if (operation === 'ImageModeration') return new Response(JSON.stringify({Code:200,RequestId:'fixture-ip-review',Data:{DataId:payload.dataId,RiskLevel:'none',Result:[{Label:'nonLabel',Description:'未检出风险'}]}}));
      throw Error('Unexpected moderation request');
    }
    const ocr = String(url).includes('ocr-api.'), body = ocr ? null : JSON.parse(String(options?.body)), content = body?.messages[1].content;
    const payload = ocr ? null : JSON.parse(Array.isArray(content) ? content[0].text : content), operation = ocr ? 'ocr' : payload.operation;
    requests.push({ operation, payload, body }); const custom = await respond?.(operation,payload); if (custom) return custom;
    if (ocr) return new Response(JSON.stringify({ Code: 'success', RequestId: 'ocr-fixture', Data: { Width: 256, Height: 256, Content: '', SubImageCount: 0, SubImages: [] } }));
    if (operation === 'listing-current-review') return chat(currentReview(payload));
    if (operation === 'image-plan') return chat({...(payload.setPolicy&&!payload.slot?{setPlan:sceneSet()}:{}), kind: 'image-plan', prompt: 'Preserve the selected SKU in supplied references on white, without added text.', textMode: 'none', expectedText: [], ipRisk:{verdict:'PASS',findings:[]}, productUnderstanding: understanding(payload) });
    if (operation === 'image-text-review') return chat({ verdict: 'PASS', checks: [], expectedTextChecks: [], noTextVerified: true, issues: [] });
    throw new Error('Unexpected provider request');
  } });
  ai.saveConnection({ id: 'deepseek', apiKey: 'image-fixture-deepseek-key' });
  ai.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-flash', enabled: true }); ai.saveFunctionSettings({ id: 'deepseek-review', model: 'deepseek-v4-pro', enabled: true });
  ai.importProfile({ id: 'aliyun-ocr', accessKeyId: 'image-fixture-key', accessKeySecret: 'image-fixture-secret' }); ai.setEnabled({ id: 'aliyun-ocr', enabled: true });
  ai.importProfile({ id: 'aliyun-image-risk', accessKeyId: 'image-fixture-key', accessKeySecret: 'image-fixture-secret' }); ai.setEnabled({ id: 'aliyun-image-risk', enabled: true });
  const cleanups:(()=>Promise<void>)[]=[];
  t.after(async () => { for(const cleanup of cleanups)await cleanup();await ai.close(); await hosting.close(); amazon.close(); store.close(); rmSync(directory,{ recursive:true, force:true }); });
  const listing = new ListingAiService(store, amazon, ai), reviewed = await listing.reviewCurrentForImages({ draftId: draft.id, draftRevision: draft.revision });
  const context: ProductImageContext = { listing: reviewed.context, currentListingCopy: reviewed.currentListingCopy, listingReviewResultId: reviewed.review.id, referenceAssets: product.assets.map(asset=>({assetId:asset.id,sha256:store.getAssetRecord(asset.id)!.sha256,variantId:product.variants[0].id})), purpose: 'main', policyVersion: PRODUCT_IMAGE_POLICY_VERSION,ipSource:imageRiskSourceSnapshot(product,product.variants[0].id) };
  const candidate: CandidateImageIdentity = { id: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex'), width: 256, height: 256 };
  return { directory, store, product, amazon, draft, ai, listing, context, candidate, bytes, requests, cleanup:(value:()=>Promise<void>)=>cleanups.push(value), respond: (value: typeof respond) => { respond = value; } };
}

test('image plan, candidate OCR and independent text review persist source-bound provenance and shared usage', async t => {
  const f = await fixture(t), fresh = () => {};
  const plan = await f.ai.imagePlan(f.context,fresh), ocr = await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,fresh), review = await f.ai.reviewGeneratedImage(f.context,plan,ocr,f.candidate,fresh);
  assert.deepEqual(f.requests.map(request => request.operation), ['listing-current-review','image-plan','ocr','image-text-review']);
  assert.deepEqual(review.sourceResultIds, [f.context.listingReviewResultId,plan.id,ocr.id]);
  assert.equal(ocr.assetId,null); assert.equal(ocr.output.kind,'generated-image-ocr'); assert.equal(review.output.kind,'image-text-review');
  assert.deepEqual(validateAiResult(review),review); assert.equal(f.ai.getUsageSummary('deepseek-review').attempts,2); assert.equal(f.ai.getUsageSummary('aliyun-ocr').processedImages,1);
  assert.equal(f.store.getProduct(f.product.id).revision,f.product.revision); assert.equal(f.amazon.getDraft(f.draft.id).revision,f.draft.revision);
  assert.ok(!JSON.stringify(f.requests[1].payload).includes(f.draft.targetId));
});

function withoutCopyReview(context: ProductImageContext): ProductImageContext {
  return { ...context, listingReviewResultId: null, copyReviewBypass: { policy: 'copy-review-disabled/v1', at: '2026-10-09T00:00:00.000Z', contextSha256: listingFingerprint(context.listing), copySha256: listingFingerprint(context.currentListingCopy) } };
}

test('image contexts accept only an explicit copy-review skip bound to the current listing and copy', async t => {
  const f = await fixture(t), context = withoutCopyReview(f.context);
  assert.deepEqual(validateProductImageContext(context), context);
  const bypass = context.copyReviewBypass!;
  for (const changed of [
    { ...context, copyReviewBypass: undefined },
    { ...context, listingReviewResultId: f.context.listingReviewResultId },
    { ...context, copyReviewBypass: { ...bypass, policy: 'ignored' } },
    { ...context, copyReviewBypass: { ...bypass, at: 'invalid-date' } },
    { ...context, copyReviewBypass: { ...bypass, contextSha256: '0'.repeat(64) } },
    { ...context, copyReviewBypass: { ...bypass, copySha256: '0'.repeat(64) } },
    { ...context, listing: { ...context.listing, sku: 'changed' } },
    { ...context, currentListingCopy: [{ field: 'item_name', values: ['Different copy'] }] },
    { ...context, policyVersion: 'product-image/vision-v2', ipSource: undefined },
  ]) assert.throws(() => validateProductImageContext(changed));
  assert.deepEqual(validateProductImageContext(f.context), f.context);
  assert.equal(listingFingerprint(validateProductImageContext(f.context)), listingFingerprint(f.context));
});

test('unreviewed image provenance omits review IDs while preserving plan, OCR and risk references', async t => {
  const f = await fixture(t), context = withoutCopyReview(f.context);
  const { writeCopyReviewSettings } = await import('../src/main/listing-ai/review-settings.ts');
  const db = openDatabase(f.directory);
  try { writeCopyReviewSettings(db, { enabled: false }); } finally { db.close(); }
  const before = f.requests.length;
  const plan = await f.ai.imagePlan(context, () => {});
  const ip = await f.ai.reviewGeneratedImageRisk(context, plan, f.candidate, f.bytes, () => {});
  const ocr = await f.ai.recognizeGeneratedImage(context, f.candidate, f.bytes, () => {});
  const review = await f.ai.reviewGeneratedImage(context, plan, ocr, f.candidate, () => {});
  assert.deepEqual(plan.sourceResultIds, []);
  assert.deepEqual(ip.sourceResultIds, [plan.id]);
  assert.deepEqual(ocr.sourceResultIds, []);
  assert.deepEqual(review.sourceResultIds, [plan.id, ocr.id]);
  assert.equal(f.requests.slice(before).some(request => request.operation === 'listing-current-review'), false);
  for (const result of [plan, ip, ocr, review]) {
    assert.deepEqual(validateAiResult(result), result);
    const extraIds = result.output.kind === 'image-plan' ? [randomUUID(), randomUUID()] : [f.context.listingReviewResultId, ...result.sourceResultIds];
    assert.throws(() => validateAiResult({ ...result, sourceResultIds: extraIds }));
  }
  const repair = await f.ai.imagePlan(context, () => {}, { previousPlanId: plan.id, issues: ['Improve the scene.'] });
  assert.deepEqual(repair.sourceResultIds, [plan.id]);
  const enabledDb = openDatabase(f.directory);
  try { writeCopyReviewSettings(enabledDb, { enabled: true }); } finally { enabledDb.close(); }
  const paidBefore = f.requests.length;
  await assert.rejects(f.ai.imagePlan(context, () => {}), (error: unknown) => error instanceof AiError && error.code === 'SOURCE_CHANGED');
  assert.equal(f.requests.length, paidBefore);
  assert.deepEqual(validateAiResult(review), review);
});

test('unreviewed seven-image history retains its own proof when later rechecked with copy review enabled', async t => {
  const f = await fixture(t); let images = 0;
  f.respond(operation => operation === 'ip-upload' ? new Response(null, { status: 200 }) : undefined);
  const generation = new ImageGenerationService(f.directory, f.store, mockStorage, { decodePreview: bytes => bytes, fetch: async () => {
    const bytes = Buffer.from(f.bytes); bytes[32] = ++images; return Response.json({ data: [{ b64_json: bytes.toString('base64') }] });
  } });
  generation.saveConnection({ model: 'gpt-image-2.5-sunburst', enabled: true, apiKey: 'fixture' });
  const workflow = new ImageWorkflowService(f.directory, f.store, f.amazon, f.ai, generation, { listing: {
    complete: async () => ({ draft: f.amazon.getDraft(f.draft.id), aiCalls: 0, previewAttempts: 0, remaining: [] }),
    reviewCurrentForImages: (input, signal) => f.listing.reviewCurrentForImages(input, signal),
    snapshotCurrentForImages: (input, signal) => f.listing.snapshotCurrentForImages(input, signal),
  } });
  f.cleanup(async () => { await workflow.close(); await generation.close(); });
  workflow.saveCopyReviewSettings({ enabled: false });
  const before = f.requests.length, first = await workflow.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
  assert.equal(first.workflow.status, 'COMPLETED', first.workflow.error ?? '');
  assert.equal(first.workflow.copyReviewEnabled, false);
  assert.equal(first.workflow.imageContext!.listingReviewResultId, null);
  assert.equal(f.requests.slice(before).some(request => request.operation === 'listing-current-review'), false);
  assert.equal(first.workflow.slots![0].attempts[0].reviewResultId !== null, true);
  assert.equal(first.workflow.slots!.every(slot => slot.attempts[0].ipReviewResultId !== null), true);
  const db = openDatabase(f.directory);
  try {
    const results = new Map(f.ai.listResults(f.product.id).filter(result => result.output.kind !== 'listing-current-review').map(result => [result.id, result]));
    const calls = new Map(db.prepare('SELECT record_json FROM ai_calls').all().map(row => { const call = JSON.parse(String(row.record_json)) as AiCall; return [call.id, call]; }));
    assert.doesNotThrow(() => assertImageWorkflowHistory(db, results, calls));
    const plan = results.get(first.workflow.slots![0].attempts[0].planResultId!)!;
    results.set(plan.id, { ...plan, sourceResultIds: [f.context.listingReviewResultId!] });
    assert.throws(() => assertImageWorkflowHistory(db, results, calls));
    results.set(plan.id, plan);
    results.delete(first.workflow.slots![0].attempts[0].ocrResultId!);
    assert.throws(() => assertImageWorkflowHistory(db, results, calls));
  } finally { db.close(); }
  workflow.saveCopyReviewSettings({ enabled: true });
  const current = f.amazon.getDraft(f.draft.id);
  const rechecked = await workflow.recheck({ draftId: current.id, draftRevision: current.revision, sourceWorkflowId: first.workflow.id });
  assert.equal(rechecked.workflow.status, 'COMPLETED', rechecked.workflow.error ?? '');
  assert.equal(rechecked.workflow.imageContext?.copyReviewBypass, undefined);
  assert.equal(rechecked.workflow.setPlanResultId, first.workflow.setPlanResultId);
  assert.equal(images, 7);
  const freshRecheck = workflow as unknown as { recheckWithFreshEvidence(input: unknown): ReturnType<ImageWorkflowService['recheck']> };
  const again = await freshRecheck.recheckWithFreshEvidence({ draftId: current.id, draftRevision: current.revision, sourceWorkflowId: rechecked.workflow.id });
  assert.equal(again.workflow.status, 'COMPLETED', again.workflow.error ?? '');
  assert.equal(again.workflow.setPlanResultId, first.workflow.setPlanResultId);
  await createWorkspaceBackup(f.directory, join(f.directory, 'copy-policy-history.htcbackup'), 'copy policy image history fixture passphrase');
});

test('text review sends explicit empty OCR items without planning descriptions', async t => {
  const f = await fixture(t);
  const context: ProductImageContext = { ...f.context, setPolicy: 'seven-product-v2', referenceMeasurements: [], setPlan: sceneSet(), slot: { index: 1, total: 7, provisional: true } };
  const plan = await f.ai.imagePlan(context, () => {}), ocr = await f.ai.recognizeGeneratedImage(context, f.candidate, f.bytes, () => {});
  const review = await f.ai.reviewGeneratedImage(context, plan, ocr, f.candidate, () => {});
  const request = f.requests.at(-1)!;
  assert.deepEqual(request.payload.reviewItems, []);
  assert.deepEqual(request.payload.unverifiedOcr, { text: '', lines: [] });
  assert.deepEqual(request.payload.plan, { textMode: 'none', expectedText: [] });
  assert.deepEqual(request.payload.slotBrief, { index: 1, role: 'main_scene' });
  for (const key of ['productUnderstanding', 'prompt', 'scene', 'ipRisk']) assert.ok(!JSON.stringify(request.payload).includes(`"${key}":`));
  assert.match(request.body.messages[0].content, /summary.*unverifiedOcr\.text/);
  assert.match(request.body.messages[0].content, /reviewItems.*empty.*checks.*\[\]/);
  assert.equal(review.output.kind, 'image-text-review');
  if (review.output.kind !== 'image-text-review') throw Error('Unexpected review');
  assert.equal(review.output.verdict, 'PASS'); assert.deepEqual(review.output.checks, []);
});

test('captured visual-summary response is rejected instead of dropping its extra OCR check', async t => {
  const f = await fixture(t);
  const context: ProductImageContext = { ...f.context, setPolicy: 'seven-product-v2', referenceMeasurements: [], setPlan: sceneSet(), slot: { index: 1, total: 7, provisional: true } };
  f.respond((operation, payload) => operation === 'image-plan' ? chat({ kind: 'image-plan', prompt: 'Use the selected product without text.', textMode: 'none', expectedText: [], ipRisk: { verdict: 'PASS', findings: [] }, productUnderstanding: { ...understanding(payload), summary: visualSummaryReview.checks[0].text } }) : operation === 'image-text-review' ? chat(visualSummaryReview) : undefined);
  const plan = await f.ai.imagePlan(context, () => {}), ocr = await f.ai.recognizeGeneratedImage(context, f.candidate, f.bytes, () => {});
  assert.equal(ocr.output.kind, 'generated-image-ocr');
  if (ocr.output.kind !== 'generated-image-ocr' || plan.output.kind !== 'image-plan') throw Error('Unexpected result');
  assert.equal(ocr.output.text, ''); assert.deepEqual(ocr.output.lines, []);
  assert.equal(visualSummaryReview.checks[0].text, plan.output.productUnderstanding!.summary);
  await assert.rejects(f.ai.reviewGeneratedImage(context, plan, ocr, f.candidate, () => {}), (error: unknown) => error instanceof AiError && error.code === 'OUTPUT_INVALID');
  assert.equal(f.ai.listResults(f.product.id).some(result => result.output.kind === 'image-text-review'), false);
  assert.equal(f.requests.filter(request => request.operation === 'image-text-review').length, 1);
});

test('text review enumerates the exact OCR summary and every nonempty original line', async t => {
  const f = await fixture(t);
  const context: ProductImageContext = { ...f.context, setPolicy: 'seven-product-v2', referenceMeasurements: [], setPlan: sceneSet(), slot: { index: 1, total: 7, provisional: true } };
  const items = [{ source: 'summary', index: 0, text: 'CCV(O SPP ' }, { source: 'line', index: 0, text: 'CCV(O' }, { source: 'line', index: 2, text: 'SPP' }];
  const output = { verdict: 'NEEDS_CHANGES', checks: items.map(item => ({ ...item, verdict: 'UNSUPPORTED', evidenceIds: [], reason: 'Unexpected text on a text-free main image.' })), expectedTextChecks: [], noTextVerified: false, issues: ['Remove the unwanted OCR text.'] };
  f.respond(operation => operation === 'ocr' ? Response.json({ Code: 'success', Data: { Width: 256, Height: 256, Content: 'CCV(O SPP ', SubImageCount: 1, SubImages: [{ SubImageId: 0, BlockInfo: { BlockCount: 3, BlockDetails: ['CCV(O', '', 'SPP'].map((text, index) => ({ BlockId: index, BlockContent: text, BlockConfidence: 55 })) } }] } }) : operation === 'image-text-review' ? chat(output) : undefined);
  const plan = await f.ai.imagePlan(context, () => {}), ocr = await f.ai.recognizeGeneratedImage(context, f.candidate, f.bytes, () => {});
  const review = await f.ai.reviewGeneratedImage(context, plan, ocr, f.candidate, () => {});
  assert.deepEqual(f.requests.at(-1)!.payload.reviewItems, items);
  assert.deepEqual(f.requests.at(-1)!.payload.unverifiedOcr, { text: 'CCV(O SPP ', lines: [{ text: 'CCV(O' }, { text: '' }, { text: 'SPP' }] });
  if (review.output.kind !== 'image-text-review') throw Error('Unexpected review');
  assert.equal(review.output.verdict, 'NEEDS_CHANGES'); assert.equal(review.output.checks[0].text, 'CCV(O SPP ');
  f.respond(operation => operation === 'image-text-review' ? chat({ ...output, checks: output.checks.slice(1) }) : undefined);
  await assert.rejects(f.ai.reviewGeneratedImage(context, plan, ocr, f.candidate, () => {}), (error: unknown) => error instanceof AiError && error.code === 'OUTPUT_INVALID');
});

test('current-copy review uses the shared item and claim verdict contract', async t => {
  const f = await fixture(t);
  assert.ok(f.requests[0].body.messages[0].content.includes(LISTING_REVIEW_OUTPUT_RULES));
});

test('set planning states the existing dimension reason, unit and numeric evidence bounds', async t => {
  const f = await fixture(t);
  await f.ai.imagePlan({ ...f.context, setPolicy: 'seven-product-v2', referenceMeasurements: [] }, () => {});
  const system = f.requests.at(-1)!.body.messages[0].content;
  assert.match(system, /dimensionReason<=1000/);
  assert.match(system, /cm, mm, in, or inches/);
  assert.match(system, /double-quote inch symbols/);
  assert.match(system, /camera lenses, background props, or excluded unknown dimensions.*qualitatively/);
});

test('current-copy review reports omitted wording without granting image planning approval', async t => {
  const f = await fixture(t);
  f.respond((operation, payload) => {
    if (operation !== 'listing-current-review') return undefined;
    const review = currentReview(payload);
    const check = review.checks.find((c: any) => c.field === 'item_name');
    check.claims[0].text = check.claims[0].text.split(' ')[0];
    return chat(review);
  });
  const review = await f.ai.reviewCurrentListing(f.context.listing, f.context.currentListingCopy, async () => {});
  assert.equal(review.output.kind, 'listing-current-review');
  if (review.output.kind !== 'listing-current-review') throw Error('Unexpected review');
  assert.equal(review.output.verdict, 'NEEDS_CHANGES');
  assert.deepEqual(validateAiResult(review), review);
  await assert.rejects(f.ai.imagePlan({ ...f.context, listingReviewResultId: review.id }, () => {}));
  assert.equal(f.requests.length, 2);
});

test('printed reference dimensions retain original OCR provenance and cannot be forged or moved to another image',async t=>{
  const f=await fixture(t);
  f.respond((operation,payload)=>{
    if(operation==='ocr')return Response.json({Code:'success',Data:{Width:256,Height:256,Content:'Diameter 8 cm',SubImageCount:1,SubImages:[{SubImageId:0,BlockInfo:{BlockCount:1,BlockDetails:[{BlockId:0,BlockContent:'Diameter 8 cm',BlockConfidence:99}]}}]}});
    if(operation==='image-plan'){
      const set=sceneSet(),id=payload.referenceMeasurements[0].id;
      set.dimensionEvidenceIds=[id];set.dimensionReason='Printed diameter confirmed against the attached product image.';
      set.slots[6]={...set.slots[6],role:'dimensions',focus:'Product diameter',evidenceIds:[id],textMode:'planned',expectedText:[{text:'Diameter 8 cm',evidenceIds:[id]}]};
      return chat({kind:'image-plan',prompt:'A tabletop scene.',textMode:'none',expectedText:[],productUnderstanding:understanding(payload),ipRisk:{verdict:'PASS',findings:[]},setPlan:set});
    }
  });
  const ocr=await f.ai.recognize({productId:f.product.id,productRevision:f.product.revision,assetId:f.product.assets[0].id});
  const context:ProductImageContext={...f.context,setPolicy:'seven-product-v2',referenceMeasurements:referenceMeasurementEvidence(ocr)};
  const planned=await f.ai.imagePlan(context,()=>{});assert.equal(planned.output.kind,'image-plan');
  assert.equal(planned.output.kind==='image-plan'&&planned.output.setPlan?.slots[6].role,'dimensions');
  const before=f.requests.length,forged=structuredClone(context);forged.referenceMeasurements![0].text='Diameter 80 cm';
  await assert.rejects(f.ai.imagePlan(forged,()=>{}));assert.equal(f.requests.length,before);
  forged.referenceMeasurements![0].assetId=randomUUID();await assert.rejects(f.ai.imagePlan(forged,()=>{}));assert.equal(f.requests.length,before);
  assert.equal(f.store.getProduct(f.product.id).facts.some(fact=>fact.value.includes('8 cm')),false);
  await createWorkspaceBackup(f.directory,join(f.directory,'reference-dimension.htcbackup'),'source reference measurement backup passphrase');
});
test('seven images through production AI adapters retain auditable slot provenance across backup and restore',async t=>{
  const f=await fixture(t);let imageCount=0;
  f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{const bytes=Buffer.from(f.bytes);bytes[32]=++imageCount;return new Response(JSON.stringify({data:[{b64_json:bytes.toString('base64')}]}));}});
  generation.saveConnection({model:'gpt-image-2.5-sunburst',enabled:true,apiKey:'test-only'});
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{complete:async()=>({draft:f.draft,aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
  f.cleanup(async()=>{await workflow.close();await generation.close();});
  const result=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(result.workflow.status,'COMPLETED',result.workflow.error??'');
  assert.equal(imageCount,7);const requests=f.requests.filter(item=>item.operation==='image-plan');assert.deepEqual(requests.map(item=>item.payload.slot?.index),[undefined,1,2,3,4,5,6,7]);
  const backup=join(f.directory,'seven.htcbackup'),target=join(f.directory,'seven-restored');await createWorkspaceBackup(f.directory,backup,'seven images backup test passphrase');
  await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,backup,'seven images backup test passphrase'));
  const restored=openDatabase(target);try{assert.equal(workflowRuns(restored,f.draft.id)[0].slots!.filter(slot=>slot.status==='PASSED').length,7);}finally{restored.close();}
});

test('a saved generated candidate resumes only its missing text review after invalid output and restart', async t => {
  const f = await fixture(t); let imageCount = 0, rejectReview = true;
  f.respond(operation => {
    if (operation === 'ip-upload') return new Response(null, { status: 200 });
    if (operation === 'image-text-review' && rejectReview) { rejectReview = false; return chat(visualSummaryReview); }
  });
  const generation = new ImageGenerationService(f.directory, f.store, mockStorage, { decodePreview: bytes => bytes, fetch: async () => {
    const bytes = Buffer.from(f.bytes); bytes[32] = ++imageCount;
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }] });
  } });
  generation.saveConnection({ model: 'gpt-image-2.5-sunburst', enabled: true, apiKey: 'test-only' });
  const options = { listing: { complete: async () => ({ draft: f.draft, aiCalls: 0, previewAttempts: 0, remaining: [] }), reviewCurrentForImages: (input: Parameters<ListingAiService['reviewCurrentForImages']>[0], signal?: AbortSignal) => f.listing.reviewCurrentForImages(input, signal) } };
  const workflow = new ImageWorkflowService(f.directory, f.store, f.amazon, f.ai, generation, options);
  f.cleanup(async () => { await workflow.close(); await generation.close(); });
  const first = await workflow.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
  assert.equal(first.workflow.status, 'FAILED'); assert.equal(first.workflow.stage, 'reviewing'); assert.equal(imageCount, 1);
  const saved = first.workflow.slots![0].attempts[0];
  assert.equal(saved.state, 'GENERATED'); assert.ok(saved.candidateId); assert.ok(saved.ipReviewResultId); assert.ok(saved.ocrResultId); assert.equal(saved.reviewResultId, null);
  const requestCount = f.requests.length;
  await workflow.close();
  const restarted = new ImageWorkflowService(f.directory, f.store, f.amazon, f.ai, generation, options);
  f.cleanup(() => restarted.close());
  const resumed = await restarted.complete({ draftId: f.draft.id, draftRevision: f.draft.revision });
  assert.equal(resumed.workflow.status, 'COMPLETED', resumed.workflow.error ?? ''); assert.equal(resumed.workflow.id, first.workflow.id);
  assert.equal(f.requests[requestCount].operation, 'image-text-review');
  const kept = resumed.workflow.slots![0].attempts[0];
  for (const key of ['requestId', 'planResultId', 'candidateId', 'ipReviewResultId', 'ocrResultId'] as const) assert.equal(kept[key], saved[key]);
  assert.ok(kept.reviewResultId); assert.equal(resumed.workflow.slots![0].attempts.length, 1);
  assert.equal(imageCount, 7); assert.equal(f.requests.filter(item => item.operation === 'ImageModeration').length, 7);
  assert.equal(f.requests.filter(item => item.operation === 'ocr').length, 2); // One source OCR plus the main image.
  assert.equal(f.requests.filter(item => item.operation === 'image-text-review').length, 2);
});

test('a source-image size, feature captions and optional scene copy survive the full seven-image pipeline and recheck',async t=>{
  const f=await fixture(t);let imageCount=0;let slot:ReturnType<typeof sceneSet>['slots'][number]|undefined;
  f.respond((operation,payload)=>{
    if(operation==='ip-upload')return new Response(null,{status:200});
    if(operation==='image-plan'){
      const set=payload.frozenSetPlan??sceneSet();
      if(!payload.slot){
        const sizeId=payload.referenceMeasurements[0].id,material=payload.evidence.find((e:any)=>e.meaning==='material').id;
        set.dimensionEvidenceIds=[sizeId];set.dimensionReason='Printed product diameter, read from original reference.';
        set.slots[1]={...set.slots[1],role:'selling_point',focus:'Silicone material',evidenceIds:[material],textMode:'planned',expectedText:[{text:'Silicone',evidenceIds:[material]}]};
        set.slots[2]={...set.slots[2],textMode:'planned',expectedText:[{text:'A quiet moment',evidenceIds:[]}]};
        set.slots[6]={...set.slots[6],role:'dimensions',focus:'Product diameter',evidenceIds:[sizeId],textMode:'planned',expectedText:[{text:'Diameter 8 cm',evidenceIds:[sizeId]}]};
      }
      slot=set.slots[(payload.slot?.index??1)-1];
      return chat({kind:'image-plan',productUnderstanding:{...understanding(payload),summary:'A round coaster. Printed diameter 8 cm.'},ipRisk:{verdict:'PASS',findings:[]},prompt:slot!.prompt,textMode:slot!.textMode,expectedText:slot!.expectedText,...(!payload.slot?{setPlan:set}:{})});
    }
    if(operation==='ocr'){
      const text=imageCount?slot!.expectedText.map(item=>item.text).join(' '):'Diameter 8 cm';
      return Response.json({Code:'success',Data:{Width:256,Height:256,Content:text,SubImageCount:text?1:0,SubImages:text?[{SubImageId:0,BlockInfo:{BlockCount:1,BlockDetails:[{BlockId:0,BlockContent:text,BlockConfidence:99}]}}]:[]}});
    }
    if(operation==='image-text-review'){
      const text=payload.unverifiedOcr.text,evidenceIds=[...new Set(payload.plan.expectedText.flatMap((line:any)=>line.evidenceIds))];
      return chat({verdict:'PASS',checks:text?[{source:'summary',index:0,text,verdict:'SUPPORTED',evidenceIds,reason:'Matches planned supported text.'},{source:'line',index:0,text,verdict:'SUPPORTED',evidenceIds,reason:'Matches planned supported text.'}]:[],expectedTextChecks:payload.plan.expectedText.map((_line:any,index:number)=>({index,present:true,reason:'Same meaning.'})),noTextVerified:!text,issues:[]});
    }
  });
  const prompts:string[]=[];
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async(_url,init)=>{prompts.push(String(init?.body));const bytes=Buffer.from(f.bytes);bytes[32]=++imageCount;return Response.json({data:[{b64_json:bytes.toString('base64')}]});}});
  generation.saveConnection({model:'gpt-image-2.5-sunburst',enabled:true,apiKey:'test-only'});
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{complete:async()=>({draft:f.draft,aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
  f.cleanup(async()=>{await workflow.close();await generation.close();});
  const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
  assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');assert.equal(imageCount,7);
  assert.deepEqual(first.workflow.setPlan?.slots.map(slot=>slot.role),['main_scene','selling_point','scene','scene','scene','scene','dimensions']);
  assert.equal(first.workflow.imageContext?.referenceMeasurements?.length,1);
  const rechecked=await workflow.recheck({draftId:f.draft.id,draftRevision:f.draft.revision,sourceWorkflowId:first.workflow.id});
  assert.equal(rechecked.workflow.status,'COMPLETED',rechecked.workflow.error??'');assert.equal(imageCount,7);
  assert.equal(rechecked.workflow.setPlanResultId,first.workflow.setPlanResultId);
  await createWorkspaceBackup(f.directory,join(f.directory,'full-size-set.htcbackup'),'full image set measurement backup passphrase');
});

test('equivalent draft saves resume unknown candidates without changing historical image evidence or resetting attempts',async t=>{
  for(const change of ['no-op','image-url']){
    const f=await fixture(t);let posts=0,loseResponse=true;
    f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
    const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{const bytes=Buffer.from(f.bytes);bytes[32]=++posts;return Response.json({data:[{b64_json:bytes.toString('base64')}]});}});
    generation.saveConnection({model:'gpt-image-2.5-sunburst',enabled:true,apiKey:'test-only'});
    const send=generation.generateForWorkflow.bind(generation);
    generation.generateForWorkflow=async(...args)=>{const candidate=await send(...args);if(posts===2&&loseResponse){loseResponse=false;throw new AiError('TIMEOUT');}return candidate;};
    const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{complete:async()=>({draft:f.draft,aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
    f.cleanup(async()=>{await workflow.close();await generation.close();});
    const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});
    assert.equal(first.workflow.slots![0].status,'PASSED');assert.equal(first.workflow.slots![1].status,'UNKNOWN');
    const history=JSON.stringify(f.ai.listResults(f.product.id)),stamp=JSON.stringify(first.workflow.imageContext),ids=first.workflow.slots!.slice(0,2).map(slot=>slot.attempts[0].requestId);
    const saved=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,...(change==='image-url'?{main_product_image_locator:[{marketplace_id:f.draft.marketplaceId,media_location:'https://images.example.com/replaced.png'}]}:{})}});
    assert.ok(saved.revision>f.draft.revision);
    const resumed=await workflow.complete({draftId:f.draft.id,draftRevision:saved.revision});
    assert.equal(resumed.workflow.status,'COMPLETED',resumed.workflow.error??change);assert.equal(resumed.workflow.id,first.workflow.id);assert.equal(posts,7);
    assert.equal(JSON.stringify(resumed.workflow.imageContext),stamp);assert.equal(resumed.workflow.slots![0].approvedAssetId,first.workflow.slots![0].approvedAssetId);
    assert.deepEqual(resumed.workflow.slots!.slice(0,2).map(slot=>slot.attempts[0].requestId),ids);assert.ok(resumed.workflow.slots!.every(slot=>slot.attempts.length===1));
    const before=JSON.parse(history) as AiResult[];assert.deepEqual(before.map(result=>f.ai.getResult(result.id)),before);
    await createWorkspaceBackup(f.directory,join(f.directory,'equivalent.htcbackup'),'equivalent draft backup passphrase');
  }
});

test('IP moderation persists candidate-bound provenance and reserves one usage attempt for token, upload and check', async t => {
  const f=await fixture(t),plan=await f.ai.imagePlan(f.context,()=>{});
  const result=await f.ai.reviewGeneratedImageRisk(f.context,plan,f.candidate,f.bytes,()=>{});
  assert.equal(result.output.kind,'image-ip-review');
  if(result.output.kind!=='image-ip-review')throw Error('Wrong result');
  assert.equal(result.output.verdict,'PASS'); assert.deepEqual(result.output.candidate,f.candidate);
  assert.deepEqual(result.sourceResultIds,[f.context.listingReviewResultId,plan.id]);
  assert.deepEqual(validateAiResult(result),result); assert.ok(f.ai.listResults(f.product.id).some(value=>value.id===result.id));
  assert.deepEqual(f.requests.slice(-3).map(request=>request.operation),['DescribeUploadToken','ip-upload','ImageModeration']);
  const usage=f.ai.getUsageSummary('aliyun-image-risk'); assert.equal(usage.attempts,1); assert.equal(usage.processedImages,1);
});

test('IP moderation rejects changed bytes, rejected source plans and zero budget before network requests',async t=>{
  const f=await fixture(t),plan=await f.ai.imagePlan(f.context,()=>{}),before=f.requests.length;
  const changed=Buffer.from(f.bytes); changed[32]^=1;
  await assert.rejects(f.ai.reviewGeneratedImageRisk(f.context,plan,f.candidate,changed,()=>{}));
  const rejected=structuredClone(plan); if(rejected.output.kind==='image-plan')rejected.output.ipRisk={verdict:'BLOCKED',findings:[{category:'brand',name:'Example',evidence:'Visible logo',referenceAssetIds:[f.context.referenceAssets[0].assetId]}]};
  await assert.rejects(f.ai.reviewGeneratedImageRisk(f.context,rejected,f.candidate,f.bytes,()=>{}));
  f.ai.setUsagePolicy({providerId:'aliyun-image-risk',dailyCallLimit:0,dailyTokenLimit:null});
  await assert.rejects(f.ai.reviewGeneratedImageRisk(f.context,plan,f.candidate,f.bytes,()=>{})); assert.equal(f.requests.length,before);
});

test('cancellation and key rotation during temporary upload cannot send a later moderation request or save PASS',async t=>{
  for(const change of ['cancel','rotate'] as const){
    const f=await fixture(t),plan=await f.ai.imagePlan(f.context,()=>{}),controller=new AbortController();
    f.respond(operation=>{if(operation==='ip-upload'){
      if(change==='cancel')controller.abort();
      else f.ai.saveConnection({id:'aliyun',accessKeyId:'rotated-key-id',accessKeySecret:'rotated-key-secret'});
    }return undefined;});
    await assert.rejects(f.ai.reviewGeneratedImageRisk(f.context,plan,f.candidate,f.bytes,()=>{},controller.signal));
    assert.equal(f.requests.some(request=>request.operation==='ImageModeration'),false);
    assert.equal(f.ai.listResults(f.product.id).some(result=>result.output.kind==='image-ip-review'),false);
  }
});

test('zero OCR requires an explicit text-free plan and independent no-text verification', async t => {
  const f = await fixture(t), plan = await f.ai.imagePlan(f.context,() => {}), ocr = await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,() => {});
  f.respond(operation => operation === 'image-text-review' ? chat({ verdict: 'PASS', checks: [], expectedTextChecks: [], noTextVerified: false, issues: [] }) : undefined);
  await assert.rejects(f.ai.reviewGeneratedImage(f.context,plan,ocr,f.candidate,() => {}));
  assert.equal(f.ai.listResults(f.product.id).some(result => result.output.kind === 'image-text-review'),false);
});

test('planned text missing from OCR cannot PASS even when a reviewer says it is present', async t => {
  const f = await fixture(t); f.context.purpose = 'detail';
  f.respond((operation,payload) => operation === 'image-plan' ? chat({ kind: 'image-plan', prompt: 'Show the exact text Silicone.', textMode: 'planned', expectedText: [{ text: 'Silicone', evidenceIds: [payload.evidence.find((e: any) => e.meaning === 'material').id] }], ipRisk:{verdict:'PASS',findings:[]}, productUnderstanding: understanding(payload) }) : operation === 'image-text-review' ? chat({ verdict: 'PASS', checks: [], expectedTextChecks: [{ index: 0, present: true, reason: 'Present.' }], noTextVerified: false, issues: [] }) : undefined);
  const plan = await f.ai.imagePlan(f.context,() => {}), ocr = await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,() => {});
  await assert.rejects(f.ai.reviewGeneratedImage(f.context,plan,ocr,f.candidate,() => {}));
});

test('OCR review must cover every line and cannot cite generated copy as evidence', async t => {
  const f = await fixture(t); f.context.purpose = 'detail';
  const plan = await f.ai.imagePlan(f.context,() => {}), ocr = await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,() => {});
  if (ocr.output.kind !== 'generated-image-ocr') throw new Error('Wrong OCR type');
  ocr.output.text = 'Silicone'; ocr.output.lines = [{ text: 'Silicone', confidence: 1, box: null }];
  const check = { source: 'summary' as const, index: 0, text: 'Silicone', verdict: 'SUPPORTED' as const, evidenceIds: [f.context.listing.evidence[0].id], reason: 'Material.' };
  const review: ImageTextReviewOutput = { kind: 'image-text-review', candidate: f.candidate, planResultId: plan.id, ocrResultId: ocr.id, verdict: 'NEEDS_CHANGES', checks: [check], expectedTextChecks: [], noTextVerified: false, issues: ['Unexpected words.'], visualReview: 'not_performed' };
  assert.throws(() => assertImageTextReview(review,f.context,plan,ocr,f.candidate));
  review.checks.push({ ...check, source: 'line', evidenceIds: [f.context.listingReviewResultId!] });
  assert.throws(() => assertImageTextReview(review,f.context,plan,ocr,f.candidate));
});

test('minor OCR inflection does not reject factually equivalent planned wording', async t => {
  const f = await fixture(t); f.context.purpose = 'detail';
  const plan = await f.ai.imagePlan(f.context,() => {}), ocr = await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,() => {});
  const evidenceIds = [f.context.listing.evidence[0].id];
  plan.output = { ...plan.output as Extract<AiResult['output'], {kind:'image-plan'}>, kind: 'image-plan', prompt: 'Show Silicone.', textMode: 'planned', expectedText: [{ text: 'Silicone', evidenceIds }] };
  if (ocr.output.kind !== 'generated-image-ocr') throw new Error('Wrong OCR type');
  ocr.output.text = 'Silicones'; ocr.output.lines = [{ text: 'Silicones', confidence: 1, box: null }];
  const review: ImageTextReviewOutput = { kind: 'image-text-review', candidate: f.candidate, planResultId: plan.id, ocrResultId: ocr.id, verdict: 'PASS', checks: (['summary','line'] as const).map(source => ({ source, index: 0, text: 'Silicones', verdict: 'SUPPORTED', evidenceIds, reason: 'Material.' })), expectedTextChecks: [{ index: 0, present: true, reason: 'Present.' }], noTextVerified: false, issues: [], visualReview: 'not_performed' };
  assert.doesNotThrow(() => assertImageTextReview(review,f.context,plan,ocr,f.candidate));
});
test('new slot OCR tolerates harmless markings and missing cosmetic captions but rejects clear measurement contradictions',async t=>{
  const f=await fixture(t),plan=await f.ai.imagePlan(f.context,()=>{}),ocr=await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,()=>{});
  f.context.slot={index:1,total:7,provisional:true};
  if(ocr.output.kind!=='generated-image-ocr')throw new Error('Wrong OCR');
  ocr.output.text='blue!';ocr.output.lines=[{text:'blue!',confidence:0.8,box:null}];
  const review:any={kind:'image-text-review',candidate:f.candidate,planResultId:plan.id,ocrResultId:ocr.id,verdict:'PASS',checks:['summary','line'].map(source=>({source,index:0,text:'blue!',verdict:'SUPPORTED',evidenceIds:[`${f.context.listing.variantId}:color`],reason:'Same actual color despite punctuation.'})),expectedTextChecks:[],noTextVerified:false,issues:[],visualReview:'not_performed'};
  assert.doesNotThrow(()=>assertImageTextReview(review,f.context,plan,ocr,f.candidate));
  f.context.purpose='detail';f.context.slot.index=2;f.context.listing.evidence.push({id:'measured',name:'Measured diameter',value:'8 cm',meaning:'general',source:'human_confirmed'});
  ocr.output.text='80 mm';ocr.output.lines=[{text:'80 mm',confidence:1,box:null}];
  review.checks.forEach((item:any)=>{item.text='80 mm';item.evidenceIds=['measured'];});
  assert.doesNotThrow(()=>assertImageTextReview(review,f.context,plan,ocr,f.candidate));
  ocr.output.text='80 cm';ocr.output.lines[0].text='80 cm';review.checks.forEach((item:any)=>item.text='80 cm');
  assert.throws(()=>assertImageTextReview(review,f.context,plan,ocr,f.candidate));
});

test('image planning rejects a fabricated fallback dimension in prompt as well as visible text', async t => {
  const f = await fixture(t);
  f.context.slot={index:1,total:7,provisional:true};
  f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',prompt:'Show this 5 x 5 x 5 cm product weighing 100 g.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:understanding(payload)}):undefined);
  await assert.rejects(f.ai.imagePlan(f.context,()=>{}),(error:any)=>error.code==='OUTPUT_INVALID');
});
test('image planning rejects fallback measurements hidden in observations or uncertainties',async t=>{
  const f=await fixture(t);f.context.slot={index:1,total:7,provisional:true};
  for(const field of ['summary','uncertainties'] as const){
    f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',prompt:'Show the source product.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},
      productUnderstanding:{...understanding(payload),[field]:field==='summary'?'A product measuring 5 cm.':['No actual measurements. Use the listing default of 5 cm and 100 g.']}}):undefined);
    await assert.rejects(f.ai.imagePlan(f.context,()=>{}),(error:any)=>error.code==='OUTPUT_INVALID',field);
  }
});
test('default-backed weight is removed before independent image-copy review and planning with matching provenance',async t=>{
  const f=await fixture(t),weight=[{value:0.22,unit:'pounds'}];
  const draft=f.amazon.saveDraft({id:f.draft.id,revision:f.draft.revision,attributes:{...f.draft.attributes,item_package_weight:weight,product_description:[{value:'Silicone coaster. Weight 100 g.'}]}});
  const db=openDatabase(f.directory);try{const row=db.prepare('SELECT record_json FROM listing_drafts WHERE id=?').get(draft.id)!,record=JSON.parse(String(row.record_json));record.draft.businessRules={revision:1,fields:{item_package_weight:{value:weight,reason:'业务默认；缺少实测重量'}},notices:[],quote:null,bundleQuantity:1};db.prepare('UPDATE listing_drafts SET record_json=? WHERE id=?').run(JSON.stringify(record),draft.id);}finally{db.close();}
  const start=f.requests.length,reviewed=await f.listing.reviewCurrentForImages({draftId:draft.id,draftRevision:draft.revision});
  const context:ProductImageContext={...f.context,listing:reviewed.context,currentListingCopy:reviewed.currentListingCopy,listingReviewResultId:reviewed.review.id,slot:{index:1,total:7,provisional:true}};
  await f.ai.imagePlan(context,()=>{});
  assert.equal(JSON.stringify(context).includes('100 g'),false);assert.equal(JSON.stringify(f.requests.slice(start).map(request=>request.payload)).includes('100 g'),false);
  assert.equal((f.amazon.getDraft(draft.id).attributes.item_package_weight as any)[0].value,0.22);
});

test('cross-SKU references, candidate byte changes and exhausted budgets make no paid request', async t => {
  const f = await fixture(t), before = f.requests.length;
  const other = structuredClone(f.context); other.referenceAssets[0].variantId = randomUUID();
  await assert.rejects(f.ai.imagePlan(other,() => {}));
  await assert.rejects(f.ai.recognizeGeneratedImage(f.context,{ ...f.candidate,sha256: 'a'.repeat(64) },f.bytes,() => {}));
  f.ai.setUsagePolicy({ providerId: 'deepseek', dailyCallLimit: 0, dailyTokenLimit: null });
  await assert.rejects(f.ai.imagePlan(f.context,() => {})); assert.equal(f.requests.length,before);
});

test('source changes during a paid image plan never produce a reusable result', async t => {
  const f = await fixture(t);
  f.respond(operation => { if (operation === 'image-plan') f.store.saveProduct({ ...saveInput(f.product), description: 'Changed during request.' }); return undefined; });
  await assert.rejects(f.ai.imagePlan(f.context,() => {}));
  assert.equal(f.ai.listResults(f.product.id).some(result => result.output.kind === 'image-plan'),false);
  assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);
});

test('a newer independent rejection supersedes a prior current-copy PASS before image planning', async t => {
  const f = await fixture(t);
  f.respond((operation,payload) => operation === 'listing-current-review' ? chat({ ...currentReview(payload), verdict: 'NEEDS_CHANGES', issues: [{ field: 'item_name', message: 'Confirm product identity.' }] }) : undefined);
  await f.listing.reviewCurrentForImages({ draftId: f.draft.id, draftRevision: f.draft.revision });
  const count = f.requests.length;
  await assert.rejects(f.ai.imagePlan(f.context,() => {}));
  assert.equal(f.requests.length,count);
});

test('cancellation during image planning stops the response from becoming reusable evidence', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.respond(operation => { if (operation === 'image-plan') controller.abort(); return undefined; });
  await assert.rejects(f.ai.imagePlan(f.context,() => {},undefined,controller.signal));
  assert.equal(f.ai.listResults(f.product.id).some(result => result.output.kind === 'image-plan'),false);
  assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);
});

test('a malformed image provider response is an output error and is charged only once', async t => {
  const f = await fixture(t);
  f.respond(operation => operation === 'image-plan' ? chat({ kind: 'image-plan', prompt: 'Plain white.', textMode: 'none', expectedText: [], unexpected: 'reject' }) : undefined);
  await assert.rejects(f.ai.imagePlan(f.context,() => {}), (error: any) => error.code === 'OUTPUT_INVALID');
  assert.equal(f.ai.getUsageSummary('deepseek').attempts,1);
});

test('DeepSeek receives actual SKU image bytes, source identity and product context before writing a plan', async t => {
  const f = await fixture(t), plan = await f.ai.imagePlan(f.context,() => {});
  const request = f.requests.find(item => item.operation === 'image-plan')!;
  assert.ok(Array.isArray(request.body.messages[1].content), 'Planning must be multimodal, not just reference IDs');
  const images = request.body.messages[1].content.filter((part: any) => part.type === 'image_url');
  assert.equal(images.length,f.context.referenceAssets.length);
  assert.deepEqual(Buffer.from(images[0].image_url.url.split(',')[1],'base64'),f.bytes);
  assert.equal(images[0].image_url.detail,'original');
  assert.equal(request.body.model,'deepseek-flash');
  assert.deepEqual(request.payload.referenceImages.map((image: any) => ({assetId:image.assetId,sha256:image.sha256})), f.context.referenceAssets.map(({assetId,sha256})=>({assetId,sha256})));
  assert.equal(request.payload.unverifiedSourceTitle,f.context.listing.unverifiedSourceTitle);
  assert.match((plan.output as any).productUnderstanding.summary,/coaster/);
  assert.ok(!JSON.stringify(plan).includes('data:image/'), 'History stores identities and observations, not duplicated image bodies');
  assert.ok(plan.imageRequestBytes! > f.bytes.length);
});

test('IP source snapshot preserves explicit brand facts and raw SKU names filtered out of listing copy evidence',async t=>{
  const f=await fixture(t); await f.ai.imagePlan(f.context,()=>{});
  const payload=f.requests.find(request=>request.operation==='image-plan')!.payload;
  assert.ok(!payload.evidence.some((fact:any)=>fact.name==='品牌'));
  assert.equal(payload.unverifiedIpSource.originalSpec,'库洛米 蓝色');
  assert.equal(payload.unverifiedIpSource.normalizedSpec,'Blue');
  assert.equal(payload.unverifiedIpSource.description,f.product.description);
  assert.ok(payload.unverifiedIpSource.facts.some((fact:any)=>fact.name==='品牌'&&fact.value==='三丽鸥'&&fact.state==='source_confirmed'));
  const before=f.requests.length, changed=structuredClone(f.context); changed.ipSource!.facts=changed.ipSource!.facts.filter(fact=>fact.name!=='品牌');
  await assert.rejects(f.ai.imagePlan(changed,()=>{})); assert.equal(f.requests.length,before);
});

test('image planning uses Flash vision with the shared key even when copy generation selects Pro', async t => {
  const f = await fixture(t);
  f.ai.saveFunctionSettings({id:'deepseek',model:'deepseek-v4-pro',enabled:true});
  const plan = await f.ai.imagePlan(f.context,() => {});
  assert.equal(f.requests.at(-1)!.body.model,'deepseek-flash');
  assert.equal(plan.model,'deepseek-flash');
  assert.equal(f.ai.getProfile('deepseek').model,'deepseek-v4-pro');
});

test('missing or foreign visual understanding cannot become a reusable image plan', async t => {
  const f = await fixture(t);
  f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',prompt:'White background.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]}}):undefined);
  await assert.rejects(f.ai.imagePlan(f.context,() => {}));
  f.respond(operation=>operation==='image-plan'?chat({kind:'image-plan',prompt:'White background.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{summary:'A coaster.',referenceAssetIds:[randomUUID()],uncertainties:[],sufficient:true}}):undefined);
  await assert.rejects(f.ai.imagePlan(f.context,() => {}));
  assert.equal(f.ai.listResults(f.product.id).some(result=>result.output.kind==='image-plan'),false);
});

test('missing or modified source bytes stop vision planning before a paid request', async t => {
  const f = await fixture(t), before=f.requests.length;
  const changed=Buffer.from(f.bytes);changed[32]=1;
  writeFileSync(join(f.directory,f.store.getAssetRecord(f.product.assets[0].id)!.originalPath),changed);
  await assert.rejects(f.ai.imagePlan(f.context,() => {}));
  assert.equal(f.requests.length,before);
});

test('two distinct references retain their byte order and reversed understanding IDs are rejected', async t=>{
  const f=await fixture(t,true); await f.ai.imagePlan(f.context,()=>{});
  const images=f.requests.at(-1)!.body.messages[1].content.filter((part:any)=>part.type==='image_url');
  assert.equal(images.length,2);
  const expected=f.context.referenceAssets.map(ref=>readFileSync(join(f.directory,f.store.getAssetRecord(ref.assetId)!.originalPath)));
  assert.notDeepEqual(expected[0],expected[1]);
  assert.deepEqual(images.map((part:any)=>Buffer.from(part.image_url.url.split(',')[1],'base64')),expected);
  f.respond((operation,payload)=>operation==='image-plan'?chat({kind:'image-plan',prompt:'Preserve this product.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{...understanding(payload),referenceAssetIds:payload.referenceImages.map((image:any)=>image.assetId).reverse()}}):undefined);
  await assert.rejects(f.ai.imagePlan(f.context,()=>{}));
});

for(const legacyVersion of ['product-image/v1','product-image/vision-v2'] as const)test(`legacy ${legacyVersion} plans and completed provenance survive backup/restore but cannot be reused`,async t=>{
  const f=await fixture(t), plan=await f.ai.imagePlan(f.context,()=>{}), ocr=await f.ai.recognizeGeneratedImage(f.context,f.candidate,f.bytes,()=>{}), review=await f.ai.reviewGeneratedImage(f.context,plan,ocr,f.candidate,()=>{});
  const legacyContext={...f.context,policyVersion:legacyVersion}; delete legacyContext.ipSource;
  const contextSha256=listingFingerprint(legacyContext), runId=randomUUID();
  const db=openDatabase(f.directory);
  try {
    for(const original of [plan,ocr,review]) {
      const legacy=structuredClone(original); legacy.imageContext=legacyContext; legacy.sourceSha256=contextSha256;
      if(legacy.output.kind==='image-plan') {
        if(legacyVersion==='product-image/v1')delete legacy.output.productUnderstanding;
        delete legacy.output.ipRisk; legacy.model=legacyVersion==='product-image/v1'?'deepseek-v4-pro':'deepseek-flash';
        db.prepare("UPDATE ai_calls SET record_json=json_set(record_json,'$.model',?) WHERE id=?").run(legacy.model,legacy.callId);
      }
      assert.deepEqual(validateAiResult(legacy),legacy);
      db.prepare('UPDATE ai_results SET record_json=? WHERE id=?').run(JSON.stringify(legacy),legacy.id);
    }
    const run={id:runId,draftId:f.draft.id,productId:f.product.id,productRevision:f.product.revision,variantId:f.product.variants[0].id,sku:f.draft.sku,status:'COMPLETED',stage:'complete',attempt:1,maxAttempts:2,contextSha256,draftSha256:imageWorkflowDraftStamp(f.draft),referenceAssets:legacyContext.referenceAssets.map(ref=>({id:ref.assetId,sha256:ref.sha256})),planResultIds:[plan.id],candidateIds:[f.candidate.id],ocrResultIds:[ocr.id],reviewResultIds:[review.id],approvedAssetId:f.product.assets[0].id,approvedSha256:f.candidate.sha256,createdAt:plan.createdAt,updatedAt:review.createdAt,error:null};
    db.prepare('INSERT INTO image_workflow_runs VALUES(?,?)').run(run.id,JSON.stringify(run));
  } finally {db.close();}
  const file=join(f.directory,'legacy.htcbackup'), target=join(f.directory,'restored');
  await createWorkspaceBackup(f.directory,file,'legacy visual provenance passphrase');
  await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,file,'legacy visual provenance passphrase'));
  const restored=openDatabase(target);
  try {
    const record=validateAiResult(JSON.parse(String(restored.prepare('SELECT record_json FROM ai_results WHERE id=?').get(plan.id)!.record_json)));
    assert.equal(record.model,legacyVersion==='product-image/v1'?'deepseek-v4-pro':'deepseek-flash'); assert.equal(record.imageContext!.policyVersion,legacyVersion);
    assert.equal(Boolean((record.output as any).productUnderstanding),legacyVersion!=='product-image/v1');
    assert.equal(workflowRuns(restored,f.draft.id)[0].id,runId);
    assert.throws(()=>approvedWorkflowAsset(restored,f.draft,f.product),/旧版流程/);
  } finally {restored.close();}
});

test('image-plan accepts only the known json_object envelope marker and keeps raw rejection evidence', async t => {
  const f=await fixture(t);
  const {planProductImage}=await import('../src/main/ai/image-adapters.ts');
  let extra:object={type:'json_object'}, raw:any;
  const adapter={fetch:async()=>chat({kind:'image-plan',prompt:'Photograph the source product without added text.',textMode:'none',expectedText:[],productUnderstanding:{summary:'A blue coaster.',referenceAssetIds:f.context.referenceAssets.map(a=>a.assetId),uncertainties:[],sufficient:true},ipRisk:{verdict:'PASS',findings:[]},...extra}),now:()=>new Date(),nonce:randomUUID,maxResponseBytes:200000,onUntrustedOutput:(value:unknown)=>{raw=value;}};
  const invoke=()=>planProductImage(f.context,undefined,'deepseek-flash',{apiKey:'fixture-key'},new AbortController().signal,adapter,f.context.referenceAssets.map(a=>({...a,mimeType:'image/png',width:256,height:256,bytes:f.bytes})));
  const result=await invoke();
  assert.equal('type' in result.output,false);
  assert.equal(raw.type,'json_object');
  for(extra of [{type:'json_schema'},{type:'json_object',unexpected:'must remain rejected'},{type:'json_object',textMode:'planned'}]) {
    await assert.rejects(invoke(),(error:unknown)=>error instanceof AiError&&error.code==='OUTPUT_INVALID');
    for(const [key,value] of Object.entries(extra))assert.equal(raw[key],value);
  }
});

test('copy-only repairs reuse exact seven-image approvals without paid calls and preserve backup provenance',async t=>{
  const f=await fixture(t);let imageCount=0;
  f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{const bytes=Buffer.from(f.bytes);bytes[32]=++imageCount;return Response.json({data:[{b64_json:bytes.toString('base64')}]});}});
  generation.saveConnection({model:'gpt-image-2.5-sunburst',enabled:true,apiKey:'test-only'});
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{complete:async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
  f.cleanup(async()=>{await workflow.close();await generation.close();});
  const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(first.workflow.status,'COMPLETED',first.workflow.error??'');
  const old=f.amazon.getDraft(f.draft.id),changed=f.amazon.saveDraft({id:old.id,revision:old.revision,attributes:{...old.attributes,item_name:[{value:'Blue Round Silicone Coaster'}]}}),before=f.requests.length;
  const reused=await workflow.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:first.workflow.id});
  assert.equal(f.requests.length,before);assert.equal(imageCount,7);assert.equal(reused.aiCalls,0);
  assert.equal(reused.workflow.approvalReuse?.sourceRunId,first.workflow.id);assert.deepEqual(reused.workflow.slots,first.workflow.slots);assert.deepEqual(reused.workflow.imageContext,first.workflow.imageContext);
  const backup=join(f.directory,'approval-reuse.htcbackup'),target=join(f.directory,'reuse-restored');await createWorkspaceBackup(f.directory,backup,'reused image approval test passphrase');
  await commitWorkspaceRestore(target,await prepareWorkspaceRestore(target,backup,'reused image approval test passphrase'));
  const restored=openDatabase(target);try{assert.equal(workflowRuns(restored,f.draft.id)[0].approvalReuse?.sourceRunId,first.workflow.id);}finally{restored.close();}
  const db=openDatabase(f.directory);try{const tampered=structuredClone(reused.workflow);tampered.approvalReuse!.draftSnapshot='{}';db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(tampered),tampered.id);await assert.rejects(createWorkspaceBackup(f.directory,join(f.directory,'tampered.htcbackup'),'reused image approval test passphrase'));db.prepare('UPDATE image_workflow_runs SET record_json=? WHERE id=?').run(JSON.stringify(reused.workflow),reused.workflow.id);}finally{db.close();}
  const again=await workflow.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:reused.workflow.id});assert.equal(again.workflow.id,reused.workflow.id);assert.equal(f.requests.length,before);
  const originalGet=f.store.getAssetRecord.bind(f.store);let mutateOnce=true;
  f.store.getAssetRecord=(id:string)=>{if(mutateOnce&&id===first.workflow.approvedAssetId){mutateOnce=false;const current=f.amazon.getDraft(changed.id);f.amazon.saveDraft({id:current.id,revision:current.revision,attributes:{...current.attributes,item_name:[{value:'Blue Silicone Coaster'}]}});}return originalGet(id);};
  await assert.rejects(workflow.recheck({draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:first.workflow.id}),(error:unknown)=>error instanceof AiError&&error.code==='SOURCE_CHANGED');
  f.store.getAssetRecord=originalGet;assert.equal(f.requests.length,before);
  const current=f.amazon.getDraft(changed.id),asset=originalGet(first.workflow.approvedAssetId!)!;writeFileSync(join(f.directory,asset.originalPath),Buffer.from('modified image bytes'));
  await assert.rejects(workflow.recheck({draftId:current.id,draftRevision:current.revision,sourceWorkflowId:first.workflow.id}),(error:unknown)=>error instanceof AiError&&error.code==='SOURCE_CHANGED');assert.equal(f.requests.length,before);
});

test('interrupted IP rechecks reuse old approvals without calls but never override a newer IP rejection',async t=>{
  const f=await fixture(t);let images=0;
  f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:bytes=>bytes,fetch:async()=>{const bytes=Buffer.from(f.bytes);bytes[32]=++images;return Response.json({data:[{b64_json:bytes.toString('base64')}]});}});
  generation.saveConnection({model:'gpt-image-2.5-sunburst',enabled:true,apiKey:'fixture'});
  const workflow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:{complete:async()=>({draft:f.amazon.getDraft(f.draft.id),aiCalls:0,previewAttempts:0,remaining:[]}),reviewCurrentForImages:(input,signal)=>f.listing.reviewCurrentForImages(input,signal)}});
  f.cleanup(async()=>{await workflow.close();await generation.close();});
  const first=await workflow.complete({draftId:f.draft.id,draftRevision:f.draft.revision});assert.equal(first.workflow.status,'COMPLETED');
  const old=f.amazon.getDraft(f.draft.id),changed=f.amazon.saveDraft({id:old.id,revision:old.revision,attributes:{...old.attributes,item_name:[{value:'Blue Round Silicone Coaster'}]}});
  const request={draftId:changed.id,draftRevision:changed.revision,sourceWorkflowId:first.workflow.id};
  const oldVersion=(workflow as unknown as {recheckWithFreshEvidence(input:unknown):ReturnType<ImageWorkflowService['recheck']>});
  f.respond(operation=>{if(operation==='ImageModeration')throw new Error('fixture network outage');return operation==='ip-upload'?new Response(null,{status:200}):undefined;});
  const interrupted=await oldVersion.recheckWithFreshEvidence(request);assert.equal(interrupted.workflow.status,'FAILED');assert.equal(interrupted.workflow.stage,'ip-check');
  f.respond(operation=>operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const before=f.requests.length,resumed=await workflow.recheck(request);assert.equal(resumed.workflow.approvalReuse?.sourceRunId,first.workflow.id);assert.equal(f.requests.length,before);assert.equal(images,7);
  await createWorkspaceBackup(f.directory,join(f.directory,'interrupted-ip-reused.htcbackup'),'interrupted IP image reuse backup passphrase');
  f.respond((operation,payload)=>operation==='ImageModeration'?Response.json({Code:200,RequestId:'fixture-new-ip-risk',Data:{DataId:payload.dataId,RiskLevel:'high',Result:[{Label:'tm_goods',Confidence:99,Description:'Distinctive brand detected'}]}}):operation==='ip-upload'?new Response(null,{status:200}):undefined);
  const rejected=await oldVersion.recheckWithFreshEvidence(request);assert.equal(rejected.workflow.slots![0].status,'BLOCKED');
  const denied=await workflow.recheck(request);assert.equal(denied.workflow.approvalReuse,undefined);assert.notEqual(denied.workflow.status,'COMPLETED');assert.equal(images,7);
});
