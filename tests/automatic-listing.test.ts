import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AutomaticListingService } from '../src/main/automatic-listing/service.ts';
import type { AutomaticListingDependencies } from '../src/main/automatic-listing/service.ts';
import type { AmazonDraft, AmazonTarget } from '../src/shared/amazon-contracts.ts';
import type { ProductDetail } from '../src/shared/contracts.ts';
import type { ExecutionTask } from '../src/shared/execution-contracts.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { openDatabase } from '../src/main/database.ts';
import { fingerprint } from '../src/main/execution/records.ts';
import { imageWorkflowDraftStamp } from '../src/main/image-workflow/records.ts';
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';
import { UserFacingError } from '../src/shared/errors.ts';
import { FAMILY_REBIND_EVENT_SUMMARY } from '../src/main/amazon/service.ts';
import { validateAutomaticListingTask } from '../src/main/automatic-listing/records.ts';

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
    store: { getProduct: () => structuredClone(product) },
    rules: () => structuredClone(rules),
    hosting: { getProfile: () => structuredClone(profile) },
    amazon: {
      executionTargetScope: () => ({ target: structuredClone(target), generation: 1 }),
      listDrafts: () => [...drafts.values()].map(value => structuredClone(value)),
      getDraft: id => structuredClone(drafts.get(id)!),
      async prepareDrafts(raw) {
        const selected = product.variants.find(value => value.id === (raw as any).items[0].variantId)!;
        const value = { id: randomUUID(), productId: product.id, productRevision: product.revision, variantId: selected.id, sku: selected.sku,
          targetId: target.id, targetName: target.name, sellerId: target.sellerId, marketplaceId: target.marketplaceId, mode, revision: 1, listingProgram: mode === 'live' ? 'haul' : 'standard',
          schema: { targetId: target.id, productType: 'BOX', requirements: 'LISTING', parentageLevel: 'NONE', locale: target.locale }, state: 'BLOCKED', attributes: {}, submittedAt: null,
          localIssues: [], previewIssues: [], listingIssues: [], createdAt: now, updatedAt: now } as unknown as AmazonDraft;
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
  const service = new AutomaticListingService(directory, dependencies);
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = () => service.create({ productIds: [product.id], targetId: target.id, profileId: 'alpha', productType: 'BOX' });
  return { service, directory, dependencies, create, product, target, profile, rules, drafts, executions, calls, workflow,
    setReady: () => { ready = true; }, failImages: () => { imageFailure = true; },
    holdImages: (callback: () => void) => { started = callback; }, releaseImages: () => release?.() };
}

for(const interruption of [null,'after-bind','recheck'] as const)test(`legacy standalone family conversion keeps SKU/images across ${interruption??'normal execution'}`,async t=>{
 const f=fixture(t);const source=f.product.variants[0];
 f.product.variants.push({...source,id:randomUUID(),sku:'SKU-TWO',originalSpec:'blue',normalizedSpec:'blue',sourceSpec:'blue'});
 const recipes=buildSalesRecipes(f.product,null,f.rules),old=recipes.map((recipe,index):SalesListingPlan=>({namingGroupId:randomUUID(),sourceGroupKey:'local:'+f.product.id+':'+String(index+1).repeat(64),collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:f.product.variants[index].sku,baseSku:f.product.variants[index].sku,recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'legacy independent',familyResolved:true,namingChildKey:null}));
 const parentId=randomUUID(),fresh=old.map(p=>({...p,namingGroupId:parentId,sourceGroupKey:'local:'+f.product.id+':'+'a'.repeat(64),sku:'PARENT-'+p.sku,baseSku:'PARENT',namingChildKey:p.recipe.key}));
 f.dependencies.planSales=()=>structuredClone(old);const task=f.create();f.dependencies.planSales=()=>structuredClone(fresh);
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
  const f = fixture(t); const task = f.create();
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
  const task = f.service.create({productIds:[f.product.id],targetId:f.target.id,profileId:'alpha'});
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  assert.equal(classifications,1); assert.equal(f.service.get(task.id).items.length,2);
  assert.ok(f.service.get(task.id).items.every(item=>item.classification?.productType==='BOX'));
});

test('child sales SKUs keep images while waiting for their parent and resume automatically without another generation',async t=>{
  const f=fixture(t,'live'),groupId=randomUUID(),parentDraftId=randomUUID();let parentReady=false;
  f.product.variants=['红色','蓝色'].map((color,i)=>({...f.product.variants[0],id:i?randomUUID():f.product.variants[0].id,sku:`SOURCE-${i}`,originalSpec:`颜色: ${color} / 尺寸: 小号`,normalizedSpec:'',purchasePrice:'0.1'}));
  const recipes=buildSalesRecipes(f.product,null,f.rules);
  f.dependencies.planSales=()=>recipes.map((recipe,i):SalesListingPlan=>({namingGroupId:groupId,sourceGroupKey:'same-model',collectedAt:f.product.createdAt,collectionBasis:'first_import',sku:`H2-261008-1-${String.fromCharCode(65+i)}`,baseSku:'H2-261008-1',recipe,parentage:'NONE',parentSku:null,variationTheme:null,relationReason:'待选类目',familyResolved:false,namingChildKey:recipe.key}));
  f.dependencies.resolveFamily=async({plans})=>plans.map(plan=>({...plan,parentage:'CHILD',parentSku:plan.baseSku,variationTheme:'COLOR',relationReason:'Schema 允许颜色',familyResolved:true}));
  const prepare=f.dependencies.amazon.prepareDrafts;
  f.dependencies.amazon.prepareDrafts=async(raw,plans)=>{
    assert.equal((raw as any).parentageLevel,'CHILD');const result=await prepare(raw);
    const draft=result.items[0].draft!;draft.sku=plans![0].sku;draft.salesPlan=plans![0];draft.schema.parentageLevel='CHILD';f.drafts.set(draft.id,structuredClone(draft));return result;
  };
  f.dependencies.ensureParent=async child=>{assert.equal(f.workflow.get(child.id)?.status,'COMPLETED');return {draftId:parentDraftId,ready:parentReady};};
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.calls.images,3);assert.equal(f.calls.submissions,0);assert.ok(f.service.get(task.id).items.every(row=>row.stage==='PARENT'&&row.status==='WAITING'));
  parentReady=true;f.setReady();await f.service.refreshWaiting();
  for(let i=0;i<6;i++){await new Promise(resolve=>setImmediate(resolve));await f.service.waitForIdle();}
  assert.equal(f.calls.images,3);assert.equal(f.calls.submissions,3);assert.equal(f.service.get(task.id).status,'COMPLETED');
});

test('accepted submission waits for platform readiness and does not submit again while observing labels', async t => {
  const f = fixture(t, 'live'); const task = f.create();
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle(); await f.service.refreshWaiting();
  assert.equal(f.service.get(task.id).status, 'WAITING'); assert.equal(f.calls.batches, 0);
  f.setReady(); await f.service.refreshWaiting(); await f.service.refreshWaiting();
  assert.equal(f.service.get(task.id).status, 'COMPLETED');
  assert.equal(f.calls.submissions, 1); assert.equal(f.calls.batches, 1);
});

test('changed scope after native confirmation blocks before paid or remote work', async t => {
  const f = fixture(t); const task = f.create(), approved = f.service.prepareStart(task.id);
  f.target.marketplaceId = 'different-site';
  assert.throws(() => f.service.startAuthorized(approved), /变化|范围|目标/);
  assert.equal(f.calls.images, 0); assert.equal(f.calls.submissions, 0);
});

test('pause during images revokes later publishing, and explicit resume reuses completed images', async t => {
  const f = fixture(t), task = f.create();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.holdImages(entered); f.service.startAuthorized(f.service.prepareStart(task.id)); await started;
  f.service.pause(task.id); f.releaseImages(); await f.service.waitForIdle();
  assert.equal(f.calls.submissions, 0); assert.equal(f.service.get(task.id).status, 'PAUSED');
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle(); await f.service.refreshWaiting();
  assert.equal(f.calls.images, 1); assert.equal(f.calls.submissions, 1);
});

test('unknown paid response remains exceptional across resume instead of repeating generation', async t => {
  const f = fixture(t), task = f.create(); f.failImages();
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  assert.equal(f.calls.images, 1); assert.equal(f.calls.submissions, 0);
  assert.equal(f.service.get(task.id).status, 'NEEDS_ATTENTION');
});

test('disabling risk interception lets a blocked image workflow resume through its existing workflow',async t=>{
  const f=fixture(t),complete=f.dependencies.images.complete;let enabled=true;
  f.dependencies.images.getRiskSettings=()=>({enabled});
  f.dependencies.images.complete=async input=>{
    if(enabled){const draft=f.dependencies.amazon.getDraft((input as any).draftId),workflow={id:randomUUID(),draftId:draft.id,status:'BLOCKED',attempt:0,error:'商品 IP 初筛未通过',slots:[{status:'BLOCKED',attempts:[]}]};f.workflow.set(draft.id,workflow);return {draft,workflow} as any;}
    return complete(input);
  };
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(f.calls.submissions,0);
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
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(f.calls.submissions,0);
  enabled=false;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);
});

test('an execution retry cannot publish completed images incompatible with current copy review policy',async t=>{
  const f=fixture(t);let compatible=true,starts=0;
  f.dependencies.images.isCopyReviewPolicyCompatible=()=>compatible;
  f.dependencies.execution.startAuthorized=approved=>{starts++;const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing field'}];return structuredClone(child);};
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(starts,1);
  compatible=false;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(starts,1);assert.match(f.service.get(task.id).items[0].error!,/复核/);assert.equal(f.calls.submissions,0);
});

test('an execution retry cannot publish completed images incompatible with the current risk policy',async t=>{
  const f=fixture(t);let compatible=true,starts=0;
  f.dependencies.images.isRiskPolicyCompatible=()=>compatible;
  f.dependencies.execution.startAuthorized=approved=>{starts++;const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing field'}];return structuredClone(child);};
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(starts,1);
  compatible=false;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(starts,1);assert.match(f.service.get(task.id).items[0].error!,/风险.*复核/);assert.equal(f.calls.submissions,0);
});

test('an infeasible saved price quote blocks before image generation and shows its real constraint', async t => {
  const f=fixture(t),prepare=f.dependencies.amazon.prepareDrafts,originalRules=structuredClone(f.rules);
  const reason='售价上限内无法满足目标 ROI，请核对采购成本、包装参数或定价设置';
  f.dependencies.amazon.prepareDrafts=async(...args)=>{const result=await prepare(...args),draft=result.items[0].draft!;
    draft.businessRules={revision:1,fields:{},notices:[reason],quote:null,bundleQuantity:1};
    draft.localIssues=[{code:'LOCAL_required',message:'our_price: missing',severity:'ERROR',attributeNames:['purchasable_offer'],category:'field',source:'local',autoFixable:false}];
    f.drafts.set(draft.id,structuredClone(draft));return result;};
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const saved=f.service.get(task.id);assert.match(saved.items[0].error!,/定价.*售价上限内无法满足目标 ROI/);
  assert.equal(saved.items[0].stage,'DRAFT');assert.equal(f.calls.images,0);assert.equal(f.calls.submissions,0);assert.deepEqual(f.rules,originalRules);
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(f.calls.images,0);
});

test('a definitive pricing constraint discovered during field repair is not sent for another paid repair',async t=>{
  const f=fixture(t);let repairs=0,rechecks=0;
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'our_price missing'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{repairs++;const draft=f.drafts.get(id)!;draft.revision++;draft.businessRules={revision:1,fields:{},quote:null,bundleQuantity:1,notices:['售价上限内无法满足目标 ROI，请核对采购成本、包装参数或定价设置']};return {draft:structuredClone(draft),remaining:['our_price missing']};};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(repairs,1);assert.equal(rechecks,0);assert.match(f.service.get(task.id).items[0].error!,/定价.*售价上限内无法满足目标 ROI/);
  assert.equal(f.service.get(task.id).items[0].repair?.phase,'FIELDS_PENDING');
});

test('restart never silently resumes queued publishing authority', async t => {
  const f = fixture(t), task = f.create(); await f.service.close();
  const db = openDatabase(f.directory);
  const record = JSON.parse(String(db.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id)!.record_json));
  record.status = 'RUNNING'; db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(record), task.id); db.close();
  const recovered = new AutomaticListingService(f.directory, f.dependencies);
  try { assert.equal(recovered.get(task.id).status, 'PAUSED'); assert.equal(f.calls.submissions, 0); }
  finally { await recovered.close(); }
});

test('readback-only continuation survives unrelated FTP and rule changes', async t => {
  const f = fixture(t, 'live'), task = f.create();
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  f.service.pause(task.id); f.profile.generation++; f.rules.revision++;
  f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle(); f.setReady(); await f.service.refreshWaiting();
  assert.equal(f.service.get(task.id).status, 'COMPLETED'); assert.equal(f.calls.submissions, 1);
});

test('restore dialog suspension prevents background labels until cancellation resumes scheduling', async t => {
  const f=fixture(t,'live'),task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
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
  const task = f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).items[0].draftId, draft.id); assert.equal(f.calls.submissions,1);
});

test('submitted sibling stays in readback while remaining variants prepare source images', async t => {
  const f = fixture(t, 'live'); f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'}); f.rules.product.variantLimit = 2;
  await f.dependencies.amazon.prepareDrafts({items:[{variantId:f.product.variants[0].id}]} as any);
  const sent = [...f.drafts.values()][0]; sent.submittedAt = new Date().toISOString(); sent.state = 'SUBMITTED';
  const task = f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  const rows = f.service.get(task.id).items; assert.equal(rows[0].stage,'READBACK'); assert.equal(rows[0].draftId,sent.id);
  assert.equal(rows[1].stage,'READBACK'); assert.equal(f.calls.submissions,1); assert.equal(f.calls.sources,1);
});

test('source preparation stays retryable while every selected SKU is missing images', async t => {
  const f = fixture(t); f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'}); f.rules.product.variantLimit=2;
  let attempts=0;
  f.dependencies.images.prepareSources = async () => { f.product.revision++; return {product:structuredClone(f.product),missing:attempts++===0?f.product.variants.map(variant=>({variantId:variant.id,message:'Source download temporarily unavailable'})):[]}; };
  const task=f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  assert.ok(f.service.get(task.id).items.every(row=>row.status==='FAILED'&&row.stage==='SOURCES'&&!row.sourcesPrepared));assert.equal(f.calls.images,0);
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(attempts,2);assert.equal(f.calls.submissions,2);assert.equal(f.calls.images,2);assert.equal(f.service.get(task.id).status,'COMPLETED');
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
  const task=f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
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
  const task=f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
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
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  f.dependencies.sourceReceipt=()=>({snapshot:{skus:f.product.variants,images:[{id:'source',url:'https://example.test/source.png'}]},skuMappings:[{localVariantId:f.product.variants[1].id,imageIds:[]}]} as any);
  const revision=f.product.revision;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const rows=f.service.get(task.id).items;
  assert.match(rows[1].error!,/商品有来源图片.*映射为空/);assert.match(rows[1].error!,/来源版本已冻结/);
  assert.equal(f.calls.sources,1);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);assert.equal(f.product.revision,revision);assert.equal(rows[0].status,'DONE');
});

test('confirmed source binding can recover an untouched SKU after its sibling submitted, preserving that submitted revision',async t=>{
  const f=fixture(t);f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'});f.rules.product.variantLimit=2;
  f.dependencies.images.prepareSources=async()=>{f.calls.sources++;return {product:structuredClone(f.product),missing:f.calls.sources===1?[{variantId:f.product.variants[1].id,message:'SKU 图片映射为空'}]:[]};};
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const first=f.service.get(task.id).items[0],submittedRevision=f.drafts.get(first.draftId!)!.productRevision;
  f.product.revision++;f.product.assets.push({id:randomUUID(),variantIds:[f.product.variants[1].id]} as any);
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(f.calls.sources,2);assert.equal(f.calls.images,2);assert.equal(f.calls.submissions,2);
  assert.equal(f.drafts.get(first.draftId!)!.productRevision,submittedRevision);assert.equal(f.service.get(task.id).items[0].productRevision,submittedRevision);
});

test('a new source binding cannot rebase a sibling whose paid images are unfinished',async t=>{
  const f=fixture(t);f.product.variants.push({...f.product.variants[0],id:randomUUID(),sku:'SKU-TWO'});f.rules.product.variantLimit=2;f.failImages();
  f.dependencies.images.prepareSources=async()=>({product:structuredClone(f.product),missing:[{variantId:f.product.variants[1].id,message:'SKU 图片映射为空'}]});
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  f.product.revision++;f.product.assets.push({id:randomUUID(),variantIds:[f.product.variants[1].id]} as any);
  assert.throws(()=>f.service.prepareStart(task.id),/变化|冻结/);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,0);
});

test('a saved legacy task with twenty blocked source rows resumes the seventeen mapped SKUs only', async t => {
  const f=fixture(t); f.rules.product.variantLimit=20;
  f.product.variants=Array.from({length:20},(_,index)=>({...f.product.variants[0],id:randomUUID(),sku:`SKU-${index+1}`}));
  const missingIds=f.product.variants.slice(6,9).map(variant=>variant.id);
  f.dependencies.images.prepareSources=async()=>{
    f.calls.sources++;
    return {product:structuredClone(f.product),missing:missingIds.map(variantId=>({variantId,message:'No source mapping for this SKU'}))};
  };
  const task=f.create(); await f.service.close();
  task.status='PAUSED';
  for(const [index,row] of task.items.entries()){
    row.status='FAILED'; row.error=index===0||missingIds.includes(row.variantId)?'No source mapping for this SKU':'Waiting for sibling sources';
  }
  const db=openDatabase(f.directory);
  db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),task.id); db.close();
  const restored=new AutomaticListingService(f.directory,f.dependencies);
  try {
    restored.startAuthorized(restored.prepareStart(task.id)); await restored.waitForIdle();
    const rows=restored.get(task.id).items;
    assert.equal(rows.length,20); assert.equal(rows.filter(row=>row.status==='DONE').length,17);
    assert.deepEqual(rows.filter(row=>row.status==='FAILED').map(row=>row.variantId),missingIds);
    assert.equal(rows[0].status,'DONE'); assert.equal(rows[0].error,null);
    assert.equal(f.calls.sources,1); assert.equal(f.calls.images,17); assert.equal(f.calls.submissions,17);
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
  const task=f.create(); f.service.startAuthorized(f.service.prepareStart(task.id)); await f.service.waitForIdle();
  const rows=f.service.get(task.id).items;
  assert.equal(rows[0].status,'DONE'); assert.equal(familySize,3); assert.equal(parents,1);
  assert.equal(rows.length,3); assert.equal(f.calls.images,1); assert.equal(f.calls.submissions,1);
  for(const row of rows.slice(1)) { assert.equal(row.status,'FAILED'); assert.equal(row.stage,'SOURCES'); assert.equal(row.draftId,null); assert.match(row.error!,/Blue has no source mapping/); }
});

test('one invalid sales plan is persisted as an exception while other selected products continue',async t=>{
  const f=fixture(t),bad=structuredClone(f.product);bad.id=randomUUID();bad.variants[0].id=randomUUID();bad.title='Conflicting pack';bad.variants[0].sku='BAD-SOURCE';
  f.dependencies.store.getProduct=id=>structuredClone(id===bad.id?bad:f.product);
  // An empty plan is not expected in production. Use the legacy single-row branch for the healthy fixture.
  f.dependencies.planSales=((id:string)=>{if(id===bad.id)throw Error('10个装与20个装冲突');return undefined;}) as any;
  const task=f.service.create({productIds:[bad.id,f.product.id],targetId:f.target.id,profileId:'alpha',productType:'BOX'});
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
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(rechecks,1);assert.equal(f.calls.submissions,1);
});

test('definitively rejected submission repairs only that child and rechecks existing images',async t=>{
  const f=fixture(t),start=f.dependencies.execution.startAuthorized;let attempts=0,repairs=0,rechecks=0;
  f.dependencies.execution.startAuthorized=task=>{
    if(attempts++===0){const value=f.executions.get(task.id)!;value.status='NEEDS_ATTENTION';value.items[0].submitStarted=false;value.items[0].steps=[{name:'submit',status:'FAILED',attempts:1,error:'INVALID item_name'}];return structuredClone(value);}return start(task);
  };
  f.dependencies.repairFields=async id=>{repairs++;const draft=f.drafts.get(id)!;draft.revision++;draft.attributes={item_name:[{value:'Corrected'}]};return structuredClone(draft);};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
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
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
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
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).status,'COMPLETED');assert.equal(fields,2);assert.equal(rechecks,1);assert.equal(f.executions.size,2);assert.equal(f.calls.images,1);
});

test('known incomplete repair survives pause and restart with its remaining reason and budget', async t => {
  const f=fixture(t);let fields=0,rechecks=0,taskId='';
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing fields'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{fields++;if(fields===1)f.service.pause(taskId);return {draft:f.dependencies.amazon.getDraft(id),remaining:['subject_character: evidence missing']};};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=f.create();taskId=task.id;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
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
  f.product.variants[0].sourceSpec=spec;f.product.variants[0].originalSpec=spec;
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing fields'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{fields++;const draft=f.drafts.get(id)!;draft.revision++;
    draft.localIssues=[{code:'LOCAL_required',message:`${field}: missing`,severity:'ERROR',attributeNames:[field],category:'field',source:'local',autoFixable:false}];return structuredClone(draft);};
  f.dependencies.recheckImage=async input=>f.dependencies.amazon.getDraft(input.draftId);
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();assert.equal(fields,2);
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
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  const original=f.service.get(task.id).items[0].error!;
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.ok(f.service.get(task.id).items[0].error!.includes(original));assert.equal(fields,1);
});

async function exhaustedColorFixture(t:test.TestContext) {
  const f=fixture(t),originalStart=f.dependencies.execution.startAuthorized;let fields=0,rechecks=0;
  f.dependencies.execution.startAuthorized=approved=>{const child=f.executions.get(approved.id)!;child.status='NEEDS_ATTENTION';child.items[0].steps=[{name:'validate',status:'FAILED',attempts:1,error:'Missing color'}];return structuredClone(child);};
  f.dependencies.repairFields=async id=>{fields++;return {draft:f.dependencies.amazon.getDraft(id),remaining:['color: source evidence insufficient']};};
  f.dependencies.recheckImage=async input=>{rechecks++;return f.dependencies.amazon.getDraft(input.draftId);};
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
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
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
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
  const task=f.create(),row=task.items[0];
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
  const task=f.create();taskId=task.id;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(f.service.get(task.id).items[0].repair?.phase,'RECHECK_PENDING');assert.equal(f.calls.submissions,0);
  f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
  assert.equal(fields,1);assert.equal(rechecks,1);assert.equal(f.calls.images,1);assert.equal(f.calls.submissions,1);
  assert.equal(f.service.get(task.id).status,'COMPLETED');
});

test('unlinked persisted child is reconciled after restart, without duplicate writes', async t => {
  const f=fixture(t),originalCreate=f.dependencies.execution.create;
  f.dependencies.execution.create=input=>{const child=originalCreate(input);throw Error('Simulated crash after child persisted '+child.id);};
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
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
  const task=f.create();taskId=task.id;f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
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
  const task=f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
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
