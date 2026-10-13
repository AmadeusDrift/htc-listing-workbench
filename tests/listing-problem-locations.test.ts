import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/listing-ai.ts';
import { listingProblems } from '../src/main/listing-ai/problems.ts';

test('A23 exact field paths and original reasons survive problem presentation',async t=>{
  const f=await fixture(t),draft={...f.draft,localIssues:[],previewIssues:[{code:'90220',message:'Missing title in selected marketplace',severity:'ERROR' as const,category:'field' as const,source:'amazon' as const,attributeNames:['item_name'],autoFixable:false}],listingIssues:[]};
  const issues=listingProblems(draft,['item_name：Missing title in selected marketplace','Unlocalized original failure']);
  assert.equal(issues.length,2);assert.equal(issues[0].summary,'Missing title in selected marketplace');assert.equal(issues[0].kind,'platform-rejection');assert.deepEqual(issues[0].locations,[{kind:'field',pointer:'/attributes/item_name',label:'item_name',relatedPointers:[]}]);
  assert.equal(issues[1].locations[0].kind,'unknown');assert.equal(issues[1].rawMessage,'Unlocalized original failure');assert.equal(issues[0].context.sku,draft.sku);
});
test('A23 an UNKNOWN submission never exposes ordinary draft editing as an issue action',async t=>{
  const f=await fixture(t),draft={...f.draft,state:'UNKNOWN' as const};
  const issues=listingProblems(draft,['Original submission result unknown']);
  assert.ok(issues.length);assert.equal(issues.every(i=>i.kind==='unknown-result'&&!i.allowedActions.includes('edit-draft')),true);
});
