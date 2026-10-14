import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { normalizeDetail } from '../src/main/miaoshou/normalize.ts';
import { execFileSync } from 'node:child_process';

const require=createRequire(import.meta.url);
function draft(){let api;try{api=require(resolve('tests/fixtures/stabilization/pipeline-normal-draft.mjs'));}catch(error){if((error as NodeJS.ErrnoException).code!=='MODULE_NOT_FOUND')throw error;}assert.ok(api,'S10 normal protocol/fixture draft missing');return api;}

test('normal draft distinguishes preview/formal/readback exact wire queries without enabling execution',()=>{
  const plan=draft().normalPlan({sellerId:'S10SELLER',skus:['S10-COASTER-01']});
  const route=(id:string)=>plan.routes.find((row:any)=>row.id===id);
  assert.equal(route('preview-0').url,'https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/S10SELLER/S10-COASTER-01?marketplaceIds=ATVPDKIKX0DER&issueLocale=en_US&mode=VALIDATION_PREVIEW&includedData=issues');
  assert.equal(route('submit-0').method,'PUT');assert.equal(new URL(route('submit-0').url).searchParams.has('mode'),false);
  assert.equal(new URL(route('readback-0').url).searchParams.get('includedData'),'summaries,issues,attributes,offers,fulfillmentAvailability,relationships');
  assert.equal(plan.normalExecutable,false);assert.equal(plan.finalIntegrationPassed,false);
  assert.ok(plan.blockers.some((row:any)=>row.owner==='S05'));assert.ok(plan.blockers.some((row:any)=>row.owner==='S08'));
  assert.equal(plan.protocolPolicyInstalled,false);assert.ok(plan.routes.every((row:any)=>row.auth&&row.url.startsWith('https://')));
});

test('draft exact registrations reject aliases, duplicate/query/authority drift and unsafe SKU identity',()=>{
  const api=draft(),plan=api.normalPlan({sellerId:'S10SELLER',skus:['S10-01']});
  const route=plan.routes.find((row:any)=>row.id==='ocr');
  assert.equal(api.matchExactRoute(plan.routes,{id:'ocr',method:'POST',url:route.url}).id,'ocr');
  for(const url of [route.url+'&Type=Commerce',route.url.replace('Commerce','commerce'),route.url.replace('https:','http:'),route.url.replace('aliyuncs.com','aliyuncs.com.evil.invalid'),route.url.replace('/?','/:443/?')])assert.throws(()=>api.matchExactRoute(plan.routes,{id:'ocr',method:'POST',url}),/S10_EXACT_ROUTE/);
  for(const sku of ['..','a/b','a%2Fb','a?x=1','a#fragment',''])assert.throws(()=>api.normalPlan({sellerId:'S10SELLER',skus:[sku]}));
  for(const url of ['http://127.1:3000/a','http://2130706433:3000/a','https://openrouter.ai:443/api/v1/images'])assert.throws(()=>api.matchExactRoute(plan.routes,{id:'image-generation',method:'POST',url}),/S10_EXACT_ROUTE/);
});

test('full-schema download fixture advertises MD5 of actual sanitized bytes and retains all properties',async()=>{
  const api=draft(),f=await api.schemaFixture('drink-coaster-us'),bytes=await readFile(resolve('tests/fixtures/amazon/drink-coaster-us/schema.json'));
  assert.deepEqual(f.schema.bytes,bytes);assert.equal(f.definition.schema.checksum,createHash('md5').update(bytes).digest('base64'));
  assert.equal(Object.keys(JSON.parse(f.schema.bytes).properties).length,106);
  assert.equal(f.definition.productType,'DRINK_COASTER');assert.equal(f.definition.requirementsEnforced,'ENFORCED');
  assert.equal(f.definition.schema.link.verb,'GET');assert.equal(f.definition.metaSchema.checksum,createHash('md5').update(f.metaSchema.bytes).digest('base64'));
  await assert.rejects(api.schemaFixture('../drink-coaster-us'));await assert.rejects(api.schemaFixture('unknown'));
});

test('owned source response is normalized by real Miaoshou parser, never a seeded product or domain completion',()=>{
  const fixture=draft().sourceFixture(),parsed=normalizeDetail(fixture.detail,'2026-10-15T00:00:00.000Z','live',(value:string)=>value);
  assert.equal(parsed.remoteId,fixture.remoteId);assert.equal(parsed.skus.length,1);assert.equal(parsed.skus[0].itemNum,'S10-SUPPLIER-BLUE');
  assert.ok(parsed.images.every(image=>image.url.startsWith('https://cbu01.alicdn.com/s10/')));
  assert.equal(fixture.list.data.detailList[0].commonCollectBoxDetailId,fixture.remoteId);
  assert.equal('workflow' in fixture,false);assert.equal('draft' in fixture,false);
});

test('external replies preserve ACCEPTED versus BUYABLE and parent relation without domain mutation',()=>{
  const api=draft(),input={sku:'S10-CHILD',marketplaceId:'ATVPDKIKX0DER'};
  assert.equal(api.listingReply('preview',input).status,'VALID');assert.equal(api.listingReply('submit',input).status,'ACCEPTED');
  const read=api.listingReply('readback',{...input,parentSku:'S10-PARENT',variationTheme:'COLOR_NAME'});
  assert.deepEqual(read.summaries[0].status,['BUYABLE','DISCOVERABLE']);assert.equal(read.relationships[0].relationships[0].parentSkus[0],'S10-PARENT');
  assert.equal('state' in read,false);assert.equal('workflow' in read,false);assert.throws(()=>api.listingReply('COMPLETED',input));
});

test('controller normal-plan mode emits the WIP inventory without opening worker/provider or reporting success',()=>{
  const output=execFileSync(process.execPath,['scripts/e2e-stabilization-pipeline.mjs','--normal-plan'],{cwd:resolve('.'),encoding:'utf8',windowsHide:true});
  const report=JSON.parse(output);assert.equal(report.mode,'normal-plan');assert.equal(report.normalExecutable,false);assert.equal(report.finalIntegrationPassed,false);
  assert.equal(report.listingProgram,'haul');
  assert.equal(report.businessStarted,false);assert.equal(report.providerStarted,false);assert.equal(report.workerStarted,false);
  assert.deepEqual(report.schemaFixtures.map((row:any)=>[row.name,row.propertyCount]),[['drink-coaster-us',106],['figurine-parent-us',87]]);
  assert.ok(report.schemaFixtures.every((row:any)=>/^[a-f0-9]{64}$/.test(row.sha256)));
  assert.throws(()=>execFileSync(process.execPath,[resolve('scripts/e2e-stabilization-pipeline.mjs'),'--normal-plan'],{cwd:resolve('..'),encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}),/S10_EXPLICIT_WORKTREE_REQUIRED|STABILIZATION_WORKTREE_REQUIRED/);
});
