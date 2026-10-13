import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

async function fixture(t:test.TestContext){
  const path='../src/main/ai/purpose-routing.ts';assert.ok(existsSync(new URL(path,import.meta.url)),'purpose router must exist');
  const api=await import(path),db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE ai_profiles(id TEXT PRIMARY KEY,record_json TEXT NOT NULL)');
  api.initializePurposeProfiles(db);return{api,db};
}
test('A43 title and description keep independent model and effort snapshots',async t=>{
  const {api,db}=await fixture(t),title=api.readPurposeProfile(db,'listing_title'),description=api.readPurposeProfile(db,'listing_description');
  assert.equal(title.gateway,'openrouter');assert.equal(title.model,'openai/gpt-6-luna');
  api.savePurposeProfile(db,{purposeId:'listing_title',expectedRevision:title.revision,patch:{model:'openai/gpt-6-astra',effort:'max'}});
  assert.deepEqual(api.readPurposeProfile(db,'listing_description'),description);
  assert.equal(api.resolvePurpose(db,'listing_title').effectiveEffort,'max');
  assert.throws(()=>api.savePurposeProfile(db,{purposeId:'listing_title',expectedRevision:title.revision,patch:{effort:'low'}}),/版本/);
});
test('A44 invalid effort and missing visual capabilities are explicit errors',async t=>{
  const {api,db}=await fixture(t),p=api.readPurposeProfile(db,'listing_title');
  assert.throws(()=>api.savePurposeProfile(db,{purposeId:p.purposeId,expectedRevision:p.revision,patch:{model:'openai/gpt-6.1-sol',effort:'none'}}),/思考/);
  api.savePurposeProfile(db,{purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'deepseek',model:'deepseek-v4-pro',effort:'high'}});
  assert.throws(()=>api.resolvePurpose(db,p.purposeId,{vision:true}),/图片|视觉/);
});
test('A43 purpose upgrade targets reject cycles and snapshot the selected target',async t=>{
  const {api,db}=await fixture(t),normal=api.readPurposeProfile(db,'copy_review'),difficult=api.readPurposeProfile(db,'copy_review_difficult');
  assert.equal(normal.upgradePurposeId,'copy_review_difficult');
  const frozen=api.resolvePurpose(db,'copy_review');
  api.savePurposeProfile(db,{purposeId:difficult.purposeId,expectedRevision:difficult.revision,patch:{model:'openai/gpt-6-astra',effort:'max'}});
  assert.equal(frozen.upgrade.model,'openai/gpt-6.1-sol');
  assert.throws(()=>api.savePurposeProfile(db,{purposeId:difficult.purposeId,expectedRevision:difficult.revision+1,patch:{upgradePurposeId:'copy_review'}}),/循环|升级/);
});
test('A42 DeepSeek selected purpose stays native and cannot carry an OpenRouter model',async t=>{
  const {api,db}=await fixture(t),p=api.readPurposeProfile(db,'listing_repair');
  api.savePurposeProfile(db,{purposeId:p.purposeId,expectedRevision:p.revision,patch:{gateway:'deepseek',model:'deepseek-flash',effort:'max'}});
  const resolved=api.resolvePurpose(db,p.purposeId);assert.equal(resolved.gateway,'deepseek');assert.equal(resolved.effectiveEffort,'max');
  assert.throws(()=>api.savePurposeProfile(db,{purposeId:p.purposeId,expectedRevision:p.revision+1,patch:{model:'openai/gpt-6-astra'}}),/渠道|模型/);
});
test('legacy text-only DeepSeek setting preserves the former fixed vision category route',async t=>{
  const {api,db}=await fixture(t);db.exec('DELETE FROM ai_purpose_profiles');
  db.prepare('INSERT INTO ai_profiles VALUES(?,?)').run('deepseek',JSON.stringify({configured:true,model:'deepseek-v4-pro',thinking:true}));
  api.initializePurposeProfiles(db);assert.equal(api.resolvePurpose(db,'category_analysis',{vision:true}).model,'deepseek-flash');
  api.inheritLegacyPurposeSettings(db,'deepseek','deepseek-v4-pro',false);assert.equal(api.resolvePurpose(db,'category_analysis',{vision:true}).model,'deepseek-flash');
});
