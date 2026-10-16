import { materializeSourceSnapshot,confirmSourceConsistencyFixture } from './helpers/source-consistency-proof.ts';
import { WorkspaceStore } from '../src/main/store.ts';
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
import { buildSalesRecipes } from '../src/main/sales-plans/recipes.ts';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import {DIRECT_HOSTING_ROUTE,profileWithHostingRoute} from '../src/shared/hosting-contracts.ts';
import type {HostingProfile} from '../src/shared/hosting-contracts.ts';

function fixture(t: test.TestContext, mode: 'live' | 'demo' = 'demo') {
  mkdirSync(resolve('.test-data'), { recursive: true });
  const directory = mkdtempSync(join(resolve('.test-data'), 'automatic-task-'));
  const now = new Date().toISOString(), batchId = randomUUID(), lineId = randomUUID();
  const product: ProductDetail = { id: randomUUID(), revision: 1, title: 'Box', sourceUrl: '', description: '', status: 'draft', origin: 'manual', createdAt: now, updatedAt: now, facts: [], assets: [], variants: [
    { id: randomUUID(), sku: 'SKU-ONE', originalSpec: 'red', normalizedSpec: 'red', purchasePrice: '1', inventory: null, sourceSpec: 'red', sourcePurchasePrice: '1' },
  ] };
  const target: AmazonTarget = { id: 'store-one', name: 'Test store', mode, sellerId: 'seller', marketplaceId: 'ATVPDKIKX0DER', marketplaceName: 'US', region: 'na', locale: 'en_US', paused: false, configured: true, credentialUpdatedAt: now, lastError: null };
  const profile:HostingProfile = { id: 'alpha' as const, name: 'Alpha' as const, generation: 1, enabled: true, configured: true, host: 'ftp.example.test', port: 21, secure: true, remoteRoot: '/', publicBaseUrl: 'https://images.example.test/' };
  const rules = defaultListingRules();
  const drafts = new Map<string, AmazonDraft>(), executions = new Map<string, ExecutionTask>();
  const calls = { sources: 0, images: 0, submissions: 0, batches: 0, labels: 0 };
  let ready = mode === 'demo', imageFailure = false, started: (() => void) | undefined, release: (() => void) | undefined;
  const workflow = new Map<string, any>();
  const dependencies: AutomaticListingDependencies = {
    store: { getProduct: () => structuredClone(product),getProductSnapshot: id => dependencies.store.getProduct(id),hasProducts:ids=>ids.every(id=>id===product.id) },
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
        const hostingRoute=(input as any).hostingRoute??(profile as any).route??DIRECT_HOSTING_ROUTE;
        const task = { id, status: 'CREATED', profileId: profile.id, hostingRoute, profileStamp: fingerprint(profileWithHostingRoute(profile,hostingRoute)), items: [{ draftId: draft.id, draftRevision: draft.revision, attributesHash: fingerprint(draft.attributes), schemaHash: fingerprint(draft.schema),
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

// Read-only audit reproductions against the already delivered source. Synthetic dependencies only.
test('AUDIT legacy source group must preserve the four selected SKUs across shared preparation',async t=>{
 const f=fixture(t);f.rules.product.variantLimit=20;
 f.product.variants=Array.from({length:20},(_,i)=>({...f.product.variants[0],id:randomUUID(),sku:`OLD-${i}`}));
 const selected=new Set<string>((f.service as any).selectedVariants(f.product).map((v:any)=>v.id));assert.equal(selected.size,4);
 const missing=[...selected][0];f.dependencies.images.prepareSources=async()=>{f.calls.sources++;return {product:structuredClone(f.product),missing:[{variantId:missing,message:'Synthetic missing selected image'}]};};
 const task=await f.create();await f.service.close();task.status='PAUSED';
 task.items=f.product.variants.map(v=>({...structuredClone(task.items[0]),key:f.product.id+':'+v.id,variantId:v.id,sku:v.sku,status:'FAILED',error:'Old source checkpoint'}));
 const db=openDatabase(f.directory);db.prepare('UPDATE automatic_listing_tasks SET record_json=? WHERE id=?').run(JSON.stringify(task),task.id);db.close();
 const seen:string[]=[],complete=f.dependencies.images.complete;f.dependencies.images.complete=async input=>{seen.push(f.drafts.get((input as any).draftId)!.variantId);return complete(input);};
 const restored=new AutomaticListingService(f.directory,f.dependencies);try{
  restored.startAuthorized(restored.prepareStart(task.id));await restored.waitForIdle();
  const outside=seen.filter(id=>!selected.has(id));t.diagnostic(JSON.stringify({selected:4,missingSelected:1,imageUnits:seen.length,unselectedImageUnits:outside.length,submissions:f.calls.submissions,statuses:restored.get(task.id).items.reduce((a:any,r)=>{a[r.status]=(a[r.status]??0)+1;return a;},{})}));
  assert.equal(outside.length,0,'Unselected legacy source rows must never reach the image or execution unit');
 }finally{await restored.close();}
});
for(const change of ['hosting','rules'] as const)test(`AUDIT paused submitted SKU can resume readback after unrelated ${change} change`,async t=>{
 const f=fixture(t,'live'),task=await f.create();f.service.startAuthorized(f.service.prepareStart(task.id));await f.service.waitForIdle();
 const before=f.service.get(task.id);assert.equal(before.items[0].stage,'READBACK');assert.equal(f.calls.submissions,1);f.service.pause(task.id);
 if(change==='hosting')f.profile.generation++;else f.rules.revision++;
 assert.doesNotThrow(()=>f.service.startAuthorized(f.service.prepareStart(task.id)),'Readback must not require a new FTP/write configuration');
 await f.service.waitForIdle();f.setReady();await f.service.refreshWaiting();assert.equal(f.calls.submissions,1);
});
