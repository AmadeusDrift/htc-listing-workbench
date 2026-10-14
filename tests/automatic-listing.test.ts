import { pricingBlockingReason } from '../src/main/image-workflow/deferred-fields.ts';
import { AiService } from '../src/main/ai/service.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { chat,mockStorage } from './fixtures/listing-ai.ts';
import { assertConsistencyView, assertProductConsistency } from '../src/main/source-image-consistency/proof.ts';
import { materializeSourceSnapshot,confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import test from 'node:test';
import { installAutomaticListingIpc } from '../src/main/automatic-listing-ipc.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AutomaticListingService } from '../src/main/automatic-listing/service.ts';
import type { AutomaticListingDependencies } from '../src/main/automatic-listing/service.ts';
import type { AmazonDraft, AmazonTarget } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import type { ExecutionTask } from '../src/shared/execution-contracts.ts';
import { defaultListingRules, quoteListing } from '../src/shared/listing-rules.ts';
import { pricingQualificationIssue } from '../src/main/pricing/qualification.ts';
import { openDatabase } from '../src/main/database.ts';
import { fingerprint } from '../src/main/execution/records.ts';
import { imageWorkflowDraftStamp } from '../src/main/image-workflow/records.ts';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';
import { UserFacingError } from '../src/shared/errors.ts';
import { FAMILY_REBIND_EVENT_SUMMARY } from '../src/main/amazon/service.ts';
import { sourceStamp, validateAutomaticListingTask } from '../src/main/automatic-listing/records.ts';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { currentFactAuthority } from '../src/main/amazon/fact-authority.ts';
import { inheritLegacyPurposeSettings } from '../src/main/ai/purpose-routing.ts';

function fixture(t: test.TestContext, mode: 'live' | 'demo' = 'demo') {
  mkdirSync(resolve('.test-data'), { recursive: true });
  const directory = mkdtempSync(join(resolve('.test-data'), 'automatic-task-'));
  const now = new Date().toISOString(), batchId = randomUUID(), lineId = randomUUID();
  const product: ProductDetail = { id: randomUUID(), revision: 1, title: 'Box', sourceUrl: '', description: '', status: 'draft', origin: 'manual', createdAt: now, updatedAt: now, facts: [], assets: [], variants: [
    { id: randomUUID(), sku: 'SKU-ONE', originalSpec: 'red', normalizedSpec: 'red', purchasePrice: '1', inventory: null, sourceSpec: 'red', sourcePurchasePrice: '1' },
  ] };
  const target: AmazonTarget = { id: 'store-one', name: 'Test store', mode, sellerId: 'seller', marketplaceId: 'ATVPDKIKX0DER', marketplaceName: 'US', region: 'na', locale: 'en_US', paused: false, configured: true, credentialUpdatedAt: now, lastError: null };
  const profile = { id: 'alpha' as const, name: 'Alpha' as const, generation: 1, enabled: true, configured: true, host: 'ftp.example.test', port: 21, secure: true, remoteRoot: '/', publicBaseUrl: 'https://images.example.test/' };
  const rules = defaultListingRules();
  const drafts = new Map<string, AmazonDraft>(), executions = new Map<string, ExecutionTask>();
  const calls = { sources: 0, images: 0, submissions: 0, batches: 0, labels: 0 };
  let ready = mode === 'demo', imageFailure = false, started: (() => void) | undefined, release: (() => void) | undefined;
  const workflow = new Map<string, any>();
  const dependencies: AutomaticListingDependencies = {
    store: { getProduct: () => structuredClone(product),hasProducts:ids=>ids.every(id=>id===product.id) },
    prepareSourceConsistency:async input=>{materializeSourceSnapshot(directory,product,input.variantIds);const store=new WorkspaceStore(directory);try{await confirmSourceConsistencyFixture(directory,store,product.id,input.variantIds);}finally{store.close();}},
    rules: () => structuredClone(rules),
    previewSales: () => buildSalesRecipes(product,null,rules),
    hosting: { getProfile: () => structuredClone(profile) },
    amazon: {
      executionTargetScope: () => ({ target: structuredClone(target), generation: 1 }),
      listDrafts: () => [...drafts.values()].map(value => structuredClone(value)),
      getDraft: id => structuredClone(drafts.get(id)!),
      async prepareDrafts(raw, plans) {
        const selected = product.variants.find(value => value.id === (raw as any).items[0].variantId)!;
        const value = { id: randomUUID(), productId: product.id, productRevision: product.revision, variantId: selected.id, sku: selected.sku,
          targetId: target.id, targetName: target.name, sellerId: target.sellerId, marketplaceId: target.marketplaceId, mode, revision: 1, listingProgram: mode === 'live' ? 'haul' : 'standard',
          schema: { targetId: target.id, productType: 'BOX', requirements: 'LISTING', parentageLevel: 'NONE', locale: target.locale }, state: 'BLOCKED', attributes: {}, submittedAt: null,
          localIssues: [], previewIssues: [], listingIssues: [], createdAt: now, updatedAt: now } as unknown as AmazonDraft;
        if (mode === 'live') {
          const recipe=plans?.[0]?.recipe;
          const priced=applyBusinessRules({product,variant:selected,target,schema:realAmazonSchema(),attributes:{},measurements:{},costCny:recipe?recipe.totalCostCny:Number(selected.purchasePrice),saleUnit:recipe,now:new Date()},rules);
          value.attributes=priced.attributes;value.businessRules=priced.report;
        }
        drafts.set(value.id, value);
        return { items: [{ productId: product.id, variantId: selected.id, sku: value.sku, draft: structuredClone(value), disposition: 'CREATED', issues: [], error: null }] } as any;
      },
    },
    images: {
      async prepareSources() { calls.sources++; product.revision++; return { product: structuredClone(product), missing: [] }; },
      async complete(input) {
        calls.images++;
        if (started) { started(); await new Promise<void>(resolve => { release = resolve; }); }
        if (imageFailure) throw new Error('provider response unknown');
        const draft = drafts.get((input as any).draftId)!;
        const result = { id: randomUUID(), draftId: draft.id, status: 'COMPLETED', stage: 'complete', attempt: 7, approvedAssetId: randomUUID(), approvedSha256: 'a'.repeat(64),
          slots:Array.from({length:7},(_,i)=>({index:i+1,status:'PASSED',approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64)})) };
        workflow.set(draft.id, result);
        return { draft: structuredClone(draft), aiCalls: 1, previewAttempts: 1, remaining: ['Image URL missing until upload'], workflow: result } as any;
      },
      getProgress: id => workflow.get(String(id)) ?? null,
      cancel: () => { release?.(); return { cancelled: true }; },
      cancelSources: () => ({ cancelled: true }),
    },
    execution: {
      create(input) {
        const id = randomUUID(), draft = drafts.get((input as any).draftIds[0])!;
        const task = { id, status: 'CREATED', profileId: profile.id, profileStamp: fingerprint(profile), items: [{ draftId: draft.id, draftRevision: draft.revision, attributesHash: fingerprint(draft.attributes), schemaHash: fingerprint(draft.schema),
          productId: draft.productId, productRevision: draft.productRevision, variantId: draft.variantId, sku: draft.sku, targetStamp: fingerprint({ target, generation: 1 }), status: 'PENDING', submitStarted: false, steps: [] }] } as unknown as ExecutionTask;
        executions.set(id, task); return structuredClone(task);
      },
      prepareStart: id => structuredClone(executions.get(id)!),
      startAuthorized(task) {
        calls.submissions++;
        const draft = drafts.get(task.items[0].draftId)!;
        draft.submittedAt = now; draft.state = mode === 'live' ? 'SUBMITTED' : 'BUYABLE';
        const saved = executions.get(task.id)!; saved.status = 'COMPLETED'; saved.items[0].status = 'DONE';
        return structuredClone(saved);
      },
      get: id => structuredClone(executions.get(id)!),
      list: () => [...executions.values()].map(value => structuredClone(value)),
      waitForIdle: async () => {},
      pause(id) { const task = executions.get(id)!; task.status = 'PAUSED'; return structuredClone(task); },
      cancel(id) { const task = executions.get(id)!; task.status = 'CANCELLED'; return structuredClone(task); },
    },
    followup: { get: () => ({ status: ready ? 'READY' : 'WAITING', error: null } as any), schedule: () => ({} as any) },
    procurement: {
      candidates: () => [...drafts.values()].map(draft => ({ draftId: draft.id, eligible: ready && !!draft.submittedAt })) as any,
      ensureAutomaticBatch(_id, ids, quantities) { calls.batches++; assert.equal(quantities[ids[0]], 5); return [{ id: batchId, lines: [{ draftId: ids[0], id: lineId }] }] as any; },
    },
    labels: {
      syncBatch() { calls.labels++; return [] as any; },
      list: () => [...drafts.values()].map(draft => ({ batchId, lineId, draftId: draft.id, current: true, status: 'READY' })) as any,
    },
  };
  const cleanups:(()=>Promise<void>)[]=[];
  const service = new AutomaticListingService(directory, dependencies);
  t.after(async () => { release?.(); await service.close(); for(const close of cleanups)await close(); rmSync(directory, { recursive: true, force: true }); });
  const create = () => service.create({ productIds: [product.id], targetId: target.id, profileId: 'alpha', productType: 'BOX' });
  return { service, directory, dependencies, cleanups, create, product, target, profile, rules, drafts, executions, calls, workflow,
    setReady: () => { ready = true; }, failImages: () => { imageFailure = true; },
    holdImages: (callback: () => void) => { started = callback; }, releaseImages: () => release?.() };
}

/** A persisted pre-v3 report: no dependency digest existed in this format. */
function legacyV2Pricing(f:ReturnType<typeof fixture>,draft:AmazonDraft) {
  const inputs={costCny:2.4,dimensionsInches:[1.97,1.97,1.97] as [number,number,number],weightPounds:.22};
  const attributeInputs={item_package_dimensions:[{length:{value:1.97,unit:'inches'},width:{value:1.97,unit:'inches'},height:{value:1.97,unit:'inches'}}],item_package_weight:[{value:.22,unit:'pounds'}]};
  const quote=quoteListing(inputs,f.rules.pricing);
  draft.attributes={...structuredClone(attributeInputs),number_of_items:[{value:1}],purchasable_offer:[{audience:'BZR',currency:'USD',marketplace_id:f.target.marketplaceId,our_price:[{schedule:[{value_with_tax:quote.price}]}]}]};
  draft.businessRules={revision:f.rules.revision,fields:{},notices:[],quote,bundleQuantity:1,pricingBasis:{kind:'source_sale_unit',sourceCostCny:2.4,quantity:1,saleUnitCostCny:2.4},pricingDecision:{version:2,status:'quoted',code:'QUOTE_VALID',quoteError:null,inputs,attributeInputs,evidence:{cost:'confirmed_cny',dimensions:'business_default',weight:'business_default',packageScope:'source_sale_unit',saleUnit:'confirmed',sourcePackage:{dimensionsInches:null,weightPounds:null}}}};
  assert.equal(pricingQualificationIssue(draft,f.rules),null,'v2 fixture must qualify before the test mutates its evidence');
}

async function reachedStage(event:Promise<void>, operation:Promise<void>, describe:()=>unknown) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([event,operation.then(()=>{throw new Error(`Expected test stage was never reached: ${JSON.stringify(describe())}`);}),
      new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out waiting for test stage: ${JSON.stringify(describe())}`)),15_000);})]);
  } finally { clearTimeout(timer); }
}

test('resume IPC survives background observation while its confirmation dialog is open', async t => {
  const f=fixture(t),task=await f.create(),saved=(f.service as any).tasks.get(task.id);
  saved.status='NEEDS_ATTENTION';saved.items[0].status='FAILED';saved.items[0].error='source failed';
  const handlers=new Map<string,(...args:any[])=>any>();let audited=0;
  installAutomaticListingIpc(f.service,(name,_count,callback)=>handlers.set(name,callback),{
    confirm:async approved=>{await f.service.refreshWaiting();await f.service.refreshWaiting();assert.deepEqual(f.service.get(task.id),approved);return true;},
    audit:()=>{audited++;},
  });
  const result=await handlers.get('red:automatic-listing:resume')!(task.id);
  assert.equal(result.status,'QUEUED');assert.equal(audited,1);
  await f.service.waitForIdle();assert.ok(f.calls.sources>0,'confirmation must reach the real worker');
});
for(const answer of ['cancel','throw','changed'] as const)test(`resume confirmation releases observation after ${answer} and preserves cancellation`,async t=>{
  const f=fixture(t),task=await f.create(),saved=(f.service as any).tasks.get(task.id);
  saved.status='NEEDS_ATTENTION';saved.items[0].status='FAILED';saved.items[0].error='source failed';
  const handlers=new Map<string,(...args:any[])=>any>();let audited=0;
  installAutomaticListingIpc(f.service,(name,_count,callback)=>handlers.set(name,callback),{
    confirm:async()=>{await f.service.refreshWaiting();if(answer==='throw')throw Error('dialog failed');if(answer==='changed')f.service.cancel(task.id);return answer!=='cancel';},audit:()=>{audited++;},
  });
  if(answer==='cancel')assert.equal(await handlers.get('red:automatic-listing:resume')!(task.id),null);
  else await assert.rejects(()=>handlers.get('red:automatic-listing:resume')!(task.id),answer==='throw'?/dialog failed/:/确认期间/);
  assert.equal(audited,0);assert.equal(f.calls.sources,0);
  if(answer==='changed')assert.equal(f.service.get(task.id).status,'CANCELLED');
  else {const before=f.service.get(task.id).revision;await f.service.refreshWaiting();assert.ok(f.service.get(task.id).revision>before,'observation resumes after dismissed dialog');}
});

test('batch failures let the event loop process pause before the next SKU', async t => {
  const f = fixture(t);
  f.product.variants.push({ ...f.product.variants[0], id: randomUUID(), sku: 'SKU-TWO' });
  const task = await f.create();
  assert.equal(task.items.length, 2);
  let attempts = 0;
  f.dependencies.images.prepareSources = async () => {
    attempts++;
    if (attempts === 1) setImmediate(() => f.service.pause(task.id));
    throw new Error('local source preparation failure');
  };
  f.service.startAuthorized(f.service.prepareStart(task.id));
  await f.service.waitForIdle();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(attempts, 1, 'pause must be serviced between SKUs, even when promises reject immediately');
  assert.equal(f.service.get(task.id).status, 'PAUSED');
  assert.equal(f.calls.submissions, 0);
});

test('readback observation lets pause run before inspecting another SKU', async t => {
  const f = fixture(t, 'live');
  f.product.variants.push({ ...f.product.variants[0], id: randomUUID(), sku: 'SKU-TWO' });
  const task = await f.create();
  const saved = (f.service as any).tasks.get(task.id);
  saved.status = 'WAITING';
  for (const row of saved.items) {
    const result = await f.dependencies.amazon.prepareDrafts({ items: [{ variantId: row.variantId }] });
    row.draftId = result.items[0].draft!.id;
    row.stage = 'READBACK'; row.status = 'WAITING';
  }
  let inspected = 0;
  const getDraft = f.dependencies.amazon.getDraft;
  f.dependencies.amazon.getDraft = id => {
    inspected++;
    if (inspected === 1) setImmediate(() => f.service.pause(task.id));
    return getDraft(id);
  };
  await f.service.refreshWaiting();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(inspected, 1, 'background observation must yield between SKUs');
  assert.equal(f.service.get(task.id).status, 'PAUSED');
});

test('confirmed pricing rejection is terminal and excluded only in the same target queue', async t => {
  const f=fixture(t,'live');f.rules.pricing.bundleEnabled=false;
  const prepare=f.dependencies.amazon.prepareDrafts;
  f.dependencies.amazon.prepareDrafts=async input=>{
    const value=await prepare(input),draft=value.items[0].draft!;
    draft.attributes={item_package_dimensions:[{length:{value:1,unit:'inches'},width:{value:1,unit:'inches'},height:{value:1,unit:'inches'}}],item_package_weight:[{value:1,unit:'pounds'}],number_of_items:[{value:1}]};
    draft.businessRules={revision:f.rules.revision,fields:{},notices:['confirmed ROI rejection'],quote:null,bundleQuantity:1,
      pricingBasis:{kind:'source_sale_unit',sourceCostCny:100,quantity:1,saleUnitCostCny:100},
      pricingDecision:{version:1,status:'business_blocked',code:'ROI_MAX_PRICE',quoteError:'ROI_MAX_PRICE',inputs:{costCny:100,dimensionsInches:[1,1,1],weightPounds:1},
        evidence:{cost:'confirmed_cny',dimensions:'confirmed_source',weight:'confirmed_source',packageScope:'source_sale_unit',saleUnit:'confirmed',sourcePackage:{dimensionsInches:[1,1,1],weightPounds:1}}}};
    f.drafts.set(draft.id,structuredClone(draft));return value;
  };
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const saved=f.service.get(task.id);
  assert.equal(saved.items[0].status,'SCREENED');assert.equal((saved.items[0] as any).outcome.kind,'RULE_FILTERED');
  assert.equal(saved.status,'COMPLETED');assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);
  assert.deepEqual(validateAutomaticListingTask(saved),saved);
  for(const tamper of ['shop','source','recipe','proof-key','proof-basis','missing-proof','unknown-phase'] as const){
    const bad=structuredClone(saved),row=bad.items[0],outcome=row.outcome!;
    if(tamper==='shop')outcome.scope.sellerId='another-seller';
    if(tamper==='source')outcome.scope.sourceStamp='d'.repeat(64);
    if(tamper==='recipe')outcome.scope.recipeKey='another-recipe';
    if(tamper==='proof-key')(outcome.pricingReport!.pricingDecision as any).extra=true;
    if(tamper==='proof-basis')(outcome.pricingReport!.pricingBasis as any).extra=true;
    if(tamper==='missing-proof')delete outcome.pricingReport;
    if(tamper==='unknown-phase'){row.repairAttempts=1;row.executionTaskIds=[randomUUID()];row.repair={phase:'FIELDS_STARTED',sourceWorkflowId:randomUUID(),draftRevision:1,draftStamp:'a'.repeat(64)};}
    assert.throws(()=>validateAutomaticListingTask(bad),tamper);
  }
  const queue=await (f.service as any).queue({productIds:[f.product.id],targetId:f.target.id});
  assert.equal(queue.products[0].eligibleCount,0);assert.equal(queue.products[0].rows[0].kind,'RULE_FILTERED');
  await assert.rejects(async()=>f.create(),/没有可启动/);
  f.target.sellerId='other-seller';
  assert.equal((await (f.service as any).queue({productIds:[f.product.id],targetId:f.target.id})).products[0].eligibleCount,1);
  f.target.sellerId='seller';f.rules.revision++;
  const changed=await (f.service as any).queue({productIds:[f.product.id],targetId:f.target.id});
  assert.equal(changed.products[0].eligibleCount,0,'global revision must not authorize paid retry without local repricing');
  assert.equal(f.service.get(task.id).items[0].status,'SCREENED','read projection preserves audit');
  f.rules.revision--;
  const oldTitle=f.product.title;f.product.title='Updated source facts';
  const sourceChanged=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(sourceChanged.products[0].eligibleCount,0,'source title must not reopen profit rejection');f.product.title=oldTitle;
  await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);
  try{assert.deepEqual(restored.get(task.id),saved);assert.equal((await restored.queue({productIds:[f.product.id],targetId:f.target.id})).products[0].filteredCount,1);assert.throws(()=>restored.prepareStart(task.id),/已经结束/);}finally{await restored.close();}
});

for(const mutation of ['precision','partial','null','unsupported','missing-snapshot'] as const)test(`actual automatic prepare blocks a stale v2 successful quote before images: ${mutation}`,async t=>{
  const f=fixture(t,'live'),prepare=f.dependencies.amazon.prepareDrafts;
  f.dependencies.amazon.prepareDrafts=async input=>{
    const result=await prepare(input),draft=result.items[0].draft!;
    legacyV2Pricing(f,draft);
    if(mutation==='precision')draft.attributes.item_package_weight=[{value:.22000001,unit:'pounds'}];
    if(mutation==='partial')draft.attributes.item_package_dimensions=[{length:{value:1.97,unit:'inches'}}];
    if(mutation==='null')draft.attributes.item_package_weight=null;
    if(mutation==='unsupported')(draft.businessRules!.pricingDecision as any).version=99;
    if(mutation==='missing-snapshot')delete (draft.businessRules!.pricingDecision as any).attributeInputs;
    f.drafts.set(draft.id,structuredClone(draft));return result;
  };
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const row=f.service.get(task.id).items[0];assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);assert.equal(row.outcome?.kind,'NEEDS_INPUT');assert.equal(row.outcome?.code,'PRICING_EVIDENCE_STALE');
});

for(const phase of ['source-color','after-color','field-intent','recheck'] as const)test(`automatic repair rechecks v2 before new paid ${phase}`,async t=>{
  const f=fixture(t,'live'),task=await f.create(),row=task.items[0];
  const result=await f.dependencies.amazon.prepareDrafts({targetId:f.target.id,productType:'BOX',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US',listingProgram:'haul',items:[{productId:f.product.id,productRevision:f.product.revision,variantId:f.product.variants[0].id,attributes:{}}]});
  const draft=result.items[0].draft!;legacyV2Pricing(f,draft);
  if(phase!=='after-color')draft.attributes.item_package_weight=null;
  f.drafts.set(draft.id,structuredClone(draft));row.draftId=draft.id;row.stage='IMAGES';
  const child=f.dependencies.execution.create({draftIds:[draft.id],profileId:'alpha'});row.executionTaskIds=[child.id];row.repairAttempts=1;
  row.repair={phase:phase==='recheck'?'RECHECK_PENDING':'FIELDS_PENDING',sourceWorkflowId:randomUUID(),draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft),remaining:phase==='recheck'?[]:['color: required']};
  let colors=0,fields=0,intents=0,rechecks=0;
  f.dependencies.prepareSourceColors=async()=>{colors++;const changed=f.drafts.get(draft.id)!;changed.attributes.item_package_weight=null;return {aiCalls:0,evidenceChanged:false};};
  f.dependencies.beginFieldRepair=()=>{intents++;return randomUUID();};
  f.dependencies.repairFields=async()=>{fields++;return draft;};f.dependencies.recheckImage=async()=>{rechecks++;return draft;};
  (f.service as any).controller=new AbortController();task.status='RUNNING';(f.service as any).grants.add(task.id);
  await assert.rejects((f.service as any).finishRepair(task,row),/定价/);
  assert.equal(colors,phase==='after-color'?1:0);assert.equal(fields,0);assert.equal(intents,0);assert.equal(rechecks,0);
});

test('pricing text without typed evidence requires evidence and never proves a rule rejection',async t=>{
  const f=fixture(t,'live'),prepare=f.dependencies.amazon.prepareDrafts;
  f.dependencies.amazon.prepareDrafts=async input=>{const result=await prepare(input),draft=result.items[0].draft!;draft.businessRules={revision:1,fields:{},notices:['售价上限内无法满足目标 ROI'],quote:null,bundleQuantity:1};f.drafts.set(draft.id,structuredClone(draft));return result;};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const row=f.service.get(task.id).items[0];assert.equal(row.status,'FAILED');assert.equal(row.outcome?.kind,'NEEDS_INPUT');assert.equal(row.outcome?.code,'PRICING_EVIDENCE_STALE');assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);
  const queue=await (f.service as any).queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(queue.products[0].pendingCount,1);assert.equal(queue.products[0].eligibleCount,0);
});

test('legacy unresolved single sale remains check-only when pure sales recipe planning is enabled',async t=>{
  const f=fixture(t);f.rules.pricing.bundleEnabled=false;f.failImages();
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();f.service.cancel(task.id);
  f.dependencies.planSales=()=>{throw Error('queue must never allocate identities');};
  const queue=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});
  assert.equal(queue.products[0].rows[0].kind,'UNKNOWN');assert.equal(queue.products[0].eligibleCount,0);
  await assert.rejects(f.create(),/没有可启动/);
});

test('an unlinked child submit intent takes precedence over a confirmed pricing rejection',async t=>{
  const f=fixture(t);installPricingFailure(f,draft=>{
    const child=f.dependencies.execution.create({draftIds:[draft.id],profileId:'alpha'});f.executions.get(child.id)!.items[0].submitStarted=true;
  });
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const row=f.service.get(task.id).items[0];assert.equal(row.outcome?.kind,'UNKNOWN');assert.equal(row.status,'FAILED');
  f.service.cancel(task.id);assert.equal((await f.service.queue({productIds:[f.product.id],targetId:f.target.id})).products[0].eligibleCount,0);
});

function installPricingFailure(f:ReturnType<typeof fixture>,change:(draft:AmazonDraft)=>void=()=>{}){
  const prepare=f.dependencies.amazon.prepareDrafts;
  f.dependencies.amazon.prepareDrafts=async (input,plans)=>{
    const value=await prepare(input,plans),draft=value.items[0].draft!;
    if(plans?.[0]){draft.sku=plans[0].sku;draft.salesPlan=plans[0];}
    draft.attributes={item_package_dimensions:[{length:{value:1,unit:'inches'},width:{value:1,unit:'inches'},height:{value:1,unit:'inches'}}],item_package_weight:[{value:1,unit:'pounds'}],number_of_items:[{value:1}]};
    draft.businessRules={revision:f.rules.revision,fields:{},notices:['ROI rule'],quote:null,bundleQuantity:1,pricingBasis:{kind:'source_sale_unit',sourceCostCny:100,quantity:1,saleUnitCostCny:100},
      pricingDecision:{version:1,status:'business_blocked',code:'ROI_MAX_PRICE',quoteError:'ROI_MAX_PRICE',inputs:{costCny:100,dimensionsInches:[1,1,1],weightPounds:1},evidence:{cost:'confirmed_cny',dimensions:'confirmed_source',weight:'confirmed_source',packageScope:'source_sale_unit',saleUnit:'confirmed',sourcePackage:{dimensionsInches:[1,1,1],weightPounds:1}}}};
    change(draft);f.drafts.set(draft.id,structuredClone(draft));return value;
  };
}
test('typed declaration conflict stays pending without becoming a rule rejection or a message-based decision',async t=>{
  const f=fixture(t,'live'),prepare=f.dependencies.amazon.prepareDrafts;f.rules.pricing.bundleEnabled=false;
  f.dependencies.amazon.prepareDrafts=async (...args)=>{
    const result=await prepare(...args),draft=result.items[0].draft!;
    draft.localIssues=[{code:'DECLARATION_SOURCE_CONFLICT',message:'Synthetic wording unrelated to classification',severity:'ERROR',source:'local',category:'compliance',autoFixable:false,attributeNames:['batteries_required']}];
    f.drafts.set(draft.id,structuredClone(draft));return result;
  };
  f.dependencies.images.complete=async input=>{f.workflow.set((input as {draftId:string}).draftId,{status:'BLOCKED',slots:[]});throw new UserFacingError('Unrelated display text');};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const row=f.service.get(task.id).items[0];assert.equal(row.status,'FAILED');assert.equal(row.outcome?.kind,'NEEDS_INPUT');assert.equal(row.outcome?.code,'DECLARATION_SOURCE_CONFLICT');
  assert.equal(f.calls.submissions,0);assert.doesNotThrow(()=>validateAutomaticListingTask(f.service.get(task.id)));
  const queue=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(queue.products[0].pendingCount,1);assert.equal(queue.products[0].filteredCount,0);
  await f.service.close();const reopened=new AutomaticListingService(f.directory,f.dependencies);try{assert.equal(reopened.get(task.id).items[0].outcome?.kind,'NEEDS_INPUT');}finally{await reopened.close();}
});
for(const cause of ['default-package','missing-cost','system','edited-draft','unknown-image','started-fields','submit-started'] as const)test(`pricing classification retains ${cause} without a paid retry`,async t=>{
  const f=fixture(t,'live');f.rules.pricing.bundleEnabled=false;
  installPricingFailure(f,draft=>{
    const d=draft.businessRules!.pricingDecision!;
    if(cause==='default-package'){d.status='needs_input';d.code='PACKAGE_INPUT_UNCONFIRMED';d.evidence.dimensions='business_default';}
    if(cause==='missing-cost'){d.status='needs_input';d.code='COST_CNY_UNCONFIRMED';d.quoteError=null;d.inputs.costCny=null;d.evidence.cost='unconfirmed';}
    if(cause==='system'){d.status='system_error';d.code='PRICING_SYSTEM_ERROR';d.quoteError=null;}
    if(cause==='edited-draft')draft.attributes.item_package_weight=[{value:2,unit:'pounds'}];
    if(cause==='unknown-image')f.workflow.set(draft.id,{status:'INTERRUPTED',slots:[{status:'UNKNOWN',attempts:[{state:'UNKNOWN'}]}]});
    if(cause==='started-fields')f.workflow.set(draft.id,{status:'INTERRUPTED',contentPreparation:{state:'STARTED'},slots:[]});
    if(cause==='submit-started'){draft.state='SUBMITTING';}
  });
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  let row=f.service.get(task.id).items[0];assert.equal(row.status,'FAILED');assert.equal(row.outcome?.kind,['unknown-image','started-fields','submit-started'].includes(cause)?'UNKNOWN':cause==='system'?'SYSTEM_REPAIR':'NEEDS_INPUT');
  const before=structuredClone(f.calls);f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.deepEqual(f.calls,before);
  await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);try{row=restored.get(task.id).items[0];assert.ok(row.outcome);const queue=await restored.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(queue.products[0].filteredCount,0);assert.equal(queue.products[0].pendingCount,1);}finally{await restored.close();}
});
test('per-recipe queue leaves a mixed recipe and healthy single when only one source single is screened',async t=>{
  const f=fixture(t,'live');f.product.variants[0].purchasePrice='0.1';f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO',originalSpec:'blue',sourceSpec:'blue',normalizedSpec:'blue'});
  const recipes=buildSalesRecipes(f.product,null,f.rules);assert.equal(recipes.length,3);
  // A verified image rule can reject one sales recipe without making a claim about shared components.
  let allocations=0;f.dependencies.planSales=()=>{allocations++;return recipes.map((recipe,i):SalesListingPlan=>({namingGroupId:randomUUID(),sourceGroupKey:'source-'+recipe.groupKey,collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:'SALE-'+i,baseSku:'SALE-'+i,recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'fixture',familyResolved:true,namingChildKey:null}));};
  const prepare=f.dependencies.amazon.prepareDrafts;f.dependencies.amazon.prepareDrafts=async(input,plans)=>{const result=await prepare(input,plans),draft=result.items[0].draft!;draft.sku=plans![0].sku;draft.salesPlan=plans![0];f.drafts.set(draft.id,structuredClone(draft));return result;};
  f.dependencies.images.complete=async()=>{throw new UserFacingError('image review stopped');};
  f.dependencies.images.getRuleFilterEvidence=async id=>{const draft=f.drafts.get(id)!;return draft.sku==='SALE-0'?{kind:'IP_PLAN_BLOCKED',workflowId:randomUUID(),resultId:randomUUID(),callId:randomUUID(),planResultId:randomUUID(),candidateId:null,contextSha256:'b'.repeat(64),draftRevision:draft.revision,references:[{id:randomUUID(),sha256:'c'.repeat(64)}],policyVersion:'product-image/vision-v3',message:'Confirmed IP rule'}:null;};
  const proofs=new Map<string,any>(),proof=f.dependencies.images.getRuleFilterEvidence;f.dependencies.images.getRuleFilterEvidence=async id=>{if(!proofs.has(id))proofs.set(id,await proof(id));return proofs.get(id);};
  f.dependencies.images.getProgress=()=>({status:'BLOCKED',slots:[]} as any);
  const before=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(before.products[0].rows.length,3);assert.equal(allocations,0);
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).items.filter(row=>row.status==='SCREENED').length,1);f.service.cancel(task.id);
  const snapshot=f.service.get(task.id),queue=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});
  assert.equal(queue.products[0].eligibleCount,2);assert.equal(queue.products[0].filteredCount,1);assert.equal(queue.products[0].rows.find(row=>row.recipeKey===recipes[2].key)?.eligible,true);assert.equal(allocations,1);assert.deepEqual(f.service.get(task.id),snapshot);
  const beforeRecipe=recipes[0].specification;recipes[0].specification+=' updated';f.dependencies.previewSales=()=>recipes;
  const recipeChanged=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(recipeChanged.products[0].eligibleCount,3);assert.match(recipeChanged.products[0].rows[0].reconsideration!,/配方/);recipes[0].specification=beforeRecipe;
  // A saved draft can change while the last recipe's local image bytes are checked.
  const goodDraft=[...f.drafts.values()].find(draft=>draft.sku==='SALE-1')!,oldState=goodDraft.state,currentProof=f.dependencies.images.getRuleFilterEvidence;
  f.dependencies.previewSales=()=>[recipes[1],recipes[2],recipes[0]];
  f.dependencies.images.getRuleFilterEvidence=async id=>{goodDraft.state='UNKNOWN';return currentProof!(id);};
  await assert.rejects(f.service.queue({productIds:[f.product.id],targetId:f.target.id}),/范围已变化/);assert.equal(allocations,1);
  goodDraft.state=oldState;f.dependencies.images.getRuleFilterEvidence=currentProof;f.dependencies.previewSales=()=>recipes;
  const next=await f.create();assert.deepEqual(next.items.map(row=>row.salesPlan!.recipe.key),recipes.slice(1).map(recipe=>recipe.key));assert.equal(allocations,2);
});
test('completed and confirmed submitted rows are not described as unknown and cannot create duplicates',async t=>{
  for(const mode of ['demo','live'] as const){const f=fixture(t,mode),task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();const queue=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(queue.products[0].rows[0].kind,mode==='demo'?'COMPLETED':'SUBMITTED');assert.equal(queue.products[0].eligibleCount,0);}
});

for(const cancelled of [false,true])test(`reconciled image UNKNOWN has a safe queue disposition for ${cancelled?'cancelled':'active'} tasks without rewriting audit`,async t=>{
  const f=fixture(t,'live');f.failImages();const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  if(cancelled)f.service.cancel(task.id);
  const audit=f.service.get(task.id),draftId=audit.items[0].draftId!;assert.equal(audit.items[0].outcome?.kind,'UNKNOWN');
  const unresolved=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(unresolved.products[0].rows[0].kind,'UNKNOWN');assert.equal(unresolved.products[0].eligibleCount,0);await assert.rejects(f.create(),/没有可启动/);
  // The dedicated reconciliation operation recovered the candidate: its durable attempt is GENERATED, slot PENDING.
  f.workflow.set(draftId,{status:'INTERRUPTED',slots:[{status:'PENDING',attempts:[{state:'GENERATED',candidateId:randomUUID()}]}]});
  const resolved=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(resolved.products[0].rows[0].kind,'SYSTEM_REPAIR');assert.equal(resolved.products[0].eligibleCount,cancelled?1:0);assert.match(resolved.products[0].rows[0].message,/已核对/);assert.deepEqual(f.service.get(task.id),audit);
  await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);
  try{
    assert.deepEqual(restored.get(task.id),audit);assert.equal((await restored.queue({productIds:[f.product.id],targetId:f.target.id})).products[0].eligibleCount,cancelled?1:0);
    const input={productIds:[f.product.id],targetId:f.target.id,profileId:'alpha'};
    if(cancelled)assert.equal((await restored.create(input)).items.length,1);else await assert.rejects(restored.create(input),/没有可启动/);
    const draft=f.drafts.get(draftId)!;draft.state='SUBMITTED';draft.submittedAt=new Date().toISOString();
    const submitted=await restored.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(submitted.products[0].rows[0].kind,'SUBMITTED');assert.equal(submitted.products[0].eligibleCount,0);await assert.rejects(restored.create(input),/没有可启动/);
    assert.deepEqual(restored.get(task.id),audit);
  }finally{await restored.close();}
  assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,0);
});

for(const interruption of [null,'after-bind','recheck'] as const)test(`legacy standalone family conversion keeps SKU/images across ${interruption??'normal execution'}`,async t=>{
 const f=fixture(t);const source=f.product.variants[0];
 f.product.variants.push({...source,id:randomUUID(),sku:'SKU-TWO',originalSpec:'blue',normalizedSpec:'blue',sourceSpec:'blue'});
 const recipes=buildSalesRecipes(f.product,null,f.rules),old=recipes.map((recipe,index):SalesListingPlan=>({namingGroupId:randomUUID(),sourceGroupKey:'local:'+f.product.id+':'+String(index+1).repeat(64),collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:f.product.variants[index].sku,baseSku:f.product.variants[index].sku,recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'legacy independent',familyResolved:true,namingChildKey:null}));
 const parentId=randomUUID(),fresh=old.map(p=>({...p,namingGroupId:parentId,sourceGroupKey:'local:'+f.product.id+':'+'a'.repeat(64),sku:'PARENT-'+p.sku,baseSku:'PARENT',namingChildKey:p.recipe.key}));
 f.dependencies.planSales=()=>structuredClone(old);const task=await f.create();f.dependencies.planSales=()=>structuredClone(fresh);
 f.dependencies.resolveFamily=async input=>input.plans.map(p=>({...p,parentage:'CHILD',parentSku:p.baseSku,variationTheme:'COLOR',familyResolved:true}));
 let binds=0,rechecks=0,parents=0,interrupted=false;
 f.dependencies.rebindFamily=async ({id,revision,plan})=>{const d=f.drafts.get(id)!;assert.equal(d.revision,revision);d.salesPlan=structuredClone(plan);d.schema.parentageLevel='CHILD';d.revision++;d.events=[{at:d.updatedAt,operation:'save',summary:FAMILY_REBIND_EVENT_SUMMARY,state:'DRAFT',requestId:null}];binds++;if(interruption==='after-bind'&&!interrupted){interrupted=true;throw Error('interrupted after saved bind');}return structuredClone(d);};
 f.dependencies.recheckImage=async input=>{rechecks++;assert.ok(f.workflow.get(input.draftId)?.slots.every((s:any)=>s.status==='PASSED'));if(interruption==='recheck'&&!interrupted){interrupted=true;throw Error('interrupted review');}return structuredClone(f.drafts.get(input.draftId)!);};
 f.dependencies.ensureParent=async child=>{parents++;assert.equal(child.salesPlan?.parentSku,'PARENT');return {draftId:parentId,ready:true};};
 const prepare=f.dependencies.amazon.prepareDrafts;f.dependencies.amazon.prepareDrafts=async (input,plans)=>{const r=await prepare(input,plans);for(const item of r.items)if(item.draft){f.drafts.get(item.draft.id)!.salesPlan=structuredClone(plans![0]);item.draft.salesPlan=structuredClone(plans![0]);}return r;};
 f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 if(interruption){
   assert.equal(f.service.get(task.id).items[0].familyTransition?.phase,interruption==='after-bind'?'BIND':'RECHECK');
   f.service.pause(task.id);await f.service.close();f.service=new AutomaticListingService(f.directory,f.dependencies);t.after(()=>f.service.close());
   f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 }
 const result=f.service.get(task.id);
 if(interruption)await f.service.close();
 assert.equal(result.items.filter(i=>i.status==='FAILED').length,0,JSON.stringify(result.items.map(i=>({sku:i.sku,error:i.error,transition:i.familyTransition?.phase}))));
 assert.equal(binds,2);assert.equal(rechecks,interruption==='recheck'?3:2);assert.equal(parents,2);assert.equal(f.calls.images,2);assert.equal(f.calls.submissions,2);
 assert.deepEqual(result.items.map(i=>i.sku),old.map(p=>p.sku));assert.ok(result.items.every(i=>i.salesPlan?.parentSku==='PARENT'&&!i.familyTransition));
});

test('one authorized start connects a missing-image draft through submission and real downstream readiness', async t => {
  const f = fixture(t); const task =await f.create();
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle(); await f.service.refreshWaiting();
  assert.equal(f.calls.submissions, 1, 'BLOCKED only for missing public images must reach the uploader');
  assert.equal(f.calls.images, 1);
  assert.equal(f.calls.batches, 1);
  assert.equal(f.service.get(task.id).status, 'COMPLETED');
  assert.equal(f.service.get(task.id).items[0].productRevision, f.product.revision);
});

test('automatic category is decided once per product after sources and saved before schema preparation', async t => {
  const f = fixture(t); let classifications = 0;
  f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'});
  f.dependencies.classify = async input => {
    classifications++; assert.equal(input.productRevision,f.product.revision); assert.equal(f.calls.sources,1);
    return {productType:'BOX',reason:'容器用途',keywords:['box'],candidateTypes:['BOX'],decisionIds:[randomUUID(),randomUUID()],judged:false,classifiedAt:new Date().toISOString()};
  };
  const prepare = f.dependencies.amazon.prepareDrafts;
  f.dependencies.amazon.prepareDrafts = async input => { assert.equal((input as any).productType,'BOX'); return prepare(input); };
  const task =await f.service.create({productIds:[f.product.id],targetId:f.target.id,profileId:'alpha'});
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  assert.equal(classifications,1); assert.equal(f.service.get(task.id).items.length,2);
  assert.ok(f.service.get(task.id).items.every(item=>item.classification?.productType==='BOX'));
});

test('child sales SKUs keep images while waiting for their parent and resume automatically without another generation',async t=>{
  const f=fixture(t,'live'),groupId=randomUUID(),parentDraftId=randomUUID();let parentReady=false;
  f.product.variants=['红色','蓝色'].map((color,i)=>({...f.product.variants[0],id:i?randomUUID():f.product.variants[0].id,sku:`SOURCE-${i}`,sourceSpec:`颜色: ${color} / 尺寸: 小号`,originalSpec:`颜色: ${color} / 尺寸: 小号`,normalizedSpec:'',purchasePrice:'0.1'}));
  const recipes=buildSalesRecipes(f.product,null,f.rules);
  f.dependencies.planSales=()=>recipes.map((recipe,i):SalesListingPlan=>({namingGroupId:groupId,sourceGroupKey:'same-model',collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:`H2-261008-1-${String.fromCharCode(65+i)}`,baseSku:'H2-261008-1',recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'待选类目',familyResolved:false,namingChildKey:recipe.key}));
  f.dependencies.resolveFamily=async({plans})=>plans.map(plan=>({...plan,parentage:'CHILD',parentSku:plan.baseSku,variationTheme:'COLOR',relationReason:'Schema 允许颜色',familyResolved:true}));
  const prepare=f.dependencies.amazon.prepareDrafts;
  f.dependencies.amazon.prepareDrafts=async(raw,plans)=>{
    assert.equal((raw as any).parentageLevel,'CHILD');const result=await prepare(raw,plans);
    const draft=result.items[0].draft!;draft.sku=plans![0].sku;draft.salesPlan=plans![0];draft.schema.parentageLevel='CHILD';f.drafts.set(draft.id,structuredClone(draft));return result;
  };
  f.dependencies.ensureParent=async child=>{assert.equal(f.workflow.get(child.id)?.status,'COMPLETED');return {draftId:parentDraftId,ready:parentReady};};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.calls.images,3);assert.equal(f.calls.submissions,0);assert.ok(f.service.get(task.id).items.every(row=>row.stage==='PARENT'&&row.status==='WAITING'));
  parentReady=true;f.setReady();await f.service.refreshWaiting();
  for(let i=0;i<6;i++){await new Promise(resolve=>setImmediate(resolve));await f.service.waitForIdle();}
  assert.equal(f.calls.images,3);assert.equal(f.calls.submissions,3);assert.equal(f.service.get(task.id).status,'COMPLETED');
});

test('accepted submission waits for platform readiness and does not submit again while observing labels', async t => {
  const f = fixture(t, 'live'); const task =await f.create();
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle(); await f.service.refreshWaiting();
  assert.equal(f.service.get(task.id).status, 'WAITING'); assert.equal(f.calls.batches, 0);
  f.setReady(); await f.service.refreshWaiting(); await f.service.refreshWaiting();
  assert.equal(f.service.get(task.id).status, 'COMPLETED');
  assert.equal(f.calls.submissions, 1); assert.equal(f.calls.batches, 1); assert.equal(f.calls.labels,0);
});

for(const action of ['pause','cancel'] as const)for(const resumeParents of [false,true])test(`readback ${action} during outcome proof stops sibling work${resumeParents?' and pending parent resume':''}`,async t=>{
  const f=fixture(t,'live');f.rules.product.variantLimit=3;
  const count=resumeParents?3:2;for(let index=1;index<count;index++)f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-'+index});
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  if(resumeParents){
    const saved=(f.service as any).tasks.get(task.id),parent=saved.items[0];parent.stage='PARENT';parent.parentDraftId=randomUUID();
    (f.service as any).grants.add(task.id);
  }
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<null>(resolve=>release=()=>resolve(null));
  const classify=(f.service as any).classifyFailure.bind(f.service);
  (f.service as any).classifyFailure=async(...args:any[])=>{await classify(...args);entered();await held;};
  f.dependencies.procurement.ensureAutomaticBatch=()=>{throw new UserFacingError('Local procurement fixture failure');};
  f.setReady();const pending=f.service.refreshWaiting();
  try {
    await reachedStage(started,pending,()=>f.service.get(task.id));
    f.service[action](task.id);const stopped=f.service.get(task.id),calls=structuredClone(f.calls);release();await pending;await new Promise(resolve=>setImmediate(resolve));await f.service.waitForIdle();
    const saved=f.service.get(task.id);assert.equal(saved.status,action==='pause'?'PAUSED':'CANCELLED');
    assert.equal(f.calls.batches,calls.batches);assert.equal(f.calls.labels,calls.labels);assert.equal(f.calls.submissions,calls.submissions);
    assert.deepEqual(saved.items.at(-1),stopped.items.at(-1),'the later readback row stays untouched');
  } finally {release();await pending;}
});

test('changed scope after native confirmation blocks before paid or remote work', async t => {
  const f = fixture(t); const task =await f.create(), approved = f.service.prepareStart(task.id);
  f.target.marketplaceId = 'different-site';
  assert.throws(() => f.service.startAuthorized(approved), /变化|范围|目标/);
  assert.equal(f.calls.images, 0); assert.equal(f.calls.submissions, 0);
});

test('pause during images revokes later publishing, and explicit resume reuses completed images', async t => {
  const f = fixture(t), task =await f.create();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.holdImages(entered); f.service.startAuthorized(f.service.prepareStart(task.id));
  await reachedStage(started,f.service.waitForIdle(),()=>f.service.get(task.id));
  f.service.pause(task.id); f.releaseImages(); await f.service.waitForIdle();
  assert.equal(f.calls.submissions, 0); assert.equal(f.service.get(task.id).status, 'PAUSED');
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle(); await f.service.refreshWaiting();
  assert.equal(f.calls.images, 1); assert.equal(f.calls.submissions, 1);
});

test('missing legacy workflow returns to its recovery owner and remains exceptional when recovery fails', async t => {
  const f = fixture(t), task =await f.create(); f.failImages();
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  assert.equal(f.calls.images, 2); assert.equal(f.calls.submissions, 0);
  assert.equal(f.service.get(task.id).status, 'NEEDS_ATTENTION');
});

test('disabling risk interception lets a blocked image workflow resume through its existing workflow',async t=>{
  const f=fixture(t),complete=f.dependencies.images.complete;let enabled=true;
  f.dependencies.images.getRiskSettings=()=>({enabled});
  f.dependencies.images.complete=async input=>{
    if(enabled){const draft=f.dependencies.amazon.getDraft((input as any).draftId),workflow={id:randomUUID(),draftId:draft.id,status:'BLOCKED',attempt:0,error:'商品 IP 初筛未通过',slots:[{status:'BLOCKED',attempts:[]}]};f.workflow.set(draft.id,workflow);return {draft,workflow} as any;}
    return complete(input);
  };
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(f.calls.submissions,0);
  enabled=false;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);
});

test('disabling copy review resumes a blocked workflow while risk interception remains enabled',async t=>{
  const f=fixture(t),complete=f.dependencies.images.complete;let enabled=true;
  f.dependencies.images.getRiskSettings=()=>({enabled:true});f.dependencies.images.getCopyReviewSettings=()=>({enabled});
  f.dependencies.images.complete=async input=>{
    if(enabled){const draft=f.dependencies.amazon.getDraft((input as any).draftId),workflow={id:randomUUID(),draftId:draft.id,status:'BLOCKED',attempt:0,error:'当前文案已用完两轮自动修复',slots:[{status:'BLOCKED',attempts:[]}]};f.workflow.set(draft.id,workflow);return {draft,workflow} as any;}
    return complete(input);
  };
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(f.calls.submissions,0);
  enabled=false;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);
});

test('an execution retry cannot publish completed images incompatible with current copy review policy',async t=>{
  const f=fixture(t);let compatible=true,starts=0;
  f.dependencies.images.isCopyReviewPolicyCompatible=()=>compatible;
  f.dependencies.execution.startAuthorized=approved=>{starts++;const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing field'}];return structuredClone(child);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(starts,1);
  compatible=false;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(starts,1);assert.match(f.service.get(task.id).items[0].error!,/复核/);assert.equal(f.calls.submissions,0);
});

test('an execution retry cannot publish completed images incompatible with the current risk policy',async t=>{
  const f=fixture(t);let compatible=true,starts=0;
  f.dependencies.images.isRiskPolicyCompatible=()=>compatible;
  f.dependencies.execution.startAuthorized=approved=>{starts++;const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing field'}];return structuredClone(child);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(starts,1);
  compatible=false;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(starts,1);assert.match(f.service.get(task.id).items[0].error!,/风险.*复核/);assert.equal(f.calls.submissions,0);
});

test('an infeasible saved price quote blocks before image generation and shows its real constraint', async t => {
  const f=fixture(t,'live'),prepare=f.dependencies.amazon.prepareDrafts,originalRules=structuredClone(f.rules);
  const reason='售价上限内无法满足目标 ROI，请核对采购成本、包装参数或定价设置';
  f.dependencies.amazon.prepareDrafts=async(...args)=>{const result=await prepare(...args),draft=result.items[0].draft!;
    const priced=applyBusinessRules({product:f.product,variant:f.product.variants[0],target:f.target,schema:realAmazonSchema(),attributes:{},measurements:{},costCny:100,now:new Date()},f.rules);
    draft.attributes=priced.attributes;draft.businessRules=priced.report;draft.businessRules.notices=[reason];
    draft.localIssues=[{code:'LOCAL_required',message:'our_price: missing',severity:'ERROR',attributeNames:['purchasable_offer'],category:'field',source:'local',autoFixable:false}];
    f.drafts.set(draft.id,structuredClone(draft));return result;};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const saved=f.service.get(task.id);assert.equal(saved.items[0].outcome?.code,'ROI_MAX_PRICE');assert.match(saved.items[0].outcome!.message,/上限/);
  assert.equal(saved.items[0].stage,'DRAFT');assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);assert.deepEqual(f.rules,originalRules);
  assert.equal(saved.items[0].status,'SCREENED');assert.throws(()=>f.service.prepareStart(task.id),/已经结束/);assert.equal(f.calls.images,0);
});

test('a definitive pricing constraint discovered during field repair is not sent for another paid repair',async t=>{
  const f=fixture(t,'live');let repairs=0,rechecks=0;
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'our_price missing'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{repairs++;const draft=f.drafts.get(id)!;draft.revision++;
    const priced=applyBusinessRules({product:f.product,variant:f.product.variants[0],target:f.target,schema:realAmazonSchema(),attributes:{},measurements:{},costCny:100,now:new Date()},f.rules);
    draft.attributes=priced.attributes;draft.businessRules=priced.report;return {draft:structuredClone(draft),remaining:['our_price missing']};};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(repairs,1);assert.equal(rechecks,0);assert.equal(f.service.get(task.id).items[0].outcome?.code,'ROI_MAX_PRICE');
  assert.equal(f.service.get(task.id).items[0].repair?.phase,'FIELDS_PENDING');
});

test('restart never silently resumes queued publishing authority', async t => {
  const f = fixture(t), task =await f.create(); await f.service.close();
  const db = openDatabase(f.directory);
  const record = JSON.parse(String(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id)!.record_json));
  record.status = 'RUNNING'; db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(record), task.id); db.close();
  const recovered = new AutomaticListingService(f.directory, f.dependencies);
  try { assert.equal(recovered.get(task.id).status, 'PAUSED'); assert.equal(f.calls.submissions, 0); }
  finally { await recovered.close(); }
});

test('readback-only continuation survives unrelated FTP and rule changes', async t => {
  const f = fixture(t, 'live'), task =await f.create();
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  f.service.pause(task.id); f.profile.generation++; f.rules.revision++;
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle(); f.setReady(); await f.service.refreshWaiting();
  assert.equal(f.service.get(task.id).status, 'COMPLETED'); assert.equal(f.calls.submissions, 1);
});

test('restore dialog suspension prevents background labels until cancellation resumes scheduling', async t => {
  const f=fixture(t,'live'),task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  f.service.suspendScheduling();f.setReady();await f.service.refreshWaiting();assert.equal(f.calls.batches,0);assert.equal(f.calls.labels,0);
  f.service.start();await f.service.refreshWaiting();assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(f.calls.submissions,1);
});

test('already edited current draft is reused after source preparation', async t => {
  const f = fixture(t);
  await f.dependencies.images.prepareSources({ productId: f.product.id, productRevision: f.product.revision, variantIds: [f.product.variants[0].id] });
  await f.dependencies.amazon.prepareDrafts({items:[{variantId:f.product.variants[0].id}]} as any);
  const draft = [...f.drafts.values()][0]; draft.attributes = { item_name: [{ value: 'Reviewed title' }] }; draft.state = 'LOCAL_VALIDATED';
  f.dependencies.images.prepareSources = async () => ({product:structuredClone(f.product),missing:[]}) as any;
  f.dependencies.amazon.prepareDrafts = async () => { throw Error('Must reuse existing edited draft'); };
  const task =await f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).items[0].draftId, draft.id); assert.equal(f.calls.submissions,1);
});

test('submitted sibling stays in readback while remaining variants prepare source images', async t => {
  const f = fixture(t, 'live'); f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'}); f.rules.product.variantLimit = 2;
  await f.dependencies.amazon.prepareDrafts({items:[{variantId:f.product.variants[0].id}]} as any);
  const sent = [...f.drafts.values()][0]; sent.submittedAt = new Date().toISOString(); sent.state = 'SUBMITTED';
  const task =await f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  const rows = f.service.get(task.id).items; assert.equal(rows[0].stage,'READBACK'); assert.equal(rows[0].draftId,sent.id);
  assert.equal(rows[1].stage,'READBACK'); assert.equal(f.calls.submissions,1); assert.equal(f.calls.sources,1);
});

test('source preparation stays retryable while every selected SKU is missing images', async t => {
  const f = fixture(t); f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'}); f.rules.product.variantLimit=2;
  let attempts=0;
  f.dependencies.images.prepareSources = async () => { f.product.revision++; return {product:structuredClone(f.product),missing:attempts++===0?f.product.variants.map(variant=>({variantId:variant.id,message:'Source download temporarily unavailable'})):[]}; };
  const task=await f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  assert.ok(f.service.get(task.id).items.every(row=>row.status==='FAILED'&&row.stage==='SOURCES'&&!row.sourcesPrepared));assert.equal(f.calls.images,0);
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(attempts,2);assert.equal(f.calls.submissions,2);assert.equal(f.calls.images,2);assert.equal(f.service.get(task.id).status,'COMPLETED');
});

for(const code of ['SOURCE_DOWNLOAD_FAILED','SOURCE_MAPPING_MISSING','SOURCE_MAPPING_INVALID','SOURCE_LINKS_MISSING','SOURCE_BINDING_UNCONFIRMED',undefined] as const)test(`source failure ${code??'legacy'} retains its classification across restart`,async t=>{
  const f=fixture(t);f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'});
  f.dependencies.images.prepareSources=async()=>({product:structuredClone(f.product),missing:f.product.variants.map(variant=>({variantId:variant.id,message:'Synthetic source diagnostic',...(code?{code}:{})}))});
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const kind=['SOURCE_DOWNLOAD_FAILED','SOURCE_MAPPING_MISSING','SOURCE_MAPPING_INVALID'].includes(code??'')?'SYSTEM_REPAIR':'NEEDS_INPUT';
  const saved=f.service.get(task.id);for(const row of saved.items){assert.equal(row.outcome?.kind,kind);assert.equal(row.outcome?.code,code??'SOURCE_INPUT_REQUIRED');assert.equal(row.status,'FAILED');}
  assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);
  try{assert.deepEqual(restored.get(task.id),saved);const queue=await restored.queue({productIds:[f.product.id],targetId:f.target.id});assert.ok(queue.products[0].rows.every(row=>row.kind===kind));}finally{await restored.close();}
});

for (const missingIndex of [0, 1]) test(`source preparation releases ready SKUs when row ${missingIndex + 1} is missing its own reference`, async t => {
  const f = fixture(t);
  f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'}); f.rules.product.variantLimit=2;
  const missingVariant = f.product.variants[missingIndex];
  f.dependencies.images.prepareSources = async input => {
    f.calls.sources++;
    assert.deepEqual(new Set((input as any).variantIds),new Set(f.product.variants.map(variant=>variant.id)));
    f.product.revision++;
    return {product:structuredClone(f.product),missing:[{variantId:missingVariant.id,message:`No mapped image for ${missingVariant.sku}`}]};
  };
  const task=await f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  const rows=f.service.get(task.id).items, missing=rows[missingIndex], ready=rows[1-missingIndex];
  assert.equal(ready.status,'DONE', 'a sibling source failure must not be attributed to a ready SKU');
  assert.equal(ready.sourcesPrepared,true); assert.equal(ready.error,null);
  assert.equal(missing.status,'FAILED'); assert.equal(missing.stage,'SOURCES'); assert.equal(missing.sourcesPrepared,false);
  assert.match(missing.error!,new RegExp(`No mapped image for ${missingVariant.sku}`));
  assert.equal(missing.draftId,null); assert.equal(missing.imageStarted,false);
  assert.equal(f.calls.sources,1); assert.equal(f.calls.images,1); assert.equal(f.calls.submissions,1);
});

test('resuming missing sources after restart preserves ready sibling image and submitted draft revisions', async t => {
  const f=fixture(t); f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'}); f.rules.product.variantLimit=2;
  f.dependencies.images.prepareSources=async()=>{
    f.calls.sources++; f.product.revision++;
    return {product:structuredClone(f.product),missing:f.calls.sources===1?[{variantId:f.product.variants[1].id,message:'Source download temporarily unavailable'}]:[]};
  };
  const task=await f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  const frozenRevision=f.product.revision;
  await f.service.close();
  const restored=new AutomaticListingService(f.directory,f.dependencies);
  try {
    restored.startAuthorized(restored.prepareStart(task.id)); await restored.waitForIdle();
    const rows=restored.get(task.id).items;
    assert.equal(f.product.revision,frozenRevision,'retry must not download new sources after a sibling has frozen its revision');
    assert.equal(f.calls.sources,1); assert.equal(f.calls.images,1); assert.equal(f.calls.submissions,1);
    assert.equal(rows[0].status,'DONE'); assert.equal(f.drafts.get(rows[0].draftId!)?.productRevision,frozenRevision);
    assert.equal(rows[1].stage,'SOURCES'); assert.equal(rows[1].status,'FAILED'); assert.equal(rows[1].sourcesPrepared,false);
    assert.match(rows[1].error!,/Source download temporarily unavailable/);
    assert.match(rows[1].error!,/来源版本已冻结/);
  } finally { await restored.close(); }
});

test('frozen legacy source error is refined from receipt mappings without downloading or changing siblings', async t => {
  const f=fixture(t);f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'});f.rules.product.variantLimit=2;
  f.dependencies.images.prepareSources=async()=>{f.calls.sources++;return {product:structuredClone(f.product),missing:[{variantId:f.product.variants[1].id,message:'缺少可确定属于该 SKU 的可用来源图片'}]};};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  f.dependencies.sourceReceipt=()=>({snapshot:{sources:[],dimensions:[],attributes:[],description:'',skus:f.product.variants.map(v=>({key:v.id})),images:[{id:'source',url:'https://example.test/source.png'}]},mapping:{skus:[],currency:'unknown'},skuMappings:[{localVariantId:f.product.variants[1].id,imageIds:[]}]} as any);
  const revision=f.product.revision;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const rows=f.service.get(task.id).items;
  assert.match(rows[1].error!,/商品有来源图片.*映射为空/);assert.match(rows[1].error!,/来源版本已冻结/);
  assert.equal(rows[1].outcome?.kind,'NEEDS_INPUT');assert.equal(rows[1].outcome?.code,'SOURCE_BINDING_UNCONFIRMED');
  assert.equal(f.calls.sources,1);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);assert.equal(f.product.revision,revision);assert.equal(rows[0].status,'DONE');
});

test('confirmed source binding can recover an untouched SKU after its sibling submitted, preserving that submitted revision',async t=>{
  const f=fixture(t);f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'});f.rules.product.variantLimit=2;
  f.dependencies.images.prepareSources=async()=>{f.calls.sources++;return {product:structuredClone(f.product),missing:f.calls.sources===1?[{variantId:f.product.variants[1].id,message:'SKU 图片映射为空'}]:[]};};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const first=f.service.get(task.id).items[0],submittedRevision=f.drafts.get(first.draftId!)!.productRevision;
  f.product.revision++;f.product.assets.push({id:randomUUID(),variantIds:[f.product.variants[1].id]} as any);
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(f.calls.sources,2);assert.equal(f.calls.images,2);assert.equal(f.calls.submissions,2);
  assert.equal(f.drafts.get(first.draftId!)!.productRevision,submittedRevision);assert.equal(f.service.get(task.id).items[0].productRevision,submittedRevision);
});

test('a new source binding cannot rebase a sibling whose paid images are unfinished',async t=>{
  const f=fixture(t);f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'});f.rules.product.variantLimit=2;f.failImages();
  f.dependencies.images.prepareSources=async()=>({product:structuredClone(f.product),missing:[{variantId:f.product.variants[1].id,message:'SKU 图片映射为空'}]});
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  f.product.revision++;f.product.assets.push({id:randomUUID(),variantIds:[f.product.variants[1].id]} as any);
  assert.throws(()=>f.service.prepareStart(task.id),/变化|冻结/);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,0);
});

test('a saved legacy task with twenty blocked source rows screens excess rows and resumes selected mapped SKUs', async t => {
  const f=fixture(t); f.rules.product.variantLimit=20;
  f.product.variants=Array.from({length:20},(_,index)=>({...f.product.variants[0],id:randomUUID(),sku:`SKU-${index+1}`}));
  const selected=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});
  const selectedIds=new Set(selected.products[0].rows.map(r=>r.recipeKey));
  const missingIds=[...selectedIds].slice(0,1);
  f.dependencies.images.prepareSources=async()=>{
    f.calls.sources++;
    return {product:structuredClone(f.product),missing:missingIds.map(variantId=>({variantId,message:'No source mapping for this SKU'}))};
  };
  const task=await f.create(); await f.service.close();
  task.status='PAUSED';
  task.items=f.product.variants.map(variant=>({...structuredClone(task.items[0]),key:f.product.id+':'+variant.id,variantId:variant.id,sku:variant.sku}));
  for(const [index,row] of task.items.entries()){
    row.status='FAILED'; row.error=index===0||missingIds.includes(row.variantId)?'No source mapping for this SKU':'Waiting for sibling sources';
  }
  const db=openDatabase(f.directory);
  db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),task.id); db.close();
  const restored=new AutomaticListingService(f.directory,f.dependencies);
  try {
    restored.startAuthorized(restored.prepareStart(task.id)); await restored.waitForIdle();
    const rows=restored.get(task.id).items;
    assert.equal(rows.length,20); assert.equal(rows.filter(row=>row.status==='DONE').length,3);assert.equal(rows.filter(row=>row.status==='SCREENED').length,16);
    assert.deepEqual(rows.filter(row=>row.status==='FAILED').map(row=>row.variantId),missingIds);
    assert.equal(f.calls.sources,1); assert.equal(f.calls.images,3); assert.equal(f.calls.submissions,3);
  } finally { await restored.close(); }
});

test('a missing component blocks its mixed sales SKU while a ready sibling retains the whole family plan', async t => {
  const f=fixture(t),groupId=randomUUID();
  f.product.variants=['red','blue'].map(color=>({...f.product.variants[0],id:randomUUID(),sku:`SOURCE-${color}`,originalSpec:`Color: ${color} / Size: small`,normalizedSpec:'',purchasePrice:'0.1'}));
  const recipes=buildSalesRecipes(f.product,null,f.rules);
  assert.equal(recipes.length,3); assert.equal(recipes[2].components.length,2);
  f.dependencies.planSales=()=>recipes.map((recipe,index):SalesListingPlan=>({namingGroupId:groupId,sourceGroupKey:'same-model',collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:`H2-261008-1-${String.fromCharCode(65+index)}`,baseSku:'H2-261008-1',recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'Pending category',familyResolved:false,namingChildKey:recipe.key}));
  let familySize=0,parents=0;
  f.dependencies.resolveFamily=async({plans})=>{familySize=plans.length;return plans.map(plan=>({...plan,parentage:'CHILD',parentSku:plan.baseSku,variationTheme:'COLOR',familyResolved:true}));};
  f.dependencies.ensureParent=async()=>{parents++;return {draftId:randomUUID(),ready:true};};
  const prepare=f.dependencies.amazon.prepareDrafts;
  f.dependencies.amazon.prepareDrafts=async(raw,plans)=>{
    const result=await prepare(raw); const draft=result.items[0].draft!;
    draft.sku=plans![0].sku;draft.salesPlan=plans![0];draft.schema.parentageLevel='CHILD';f.drafts.set(draft.id,structuredClone(draft));return result;
  };
  f.dependencies.images.prepareSources=async input=>{
    assert.deepEqual(new Set((input as any).variantIds),new Set(f.product.variants.map(variant=>variant.id)));
    return {product:structuredClone(f.product),missing:[{variantId:f.product.variants[1].id,message:'Blue has no source mapping'}]};
  };
  const task=await f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  const rows=f.service.get(task.id).items;
  assert.equal(rows[0].status,'DONE'); assert.equal(familySize,3); assert.equal(parents,1);
  assert.equal(rows.length,3); assert.equal(f.calls.images,1); assert.equal(f.calls.submissions,1);
  for(const row of rows.slice(1)) { assert.equal(row.status,'FAILED'); assert.equal(row.stage,'SOURCES'); assert.equal(row.draftId,null); assert.match(row.error!,/Blue has no source mapping/); }
});

test('one invalid sales plan is persisted as an exception while other selected products continue',async t=>{
  const f=fixture(t),bad=structuredClone(f.product);bad.id=randomUUID();bad.variants[0].id=randomUUID();bad.title='Conflicting pack';bad.variants[0].sku='BAD-SOURCE';
  f.dependencies.store.getProduct=id=>structuredClone(id===bad.id?bad:f.product);
  const recipe=buildSalesRecipes(f.product,null,f.rules)[0];
  const plan:SalesListingPlan={namingGroupId:randomUUID(),sourceGroupKey:'source',collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:'SALE-ONE',baseSku:'SALE-ONE',recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'fixture',familyResolved:true,namingChildKey:null};
  f.dependencies.planSales=id=>{if(id===bad.id)throw new UserFacingError('10个装与20个装冲突');return [plan];};
  f.dependencies.previewSales=id=>{if(id===bad.id)throw new UserFacingError('10个装与20个装冲突');return [recipe];};
  const prepare=f.dependencies.amazon.prepareDrafts;f.dependencies.amazon.prepareDrafts=async(input,plans)=>{const result=await prepare(input,plans),draft=result.items[0].draft!;draft.salesPlan=plans![0];draft.sku=plans![0].sku;f.drafts.set(draft.id,structuredClone(draft));return result;};
  const queue=await f.service.queue({productIds:[bad.id,f.product.id],targetId:f.target.id});
  assert.deepEqual(queue.products[0].rows,[],'an unresolved recipe must not become a guessed sales SKU');
  assert.equal(queue.products[0].eligibleCount,0);assert.match(queue.products[0].inputIssue!,/10个装/);
  await assert.rejects(f.service.create({productIds:[bad.id],targetId:f.target.id,profileId:'alpha'}),/销售配方待补资料.*10个装/);
  const task=await f.service.create({productIds:[bad.id,f.product.id],targetId:f.target.id,profileId:'alpha',productType:'BOX'});
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.calls.submissions,1);assert.equal(f.service.get(task.id).items[0].stage,'PLAN');assert.equal(f.service.get(task.id).items[0].status,'FAILED');
  assert.equal(f.service.get(task.id).items[1].status,'DONE');
});

test('field repair may defer a required planned main URL after color is repaired',async t=>{
  const f=fixture(t),start=f.dependencies.execution.startAuthorized;let attempts=0,rechecks=0;
  const missing=(field:string)=>({code:'LOCAL_required',message:`${field}：缺少必填字段`,severity:'ERROR' as const,attributeNames:[field],category:'field' as const,source:'local' as const,autoFixable:false});
  f.dependencies.execution.startAuthorized=task=>{
    if(attempts++===0){const draft=f.drafts.get(task.items[0].draftId)!;draft.localIssues=[missing('color'),missing('main_product_image_locator')];const child=f.executions.get(task.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing fields'}];return structuredClone(child);}return start(task);
  };
  f.dependencies.repairFields=async id=>{const draft=f.drafts.get(id)!;draft.revision++;draft.attributes.color=[{value:'Red'}];draft.localIssues=[missing('main_product_image_locator')];return {draft:structuredClone(draft),remaining:[`main_product_image_locator：${draft.localIssues[0].message}`]};};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(rechecks,1);assert.equal(f.calls.submissions,1);
});

test('definitively rejected submission repairs only that child and rechecks existing images',async t=>{
  const f=fixture(t),start=f.dependencies.execution.startAuthorized;let attempts=0,repairs=0,rechecks=0;
  f.dependencies.execution.startAuthorized=task=>{
    if(attempts++===0){const value=f.executions.get(task.id)!;value.status='NEEDS_ATTENTION';value.items[0].submitStarted=false;value.items[0].steps=[{name:'submit',status:'FAILED',attempts:1,error:'INVALID item_name'}];return structuredClone(value);}return start(task);
  };
  f.dependencies.repairFields=async id=>{repairs++;const draft=f.drafts.get(id)!;draft.revision++;draft.attributes={item_name:[{value:'Corrected'}]};return structuredClone(draft);};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(repairs,1);assert.equal(rechecks,1);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);
});

for (const source of ['local', 'preview', 'remaining'] as const) test(`unresolved ${source} field repair stops before image recheck or replacement execution`, async t => {
  const f=fixture(t);let rechecks=0;
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing fields'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{
    const draft=f.drafts.get(id)!;draft.revision++;
    const issues=['color','subject_character','theme'].map(field=>({code:'LOCAL_required',message:`${field}: missing`,severity:'ERROR' as const,attributeNames:[field],category:'field' as const,source:'local' as const,autoFixable:false}));
    if(source==='local')draft.localIssues=issues;
    if(source==='preview')draft.previewIssues=issues;
    return source==='remaining'?{draft:structuredClone(draft),remaining:['color: evidence insufficient']}:structuredClone(draft);
  };
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const saved=f.service.get(task.id);
  assert.equal(saved.status,'NEEDS_ATTENTION');assert.match(saved.items[0].error!,/color/);
  assert.equal(rechecks,0);assert.equal(f.executions.size,1);assert.equal(f.calls.submissions,0);
  assert.equal(saved.items[0].repair?.phase,'FIELDS_PENDING');assert.equal(saved.items[0].repairAttempts,2);
});

test('an incomplete first repair continues fields alone and rechecks images only after success', async t => {
  const f=fixture(t),start=f.dependencies.execution.startAuthorized;let fields=0,rechecks=0,starts=0;
  f.dependencies.execution.startAuthorized=approved=>{if(starts++>0)return start(approved);const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing color'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{fields++;const draft=f.drafts.get(id)!;draft.revision++;return {draft:structuredClone(draft),remaining:fields===1?['color: missing']:[]};};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(fields,2);assert.equal(rechecks,1);assert.equal(f.executions.size,2);assert.equal(f.calls.images,1);
});

test('known incomplete repair survives pause and restart with its remaining reason and budget', async t => {
  const f=fixture(t);let fields=0,rechecks=0,taskId='';
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing fields'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{fields++;if(fields===1)f.service.pause(taskId);return {draft:f.dependencies.amazon.getDraft(id),remaining:['subject_character: evidence missing']};};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=await f.create();taskId=task.id;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.deepEqual(f.service.get(task.id).items[0].repair?.remaining,['subject_character: evidence missing']);
  await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);
  try {
    for(let i=0;i<2;i++){restored.startAuthorized(restored.prepareStart(task.id));await restored.waitForIdle();assert.match(restored.get(task.id).items[0].error!,/subject_character/);}
    assert.equal(fields,2);assert.equal(rechecks,0);assert.equal(f.executions.size,1);assert.equal(f.calls.images,1);
  } finally {await restored.close();}
});

for(const {field,spec,eligible} of [
  {field:'theme',spec:'red',eligible:true},{field:'subject_character',spec:'red',eligible:true},{field:'color',spec:'red',eligible:false},
  {field:'color',spec:'夜光本色',eligible:true},{field:'color',spec:'松针绿',eligible:true},
  {field:'target_audience',spec:'red',eligible:true},{field:'fabric_type',spec:'red',eligible:true},
]) test(`legacy exhausted ${field} ${spec} repair receives only its eligible one-time capability migration`,async t=>{
  const f=fixture(t);let fields=0;
  f.product.variants[0].sourceSpec=spec;f.product.variants[0].normalizedSpec=spec;f.product.variants[0].originalSpec=spec;f.product.variants[0].sourceSpec=spec;f.product.variants[0].normalizedSpec=spec;f.product.variants[0].normalizedSpec=spec;
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing fields'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{fields++;const draft=f.drafts.get(id)!;draft.revision++;
    draft.localIssues=[{code:'LOCAL_required',message:`${field}: missing`,severity:'ERROR',attributeNames:[field],category:'field',source:'local',autoFixable:false}];return structuredClone(draft);};
  f.dependencies.recheckImage=async input=>f.dependencies.amazon.getDraft(input.draftId);
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(fields,2);
  await f.service.close();const db=openDatabase(f.directory),legacy=JSON.parse(String(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id)!.record_json));
  delete legacy.items[0].repairPolicyVersion;delete legacy.items[0].repairPolicyMigration;
  db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(legacy),task.id);db.close();
  for(let reopen=0;reopen<2;reopen++){
    const restored=new AutomaticListingService(f.directory,f.dependencies);
    try{restored.startAuthorized(restored.prepareStart(task.id));await restored.waitForIdle();
      const row=restored.get(task.id).items[0];assert.equal(row.repairAttempts,eligible?3:2);
      if(eligible){assert.deepEqual(row.repairPolicyMigration?.fields,[field]);assert.equal(row.repairPolicyMigration?.previousAttempts,2);assert.equal(row.repairPolicyMigration?.grantedAttempts,1);assert.ok(row.repairPolicyMigration?.grantedAt);}
      else assert.equal(row.repairPolicyMigration,undefined);
    }finally{await restored.close();}
  }
  assert.equal(fields,eligible?3:2);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,0);
});

test('unknown repair failure retains its original cause without replaying the field request', async t => {
  const f=fixture(t);let fields=0;
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing color'}];return structuredClone(child);};
  f.dependencies.repairFields=async()=>{fields++;throw new Error('Network fetch failed');};
  f.dependencies.recheckImage=async input=>f.dependencies.amazon.getDraft(input.draftId);
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const original=f.service.get(task.id).items[0].error!;
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.ok(f.service.get(task.id).items[0].error!.includes(original));assert.equal(fields,1);
});

async function exhaustedColorFixture(t:test.TestContext) {
  const f=fixture(t),originalStart=f.dependencies.execution.startAuthorized;let fields=0,rechecks=0;
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing color'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{fields++;return {draft:f.dependencies.amazon.getDraft(id),remaining:['color: source evidence insufficient']};};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(fields,2);assert.equal(f.service.get(task.id).items[0].repair?.phase,'FIELDS_PENDING');
  return {...f,task,originalStart,get fields(){return fields;},get rechecks(){return rechecks;}};
}

for(const outcome of ['incomplete','unknown','repaired','current-policy'] as const)test(`category capability migration is bounded across restart: ${outcome}`,async t=>{
  const f=await exhaustedColorFixture(t),saved=f.service.get(f.task.id);await f.service.close();
  const row=saved.items[0];row.repair!.remaining=['age_range_description: required'];
  if(outcome==='current-policy')(row as any).categoryFieldPolicyVersion='category-inference/v1';else delete (row as any).categoryFieldPolicyVersion;
  const db=openDatabase(f.directory);db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(saved),saved.id);db.close();
  let repairs=0;
  f.dependencies.repairFields=async id=>{repairs++;if(outcome==='unknown')throw Error('Category response unknown');return {draft:f.dependencies.amazon.getDraft(id),remaining:outcome==='repaired'?[]:['age_range_description: required']};};
  if(outcome==='repaired')f.dependencies.execution.startAuthorized=f.originalStart;
  for(let i=0;i<(outcome==='repaired'?1:2);i++){
    const restored=new AutomaticListingService(f.directory,f.dependencies);
    try{restored.startAuthorized(restored.prepareStart(saved.id));await restored.waitForIdle();const item=restored.get(saved.id).items[0];
      assert.equal(item.repairAttempts,outcome==='current-policy'?2:3);
      if(outcome!=='current-policy')assert.deepEqual((item as any).categoryFieldRepair?.fields,['age_range_description']);
      if(outcome==='unknown')assert.equal(item.repair?.phase,'FIELDS_STARTED');
      assert.deepEqual(validateAutomaticListingTask(restored.get(saved.id)),restored.get(saved.id));
    }finally{await restored.close();}
  }
  assert.equal(repairs,outcome==='current-policy'?0:1);assert.equal(f.calls.images,1);assert.equal(f.rechecks,outcome==='repaired'?1:0);
});

test('category repair can follow both prior capability and color grants without losing either history',async t=>{
  const f=await exhaustedColorFixture(t),saved=f.service.get(f.task.id);await f.service.close();const row=saved.items[0];
  delete (row as any).categoryFieldPolicyVersion;row.repairAttempts=4;row.repair!.remaining=['item_firmness_description: required'];
  row.repairPolicyMigration={version:'field-evidence/v2',previousAttempts:2,grantedAttempts:1,grantedAt:new Date().toISOString(),fields:['color']};
  row.sourceColorEvidenceSha256='a'.repeat(64);row.sourceColorRepair={evidenceSha256:row.sourceColorEvidenceSha256,previousAttempts:3,grantedAttempts:1,grantedAt:new Date().toISOString()};
  const db=openDatabase(f.directory);db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(saved),saved.id);db.close();
  let repairs=0;f.dependencies.repairFields=async id=>{repairs++;return {draft:f.dependencies.amazon.getDraft(id),remaining:['item_firmness_description: required']};};
  const restored=new AutomaticListingService(f.directory,f.dependencies);
  try{restored.startAuthorized(restored.prepareStart(saved.id));await restored.waitForIdle();const result=restored.get(saved.id),item=result.items[0];
    assert.equal(repairs,1);assert.equal(item.repairAttempts,5);assert.deepEqual(item.sourceColorRepair,row.sourceColorRepair);assert.deepEqual(item.repairPolicyMigration,row.repairPolicyMigration);
    assert.deepEqual(validateAutomaticListingTask(result),result);
    const history=structuredClone(result);history.items[0].executionTaskIds=Array.from({length:6},()=>randomUUID());assert.deepEqual(validateAutomaticListingTask(history),history);
    for(const change of ['missing-grant','previous','fields','count'] as const){const bad=structuredClone(result) as any;if(change==='missing-grant')delete bad.items[0].categoryFieldRepair;if(change==='previous')bad.items[0].categoryFieldRepair.previousAttempts=3;if(change==='fields')bad.items[0].categoryFieldRepair.fields=['color'];if(change==='count')bad.items[0].repairAttempts=6;assert.throws(()=>validateAutomaticListingTask(bad));}
    restored.startAuthorized(restored.prepareStart(saved.id));await restored.waitForIdle();assert.equal(repairs,1);
  }finally{await restored.close();}
});

test('a new source color grant after category and old capability grants has one final bounded attempt',async t=>{
  const f=await exhaustedColorFixture(t),saved=f.service.get(f.task.id);await f.service.close();const row=saved.items[0] as any;
  row.repairAttempts=4;row.repairPolicyMigration={version:'field-evidence/v2',previousAttempts:2,grantedAttempts:1,grantedAt:new Date().toISOString(),fields:['color']};
  row.categoryFieldPolicyVersion='category-inference/v1';row.categoryFieldRepair={version:row.categoryFieldPolicyVersion,previousAttempts:3,grantedAttempts:1,grantedAt:new Date().toISOString(),fields:['age_range_description']};
  const db=openDatabase(f.directory);db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(saved),saved.id);db.close();
  let repairs=0;f.dependencies.prepareSourceColors=async()=>({aiCalls:0,evidenceChanged:false,evidenceSha256:'b'.repeat(64)});f.dependencies.repairFields=async id=>{repairs++;return {draft:f.dependencies.amazon.getDraft(id),remaining:['color: required']};};
  const restored=new AutomaticListingService(f.directory,f.dependencies);try{for(let i=0;i<2;i++){restored.startAuthorized(restored.prepareStart(saved.id));await restored.waitForIdle();}const result=restored.get(saved.id);assert.equal(repairs,1);assert.equal(result.items[0].repairAttempts,5);assert.equal(result.items[0].sourceColorRepair?.previousAttempts,4);assert.deepEqual(validateAutomaticListingTask(result),result);}finally{await restored.close();}
});

for(const guard of ['STARTED','submitted','PARENT','unrelated','edited','submitStarted'] as const)test(`category migration preserves ${guard} protection`,async t=>{
  const f=await exhaustedColorFixture(t),saved=f.service.get(f.task.id);await f.service.close();const row=saved.items[0] as any,draft=f.drafts.get(row.draftId)!;
  delete row.categoryFieldPolicyVersion;row.repair.remaining=[guard==='unrelated'?'batteries_required: missing':'age_range_description: missing'];
  if(guard==='STARTED')row.repair.phase='FIELDS_STARTED';if(guard==='submitted'){draft.submittedAt=new Date().toISOString();draft.state='SUBMITTED';}if(guard==='PARENT')draft.schema.parentageLevel='PARENT';if(guard==='edited')draft.revision++;if(guard==='submitStarted')f.executions.get(row.executionTaskIds[0])!.items[0].submitStarted=true;
  const db=openDatabase(f.directory);db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(saved),saved.id);db.close();let repairs=0;f.dependencies.repairFields=async id=>{repairs++;return f.dependencies.amazon.getDraft(id);};
  const restored=new AutomaticListingService(f.directory,f.dependencies);try{restored.startAuthorized(restored.prepareStart(saved.id));await restored.waitForIdle();assert.equal(repairs,0);assert.equal(restored.get(saved.id).items[0].categoryFieldRepair,undefined);}finally{await restored.close();}
});

test('cached new source color evidence grants one persisted repair without resetting exhausted history',async t=>{
  const f=await exhaustedColorFixture(t),hash='c'.repeat(64);let repaired=0;
  f.dependencies.prepareSourceColors=async()=>({aiCalls:0,evidenceChanged:false,evidenceSha256:hash});
  f.dependencies.repairFields=async id=>{repaired++;const draft=f.drafts.get(id)!;draft.revision++;draft.attributes.color=[{value:'Green'}];return {draft:structuredClone(draft),remaining:[]};};
  f.dependencies.execution.startAuthorized=f.originalStart;
  f.service.startAuthorized(f.service.prepareStart(f.task.id));await f.service.waitForIdle();
  const saved=f.service.get(f.task.id),row=saved.items[0];
  assert.equal(saved.status,'COMPLETED',row.error??'');assert.equal(repaired,1);assert.equal(row.repairAttempts,3);
  assert.deepEqual(row.sourceColorRepair,{evidenceSha256:hash,previousAttempts:2,grantedAttempts:1,grantedAt:row.sourceColorRepair?.grantedAt});
  assert.equal(row.sourceColorEvidenceSha256,hash);assert.equal(f.rechecks,1);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);
  assert.deepEqual(validateAutomaticListingTask(saved),saved);
  await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);
  try{assert.deepEqual(restored.get(f.task.id).items[0].sourceColorRepair,row.sourceColorRepair);}finally{await restored.close();}
});

test('same source color evidence cannot grant another repair across repeated reopen',async t=>{
  const f=await exhaustedColorFixture(t),hash='d'.repeat(64);let extra=0;
  f.dependencies.prepareSourceColors=async()=>({aiCalls:0,evidenceChanged:false,evidenceSha256:hash});
  f.dependencies.repairFields=async id=>{extra++;return {draft:f.dependencies.amazon.getDraft(id),remaining:['color: source evidence insufficient']};};
  f.service.startAuthorized(f.service.prepareStart(f.task.id));await f.service.waitForIdle();
  assert.equal(extra,1);assert.equal(f.service.get(f.task.id).items[0].repairAttempts,3);
  await f.service.close();
  for(let repeat=0;repeat<2;repeat++){
    const restored=new AutomaticListingService(f.directory,f.dependencies);
    try{restored.startAuthorized(restored.prepareStart(f.task.id));await restored.waitForIdle();assert.equal(restored.get(f.task.id).items[0].repairAttempts,3);}finally{await restored.close();}
  }
  assert.equal(extra,1);assert.equal(f.rechecks,0);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,0);
});

test('color evidence already used within the original two repairs does not extend their budget',async t=>{
  const f=fixture(t),hash='e'.repeat(64);let fields=0;
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing color'}];const draft=f.drafts.get(child.items[0].draftId)!;draft.localIssues=[{code:'LOCAL_required',message:'Missing color',severity:'ERROR',attributeNames:['color'],category:'field',source:'local',autoFixable:false}];return structuredClone(child);};
  f.dependencies.prepareSourceColors=async()=>({aiCalls:0,evidenceChanged:false,evidenceSha256:hash});
  f.dependencies.repairFields=async id=>{fields++;return {draft:f.dependencies.amazon.getDraft(id),remaining:['color: missing']};};
  f.dependencies.recheckImage=async input=>f.dependencies.amazon.getDraft(input.draftId);
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const row=f.service.get(task.id).items[0];assert.equal(fields,2);assert.equal(row.repairAttempts,2);assert.equal(row.sourceColorEvidenceSha256,hash);assert.equal(row.sourceColorRepair,undefined);
});

test('unknown source color field repair consumes its grant before calling and never replays after restart',async t=>{
  const f=await exhaustedColorFixture(t);let prepares=0,fields=0;
  f.dependencies.prepareSourceColors=async()=>{prepares++;return {aiCalls:0,evidenceChanged:false,evidenceSha256:'f'.repeat(64)};};
  f.dependencies.repairFields=async()=>{fields++;const row=f.service.get(f.task.id).items[0];assert.equal(row.repairAttempts,3);assert.equal(row.repair?.phase,'FIELDS_STARTED');assert.equal(row.sourceColorRepair?.grantedAttempts,1);throw Error('Field response unknown');};
  f.service.startAuthorized(f.service.prepareStart(f.task.id));await f.service.waitForIdle();
  assert.equal(fields,1);assert.equal(f.service.get(f.task.id).items[0].repair?.phase,'FIELDS_STARTED');
  await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);
  try{restored.startAuthorized(restored.prepareStart(f.task.id));await restored.waitForIdle();assert.match(restored.get(f.task.id).items[0].error!,/未自动重发/);}finally{await restored.close();}
  assert.equal(prepares,1);assert.equal(fields,1);assert.equal(f.calls.submissions,0);
});

test('source color preparation paused before its checkpoint resumes cached evidence without losing or duplicating the grant',async t=>{
  const f=await exhaustedColorFixture(t);let prepares=0,fields=0;
  f.dependencies.prepareSourceColors=async()=>{if(++prepares===1)f.service.pause(f.task.id);return {aiCalls:prepares===1?1:0,evidenceChanged:prepares===1,evidenceSha256:'b'.repeat(64)};};
  f.dependencies.repairFields=async id=>{fields++;return {draft:f.dependencies.amazon.getDraft(id),remaining:[]};};
  f.dependencies.execution.startAuthorized=f.originalStart;
  f.service.startAuthorized(f.service.prepareStart(f.task.id));await f.service.waitForIdle();
  const paused=f.service.get(f.task.id).items[0];assert.equal(paused.repair?.phase,'FIELDS_PENDING');assert.equal(paused.repairAttempts,2);assert.equal(paused.sourceColorRepair,undefined);assert.equal(fields,0);
  await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);
  try{restored.startAuthorized(restored.prepareStart(f.task.id));await restored.waitForIdle();assert.equal(restored.get(f.task.id).status,'COMPLETED');assert.equal(restored.get(f.task.id).items[0].repairAttempts,3);}finally{await restored.close();}
  assert.equal(prepares,2);assert.equal(fields,1);assert.equal(f.calls.images,1);
});

test('source color grant adds one attempt after the existing capability migration and validates its full history',async t=>{
  const f=await exhaustedColorFixture(t),saved=f.service.get(f.task.id);await f.service.close();
  saved.items[0].repairAttempts=3;
  saved.items[0].repairPolicyMigration={version:'field-evidence/v2',previousAttempts:2,grantedAttempts:1,grantedAt:new Date().toISOString(),fields:['color']};
  const db=openDatabase(f.directory);db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(saved),saved.id);db.close();
  f.dependencies.prepareSourceColors=async()=>({aiCalls:0,evidenceChanged:false,evidenceSha256:'a'.repeat(64)});
  f.dependencies.repairFields=async id=>({draft:f.dependencies.amazon.getDraft(id),remaining:[]});
  f.dependencies.execution.startAuthorized=f.originalStart;
  const restored=new AutomaticListingService(f.directory,f.dependencies);
  try{
    restored.startAuthorized(restored.prepareStart(f.task.id));await restored.waitForIdle();
    const complete=restored.get(f.task.id),row=complete.items[0];assert.equal(complete.status,'COMPLETED');assert.equal(row.repairAttempts,4);assert.equal(row.sourceColorRepair?.previousAttempts,3);
    assert.deepEqual(row.repairPolicyMigration,saved.items[0].repairPolicyMigration);assert.deepEqual(validateAutomaticListingTask(complete),complete);
    for(const tamper of ['fingerprint','previous','grant','date','missing-evidence','missing-grant','missing-migration','unused-marker'] as const){
      const invalid=structuredClone(complete),item=invalid.items[0];
      if(tamper==='fingerprint')item.sourceColorRepair!.evidenceSha256='invalid';
      if(tamper==='previous')item.sourceColorRepair!.previousAttempts=2;
      if(tamper==='grant')(item.sourceColorRepair as any).grantedAttempts=2;
      if(tamper==='date')item.sourceColorRepair!.grantedAt='invalid';
      if(tamper==='missing-evidence')delete item.sourceColorEvidenceSha256;
      if(tamper==='missing-grant')delete item.sourceColorRepair;
      if(tamper==='missing-migration')delete item.repairPolicyMigration;
      if(tamper==='unused-marker'){item.repairAttempts=0;delete item.sourceColorRepair;delete item.repairPolicyMigration;}
      assert.throws(()=>validateAutomaticListingTask(invalid),tamper);
    }
  }finally{await restored.close();}
});

for(const guard of ['missing-hash','invalid-hash','other-field','submit-started','draft-changed'] as const)test(`source color recovery rejects ${guard} before another field repair`,async t=>{
  const f=await exhaustedColorFixture(t);let prepares=0,fields=0;
  f.dependencies.prepareSourceColors=async()=>{prepares++;return {aiCalls:0,evidenceChanged:true,...(guard==='missing-hash'?{}:{evidenceSha256:guard==='invalid-hash'?'invalid':'a'.repeat(64)})};};
  f.dependencies.repairFields=async id=>{fields++;return f.dependencies.amazon.getDraft(id);};
  if(guard==='submit-started')f.executions.get(f.service.get(f.task.id).items[0].executionTaskIds[0])!.items[0].submitStarted=true;
  if(guard==='draft-changed')f.drafts.get(f.service.get(f.task.id).items[0].draftId!)!.revision++;
  if(guard==='other-field'){
    const saved=f.service.get(f.task.id);await f.service.close();const db=openDatabase(f.directory);
    saved.items[0].repair!.remaining=['brand: missing'];db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(saved),saved.id);db.close();
    const restored=new AutomaticListingService(f.directory,f.dependencies);try{restored.startAuthorized(restored.prepareStart(f.task.id));await restored.waitForIdle();}finally{await restored.close();}
  }else{f.service.startAuthorized(f.service.prepareStart(f.task.id));await f.service.waitForIdle();}
  assert.equal(fields,0);assert.equal(prepares,['missing-hash','invalid-hash'].includes(guard)?1:0);assert.equal(f.calls.submissions,0);
});

test('new tasks keep allocated SKU identity but refresh stale unsent recipe costs',async t=>{
  const f=fixture(t);f.rules.pricing.bundleEnabled=false;
  const oldRecipe=buildSalesRecipes(f.product,null,f.rules)[0],sku='H2-261008-1';
  const oldPlan:SalesListingPlan={namingGroupId:randomUUID(),sourceGroupKey:'source',collectedAt:f.product.createdAt,collectionBasis:'first_import',sku,baseSku:sku,recipe:oldRecipe,
    parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'Single',familyResolved:true,namingChildKey:null};
  const old=await f.dependencies.amazon.prepareDrafts({items:[{variantId:f.product.variants[0].id}]});const saved=old.items[0].draft!;saved.salesPlan=oldPlan;saved.sku=sku;
  f.product.revision++;f.product.variants[0].purchasePrice='2';
  f.dependencies.planSales=()=>[{...oldPlan,recipe:buildSalesRecipes(f.product,null,f.rules)[0]}];
  f.dependencies.existingSale=()=>structuredClone(saved);
  const task=await f.create(),row=task.items[0];
  assert.equal(row.sku,sku);assert.equal(row.productRevision,2);assert.equal(row.salesPlan!.recipe.totalCostCny,2);assert.equal(saved.salesPlan.recipe.totalCostCny,1);
});

test('pause after field repair checkpoints recheck and rebuilds the child without repeating fields or generation', async t => {
  const f=fixture(t), originalStart=f.dependencies.execution.startAuthorized;
  let fields=0,rechecks=0, starts=0, taskId='';
  f.dependencies.execution.startAuthorized = approved => {
    if(starts++===0){const task=f.executions.get(approved.id)!;task.status='NEEDS_ATTENTION';task.items[0].steps=[{name:'preview',status:'FAILED',attempts:1,error:'Title rejected'}];return structuredClone(task);}
    return originalStart(approved);
  };
  f.dependencies.repairFields=async id=>{fields++; const draft=f.drafts.get(id)!;draft.revision++;draft.attributes={item_name:[{value:'Repaired'}]};f.service.pause(taskId);return structuredClone(draft);};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=await f.create();taskId=task.id;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).items[0].repair?.phase,'RECHECK_PENDING');assert.equal(f.calls.submissions,0);
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(fields,1);assert.equal(rechecks,1);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);
  assert.equal(f.service.get(task.id).status,'COMPLETED');
});

test('unlinked persisted child is reconciled after restart, without duplicate writes', async t => {
  const f=fixture(t),originalCreate=f.dependencies.execution.create;
  f.dependencies.execution.create=input=>{const child=originalCreate(input);throw Error('Simulated crash after child persisted '+child.id);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.executions.size,1);assert.equal(f.service.get(task.id).items[0].executionTaskIds.length,0);
  await f.service.close();f.dependencies.execution.create=originalCreate;
  const restored=new AutomaticListingService(f.directory,f.dependencies);
  try {restored.startAuthorized(restored.prepareStart(task.id));await restored.waitForIdle();assert.equal(f.executions.size,1);assert.equal(f.calls.submissions,1);assert.equal(f.calls.images,1);}
  finally {await restored.close();}
});

test('legacy pending image recheck with unresolved fields is blocked after restart', async t => {
  const f=fixture(t);let taskId='',fields=0,rechecks=0;
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing fields'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{fields++;const draft=f.drafts.get(id)!;draft.revision++;f.service.pause(taskId);return structuredClone(draft);};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=await f.create();taskId=task.id;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const row=f.service.get(task.id).items[0];assert.equal(row.repair?.phase,'RECHECK_PENDING');
  // Reproduce an older checkpoint whose revision/stamp are valid but fields remain missing.
  f.drafts.get(row.draftId!)!.localIssues=[{code:'LOCAL_required',message:'color: missing',severity:'ERROR',attributeNames:['color'],category:'field',source:'local',autoFixable:false}];
  await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);
  f.dependencies.repairFields=async id=>{fields++;return {draft:f.dependencies.amazon.getDraft(id),remaining:['color: missing']};};
  try {
    restored.startAuthorized(restored.prepareStart(task.id));await restored.waitForIdle();
    assert.match(restored.get(task.id).items[0].error!,/color/);
    assert.equal(fields,2);assert.equal(rechecks,0);assert.equal(f.executions.size,1);assert.equal(f.calls.submissions,0);
  } finally {await restored.close();}
});

for (const externalEdit of [false,true]) test(`interrupted recheck copy repair ${externalEdit?'rejects a later external edit':'resumes its recorded draft after restart'} without repeating field repair`,async t=>{
  const f=fixture(t),start=f.dependencies.execution.startAuthorized;let fields=0,rechecks=0,starts=0;
  let recorded:{revision:number;stamp:string;sourceWorkflowId:string}|undefined;
  f.dependencies.execution.startAuthorized=approved=>{
    if(starts++===0){const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'preview',status:'FAILED',attempts:1,error:'Title rejected'}];return structuredClone(child);}
    return start(approved);
  };
  f.dependencies.repairFields=async id=>{fields++;const draft=f.drafts.get(id)!;draft.revision++;return {draft:structuredClone(draft),remaining:[]};};
  f.dependencies.recheckImage=async input=>{
    rechecks++;const draft=f.drafts.get(input.draftId)!;
    if(rechecks===1){draft.revision++;draft.attributes.item_name=[{value:'Copy repaired during image recheck',marketplace_id:f.target.marketplaceId,language_tag:'en_US'}];
      recorded={revision:draft.revision,stamp:imageWorkflowDraftStamp(draft),sourceWorkflowId:input.sourceWorkflowId};
      throw new UserFacingError('Independent copy review needs changes');}
    return structuredClone(draft);
  };
  (f.dependencies.images as any).canResumeRecheckDraft=(input:{draftId:string;draftRevision:number;sourceWorkflowId:string})=>{
    const draft=f.drafts.get(input.draftId)!;
    return !!recorded&&recorded.sourceWorkflowId===input.sourceWorkflowId&&recorded.revision===input.draftRevision&&recorded.stamp===imageWorkflowDraftStamp(draft);
  };
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.match(f.service.get(task.id).items[0].error!,/Independent copy review needs changes/);assert.equal(f.calls.submissions,0);
  if(externalEdit){const draft=f.drafts.get(f.service.get(task.id).items[0].draftId!)!;draft.revision++;draft.attributes.item_name=[{value:'Later manual edit'}];}
  await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);
  try{restored.startAuthorized(restored.prepareStart(task.id));await restored.waitForIdle();
    const row=restored.get(task.id).items[0];
    if(externalEdit){assert.match(row.error!,/草稿发生变化/);assert.equal(rechecks,1);assert.equal(f.calls.submissions,0);}
    else{assert.equal(restored.get(task.id).status,'COMPLETED',row.error??'');assert.equal(rechecks,2);assert.equal(f.calls.submissions,1);}
    assert.equal(fields,1);assert.equal(f.calls.images,1);
  }finally{await restored.close();}
});

for(const outcome of ['mismatch','unknown'] as const)test(`actual source observations isolate ${outcome} sibling and resume current manual proof without redelivery`,async t=>{
  const f=fixture(t);f.rules.product.variantLimit=2;
  const second={...f.product.variants[0],id:randomUUID(),sku:'SKU-BLUE',originalSpec:'Blue',normalizedSpec:'Blue',sourceSpec:'Blue'};f.product.variants.push(second);
  const store=new WorkspaceStore(f.directory),hosting=new HostingService(f.directory,store,mockStorage);let sends=0;
  const ai=new AiService(f.directory,store,hosting,mockStorage,{fetch:async(_url,options)=>{
    sends++;const p=JSON.parse(JSON.parse(String(options?.body)).messages[1].content[0].text);
    if(outcome==='unknown'&&p.claims.some((c:any)=>c.value==='Blue'))throw new TypeError('synthetic unknown');
    return chat({kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Red'],appearance:[],claims:p.claims.map((c:any)=>({claimId:c.id,value:'Red',visibility:'visible'}))}))});
  }});
  ai.saveConnection({id:'deepseek',apiKey:'synthetic-source-state-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});inheritLegacyPurposeSettings((ai as any).db,'deepseek','deepseek-flash',false);
  f.cleanups.push(async()=>{await ai.close();await hosting.close();store.close();});
  f.dependencies.prepareSourceConsistency=async(input,signal,fresh)=>{
    materializeSourceSnapshot(f.directory,f.product,input.variantIds);
    for(const variantId of input.variantIds){const selected={productId:input.productId,productRevision:input.productRevision,variantId};const context=ai.sourceConsistencyContext(selected);await ai.observeSourceConsistency(context,fresh,signal);assertConsistencyView(await ai.getSourceConsistency(selected));}
  };
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const first=f.service.get(task.id),healthy=first.items[0],blocked=first.items[1];
  assert.equal(healthy.status,'DONE',healthy.error??'');if(outcome==='unknown')assert.equal(blocked.outcome?.kind,'UNKNOWN');else assert.equal(blocked.status,'DONE',blocked.error??'');
  assert.equal(f.calls.sources,1);assert.equal(f.calls.images,outcome==='unknown'?1:2);assert.equal(sends,2);
  const proofInput={productId:f.product.id,productRevision:f.product.revision,variantId:second.id},view=await ai.getSourceConsistency(proofInput);
  assert.equal(sends,2,'read projection never sends');
  if(outcome==='mismatch'){assert.ok(ai.sourceObservationEvidence(proofInput).conflicts.length>0);assert.equal(first.status,'COMPLETED');return;}
  const confirm=()=>ai.decideSourceConsistency({...proofInput,fingerprint:view.fingerprint,decision:'CONFIRMED',reason:'Synthetic independent human checked this exact visual association'});
  if(outcome==='unknown')await assert.rejects(confirm());else await confirm();
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const after=f.service.get(task.id);assert.equal(after.items[0].draftId,healthy.draftId);assert.equal(sends,outcome==='unknown'?3:2);assert.equal(f.calls.sources,1,'a new current visual proof must not redownload unchanged source identity');
  assert.equal(f.calls.images,outcome==='unknown'?1:2);assert.equal(after.items[1].status,outcome==='unknown'?'FAILED':'DONE');
});

test('release four-SKU synthetic sample separates rule, missing facts and UNKNOWN while preserving healthy paid work',async t=>{
  // Real automatic coordinator, AiService, source observations, fact validator and
  // SQLite. Amazon/image generation/execution are the existing explicit substitutes.
  const f=fixture(t,'live');f.setReady();f.rules.product.variantLimit=5;f.rules.pricing.bundleEnabled=false;
  f.product.variants=['Red','Green','Yellow','White'].map((color,index)=>({...f.product.variants[0],id:randomUUID(),sku:`RELEASE-${index}`,originalSpec:color,normalizedSpec:color,sourceSpec:color}));
  const store=new WorkspaceStore(f.directory),hosting=new HostingService(f.directory,store,mockStorage);let sends=0;
  const ai=new AiService(f.directory,store,hosting,mockStorage,{fetch:async(_url,options)=>{
    sends++;const payload=JSON.parse(JSON.parse(String(options?.body)).messages[1].content[0].text),color=payload.claims.find((c:any)=>c.kind==='color')?.value||payload.claims[0].value;
    if(color==='Green')throw new TypeError('synthetic ambiguous source result');
    const observed=color==='Blue'?'Red':color;
    return chat({kind:'source-image-consistency',assets:payload.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:[observed],appearance:[],claims:payload.claims.map((c:any)=>({claimId:c.id,value:observed,visibility:'visible'}))}))});
  }});
  ai.saveConnection({id:'deepseek',apiKey:'synthetic-release-observation'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});inheritLegacyPurposeSettings((ai as any).db,'deepseek','deepseek-flash',false);
  f.cleanups.push(async()=>{await ai.close();await hosting.close();store.close();});
  f.dependencies.prepareSourceConsistency=async(input,signal,fresh)=>{
    materializeSourceSnapshot(f.directory,f.product,input.variantIds);
    for(const variantId of input.variantIds){const selected={productId:input.productId,productRevision:input.productRevision,variantId};await ai.observeSourceConsistency(ai.sourceConsistencyContext(selected),fresh,signal);assertConsistencyView(await ai.getSourceConsistency(selected));}
  };
  const prepare=f.dependencies.amazon.prepareDrafts;
  f.dependencies.amazon.prepareDrafts=async raw=>{
    const result=await prepare(raw),draft=result.items[0].draft!;
    if(draft.variantId===f.product.variants[2].id){
      draft.attributes={...draft.attributes,batteries_required:[{value:false}]};
      draft.localIssues=currentFactAuthority(f.product,realAmazonSchema(),f.target,draft.attributes).issues;
      assert.ok(draft.localIssues.some(issue=>issue.code==='FACT_AUTHORITY_REQUIRED'));
    }
    if(draft.variantId===f.product.variants[3].id){
      draft.attributes={item_package_dimensions:[{length:{value:1,unit:'inches'},width:{value:1,unit:'inches'},height:{value:1,unit:'inches'}}],item_package_weight:[{value:1,unit:'pounds'}],number_of_items:[{value:1}]};
      draft.businessRules={revision:f.rules.revision,fields:{},notices:[],quote:null,bundleQuantity:1,pricingBasis:{kind:'source_sale_unit',sourceCostCny:100,quantity:1,saleUnitCostCny:100},pricingDecision:{version:1,status:'business_blocked',code:'ROI_MAX_PRICE',quoteError:'ROI_MAX_PRICE',inputs:{costCny:100,dimensionsInches:[1,1,1],weightPounds:1},evidence:{cost:'confirmed_cny',dimensions:'confirmed_source',weight:'confirmed_source',packageScope:'source_sale_unit',saleUnit:'confirmed',sourcePackage:{dimensionsInches:[1,1,1],weightPounds:1}}}};
    }
    f.drafts.set(draft.id,structuredClone(draft));return result;
  };
  const complete=f.dependencies.images.complete;
  f.dependencies.images.complete=async input=>{const draft=f.drafts.get((input as {draftId:string}).draftId)!;if(draft.localIssues.length){f.workflow.set(draft.id,{status:'BLOCKED',slots:[],error:'Synthetic known facts are missing'});throw new UserFacingError('Synthetic known facts are missing');}return complete(input);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const first=f.service.get(task.id),row=(index:number)=>first.items.find(i=>i.variantId===f.product.variants[index].id)!;
  assert.equal(row(0).status,'DONE',JSON.stringify({sends,rows:first.items.map(r=>({sku:r.sku,error:r.error,outcome:r.outcome?.kind}))}));assert.equal(row(1).outcome?.kind,'UNKNOWN');assert.equal(row(2).outcome?.kind,'NEEDS_INPUT');assert.equal(row(2).outcome?.code,'FACT_AUTHORITY_REQUIRED');assert.equal(row(3).outcome?.kind,'RULE_FILTERED');
  assert.equal(sends,4);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);
  const preserved=JSON.stringify(f.workflow.get(row(0).draftId!)),history=JSON.stringify(ai.listResults(f.product.id));
  await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);
  try{
    const queue=await restored.queue({productIds:[f.product.id],targetId:f.target.id});
    assert.equal(queue.products[0].filteredCount,1);assert.equal(queue.products[0].rows.filter(r=>r.kind==='UNKNOWN').length,1);
    restored.startAuthorized(restored.prepareStart(task.id));await restored.waitForIdle();
    assert.equal(sends,5);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);
    assert.equal(JSON.stringify(f.workflow.get(row(0).draftId!)),preserved);assert.equal(JSON.stringify(ai.listResults(f.product.id)),history);
  }finally{await restored.close();}
});

for (const submittedBeforeUpgrade of [false, true]) test(`legacy prepared source resumes consistency preparation without redelivery (submitted=${submittedBeforeUpgrade})`, async t => {
  const f = fixture(t, 'live');
  materializeSourceSnapshot(f.directory, f.product, [f.product.variants[0].id]);
  const task = await f.create(), saved = (f.service as any).tasks.get(task.id), row = saved.items[0];
  row.sourcesPrepared = true; row.stage = 'DRAFT';
  const result = await f.dependencies.amazon.prepareDrafts({ items: [{ variantId: row.variantId }] });
  row.draftId = result.items[0].draft!.id;
  if (submittedBeforeUpgrade) { const draft = f.drafts.get(row.draftId)!; draft.submittedAt = new Date().toISOString(); draft.state = 'SUBMITTED'; }
  let checks = 0;
  const prepare = f.dependencies.prepareSourceConsistency!, complete = f.dependencies.images.complete;
  f.dependencies.prepareSourceConsistency = async (...args) => { checks++; return prepare(...args); };
  f.dependencies.images.complete = input => {
    const db = openDatabase(f.directory);
    try { assertProductConsistency(db, f.product, [row.variantId]); } finally { db.close(); }
    return complete(input);
  };
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  const after = f.service.get(task.id).items[0];
  assert.equal(after.status, 'WAITING', after.error ?? '');
  assert.equal(checks, submittedBeforeUpgrade ? 0 : 1);
  assert.equal(f.calls.sources, 0, 'downloaded originals and product revision must be preserved');
  assert.equal(f.product.revision, 1);
  assert.equal(f.calls.images, submittedBeforeUpgrade ? 0 : 1);
  assert.equal(f.calls.submissions, submittedBeforeUpgrade ? 0 : 1);
  assert.equal(after.draftId, row.draftId);
});

test('a format-failed source sibling resumes from diagnostics after a healthy sibling froze source delivery',async t=>{
  const f=fixture(t);f.rules.product.variantLimit=2;
  f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-BLUE',originalSpec:'Blue',normalizedSpec:'Blue',sourceSpec:'Blue'});
  const store=new WorkspaceStore(f.directory),hosting=new HostingService(f.directory,store,mockStorage);let sends=0;
  const ai=new AiService(f.directory,store,hosting,mockStorage,{fetch:async(_url,options)=>{
    sends++;const p=JSON.parse(JSON.parse(String(options?.body)).messages[1].content[0].text);
    return chat(p.claims.some((c:any)=>c.value==='Blue')?{bad:true}:{kind:'source-image-consistency',assets:p.referenceAssets.map((a:any)=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Red'],appearance:[],claims:[]}))});
  }});
  ai.saveConnection({id:'deepseek',apiKey:'synthetic-sibling-recovery'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});inheritLegacyPurposeSettings((ai as any).db,'deepseek','deepseek-flash',false);
  f.cleanups.push(async()=>{await ai.close();await hosting.close();store.close();});
  f.dependencies.prepareSourceConsistency=async(input,signal,fresh)=>{materializeSourceSnapshot(f.directory,f.product,input.variantIds);for(const variantId of input.variantIds)await ai.prepareSourceConsistency({productId:input.productId,productRevision:input.productRevision,variantId},signal,fresh);};
  const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const first=f.service.get(task.id),healthy=first.items[0],failed=first.items[1];assert.equal(healthy.status,'DONE');assert.equal(failed.sourcesPrepared,false);assert.equal(sends,2);
  const call=ai.listCalls().find(c=>c.errorCode==='OUTPUT_INVALID')!;assert.ok(call);
  const {recordInvalidAiOutput}=await import('../src/main/ai/output-diagnostics.ts');
  recordInvalidAiOutput(f.directory,{call,operation:'source-image-consistency',createdAt:new Date(Date.parse(call.finishedAt!)+1).toISOString(),rejectionStage:'operation-output-validation',output:{type:'json_object',assets:call.sourceConsistencyContext!.referenceAssets.map(a=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Blue'],appearance:[],claims:[]}))}});
  await f.service.close();const restarted=new AutomaticListingService(f.directory,f.dependencies);
  try{restarted.startAuthorized(restarted.prepareStart(task.id));await restarted.waitForIdle();const after=restarted.get(task.id);assert.equal(after.status,'COMPLETED',after.items[1].error??'');assert.equal(after.items[0].draftId,healthy.draftId);assert.equal(sends,2);assert.equal(f.calls.sources,1);assert.equal(f.calls.images,2);assert.equal(ai.listCalls().find(c=>c.id===call.id)!.status,'FAILED');}finally{await restarted.close();}
});

test('legacy sourcesPrepared row recovers an OUTPUT_INVALID diagnostic locally and continues without another source call',async t=>{
  const f=fixture(t,'live');materializeSourceSnapshot(f.directory,f.product,[f.product.variants[0].id]);
  const store=new WorkspaceStore(f.directory),hosting=new HostingService(f.directory,store,mockStorage);let sends=0;
  const ai=new AiService(f.directory,store,hosting,mockStorage,{fetch:async()=>{sends++;return chat({bad:true});}});
  ai.saveConnection({id:'deepseek',apiKey:'synthetic-recovery-key'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});inheritLegacyPurposeSettings((ai as any).db,'deepseek','deepseek-flash',false);
  f.cleanups.push(async()=>{await ai.close();await hosting.close();store.close();});
  const input={productId:f.product.id,productRevision:f.product.revision,variantId:f.product.variants[0].id},context=ai.sourceConsistencyContext(input);
  await assert.rejects(ai.observeSourceConsistency(context,()=>{}));const call=ai.listCalls()[0];assert.equal(call.errorCode,'OUTPUT_INVALID');
  const {recordInvalidAiOutput}=await import('../src/main/ai/output-diagnostics.ts');
  recordInvalidAiOutput(f.directory,{call,operation:'source-image-consistency',createdAt:new Date(Date.parse(call.finishedAt!)+1).toISOString(),rejectionStage:'operation-output-validation',output:{type:'json_object',assets:context.referenceAssets.map(a=>({assetId:a.assetId,quality:'clear',visibility:'complete',lighting:'neutral',presentation:'single-product',colors:['Red'],appearance:['Rounded'],claims:[]}))}});
  const task=await f.create(),saved=(f.service as any).tasks.get(task.id),row=saved.items[0];row.sourcesPrepared=true;row.stage='DRAFT';
  let prepared=0;
  f.dependencies.prepareSourceConsistency=async(raw,signal,fresh)=>{prepared++;for(const variantId of raw.variantIds)await ai.prepareSourceConsistency({productId:raw.productId,productRevision:raw.productRevision,variantId},signal,fresh);};
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const after=f.service.get(task.id).items[0];assert.equal(after.status,'WAITING',after.error??'');assert.equal(prepared,1);assert.equal(sends,1);assert.equal(f.calls.sources,0);assert.equal(f.calls.images,1);assert.equal(ai.listCalls()[0].status,'FAILED');assert.equal(ai.listResults(f.product.id).length,0);
});

test('synchronous image source preflight rejection is not an unknown paid request and can resume after restart', async t => {
  const { ImageWorkflowService } = await import('../src/main/image-workflow/service.ts');
  const f = fixture(t), complete = f.dependencies.images.complete;
  let rejectPreflight = true;
  f.dependencies.images.complete = input => {
    if (!rejectPreflight) return complete(input);
    const db = openDatabase(f.directory);
    try {
      db.exec('DELETE FROM source_consistency_decisions');
      const realEntry = Object.assign(Object.create(ImageWorkflowService.prototype), {
        closed: false, active: new Map(), activeSources: new Map(),
        store: f.dependencies.store, db, amazon: f.dependencies.amazon,
      });
      return realEntry.complete(input);
    } finally { db.close(); }
  };
  const task = await f.create();
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  const row = f.service.get(task.id).items[0];
  assert.equal(row.imageStarted, false, 'the real synchronous source guard rejected before a workflow was admitted');
  assert.equal(row.outcome?.code, 'SOURCE_CONSISTENCY_NEEDS_INPUT');
  assert.equal(f.workflow.size, 0); assert.equal(f.calls.images, 0); assert.equal(f.calls.submissions, 0);
  rejectPreflight = false;
  await f.service.close();
  const restored = new AutomaticListingService(f.directory, f.dependencies);
  try {
    restored.startAuthorized(restored.prepareStart(task.id)); await restored.waitForIdle();
    assert.equal(restored.get(task.id).status, 'COMPLETED', restored.get(task.id).items[0].error ?? '');
    assert.equal(f.calls.sources, 1, 'retry reuses downloaded source originals');
    assert.equal(f.calls.images, 1); assert.equal(f.calls.submissions, 1);
    assert.equal(restored.get(task.id).items[0].draftId, row.draftId);
  } finally { await restored.close(); }
});

for(const stage of ['READBACK'] as const)test(`submitted ${stage} failure retains its own cause without requiring legacy source proof`,async t=>{
  const f=fixture(t,'live'),task=await f.create();
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const db=openDatabase(f.directory);try{db.exec('DELETE FROM source_consistency_decisions');}finally{db.close();}
  f.dependencies.followup.get=()=>({status:'NEEDS_ATTENTION',error:'平台回读确认缺少必填属性'} as any);
  await f.service.refreshWaiting();
  const row=f.service.get(task.id).items[0];
  assert.equal(row.outcome?.code,'READBACK_FAILED');
  assert.equal(row.outcome?.kind,'SYSTEM_REPAIR');
  assert.match(row.outcome!.message,/平台回读确认缺少必填属性/);
  assert.equal(f.calls.submissions,1);assert.equal(f.calls.images,1);
  assert.deepEqual(validateAutomaticListingTask(f.service.get(task.id)),f.service.get(task.id));
});

for (const state of ['PROCESSING','NEEDS_ATTENTION','READY'] as const) test(`readback ${state} drives handling independently of procurement`, async t => {
 const f=fixture(t,'live'),task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 if(state!=='READY')f.setReady();
 f.dependencies.followup.get=()=>({status:state,error:state==='NEEDS_ATTENTION'?'Generic brand requires manual handling':null} as any);
 await f.service.refreshWaiting();const row=f.service.get(task.id).items[0];
 assert.equal(row.stage,'READBACK');assert.equal(row.status,state==='NEEDS_ATTENTION'?'FAILED':'WAITING');assert.ok(row.error);
 assert.equal(f.calls.batches,0);assert.equal(f.calls.submissions,1);
});

for(const code of ['5665','5882'])test(`explicit readback brand ${code} requires manual input without changing Generic`,async t=>{
 const f=fixture(t,'live'),task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 const draft=f.drafts.get(f.service.get(task.id).items[0].draftId!)!;
 draft.attributes.brand=[{value:'Generic'}];draft.listingIssues=[{code,message:'平台要求批准',severity:'ERROR',attributeNames:['brand'],category:'qualification',source:'amazon',autoFixable:false}];
 f.dependencies.followup.get=()=>({status:'NEEDS_ATTENTION',reason:'LISTING_ERRORS',issues:draft.listingIssues,error:'Brand approval required'} as any);
 await f.service.refreshWaiting();assert.equal(f.service.get(task.id).items[0].outcome?.kind,'NEEDS_INPUT');
 assert.deepEqual(draft.attributes.brand,[{value:'Generic'}]);assert.equal(f.calls.submissions,1);
});

test('demo readback does not require a live followup record',async t=>{
 const f=fixture(t),task=await f.create();f.dependencies.followup.get=()=>{throw new UserFacingError('No live followup');};
 f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(f.service.get(task.id).status,'COMPLETED');
});

test('automatic SKU policy is enforced in legacy preview and task creation',async t=>{
 const f=fixture(t);f.product.variants=Array.from({length:7},(_,i)=>({...f.product.variants[0],id:randomUUID(),sku:'selection-'+i,originalSpec:i===0?'更低价格请咨询客服~':['红色','蓝色','白色','黑色','绿色','黄色'][i-1],normalizedSpec:''}));
 const queue=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});
 assert.equal(queue.products[0].rows.length,7);assert.equal(queue.products[0].notSelectedCount,3);assert.equal(queue.products[0].eligibleCount,4);
 const task=await f.create();assert.equal(task.items.length,4);assert.ok(task.items.every(r=>r.variantId!==f.product.variants[0].id));
});
test('old unsubmitted informational row is screened without deleting its saved work',async t=>{
 const f=fixture(t);const info={...f.product.variants[0],id:randomUUID(),sku:'old-info',originalSpec:'春夏秋冬-可备注颜色',normalizedSpec:'',sourceSpec:'春夏秋冬-可备注颜色'};f.product.variants.push(info);
 const task=await f.create(),saved=(f.service as any).tasks.get(task.id);
 const row={...structuredClone(saved.items[0]),key:f.product.id+':'+info.id,variantId:info.id,sku:info.sku};saved.items=[row];
 f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 const result=f.service.get(task.id);assert.equal(result.items.length,1);assert.equal(result.items[0].status,'SCREENED',JSON.stringify(result.items[0]));assert.equal(result.items[0].outcome?.code,'SKU_SELECTION_FILTERED');assert.equal(f.calls.sources,0);assert.equal(f.calls.images,0);
});


test('all informational source is visibly not selected and creates no task',async t=>{
 const f=fixture(t);f.product.variants[0].originalSpec='更低价格请咨询客服~';f.product.variants[0].normalizedSpec='';f.product.variants[0].sourceSpec='';
 const queue=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});
 assert.equal(queue.products[0].eligibleCount,0);assert.equal(queue.products[0].filteredCount,0);assert.equal(queue.products[0].notSelectedCount,1);assert.match(queue.products[0].rows[0].message,/未选中/);
 await assert.rejects(f.create,/没有可启动/);
});





for(const sent of [false,true])test(`selection reconciliation preserves completed images and submitted identity (submitted=${sent})`,async t=>{
 const f=fixture(t);const info={...f.product.variants[0],id:randomUUID(),sku:'old-info',originalSpec:'春夏秋冬-可备注颜色',normalizedSpec:'',sourceSpec:'春夏秋冬-可备注颜色'};f.product.variants.push(info);
 const task=await f.create(),saved=(f.service as any).tasks.get(task.id);
 const prepared=await f.dependencies.amazon.prepareDrafts({items:[{variantId:info.id}]}),draft=prepared.items[0].draft!;
 const original=f.drafts.get(draft.id)!;if(sent){original.submittedAt=new Date().toISOString();original.state='SUBMITTED';}
 const paid={status:'COMPLETED',slots:[{index:1,status:'PASSED',approvedAssetId:randomUUID()}]};f.workflow.set(draft.id,paid);
 saved.items=[{...structuredClone(saved.items[0]),key:f.product.id+':'+info.id,variantId:info.id,sku:info.sku,draftId:draft.id,imageStarted:true,imageAttempts:1,stage:'IMAGES'}];
 f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 const row=f.service.get(task.id).items[0];assert.equal(row.draftId,draft.id);assert.equal(row.sku,info.sku);assert.deepEqual(f.workflow.get(draft.id),paid);assert.equal(f.calls.images,0);
 if(sent)assert.notEqual(row.status,'SCREENED');else assert.equal(row.status,'SCREENED');
});

for(const spec of ['颜色:红色;备注:可备注颜色','红色整机 / 可备注颜色'])test(`selection preview and creation preserve real configuration with note: ${spec}`,async t=>{
 const f=fixture(t);Object.assign(f.product.variants[0],{originalSpec:spec,normalizedSpec:'',sourceSpec:spec});
 const queue=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(queue.products[0].eligibleCount,1);
 const task=await f.create();assert.equal(task.items.length,1);assert.equal(task.items[0].variantId,f.product.variants[0].id);
});

test('authorized resume sends a retained unknown image workflow back to its bounded recovery owner',async t=>{
 const f=fixture(t),complete=f.dependencies.images.complete;let first=true;
 f.dependencies.images.complete=async input=>{if(first){first=false;f.calls.images++;const id=(input as any).draftId;f.workflow.set(id,{id:randomUUID(),draftId:id,status:'INTERRUPTED',slots:[{status:'UNKNOWN',attempts:[{state:'UNKNOWN'}]}]});throw Error('synthetic missing provider result');}return complete(input);};
 const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(f.service.get(task.id).items[0].outcome?.kind,'UNKNOWN');
 f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 assert.equal(f.calls.images,2);assert.equal(f.calls.sources,1);assert.equal(f.calls.submissions,1);assert.equal(f.service.get(task.id).status,'COMPLETED');
});
test('unknown formal submission takes priority over an unknown image and is never retried as AI',async t=>{
 const f=fixture(t),complete=f.dependencies.images.complete;
 f.dependencies.images.complete=async input=>{f.calls.images++;const id=(input as any).draftId;f.workflow.set(id,{id:randomUUID(),draftId:id,status:'INTERRUPTED',slots:[{status:'UNKNOWN',attempts:[{state:'UNKNOWN'}]}]});throw Error('synthetic missing image');};
 const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();const draftId=f.service.get(task.id).items[0].draftId!;f.drafts.get(draftId)!.state='UNKNOWN';
 assert.equal((f.service as any).unknownCode(f.service.get(task.id).items[0],f.service.get(task.id)),'SUBMISSION_UNKNOWN');
 f.dependencies.images.complete=complete;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,0);
});

for(const [cost,expected,spec] of [[2.4,'PENDING','red'],[2.4,'PENDING','repair'],[2.4,'PENDING','repair-other'],[100,'SCREENED','red'],[null,'FAILED','red'],[100,'FAILED','5 pc / 10 pc']] as const)
test(`legacy pricing resume locally recomputes current cost ${cost} ${spec} without paid calls`,async t=>{
  const f=fixture(t,'live');f.rules.pricing.bundleEnabled=false;
  const task=await f.create(),saved=(f.service as any).tasks.get(task.id),row=saved.items[0];
  // Seed an existing historical row; current creation correctly rejects conflicting quantities.
  f.product.variants[0].originalSpec=spec;f.product.variants[0].sourceSpec=spec;f.product.variants[0].normalizedSpec=spec;
  await f.dependencies.prepareSourceConsistency!({productId:f.product.id,productRevision:f.product.revision,variantIds:[f.product.variants[0].id]},new AbortController().signal,()=>{});
  row.sourceStamp=sourceStamp(f.product);
  const prepared=await f.dependencies.amazon.prepareDrafts({items:[{variantId:row.variantId}]}),draft=prepared.items[0].draft!;
  // The historical failed quote had no actual offer; retaining the new fixture's
  // generated offer while discarding its ownership would falsely make it manual.
  draft.attributes={};draft.businessRules={revision:1,fields:{},notices:['售价上限内无法满足目标 ROI'],quote:null,bundleQuantity:1};
  draft.previewIssues=spec==='repair'?[]:[{code:'PLATFORM_KEEP',severity:'ERROR',message:'Keep platform error',attributeNames:[]} as any];
  f.drafts.set(draft.id,draft);
  row.draftId=draft.id;row.stage='IMAGES';row.status='FAILED';row.error='售价上限内无法满足目标 ROI';row.sourcesPrepared=true;
  if(spec.startsWith('repair')){
    const child=f.dependencies.execution.create({draftIds:[draft.id],profileId:'alpha'});f.executions.get(child.id)!.status='NEEDS_ATTENTION';row.executionTaskIds=[child.id];
    row.repair={phase:'FIELDS_PENDING',sourceWorkflowId:randomUUID(),remaining:[pricingBlockingReason(draft)!],draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)};
  }
  saved.status='NEEDS_ATTENTION';(f.service as any).save(saved);
  const images={id:randomUUID(),status:'COMPLETED',stage:'complete',approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64),slots:Array.from({length:7},(_,i)=>({index:i+1,status:'PASSED',approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64)}))};f.workflow.set(draft.id,images);
  let refreshes=0;
  f.dependencies.amazon.applyBusinessDefaults=(reference,_operation,revalidate)=>{
    refreshes++;assert.equal(revalidate,true);
    const current=f.drafts.get(reference.id)!;
    const result=applyBusinessRules({product:f.product,variant:f.product.variants[0],target:f.target,schema:realAmazonSchema(),attributes:current.attributes,measurements:{},costCny:cost,previousBusinessReport:current.businessRules,now:new Date()},f.rules);
    current.attributes=result.attributes;current.businessRules=result.report;current.revision++;return structuredClone(current);
  };
  f.service.startAuthorized(f.service.prepareStart(task.id));f.service.pause(task.id);await f.service.waitForIdle();
  const actual=f.service.get(task.id).items[0];assert.equal(refreshes,1);assert.equal(actual.status,expected);
  if(expected==='SCREENED'){assert.equal(actual.outcome?.kind,'RULE_FILTERED');assert.match(actual.outcome!.message,/100.*所需售价.*上限/s);}
  if(expected==='FAILED')assert.equal(actual.outcome?.kind,'NEEDS_INPUT');
  if(spec==='5 pc / 10 pc')assert.match(actual.outcome!.message,/件数|计价|数量/);
  assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);assert.deepEqual(f.workflow.get(draft.id),images);assert.deepEqual(f.drafts.get(draft.id)!.previewIssues,draft.previewIssues);
  await f.service.close();const restarted=new AutomaticListingService(f.directory,f.dependencies);f.cleanups.push(()=>restarted.close());
  assert.deepEqual(restarted.get(task.id).items[0],actual);
  if(expected==='PENDING'){
    f.setReady();restarted.startAuthorized(restarted.prepareStart(task.id));await restarted.waitForIdle();
    assert.equal(restarted.get(task.id).items[0].status,spec==='repair-other'?'FAILED':'DONE',restarted.get(task.id).items[0].error??'');assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,spec==='repair-other'?0:1,'only the fake downstream execution continues');
    if(spec==='repair-other')assert.match(restarted.get(task.id).items[0].error!,/PLATFORM_KEEP/);
    assert.deepEqual(f.workflow.get(draft.id),images);
  }
  if(expected!=='PENDING'){
    restarted.startAuthorized(restarted.prepareStart(task.id));restarted.pause(task.id);await restarted.waitForIdle();
    assert.equal(restarted.get(task.id).items[0].status,expected);assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);
    if(spec==='5 pc / 10 pc')assert.equal(restarted.get(task.id).items[0].outcome?.message,actual.outcome?.message);
  }
  const queue=await restarted.queue({productIds:[f.product.id],targetId:f.target.id});
  if(expected==='SCREENED'){assert.equal(queue.products[0].rows[0].kind,'RULE_FILTERED');assert.match(queue.products[0].rows[0].message,/100.*所需售价/s);}
});

test('legacy field-started without operation can be selection-screened with history intact and no paid work',async t=>{
 const f=fixture(t),info={...f.product.variants[0],id:randomUUID(),sku:'legacy-info',originalSpec:'春夏秋冬-可备注颜色',normalizedSpec:'',sourceSpec:'春夏秋冬-可备注颜色'};f.product.variants.push(info);
 const task=await f.create(),saved=(f.service as any).tasks.get(task.id);
 const prepared=await f.dependencies.amazon.prepareDrafts({items:[{variantId:info.id}]}),draft=prepared.items[0].draft!;
 const execution=f.dependencies.execution.create({draftIds:[draft.id],profileId:'alpha'});
 const repair={phase:'FIELDS_STARTED',sourceWorkflowId:randomUUID(),draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft),remaining:['历史字段响应尚未恢复']};
 saved.status='PAUSED';saved.items=[{...saved.items[0],key:f.product.id+':'+info.id,variantId:info.id,sku:info.sku,status:'FAILED',stage:'IMAGES',draftId:draft.id,executionTaskIds:[execution.id],repairAttempts:1,repair:structuredClone(repair)}];
 (f.service as any).save(saved);assert.doesNotThrow(()=>validateAutomaticListingTask(saved));
 f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 const after=f.service.get(task.id),row=after.items[0];assert.equal(row.status,'SCREENED');assert.equal(row.outcome?.code,'SKU_SELECTION_FILTERED');assert.deepEqual(row.repair,repair);assert.equal(row.repairAttempts,1);
 assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);assert.equal(f.calls.sources,0);
 const db=(f.service as any).db;assert.deepEqual(JSON.parse(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id).record_json),after);
 const wrong=structuredClone(after);wrong.items[0].outcome!.code='ROI_MAX_PRICE';assert.throws(()=>validateAutomaticListingTask(wrong));
 await f.service.close();const reopened=new AutomaticListingService(f.directory,f.dependencies);try{assert.deepEqual(reopened.get(task.id).items[0].repair,repair);}finally{await reopened.close();}
});

test('failed start checkpoint restores persisted paused state and permits a clean subsequent start',async t=>{
 const f=fixture(t),task=await f.create(),saved=(f.service as any).tasks.get(task.id),db=(f.service as any).db;saved.status='PAUSED';(f.service as any).save(saved);const before=f.service.get(task.id);
 db.exec("CREATE TRIGGER fail_start BEFORE UPDATE ON automatic_listing_tasks WHEN json_extract(NEW.record_json,'$.status')='QUEUED' BEGIN SELECT RAISE(ABORT,'synthetic start save failure'); END");
 assert.throws(()=>f.service.startAuthorized(f.service.prepareStart(task.id)),/synthetic start save failure/);
 assert.deepEqual(f.service.get(task.id),before);assert.equal((f.service as any).grants.has(task.id),false);assert.equal(f.service.busy,false);assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);
 assert.deepEqual(JSON.parse(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id).record_json),before);
 db.exec('DROP TRIGGER fail_start');f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(f.service.get(task.id).status,'COMPLETED');
});


test('changed recipe quantity cannot bypass a historical profit rejection by changing its key',async t=>{
 const f=fixture(t,'live');f.rules.pricing.bundleEnabled=false;f.product.variants[0].purchasePrice='100';
 f.dependencies.planSales=()=>buildSalesRecipes(f.product,null,f.rules).map((recipe):SalesListingPlan=>({namingGroupId:randomUUID(),sourceGroupKey:'same-source',collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:'SALE-ONE',baseSku:'SALE-ONE',recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'fixture',familyResolved:true,namingChildKey:null}));
 const prepare=f.dependencies.amazon.prepareDrafts;
 const reprice=(draft:AmazonDraft,recipe:SalesListingPlan['recipe'])=>{
   const result=applyBusinessRules({product:f.product,variant:f.product.variants[0],target:f.target,schema:realAmazonSchema(),attributes:{},measurements:{},costCny:recipe.totalCostCny,saleUnit:recipe,packageMatchesSaleUnit:true,now:new Date()},f.rules);
   return {...draft,salesPlan:{...draft.salesPlan!,recipe},attributes:result.attributes,businessRules:result.report};
 };
 f.dependencies.amazon.prepareDrafts=async(raw,plans)=>{const result=await prepare(raw,plans),draft=result.items[0].draft!;draft.sku=plans![0].sku;draft.salesPlan=plans![0];Object.assign(draft,reprice(draft,plans![0].recipe));f.drafts.set(draft.id,structuredClone(draft));return result;};
 const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 assert.equal(f.service.get(task.id).items[0].status,'SCREENED');
 f.product.variants[0].originalSpec='red 2 pc';f.product.variants[0].normalizedSpec='red 2 pc';
 let previews=0;f.dependencies.amazon.previewPricing=(id,_source,recipe)=>{previews++;return reprice(f.drafts.get(id)!,recipe!);};
 const queue=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(queue.products[0].eligibleCount,0);assert.equal(previews,1);assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);
});
for(const shape of ['94-A','94-B'])test(`legacy ${shape} missing workflow is delegated with its original budget and cannot submit`,async t=>{
 const f=fixture(t);let admissionOptions:any;f.dependencies.images.complete=async(_input,options)=>{f.calls.images++;admissionOptions=options;throw Error('mock stop before any provider work');};
 const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 assert.equal(f.service.get(task.id).items[0].imageStarted,true);assert.equal(f.workflow.size,0);
 f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 assert.deepEqual(admissionOptions,{legacyImageAttempts:0});assert.equal(f.calls.images,2);assert.equal(f.calls.submissions,0);
});

test('W2 read-only adaptation detects current selection and source without writes or dispatch; apply is stale-safe and idempotent', async t => {
  const f=fixture(t), task=await f.create();
  f.dependencies.store.getProductSnapshot=()=>structuredClone(f.product);
  f.dependencies.store.getProduct=()=>{throw new Error('mutating read forbidden');};
  f.product.revision++; f.product.title='Current box';
  const before=f.service.get(task.id);
  const preview=f.service.previewAdaptation(task.id);
  assert.ok(preview.changes.some(change=>change.kind==='SOURCE'));
  assert.deepEqual(f.service.get(task.id),before);
  assert.deepEqual(f.calls,{sources:0,images:0,submissions:0,batches:0,labels:0});
  f.product.revision++;
  assert.throws(()=>f.service.applyAdaptation({taskId:task.id,token:preview.token}),/变化/);
  const fresh=f.service.previewAdaptation(task.id), applied=f.service.applyAdaptation({taskId:task.id,token:fresh.token});
  assert.equal(applied.status,'PAUSED');assert.equal(applied.items[0].productRevision,f.product.revision);
  assert.deepEqual(f.service.applyAdaptation({taskId:task.id,token:fresh.token}),applied);
  assert.equal(applied.items[0].imageAttempts,before.items[0].imageAttempts);
  const db=openDatabase(f.directory);
  try{assert.equal(db.prepare("SELECT count(*) n FROM audit_events WHERE action='automatic-listing.adapted'").get()!.n,1);}finally{db.close();}
});

test('W2 task save failure rolls back task and audit then restart accepts the same preview', async t=>{
  const f=fixture(t),task=await f.create();f.dependencies.store.getProductSnapshot=()=>structuredClone(f.product);
  f.product.revision++;const preview=f.service.previewAdaptation(task.id),before=f.service.get(task.id),original=(f.service as any).save;
  (f.service as any).save=function(...args:any[]){original.apply(this,args);throw Error('save failed');};
  assert.throws(()=>f.service.applyAdaptation({taskId:task.id,token:preview.token}),/save failed/);
  assert.deepEqual(f.service.get(task.id),before);
  (f.service as any).save=original;await f.service.close();
  const restarted=new AutomaticListingService(f.directory,f.dependencies);f.cleanups.push(()=>restarted.close());
  assert.deepEqual(restarted.get(task.id),before);
  const applied=restarted.applyAdaptation({taskId:task.id,token:preview.token});assert.equal(applied.status,'PAUSED');
  const db=openDatabase(f.directory);try{assert.equal(db.prepare("SELECT count(*) n FROM audit_events WHERE action='automatic-listing.adapted'").get()!.n,1);}finally{db.close();}
});

test('W2 submitted rows remain byte-identical when task rules change, in-flight apply is rejected without cancellation',async t=>{
  const f=fixture(t),task=await f.create();f.dependencies.store.getProductSnapshot=()=>structuredClone(f.product);
  const saved=(f.service as any).tasks.get(task.id),row=saved.items[0];
  row.draftId=randomUUID();row.stage='READBACK';row.status='WAITING';row.imageStarted=true;row.imageAttempts=3;
  f.drafts.set(row.draftId,{id:row.draftId,submittedAt:new Date().toISOString(),state:'SUBMITTED',revision:7} as AmazonDraft);
  (f.service as any).save(saved);const before=structuredClone(row);f.rules.revision++;f.rules.product.stockSets++;
  let p=f.service.previewAdaptation(task.id);const result=f.service.applyAdaptation({taskId:task.id,token:p.token});assert.deepEqual(result.items[0],before);
  const current=(f.service as any).tasks.get(task.id);current.status='RUNNING';p=f.service.previewAdaptation(task.id);assert.equal(p.canApply,false);
  assert.throws(()=>f.service.applyAdaptation({taskId:task.id,token:p.token}),/进行/);assert.deepEqual(f.calls,{sources:0,images:0,submissions:0,batches:0,labels:0});
});

test('W2 IPC preview/apply never invokes task start confirmation or paid work',async t=>{
 const f=fixture(t),task=await f.create();f.dependencies.store.getProductSnapshot=()=>structuredClone(f.product);f.product.revision++;
 const handlers=new Map<string,(...args:any[])=>any>();installAutomaticListingIpc(f.service,(name,_count,fn)=>handlers.set(name,fn),{confirm:async()=>{throw Error('unexpected start');},audit:()=>{}});
 const preview=await handlers.get('red:automatic-listing:adaptation-preview')!(task.id),applied=handlers.get('red:automatic-listing:adaptation-apply')!({taskId:task.id,token:preview.token});
 assert.equal(applied.status,'PAUSED');assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);
});

test('W2 complete source selection adds missing rows with atomic naming and no duplicate identity after retry',async t=>{
 const {SkuNamingService}=await import('../src/main/sku-naming/service.ts');const {planSalesListings}=await import('../src/main/sales-plans/planning.ts');
 const f=fixture(t);f.product.facts.push({id:randomUUID(),name:'采购币种',value:'CNY',source:'manual',sourceRef:'fixture',state:'human_confirmed'});
 f.dependencies.store.getProductSnapshot=()=>structuredClone(f.product);
 const naming=new SkuNamingService(f.directory);f.cleanups.push(async()=>naming.close());
 f.dependencies.planSales=()=>planSalesListings(f.product,null,f.target,f.rules,naming);
 f.dependencies.planSalesForAdaptation=(source,_target,db)=>planSalesListings(source,null,f.target,f.rules,new SkuNamingService(f.directory,db));
 const task=await f.create();const old=task.items[0];
 f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO',originalSpec:'green',normalizedSpec:'green',sourceSpec:'green'});f.product.revision++;
 const p=f.service.previewAdaptation(task.id);assert.ok(p.changes.some(c=>c.kind==='NEW'));
 const beforeGroups=(f.service as any).db.prepare('SELECT * FROM sku_naming_groups').all(),save=(f.service as any).save;
 (f.service as any).save=()=>{throw Error('task save failure');};assert.throws(()=>f.service.applyAdaptation({taskId:task.id,token:p.token}),/task save failure/);
 assert.deepEqual((f.service as any).db.prepare('SELECT * FROM sku_naming_groups').all(),beforeGroups);
 (f.service as any).save=save;const next=f.service.applyAdaptation({taskId:task.id,token:p.token});assert.equal(next.items.length,2);assert.equal(next.items[0].sku,old.sku);
 assert.equal(new Set(next.items.map(r=>r.sku)).size,2);assert.deepEqual(f.service.applyAdaptation({taskId:task.id,token:p.token}),next);
 assert.equal(f.calls.sources+f.calls.images+f.calls.submissions,0);
});

for(const changed of ['task','rules','draft','request'] as const)test(`W2 rejects preview when ${changed} changes before apply`,async t=>{
 const f=fixture(t),task=await f.create();f.dependencies.store.getProductSnapshot=()=>structuredClone(f.product);const saved=(f.service as any).tasks.get(task.id),row=saved.items[0];
 row.draftId=randomUUID();row.stage='IMAGES';f.drafts.set(row.draftId,{id:row.draftId,productId:f.product.id,productRevision:f.product.revision,state:'DRAFT',revision:1,submittedAt:null,attributes:{},localIssues:[],schema:{}} as unknown as AmazonDraft);(f.service as any).save(saved);
 const preview=f.service.previewAdaptation(task.id);
 if(changed==='task')saved.revision++;if(changed==='rules')f.rules.revision++;if(changed==='draft')f.drafts.get(row.draftId)!.revision++;
 if(changed==='request')(f.service as any).db.prepare('INSERT INTO ai_calls VALUES(?,?)').run(randomUUID(),JSON.stringify({id:randomUUID(),productId:f.product.id,status:'FAILED',finishedAt:new Date().toISOString()}));
 assert.throws(()=>f.service.applyAdaptation({taskId:task.id,token:preview.token}),/变化/);assert.equal(f.calls.images+f.calls.sources+f.calls.submissions,0);
});
for(const phase of ['create','start'] as const)test(`local failure after seven approved images records stage evidence and preserves work: ${phase}`, async t=>{
  const f=fixture(t), task=await f.create();
  const failure=Object.assign(new Error('Bearer sk-private https://private.test/path'),phase==='create'?{}:{code:'ENOSPC'});
  failure.stack='Error: private\n    at save (C:\\private\\src\\main\\execution\\service.ts:88:9)';
  if(phase==='create')f.dependencies.execution.create=()=>{throw failure;};else f.dependencies.execution.startAuthorized=()=>{throw failure;};
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const row=f.service.get(task.id).items[0], workflow=structuredClone(f.workflow.get(row.draftId!));
  assert.equal(workflow.slots.filter((slot:any)=>slot.status==='PASSED').length,7);assert.match(row.error!,new RegExp(row.sku));assert.match(row.error!,new RegExp(row.stage));
  assert.equal(row.imageAttempts,7);assert.deepEqual(row.executionTaskIds,[...f.executions.keys()]);assert.equal(row.executionTaskIds.length,phase==='create'?0:1);assert.equal(f.calls.submissions,0);
  const db=openDatabase(f.directory);try{
    const record=db.prepare("SELECT detail_json FROM audit_events WHERE action='operation.failed'").get() as any;
    assert.ok(record,'failure evidence must exist before public mapping');
    const detail=JSON.parse(record.detail_json);
    assert.equal(detail.stage,phase==='create'?'IMAGES':'EXECUTION');assert.equal(detail.taskId,task.id);assert.equal(detail.variantId,row.variantId);
    assert.equal(detail.code,phase==='create'?'UNKNOWN_LOCAL_ERROR':'ENOSPC');assert.deepEqual(detail.executionTaskIds,row.executionTaskIds);assert.equal(detail.callsite,'src/main/execution/service.ts:88:9');
    assert.doesNotMatch(record.detail_json,/sk-private|private.test|C:\\\\private/);
  }finally{db.close();}
  assert.deepEqual(f.workflow.get(row.draftId!),workflow);
});


test('idle observer avoids procurement scans and unchanged task revision churn',async t=>{
 const f=fixture(t);let scans=0;f.dependencies.procurement.candidates=()=>{scans++;return [];};
 await f.service.refreshWaiting();assert.equal(scans,0,'no task means no expensive scan');
 const created=await f.create();f.service.pause(created.id);const paused=f.service.get(created.id);
 await f.service.refreshWaiting();assert.equal(scans,0,'paused task must not scan');assert.deepEqual(f.service.get(created.id),paused);
 const saved=(f.service as any).tasks.get(created.id);saved.status='NEEDS_ATTENTION';saved.items[0].status='FAILED';saved.items[0].error='source failure';
 await f.service.refreshWaiting();const settled=f.service.get(created.id);
 await f.service.refreshWaiting();assert.deepEqual(f.service.get(created.id),settled,'unchanged observation must not rewrite revision or updatedAt');assert.equal(scans,0,'source failures have no readback candidates');
 saved.items[0].error='new source failure';await f.service.refreshWaiting();assert.ok(f.service.get(created.id).revision>settled.revision);assert.equal(f.service.get(created.id).error,'new source failure');
});


test('global procurement scan failure aborts observation once without reclassifying any SKU',async t=>{
 const f=fixture(t,'live');f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SECOND'});const task=await f.create(),saved=(f.service as any).tasks.get(task.id);saved.status='WAITING';
 for(const row of saved.items){row.draftId=randomUUID();row.stage='READBACK';row.status='WAITING';}
 let scans=0;f.dependencies.procurement.candidates=()=>{scans++;throw Error('global candidate failure');};const before=f.service.get(task.id);
 await assert.rejects(()=>f.service.refreshWaiting(),/global candidate failure/);assert.equal(scans,1);assert.deepEqual(f.service.get(task.id),before);
});

for(const stop of ['pause','suspend','close'] as const)test(`background procurement scan stops safely on ${stop} and stays single-flight`,async t=>{
 const f=fixture(t,'live'),task=await f.create(),saved=(f.service as any).tasks.get(task.id);saved.status='WAITING';
 saved.items[0].draftId=randomUUID();saved.items[0].stage='READBACK';saved.items[0].status='WAITING';
 let scans=0,stopped:ReturnType<typeof f.service.get>|undefined,closing:Promise<void>|undefined;
 f.dependencies.procurement.candidates=()=>{throw Error('background observer must use cooperative projection');};
 f.dependencies.procurement.candidatesForObservation=async canContinue=>{
   scans++;assert.equal(canContinue!(),true);
   await new Promise<void>(resolve=>setImmediate(()=>{
     if(stop==='pause')stopped=f.service.pause(task.id);
     else if(stop==='suspend')f.service.suspendScheduling();
     else closing=f.service.close();
     resolve();
   }));
   assert.equal(canContinue!(),false);return null;
 };
 const pending=f.service.refreshWaiting();assert.equal(f.service.refreshWaiting(),pending);
 await pending;await closing;assert.equal(scans,1);assert.equal(f.calls.batches,0);assert.equal(f.calls.labels,0);
 if(stopped)assert.deepEqual(f.service.get(task.id),stopped);
});


test('UI adaptation yields to pending input and keeps the exact synchronous proof',async t=>{
 const f=fixture(t),task=await f.create();f.dependencies.store.getProductSnapshot=()=>structuredClone(f.product);
 const baseline=f.service.previewAdaptation(task.id);let inputHandled=false;setImmediate(()=>{inputHandled=true;});
 const preview=await f.service.previewAdaptationForUi(task.id);assert.equal(inputHandled,true);assert.deepEqual(preview,baseline);assert.equal(f.calls.submissions,0);assert.equal(f.calls.images,0);
});
test('UI adaptation discards obsolete work and blocks apply if task changes during a yield',async t=>{
 const f=fixture(t),task=await f.create();f.dependencies.store.getProductSnapshot=()=>structuredClone(f.product);
 setImmediate(()=>f.service.pause(task.id));const preview=await f.service.previewAdaptationForUi(task.id);assert.equal(preview.canApply,false);assert.match(preview.blockers.join('；'),/任务.*变化/);assert.equal(preview.sources.length,0);assert.throws(()=>f.service.applyAdaptation({taskId:task.id,token:preview.token}),/变化/);assert.equal(f.service.get(task.id).status,'PAUSED');assert.equal(f.calls.images,0);
});

test('Schema retries only its GET while waiting and resumes the original row after success',async t=>{
  const {SchemaTransientError}=await import('../src/main/amazon/schema-retry.ts');
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=fixture(t);let gets=0,prepares=0,ready=false;
  const original=f.dependencies.amazon.prepareDrafts;
  const selected={targetId:f.target.id,productType:'BOX',requirements:'LISTING',parentageLevel:'NONE',locale:'en_US'} as const;
  f.dependencies.amazon.prepareDrafts=async(...args)=>{prepares++;if(!ready){const e=new SchemaTransientError('BODY_INCOMPLETE');e.selection=selected;throw e;}return original(...args);};
  (f.dependencies.amazon as any).getSchema=async()=>{gets++;if(gets===1){const e=new SchemaTransientError('BODY_INCOMPLETE');e.selection=selected;throw e;}ready=true;return {};};
  const created=await f.create();f.service.startAuthorized(f.service.prepareStart(created.id));await f.service.waitForIdle();
  const waiting=f.service.get(created.id);assert.equal(waiting.status,'WAITING');assert.equal(waiting.items[0].schemaRetry?.usedDelayedRounds,0);
  const counts=structuredClone(f.calls);await f.service.refreshWaiting();assert.equal(gets,0);
  t.mock.timers.tick(30_001);await f.service.refreshWaiting();assert.equal(gets,1);assert.equal(prepares,1);assert.deepEqual(f.calls,counts);
  assert.equal(f.service.get(created.id).items[0].schemaRetry?.usedDelayedRounds,1);
  t.mock.timers.tick(90_001);await f.service.refreshWaiting();await new Promise(resolve=>setImmediate(resolve));await f.service.waitForIdle();
  assert.equal(gets,2);assert.equal(prepares,2);assert.equal(f.calls.sources,counts.sources);assert.equal(f.calls.submissions,1);
  assert.equal(f.service.get(created.id).items[0].schemaRetry?.state,'SUCCEEDED');
});

async function schemaWaitingFixture(t:test.TestContext){
  const {SchemaTransientError}=await import('../src/main/amazon/schema-retry.ts');
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=fixture(t),selected={targetId:f.target.id,productType:'BOX',requirements:'LISTING',parentageLevel:'NONE',locale:'en_US'} as const;
  const failure=()=>Object.assign(new SchemaTransientError('BODY_INCOMPLETE'),{selection:selected});
  const healthyPrepare=f.dependencies.amazon.prepareDrafts;
  f.dependencies.amazon.prepareDrafts=async()=>{throw failure();};let gets=0;
  f.dependencies.amazon.getSchema=async()=>{gets++;throw failure();};
  const created=await f.create();f.service.startAuthorized(f.service.prepareStart(created.id));await f.service.waitForIdle();
  return {...f,id:created.id,get gets(){return gets;},failure,healthyPrepare};
}
test('Schema delayed budget expires after three rounds and explicit resume cannot reset it',async t=>{
  const f=await schemaWaitingFixture(t),counts=structuredClone(f.calls);
  for(const ms of [30_001,90_001,180_001]){t.mock.timers.tick(ms);await f.service.refreshWaiting();}
  assert.equal(f.gets,3);assert.equal(f.service.get(f.id).items[0].schemaRetry?.state,'EXHAUSTED');assert.deepEqual(f.calls,counts);
  f.service.startAuthorized(f.service.prepareStart(f.id));await f.service.waitForIdle();assert.equal(f.gets,3);assert.equal(f.service.get(f.id).items[0].schemaRetry?.usedDelayedRounds,3);
});
test('Schema deadline and permanent errors stop without additional row preparation',async t=>{
  const f=await schemaWaitingFixture(t);t.mock.timers.tick(600_001);await f.service.refreshWaiting();
  assert.equal(f.gets,0);assert.equal(f.service.get(f.id).items[0].schemaRetry?.state,'EXHAUSTED');
});
for(const action of ['pause','cancel','suspend','confirm','revoke'] as const)test(`Schema due GET respects ${action}`,async t=>{
  const f=await schemaWaitingFixture(t);t.mock.timers.tick(30_001);
  if(action==='pause')f.service.pause(f.id);else if(action==='cancel')f.service.cancel(f.id);else if(action==='suspend')f.service.suspendScheduling();else if(action==='confirm')(f.service as any).confirming.add(f.id);else (f.service as any).grants.delete(f.id);
  await f.service.refreshWaiting();assert.equal(f.gets,0);
});
for(const action of ['pause','cancel','close','source'] as const)test(`Schema GET reservation survives in-flight ${action} and does not resume paid work`,async t=>{
  const f=await schemaWaitingFixture(t),counts=structuredClone(f.calls);let release!:()=>void;
  const started=new Promise<void>(resolve=>{f.dependencies.amazon.getSchema=async()=>{resolve();await new Promise<void>(r=>release=r);return {} as any;};});
  t.mock.timers.tick(30_001);const observation=f.service.refreshWaiting();
  try {
    await reachedStage(started,observation,()=>f.service.get(f.id));
    assert.equal(f.service.get(f.id).items[0].schemaRetry?.usedDelayedRounds,1);
    let closing:Promise<void>|undefined,closed=false;
    if(action==='pause')f.service.pause(f.id);else if(action==='cancel')f.service.cancel(f.id);else if(action==='close'){closing=f.service.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);}else f.product.revision++;
    release();await observation;await closing;assert.deepEqual(f.calls,counts);
    if(action!=='close')assert.notEqual(f.service.get(f.id).status,'QUEUED');
  } finally {release?.();await observation;}
});
test('restart revokes Schema grant and explicit resume retains consumed rounds',async t=>{
  const f=await schemaWaitingFixture(t);t.mock.timers.tick(30_001);await f.service.refreshWaiting();await f.service.close();
  const reopened=new AutomaticListingService(f.directory,f.dependencies);f.cleanups.push(()=>reopened.close());
  assert.equal(reopened.get(f.id).status,'PAUSED');assert.equal(reopened.get(f.id).items[0].schemaRetry?.usedDelayedRounds,1);
  t.mock.timers.tick(90_001);await reopened.refreshWaiting();assert.equal(f.gets,1);
  reopened.startAuthorized(reopened.prepareStart(f.id));await reopened.waitForIdle();assert.equal(f.gets,2);assert.equal(reopened.get(f.id).items[0].schemaRetry?.usedDelayedRounds,2);
});
test('Schema receipts strictly reject unknown fields, impossible rounds and signed URLs',async t=>{
  const f=await schemaWaitingFixture(t),saved=f.service.get(f.id);
  for(const patch of [{usedDelayedRounds:4},{deadlineAt:new Date(Date.now()+700_000).toISOString()},{url:'https://secret.test/signed'}]){
    const bad=structuredClone(saved);Object.assign(bad.items[0].schemaRetry!,patch);assert.throws(()=>validateAutomaticListingTask(bad));
  }
  const old=structuredClone(saved);delete old.items[0].schemaRetry;assert.doesNotThrow(()=>validateAutomaticListingTask(old));
});

test('older backup retains Schema delayed rounds and deadline without restoring permission',async t=>{
  const {retainSchemaRetryBudgets}=await import('../src/main/automatic-listing/schema-retry-budget.ts');
  const f=await schemaWaitingFixture(t),old=f.service.get(f.id);
  t.mock.timers.tick(30_001);await f.service.refreshWaiting();
  const snapshotDir=mkdtempSync(join(resolve('.test-data'),'schema-backup-')),snapshot=openDatabase(snapshotDir),current=openDatabase(f.directory);
  try{
    snapshot.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(old.id,JSON.stringify(old));
    retainSchemaRetryBudgets(current,snapshot);
    const restored=validateAutomaticListingTask(JSON.parse(String(snapshot.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(old.id)!.record_json)));
    assert.equal(restored.items[0].schemaRetry?.usedDelayedRounds,1);assert.equal(restored.items[0].schemaRetry?.deadlineAt,old.items[0].schemaRetry?.deadlineAt);assert.equal(restored.status,'PAUSED');
  }finally{snapshot.close();current.close();rmSync(snapshotDir,{recursive:true,force:true});}
});
test('Schema grant never leaks to another waiting task',async t=>{
  const f=await schemaWaitingFixture(t),other=structuredClone(f.service.get(f.id));other.id=randomUUID();other.items[0].schemaRetry!.scope=(f.service as any).schemaScope(other,other.items[0],other.items[0].schemaRetry!.selection);
  (f.service as any).tasks.set(other.id,other);(f.service as any).save(other);
  t.mock.timers.tick(30_001);await f.service.refreshWaiting();assert.equal(f.gets,1);assert.equal(f.service.get(other.id).items[0].schemaRetry?.usedDelayedRounds,0);
});

test('a later image failure after Schema success can explicitly continue without resetting Schema history',async t=>{
  const f=await schemaWaitingFixture(t),complete=f.dependencies.images.complete;
  f.dependencies.amazon.prepareDrafts=f.healthyPrepare;
  f.dependencies.amazon.getSchema=async()=>({} as any);
  f.dependencies.images.complete=async()=>{throw new UserFacingError('Later local image failure');};
  t.mock.timers.tick(30_001);await f.service.refreshWaiting();await new Promise(r=>setImmediate(r));await f.service.waitForIdle();
  const row=f.service.get(f.id).items[0];assert.equal(row.schemaRetry?.state,'SUCCEEDED');assert.equal(row.status,'FAILED');
  f.dependencies.images.complete=complete;
  f.service.startAuthorized(f.service.prepareStart(f.id));await f.service.waitForIdle();
  assert.equal(f.calls.submissions,1);assert.equal(f.service.get(f.id).items[0].schemaRetry?.usedDelayedRounds,1);
});
test('a permanent error in the delayed Schema GET exhausts the receipt without preparing the row',async t=>{
  const f=await schemaWaitingFixture(t),counts=structuredClone(f.calls);let calls=0;
  f.dependencies.amazon.getSchema=async()=>{calls++;throw new UserFacingError('Amazon Schema checksum 校验失败');};
  t.mock.timers.tick(30_001);await f.service.refreshWaiting();t.mock.timers.tick(180_001);await f.service.refreshWaiting();
  assert.equal(calls,1);assert.equal(f.service.get(f.id).items[0].schemaRetry?.state,'EXHAUSTED');assert.match(f.service.get(f.id).items[0].error!,/checksum/);assert.deepEqual(f.calls,counts);
});
for(const status of ['WAITING','PAUSED','CANCELLED'] as const)test(`legacy LABELS ${status} retains evidence and requires readback eligibility`,async t=>{
 const f=fixture(t,'live'),task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 const stored=(f.service as any).tasks.get(task.id);stored.status=status;stored.items[0].stage='LABELS';stored.items[0].error='历史标签权限错误';stored.items[0].status='FAILED';
 const labels={pause:0,resume:0,cancel:0};f.dependencies.labels.pauseJob=()=>labels.pause++;f.dependencies.labels.resumeJob=()=>labels.resume++;f.dependencies.labels.cancelJob=()=>labels.cancel++;
 await f.service.refreshWaiting();let row=f.service.get(task.id).items[0];assert.notEqual(row.status,'DONE');
 if(status==='WAITING'){
  const db=openDatabase(f.directory);const evidence=db.prepare("SELECT detail_json FROM audit_events WHERE action='automatic-listing.labels-detached'").all();db.close();assert.equal(evidence.length,1);assert.match(String(evidence[0].detail_json),/历史标签权限错误/);
  f.setReady();await f.service.refreshWaiting();row=f.service.get(task.id).items[0];assert.equal(row.status,'DONE');assert.equal(row.stage,'COMPLETE');assert.equal(f.calls.labels,0);
 }else{assert.equal(f.service.get(task.id).status,status);assert.equal(row.error,'历史标签权限错误');}
 assert.deepEqual(labels,{pause:0,resume:0,cancel:0});
});

test('deferred task admission rejects missing Batch runtime without freezing sources',async t=>{
 const f=fixture(t);
 await assert.rejects(f.service.create({productIds:[f.product.id],targetId:f.target.id,profileId:'alpha',executionMode:'deferred_batch'}),/Batch/);
 assert.equal(f.service.list().length,0);
});

import { TaskBatchRuntime } from '../src/main/ai/batch/task-runtime.ts';
import { resolvePurpose } from '../src/main/ai/purpose-routing.ts';
test('task mode and immutable purpose coverage survive create, immediate switch and IPC reads',async t=>{
 const f=fixture(t),db=openDatabase(f.directory),credentialScope='a'.repeat(64);f.cleanups.push(async()=>db.close());
 f.dependencies.batch=new TaskBatchRuntime(db,f.directory,{fetch:async()=>{throw Error('No requests allowed');},credential:()=>({apiKey:'plan-fixture-only-key',scope:credentialScope})});
 const purpose=resolvePurpose(db,'listing_title'),plan={version:1 as const,credentialScope,purposes:[purpose],coverage:[{purposeId:'listing_title',mode:'deferred_batch' as const,reason:'Supported text'}]};
 f.dependencies.batchPlan=()=>structuredClone(plan);
 const task=await f.service.create({productIds:[f.product.id],targetId:f.target.id,profileId:'alpha',executionMode:'deferred_batch'});
 assert.equal(task.executionMode,'deferred_batch');assert.deepEqual(task.batchPlan,plan);
 plan.purposes[0].revision++;
 const switched=f.service.setExecutionMode({taskId:task.id,mode:'immediate'});assert.equal(switched.batchPlan!.purposes[0].revision,task.batchPlan!.purposes[0].revision);
 const handlers=new Map<string,(...args:any[])=>Promise<any>>();installAutomaticListingIpc(f.service,(channel,_count,handler)=>handlers.set(channel,async(...args)=>handler(...args)),{confirm:async()=>false,audit:()=>{}});
 const summary=await handlers.get('red:automatic-listing:batch-summary')!(task.id);assert.equal(summary.mode,'immediate');assert.deepEqual(summary.batches,[]);
 assert.equal((await handlers.get('red:automatic-listing:batch-plan')!()).coverage[0].reason,'Supported text');
 const legacy=structuredClone(switched);delete legacy.executionMode;delete legacy.batchPlan;assert.equal(validateAutomaticListingTask(legacy).executionMode??'immediate','immediate');
});

test('readback observation without an execution grant cannot create a procurement step and restart revokes waiting authorization',async t=>{
 const f=fixture(t),created=await f.create(),task=(f.service as any).tasks.get(created.id),row=task.items[0];
 const prepared=await f.dependencies.amazon.prepareDrafts({targetId:f.target.id,productType:'BOX',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US',items:[{productId:f.product.id,productRevision:f.product.revision,variantId:f.product.variants[0].id,attributes:{}}]});
 row.draftId=prepared.items[0].draft!.id;row.stage='READBACK';row.status='WAITING';task.status='WAITING';(f.service as any).save(task);
 f.dependencies.procurement.candidates=()=>[{draftId:row.draftId,eligible:true}] as any;
 await f.service.refreshWaiting();assert.equal(f.calls.batches,0,'GET/readback is not a new execution grant');
 await f.service.close();const restored=new AutomaticListingService(f.directory,f.dependencies);f.cleanups.push(()=>restored.close());
 assert.equal(restored.get(task.id).status,'PAUSED');await restored.refreshWaiting();assert.equal(f.calls.batches,0);
});

test('saved READBACK failure is stable but a new response with the same error is a new event',async t=>{
 const f=fixture(t,'live'),task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 let response=1;f.dependencies.followup.get=()=>({status:'NEEDS_ATTENTION',error:'saved failure',checkedAt:`2026-10-14T00:00:0${response}.000Z`} as any);
 await f.service.refreshWaiting();const first=f.service.get(task.id);
 const db=openDatabase(f.directory);const logs=()=>Number(db.prepare("SELECT count(*) n FROM audit_events WHERE action='operation.failed'").get()!.n);
 try{const count=logs();await new Promise(r=>setTimeout(r,5));await f.service.refreshWaiting();assert.deepEqual(f.service.get(task.id),first);assert.equal(logs(),count);
 response++;await f.service.refreshWaiting();const next=f.service.get(task.id);assert.ok(next.revision>first.revision);assert.notEqual(next.items[0].outcome?.classifiedAt,first.items[0].outcome?.classifiedAt);assert.equal(logs(),count+1);
 }finally{db.close();}
});
test('parallel UI previews share one readonly computation and release the flight after completion',async t=>{
 const f=fixture(t),task=await f.create();let reads=0;f.dependencies.store.getProductSnapshot=()=>{reads++;return structuredClone(f.product);};
 const [a,b]=await Promise.all([f.service.previewAdaptationForUi(task.id),f.service.previewAdaptationForUi(task.id)]);assert.deepEqual(a,b);assert.equal(reads,1);
 await f.service.previewAdaptationForUi(task.id);assert.equal(reads,2);
});

test('saved READBACK observation identity survives restart and rejects malformed stamps',async t=>{
 const f=fixture(t,'live'),task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 f.dependencies.followup.get=()=>({status:'NEEDS_ATTENTION',error:'saved failure',checkedAt:'2026-10-14T00:00:01.000Z'} as any);
 await f.service.refreshWaiting();const first=f.service.get(task.id);assert.match(first.items[0].observationFailureStamp!,/^[a-f0-9]{64}$/);
 const bad=structuredClone(first);bad.items[0].observationFailureStamp='invalid';assert.throws(()=>validateAutomaticListingTask(bad));
 await f.service.close();const reopened=new AutomaticListingService(f.directory,f.dependencies);f.cleanups.push(()=>reopened.close());await reopened.refreshWaiting();assert.deepEqual(reopened.get(task.id),first);
});
test('same-text new dependency failures are never deduplicated as saved observations',async t=>{
 const f=fixture(t,'live'),task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 f.dependencies.followup.get=()=>{throw new Error('new I/O failure');};await f.service.refreshWaiting();const first=f.service.get(task.id);await new Promise(r=>setTimeout(r,5));await f.service.refreshWaiting();
 const next=f.service.get(task.id);assert.ok(next.revision>first.revision);assert.notEqual(next.items[0].outcome?.classifiedAt,first.items[0].outcome?.classifiedAt);assert.equal(next.items[0].observationFailureStamp,undefined);
});
test('UI preview invalidates a changed rule scope and does not share its obsolete flight',async t=>{
 const f=fixture(t),task=await f.create();f.dependencies.store.getProductSnapshot=()=>structuredClone(f.product);
 const old=f.service.previewAdaptationForUi(task.id);f.rules.revision++;const fresh=f.service.previewAdaptationForUi(task.id);
 const [a,b]=await Promise.all([old,fresh]);assert.equal(a.canApply,false);assert.equal(a.sources.length,0);assert.notEqual(a.token,b.token);assert.deepEqual(b,f.service.previewAdaptation(task.id));
});
test('UI preview detects writes from another database connection before expensive projection',async t=>{
 const f=fixture(t),task=await f.create();let reads=0;f.dependencies.store.getProductSnapshot=()=>{reads++;return structuredClone(f.product);};
 const pending=f.service.previewAdaptationForUi(task.id),db=openDatabase(f.directory);try{db.prepare("INSERT INTO audit_events(id,product_id,action,summary,detail_json,created_at) VALUES(?,NULL,'test.changed','changed','{}',?)").run(randomUUID(),new Date().toISOString());}finally{db.close();}
 const preview=await pending;assert.equal(preview.canApply,false);assert.equal(reads,0);
});
test('background fallback uses active 10s / idle 30s and explicit refresh remains immediate',async t=>{
 const f=fixture(t),task=await f.create();t.mock.timers.enable({apis:['setTimeout','setInterval']});let reads=0;
 f.service.refreshWaiting=async()=>{reads++;};f.service.start();assert.equal(reads,1);t.mock.timers.tick(29_999);assert.equal(reads,1);t.mock.timers.tick(1);assert.equal(reads,2);await Promise.resolve();await Promise.resolve();
 f.service.suspendScheduling();(f.service as any).tasks.get(task.id).status='WAITING';f.service.start();const count=reads;t.mock.timers.tick(9_999);assert.equal(reads,count);t.mock.timers.tick(1);assert.equal(reads,count+1);await Promise.resolve();await Promise.resolve();
 await f.service.refreshWaiting();assert.equal(reads,count+2);f.service.suspendScheduling();t.mock.timers.tick(60_000);assert.equal(reads,count+2);
});

test('legacy same saved failure establishes its stamp without rewriting the old failure time',async t=>{
 const f=fixture(t,'live'),task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 let checkedAt='2026-10-01T00:00:00.000Z';f.dependencies.followup.get=()=>({status:'NEEDS_ATTENTION',error:'same failure',checkedAt} as any);
 await f.service.refreshWaiting();const saved=(f.service as any).tasks.get(task.id);delete saved.items[0].observationFailureStamp;const previous=f.service.get(task.id);(f.service as any).save(saved);
 await new Promise(r=>setTimeout(r,5));await f.service.refreshWaiting();const checkpoint=f.service.get(task.id);assert.ok(checkpoint.items[0].observationFailureStamp);assert.equal(checkpoint.items[0].outcome?.classifiedAt,previous.items[0].outcome?.classifiedAt);
 delete saved.items[0].observationFailureStamp;checkedAt=new Date(Date.now()+1_000).toISOString();(f.service as any).save(saved);await new Promise(r=>setTimeout(r,5));await f.service.refreshWaiting();assert.notEqual(f.service.get(task.id).items[0].outcome?.classifiedAt,checkpoint.items[0].outcome?.classifiedAt,'new response is not mistaken for legacy observation even without stamp');
});

test('a readonly observer can conservatively expire one preview but explicit refresh works after it settles',async t=>{
 const f=fixture(t),task=await f.create();let reads=0;f.dependencies.store.getProductSnapshot=()=>{reads++;return structuredClone(f.product);};
 const pending=f.service.previewAdaptationForUi(task.id);(f.service as any).observing=Promise.resolve();const stale=await pending;assert.equal(stale.canApply,false);assert.equal(reads,0);assert.equal((f.service as any).previewFlights.size,0);
 (f.service as any).observing=null;const fresh=await f.service.previewAdaptationForUi(task.id);assert.equal(fresh.canApply,true);assert.equal(reads,1);assert.equal((f.service as any).previewFlights.size,0);
});

test('P05 targeted resume does not execute an unselected pending sibling',async t=>{
 const f=fixture(t);f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO',originalSpec:'blue',normalizedSpec:'blue',sourceSpec:'blue'});
 const task=await f.create();assert.equal(task.items.length,2);
 const scope={mode:'targeted' as const,selections:[{key:task.items[0].key}]};
 const preview=await f.service.previewResume({taskId:task.id,scope});
 await f.service.confirmResume({taskId:task.id,taskRevision:preview.taskRevision,token:preview.token,scope},async()=>true);
 await f.service.waitForIdle();
 assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);
 assert.equal(f.service.get(task.id).items[1].draftId,null);
});

test('P05 cancelled or stale scope never grants worker authority',async t=>{
 const f=fixture(t),task=await f.create(),scope={mode:'recheck' as const,selections:[{key:task.items[0].key}]};
 const before=structuredClone(f.calls),preview=await f.service.previewResume({taskId:task.id,scope});
 assert.equal(await f.service.confirmResume({taskId:task.id,taskRevision:preview.taskRevision,token:preview.token,scope},async()=>false),null);
 assert.deepEqual(f.service.get(task.id),task);assert.deepEqual(f.calls,before);
 await assert.rejects(f.service.confirmResume({taskId:task.id,taskRevision:preview.taskRevision-1,token:preview.token,scope},async()=>true),/预览已变化/);
 assert.deepEqual(f.calls,before);
});
test('P05 continuing preserves old failure without inventing time and saves a new independent check event',async t=>{
 const f=fixture(t),task=await f.create(),saved=(f.service as any).tasks.get(task.id);saved.status='NEEDS_ATTENTION';saved.items[0].status='FAILED';saved.items[0].error='旧图位 2 下载失败 https://private.invalid?k=secret api_key=secret';(f.service as any).save(saved);f.failImages();
 const scope={mode:'recheck' as const,selections:[{key:task.items[0].key}]},preview=await f.service.previewResume({taskId:task.id,scope});
 await f.service.confirmResume({taskId:task.id,taskRevision:preview.taskRevision,token:preview.token,scope},async()=>true);await f.service.waitForIdle();
 const result=f.service.get(task.id),history=result.items[0].failureHistory!;
 assert.equal(history[0].occurredAt,null);assert.match(history[0].reason,/旧图位 2 下载失败/);assert.doesNotMatch(history[0].reason,/private|secret/);
 assert.equal(history.at(-1)!.source,'local-check');assert.ok(Date.parse(history.at(-1)!.occurredAt!)>=Date.parse(result.items[0].lastContinuedAt!));
 assert.deepEqual(validateAutomaticListingTask(result),result);
});
test('P05 selected slot confirmation invokes image owner with exact slots and never starts publishing',async t=>{
 const f=fixture(t),task=await f.create();f.failImages();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 const row=f.service.get(task.id).items[0],draft=f.drafts.get(row.draftId!)!;
 f.workflow.set(draft.id,{id:randomUUID(),draftId:draft.id,status:'FAILED',stage:'generating',maxAttempts:3,setPlan:{},slots:Array.from({length:7},(_,index)=>({index:index+1,status:'PENDING',attempts:[]}))});
 let options:any;f.dependencies.images.complete=async(_raw,opts)=>{options=opts;return {draft,workflow:{...f.workflow.get(draft.id),attempt:7,status:'BLOCKED',stage:'generating',error:'其他历史图位失败',slots:Array.from({length:7},(_,index)=>({index:index+1,status:index===1?'PASSED':'PENDING',attempts:[]}))},remaining:[],aiCalls:0,previewAttempts:0} as any;};
 const scope={mode:'targeted' as const,selections:[{key:row.key,slots:[2]}]},preview=await f.service.previewResume({taskId:task.id,scope});
 await f.service.confirmResume({taskId:task.id,taskRevision:preview.taskRevision,token:preview.token,scope},async()=>true);await f.service.waitForIdle();
 assert.deepEqual(options,{selectedSlots:[2]});assert.equal(f.calls.submissions,0);assert.match(f.service.get(task.id).items[0].error!,/图位 2：通过/);assert.match(f.service.get(task.id).items[0].error!,/未执行其他图位/);assert.doesNotMatch(f.service.get(task.id).items[0].failureHistory!.at(-1)!.reason,/其他历史图位失败/);
});

for(const missing of [true,false])test(`P05 from-start checks early field evidence even from EXECUTION and preserves healthy images (${missing})`,async t=>{
 const f=fixture(t),submit=f.dependencies.execution.startAuthorized;f.dependencies.execution.startAuthorized=()=>{throw new UserFacingError('暂停在发送前');};
 const task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();const row=f.service.get(task.id).items[0];assert.equal(row.stage,'EXECUTION');
 f.dependencies.execution.startAuthorized=submit;
 let checks=0;f.dependencies.amazon.previewTaskAdaptation=id=>{checks++;return {...f.drafts.get(id)!,localIssues:missing?[{severity:'ERROR',code:'REQUIRED',message:'缺少真实材质资料',attributeNames:['material'],category:'fact',source:'local',autoFixable:false}]:[]};};
 f.dependencies.images.inspectApproval=id=>f.workflow.get(id).slots.map((slot:any)=>({id:slot.approvedAssetId,sha256:slot.approvedSha256}));
 f.dependencies.hosting.checkLocalAssets=async()=>{};
 const before=structuredClone(f.calls),scope={mode:'recheck' as const,selections:[{key:row.key}]},preview=await f.service.previewResume({taskId:task.id,scope});
 assert.ok(preview.lines[0].includes('当前步骤 EXECUTION'));assert.ok(preview.lines[0].includes(missing?'缺少真实材质资料':'字段与事实校验通过'));
 await f.service.confirmResume({taskId:task.id,taskRevision:preview.taskRevision,token:preview.token,scope},async()=>true);await f.service.waitForIdle();
 assert.ok(checks>=4);assert.equal(f.calls.images,before.images);assert.equal(f.calls.sources,before.sources);
 assert.equal(f.calls.submissions-before.submissions,missing?0:1);
 if(missing)assert.match(f.service.get(task.id).items[0].error!,/从头检查发现字段待处理/);
});
test('P05 evidence token rejects a draft change during native confirmation without dispatch',async t=>{
 const f=fixture(t),task=await f.create(),scope={mode:'recheck' as const,selections:[{key:task.items[0].key}]},preview=await f.service.previewResume({taskId:task.id,scope});
 await assert.rejects(f.service.confirmResume({taskId:task.id,taskRevision:preview.taskRevision,token:preview.token,scope},async()=>{f.product.title='changed source';return true;}),/资料|变化/);
 assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);
});

test('P05 changed unrelated unselected product cannot block or join selected execution',async t=>{
 const f=fixture(t),task=await f.create(),other=structuredClone(f.product);other.id=randomUUID();other.variants[0].id=randomUUID();other.variants[0].sku='UNSELECTED';
 const saved=(f.service as any).tasks.get(task.id),second={...structuredClone(saved.items[0]),productId:other.id,variantId:other.variants[0].id,sku:'UNSELECTED',sourceStamp:sourceStamp(other)};second.key=second.productId+':'+second.variantId;saved.items.push(second);(f.service as any).save(saved);
 f.dependencies.store.getProduct=id=>structuredClone(id===other.id?other:f.product);other.title='unselected changed';
 const scope={mode:'targeted' as const,selections:[{key:task.items[0].key}]},preview=await f.service.previewResume({taskId:task.id,scope});
 await f.service.confirmResume({taskId:task.id,taskRevision:preview.taskRevision,token:preview.token,scope},async()=>true);await f.service.waitForIdle();
 assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);assert.deepEqual(f.service.get(task.id).items[1],second);
});

test('P05 ordinary continue after targeted operation confirms the full scope rather than reusing restricted dialog',async t=>{
 const f=fixture(t),task=await f.create(),saved=(f.service as any).tasks.get(task.id);saved.resumeScope={mode:'targeted',selections:[{key:task.items[0].key,slots:[1]}]};(f.service as any).save(saved);
 await f.service.confirmStart(task.id,async approved=>{assert.equal(approved.resumeScope,undefined);assert.equal(approved.items.length,task.items.length);return false;});
 assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);
});

test('working batch archive pauses in-flight image work before new empty batch; original task can still resume',async t=>{
 const f=fixture(t),task=await f.create(),before=f.service.listWorkBatches().find(b=>!b.archivedAt)!;
 let started!:()=>void;const began=new Promise<void>(resolve=>started=resolve);f.holdImages(started);
 f.dependencies.images.cancel=()=>({cancelled:true}); // The remote request cannot be cancelled; its local result arrives later.
 f.service.startAuthorized(f.service.prepareStart(task.id));await reachedStage(began,f.service.waitForIdle(),()=>f.service.get(task.id));
 let done=false;const archive=f.service.archiveWorkBatch(before.id).then(v=>{done=true;return v;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false,'archive waits for the local late result');
 assert.equal(f.service.get(task.id).status,'PAUSED');assert.throws(()=>f.service.prepareStart(task.id),/归档/);
 f.releaseImages();const next=await archive;assert.deepEqual(next.productIds,[]);assert.deepEqual(next.taskIds,[]);
 const after=f.service.get(task.id);assert.equal(after.status,'PAUSED');assert.equal(f.calls.submissions,0);assert.equal(f.service.listWorkBatches().find(b=>b.id===before.id)!.taskIds[0],task.id);
 assert.equal(f.service.prepareStart(task.id).id,task.id);assert.equal(f.service.listWorkBatches().find(b=>!b.archivedAt)!.id,next.id);
});
test('adding historical product to new batch does not evade global original-task guard or send',async t=>{
 const f=fixture(t),task=await f.create(),before=f.service.listWorkBatches().find(b=>!b.archivedAt)!;
 const next=await f.service.archiveWorkBatch(before.id);f.service.addWorkBatchProducts({batchId:next.id,productIds:[f.product.id]});
 const queue=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});assert.equal(queue.products[0].eligibleCount,0);assert.equal(queue.products[0].rows[0].taskId,task.id);
 await assert.rejects(()=>f.service.create({workBatchId:next.id,productIds:[f.product.id],targetId:f.target.id,profileId:'alpha'}),/原任务/);assert.deepEqual(f.calls,{sources:0,images:0,submissions:0,batches:0,labels:0});
});

test('historical batch resumes the same task while current batch stays empty and original SKU is preserved',async t=>{
 const f=fixture(t),task=await f.create(),old=f.service.listWorkBatches().find(b=>!b.archivedAt)!,next=await f.service.archiveWorkBatch(old.id);
 f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();const done=f.service.get(task.id);
 assert.equal(done.status,'COMPLETED');assert.equal(done.items[0].sku,task.items[0].sku);assert.equal(f.calls.submissions,1);assert.equal(f.service.list().length,1);assert.deepEqual(f.service.listWorkBatches().find(b=>b.id===next.id)!.productIds,[]);assert.deepEqual(f.service.listWorkBatches().find(b=>b.id===old.id)!.taskIds,[task.id]);
});
for(const state of ['completed','unknown'] as const)test(`archive and re-add preserves global ${state} SKU guard`,async t=>{
 const f=fixture(t),task=await f.create();if(state==='unknown')f.failImages();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 const old=f.service.listWorkBatches().find(b=>!b.archivedAt)!,next=await f.service.archiveWorkBatch(old.id);f.service.addWorkBatchProducts({batchId:next.id,productIds:[f.product.id]});const before=structuredClone(f.calls),q=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});
 assert.equal(q.products[0].eligibleCount,0);assert.equal(q.products[0].rows[0].kind,state==='completed'?'COMPLETED':'UNKNOWN');await assert.rejects(()=>f.service.create({workBatchId:next.id,productIds:[f.product.id],targetId:f.target.id,profileId:'alpha'}),/原任务|没有可启动/);assert.deepEqual(f.calls,before);
});
test('archive invalidates a pending start confirmation before original execution grant',async t=>{
 const f=fixture(t),task=await f.create();let enter!:()=>void,release!:(allowed:boolean)=>void;const entered=new Promise<void>(r=>enter=r),answer=new Promise<boolean>(r=>release=r);
 const start=f.service.confirmStart(task.id,async()=>{enter();return answer;});await entered;await f.service.archiveWorkBatch(f.service.listWorkBatches().find(b=>!b.archivedAt)!.id);release(true);await assert.rejects(()=>start,/确认期间/);assert.deepEqual(f.calls,{sources:0,images:0,submissions:0,batches:0,labels:0});
});

test('archive during asynchronous queue admission rejects creation before allocating any new sales identity',async t=>{
 const f=fixture(t),batch=f.service.listWorkBatches().find(b=>!b.archivedAt)!;f.service.addWorkBatchProducts({batchId:batch.id,productIds:[f.product.id]});
 const projection=await f.service.queue({productIds:[f.product.id],targetId:f.target.id});let release!:()=>void,entered!:()=>void;const begin=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);let planned=0;
 f.service.queue=async()=>{entered();await wait;return projection;};f.dependencies.planSales=()=>{planned++;throw Error('unexpected plan allocation');};
 const creating=f.service.create({workBatchId:batch.id,productIds:[f.product.id],targetId:f.target.id,profileId:'alpha'});await begin;await f.service.archiveWorkBatch(batch.id);release();await assert.rejects(()=>creating,/当前批次/);assert.equal(planned,0);assert.equal(f.service.list().length,0);
});

test('adding batch members uses one readonly existence check and never full product reads',async t=>{
 const f=fixture(t),batch=f.service.listWorkBatches().find(b=>!b.archivedAt)!;let reads=0;
 f.dependencies.store.hasProducts=ids=>{reads++;return ids.length===1&&ids[0]===f.product.id;};f.dependencies.store.getProduct=()=>{throw Error('full product read must not run during membership changes');};
 assert.deepEqual(f.service.addWorkBatchProducts({batchId:batch.id,productIds:[f.product.id]}).productIds,[f.product.id]);assert.equal(reads,1);
});

test('integrated scoped resume revoked by archive cannot publish a late image or execute its sibling',async t=>{
 const f=fixture(t);f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO',originalSpec:'blue',normalizedSpec:'blue',sourceSpec:'blue'});
 const task=await f.create(),batch=f.service.listWorkBatches().find(b=>!b.archivedAt)!,sibling=structuredClone(task.items[1]);
 const scope={mode:'targeted' as const,selections:[{key:task.items[0].key}]},preview=await f.service.previewResume({taskId:task.id,scope});
 let started!:()=>void;const began=new Promise<void>(resolve=>started=resolve);f.holdImages(started);f.dependencies.images.cancel=()=>({cancelled:true});
 await f.service.confirmResume({taskId:task.id,taskRevision:preview.taskRevision,token:preview.token,scope},async()=>true);
 await reachedStage(began,f.service.waitForIdle(),()=>f.service.get(task.id));
 const archived=f.service.archiveWorkBatch(batch.id);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.service.get(task.id).status,'PAUSED');assert.throws(()=>f.service.prepareStart(task.id,scope),/归档/);
 f.releaseImages();const next=await archived;await f.service.waitForIdle();
 assert.deepEqual(next.productIds,[]);assert.deepEqual(next.taskIds,[]);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,0);
 assert.deepEqual(f.service.get(task.id).items[1],sibling);assert.equal(f.service.get(task.id).status,'PAUSED');
 await assert.rejects(f.service.confirmResume({taskId:task.id,taskRevision:preview.taskRevision,token:preview.token,scope},async()=>true),/变化/);
 assert.equal(f.calls.submissions,0);
});

test('create yields between source plans and rejects a source change without saving a partial task',async t=>{
 const f=fixture(t);let interleaved=false;
 // Keep admission real; a selected recipe must survive through the planning boundary.
 const recipes=buildSalesRecipes(f.product,null,f.rules);
 f.dependencies.planSales=()=>{setImmediate(()=>{interleaved=true;f.product.revision++;});return recipes.map(recipe=>({namingGroupId:randomUUID(),sourceGroupKey:'source',collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:'SALE',baseSku:'SALE',recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'fixture',familyResolved:true,namingChildKey:null}));};
 await assert.rejects(()=>f.create(),/创建期间范围已变化/);
 assert.equal(interleaved,true);assert.equal(f.service.list().length,0);
});

test('100 sources / 330 sales create keeps stable SKUs and yields once per source',async t=>{
 const f=fixture(t),products=new Map<string,ProductDetail>();
 for(let i=0;i<100;i++){
  const product=structuredClone(f.product);product.id=randomUUID();
  product.variants=['红色','蓝色','绿色','黑色'].slice(0,i<30?4:3).map((color,j)=>({...product.variants[0],id:randomUUID(),sku:`SOURCE-${i}-${j}`,sourceSpec:`颜色: ${color} / 尺寸: 小号`,originalSpec:`颜色: ${color} / 尺寸: 小号`,normalizedSpec:''}));
  products.set(product.id,product);
 }
 f.dependencies.store.getProduct=id=>structuredClone(products.get(id)!);f.dependencies.store.hasProducts=ids=>ids.every(id=>products.has(id));
 f.dependencies.previewSales=id=>buildSalesRecipes(products.get(id)!,null,f.rules);
 f.dependencies.planSales=id=>f.dependencies.previewSales!(id).map((recipe,j)=>({namingGroupId:id,sourceGroupKey:id,collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:`SALE-${id.slice(0,20)}-${j}`,baseSku:`BASE-${id.slice(0,20)}`,recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'fixture',familyResolved:true,namingChildKey:null}));
 const {DatabaseSync}=await import('node:sqlite'),{AmazonPersistence}=await import('../src/main/amazon/persistence.ts'),{AmazonService}=await import('../src/main/amazon/service.ts'),{SALES_IDENTITY_INDEXES}=await import('../src/main/record-indexes.ts');
 const history=new DatabaseSync(join(f.directory,'synthetic-history.sqlite'));f.cleanups.push(async()=>history.close());
 history.exec('CREATE TABLE listing_drafts(id TEXT PRIMARY KEY, product_id TEXT, record_json TEXT, created_at TEXT);CREATE INDEX amazon_drafts_product ON listing_drafts(product_id,created_at)');
 history.exec('BEGIN');const put=history.prepare('INSERT INTO listing_drafts VALUES(?,?,?,?)');
 for(let i=0;i<3000;i++)put.run('history-'+i,'history-product-'+i,JSON.stringify({draft:{id:'history-'+i,sku:'history-sku-'+i,salesPlan:{recipe:{key:'history-recipe-'+i}},schema:{padding:'x'.repeat(8000)}}}),'');
 history.exec('COMMIT');for(const index of SALES_IDENTITY_INDEXES)history.exec(index.sql);
 const persistence=Object.create(AmazonPersistence.prototype) as InstanceType<typeof AmazonPersistence>;persistence.db=history;
 f.dependencies.existingSale=(productId,plan,targetId)=>AmazonService.prototype.findSalesDraft.call({getTarget:()=>f.target,persistence} as never,productId,plan,targetId);
 let ticks=0,maxGap=0,last=performance.now(),running=true;
 const beat=()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;if(running)setImmediate(beat).unref();};setImmediate(beat).unref();
 const start=performance.now();const task=await f.service.create({productIds:[...products.keys()],targetId:f.target.id,profileId:'alpha'});running=false;
 assert.equal(task.items.length,330);assert.equal(new Set(task.items.map(row=>row.sku)).size,330);assert.ok(ticks>=100,`heartbeats=${ticks}`);
 t.diagnostic(`synthetic 100 sources / 330 SKU create: ${(performance.now()-start).toFixed(1)} ms; max immediate heartbeat gap ${maxGap.toFixed(1)} ms; heartbeats ${ticks}`);
 let reads=0;const get=f.dependencies.store.getProduct;f.dependencies.store.getProduct=id=>{reads++;return get(id);};
 f.service.prepareStart(task.id);assert.equal(reads,100,'scope assertion reads each source once');
});

test('create rejects a canonical prior source changing during the planning yield',async t=>{
 const f=fixture(t),canonical=structuredClone(f.product);canonical.id=randomUUID();
 const recipe=buildSalesRecipes(f.product,null,f.rules)[0],plan:SalesListingPlan={namingGroupId:randomUUID(),sourceGroupKey:'source',collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:'SALE',baseSku:'SALE',recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'fixture',familyResolved:true,namingChildKey:null};
 f.dependencies.planSales=()=>[plan];f.dependencies.store.getProduct=id=>structuredClone(id===canonical.id?canonical:f.product);
 const draft=(await f.dependencies.amazon.prepareDrafts({items:[{variantId:f.product.variants[0].id}]})).items[0].draft!;Object.assign(draft,{productId:canonical.id,salesPlan:plan,sku:plan.sku,state:'SUBMITTED',submittedAt:new Date().toISOString()});
 let reads=0;f.dependencies.existingSale=()=>{if(reads++===0)setImmediate(()=>canonical.revision++);return structuredClone(draft);};
 await assert.rejects(()=>f.create(),/创建期间范围已变化/);assert.equal(f.service.list().length,0);
});

for(const change of ['rules','target','profile','preflight','submission'] as const)test(`create rejects ${change} changing at a planning yield without a partial task`,async t=>{
 const f=fixture(t),recipe=buildSalesRecipes(f.product,null,f.rules)[0];
 const plan:SalesListingPlan={namingGroupId:randomUUID(),sourceGroupKey:'source',collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:'SALE',baseSku:'SALE',recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'fixture',familyResolved:true,namingChildKey:null};
 let enabled=true;f.dependencies.preflight=()=>{if(!enabled)throw new UserFacingError('用途连接已停用');};
 const draft=(await f.dependencies.amazon.prepareDrafts({items:[{variantId:f.product.variants[0].id}]})).items[0].draft!;Object.assign(draft,{salesPlan:plan,sku:plan.sku});f.dependencies.existingSale=()=>structuredClone(draft);
 f.dependencies.planSales=()=>{setImmediate(()=>{if(change==='rules')f.rules.revision++;if(change==='target')f.target.paused=true;if(change==='profile')f.profile.generation++;if(change==='preflight')enabled=false;if(change==='submission')draft.state='UNKNOWN';});return [plan];};
 await assert.rejects(()=>f.create(),/创建期间范围已变化|用途连接已停用/);assert.equal(f.service.list().length,0);assert.equal(f.calls.submissions,0);
});

test('unrelated task progress during creation does not invalidate the selected sources',async t=>{
 const f=fixture(t),prior=await f.create(),old=(f.service as any).tasks.get(prior.id);
 const next=structuredClone(f.product);next.id=randomUUID();next.variants[0].id=randomUUID();next.variants[0].sku='NEXT-SOURCE';
 f.dependencies.store.getProduct=id=>structuredClone(id===next.id?next:f.product);f.dependencies.store.hasProducts=()=>true;
 f.dependencies.previewSales=id=>buildSalesRecipes(id===next.id?next:f.product,null,f.rules);
 f.dependencies.planSales=id=>{setImmediate(()=>old.revision++);return f.dependencies.previewSales!(id).map(recipe=>({namingGroupId:randomUUID(),sourceGroupKey:'next-source',collectedAt:next.createdAt,collectionBasis:'first_import',sku:'NEXT-SALE',baseSku:'NEXT-SALE',recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'fixture',familyResolved:true,namingChildKey:null}));};
 const task=await f.service.create({productIds:[next.id],targetId:f.target.id,profileId:'alpha'});assert.equal(task.items[0].sku,'NEXT-SALE');assert.equal(f.service.list().length,2);
});
