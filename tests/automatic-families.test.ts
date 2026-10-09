import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ensureFamilyParent } from '../src/main/automatic-listing/families.ts';
import { observeFamilyRelationship } from '../src/main/amazon/relationships.ts';

function fixture(failures=0){
  const recipeKey=createHash('sha256').update(JSON.stringify([['source',1]])).digest('hex');
  const plan={namingGroupId:randomUUID(),sourceGroupKey:'local:fixture:'+'a'.repeat(64),collectedAt:new Date().toISOString(),collectionBasis:'first_import',sku:'H2-261008-1',baseSku:'H2-261008-1',parentage:'PARENT',parentSku:null,variationTheme:'COLOR',relationReason:'test',familyResolved:true,namingChildKey:null,
    recipe:{key:recipeKey,groupKey:'a'.repeat(64),specification:'red box',color:'Red',totalPieces:1,totalCostCny:1,components:[{variantId:randomUUID(),sourceKey:'source',sourceSku:'SOURCE',specification:'red box',color:'Red',quantity:1,quotedCostCny:1,piecesPerQuote:1,sourcePackPieces:1}]}};
  const parent:any={id:randomUUID(),productId:randomUUID(),sku:'H2-261008-1',targetId:'store',mode:'live',revision:1,state:'DRAFT',submittedAt:null,schema:{parentageLevel:'PARENT',productType:'BOX'},salesPlan:{sourceGroupKey:'same-group'}};
  const child:any={...parent,id:randomUUID(),sku:parent.sku+'-A',schema:{...parent.schema,parentageLevel:'CHILD'},salesPlan:{sourceGroupKey:'same-group',parentage:'CHILD',baseSku:parent.sku,parentSku:parent.sku,variationTheme:'COLOR'}};
  parent.salesPlan=structuredClone(plan);child.salesPlan={...structuredClone(plan),sku:child.sku,parentage:'CHILD',parentSku:parent.sku,namingChildKey:recipeKey};
  let starts=0,repairs=0,images=0;const tasks:any[]=[];
  const deps:any={amazon:{familyParentPlan:()=>structuredClone(parent.salesPlan),listDrafts:()=>[parent,child],getDraft:()=>structuredClone(parent),applyBusinessDefaults:()=>structuredClone(parent),useFamilyImage:()=>{images++;return structuredClone(parent);}},
    listing:{complete:async()=>{repairs++;parent.revision++;return {draft:structuredClone(parent)};}},
    execution:{list:()=>structuredClone(tasks),create:()=>{const task={id:randomUUID(),profileId:'alpha',status:'CREATED',items:[{draftId:parent.id,draftRevision:parent.revision,steps:[],submitStarted:false}]};tasks.push(task);return structuredClone(task);},
      prepareStart:(id:string)=>structuredClone(tasks.find(t=>t.id===id)),startAuthorized:(approved:any)=>{starts++;const task=tasks.find(t=>t.id===approved.id)!;
        if(starts<=failures){task.status='NEEDS_ATTENTION';task.items[0].steps=[{name:'preview',status:'FAILED',error:'Fix title'}];}
        else{parent.submittedAt=new Date().toISOString();parent.state='SUBMITTED';task.status='COMPLETED';}},
      get:(id:string)=>structuredClone(tasks.find(t=>t.id===id)),waitForIdle:async()=>{},pause:()=>{},cancel:(id:string)=>{tasks.find(t=>t.id===id).status='CANCELLED';}},
    followup:{schedule:()=>({status:parent.state==='UNKNOWN'?'NEEDS_ATTENTION':'WAITING',error:'Unknown write'})}};
  return {parent,child,tasks,deps,get starts(){return starts;},get repairs(){return repairs;},get images(){return images;}};
}
test('parent continuation never starts an execution containing unrelated drafts or another profile',async()=>{
  for(const extra of [true,false]){
    const f=fixture();f.tasks.push({id:randomUUID(),status:'CREATED',profileId:extra?'alpha':'other',items:[{draftId:f.parent.id},...(extra?[{draftId:randomUUID()}]:[])]});
    await assert.rejects(ensureFamilyParent(f.deps,f.child,'alpha',new AbortController().signal),/不同范围/);assert.equal(f.starts,0);
  }
});
test('parent repairs only failed fields with a durable three-attempt ceiling and one shared image',async()=>{
  const f=fixture(1),result=await ensureFamilyParent(f.deps,f.child,'alpha',new AbortController().signal);
  assert.equal(result.ready,false);assert.equal(f.starts,2);assert.equal(f.images,1);assert.equal(f.repairs,2);
  const blocked=fixture(99);
  await assert.rejects(ensureFamilyParent(blocked.deps,blocked.child,'alpha',new AbortController().signal),/Fix title/);
  assert.equal(blocked.starts,3);assert.equal(blocked.repairs,3);
  await assert.rejects(ensureFamilyParent(blocked.deps,blocked.child,'alpha',new AbortController().signal),/Fix title/);
  assert.equal(blocked.starts,3);assert.equal(blocked.repairs,3);
});
test('submitted and uncertain parents are observed without another write',async()=>{
  for(const state of ['SUBMITTED','UNKNOWN']){
    const f=fixture();f.parent.state=state;if(state==='SUBMITTED')f.parent.submittedAt=new Date().toISOString();
    if(state==='UNKNOWN')await assert.rejects(ensureFamilyParent(f.deps,f.child,'alpha',new AbortController().signal),/Unknown/);
    else assert.equal((await ensureFamilyParent(f.deps,f.child,'alpha',new AbortController().signal)).ready,false);
    assert.equal(f.starts,0);assert.equal(f.repairs,0);
  }
});

test('corrected business defaults recover an exhausted unsubmitted parent without deleting failed history',async()=>{
  const f=fixture(3),signal=new AbortController().signal;
  await assert.rejects(ensureFamilyParent(f.deps,f.child,'alpha',signal),/Fix title/);
  let corrections=0;
  f.deps.amazon.applyBusinessDefaults=()=>{if(!corrections++){f.parent.revision++;f.parent.attributes={batteries_required:[{value:false}]};}return structuredClone(f.parent);};
  assert.equal((await ensureFamilyParent(f.deps,f.child,'alpha',signal)).ready,false);
  assert.equal(f.starts,4);
  assert.equal(f.tasks.length,4);
  assert.ok(f.tasks.slice(0,3).every(t=>t.status==='CANCELLED'&&t.items[0].steps[0].error==='Fix title'));
  assert.equal(f.tasks[3].items[0].draftRevision,f.parent.revision);
});

test('a corrected parent gets no repeated execution when the new attempt fails with unchanged fields',async()=>{
  const f=fixture(99),signal=new AbortController().signal;
  await assert.rejects(ensureFamilyParent(f.deps,f.child,'alpha',signal),/Fix title/);
  let corrected=false;
  f.deps.amazon.applyBusinessDefaults=()=>{if(!corrected){corrected=true;f.parent.revision++;}return structuredClone(f.parent);};
  await assert.rejects(ensureFamilyParent(f.deps,f.child,'alpha',signal),/Fix title/);
  assert.equal(f.starts,4);
  await assert.rejects(ensureFamilyParent(f.deps,f.child,'alpha',signal),/Fix title/);
  assert.equal(f.starts,4);
});

test('parent recovery survives interruption after defaults saved and never retries a started submit',async()=>{
  for(const submitStarted of [false,true]){
    const f=fixture(3),signal=new AbortController().signal;
    await assert.rejects(ensureFamilyParent(f.deps,f.child,'alpha',signal),/Fix title/);
    f.parent.revision++;f.tasks.at(-1)!.items[0].submitStarted=submitStarted;
    if(submitStarted){await assert.rejects(ensureFamilyParent(f.deps,f.child,'alpha',signal),/Fix title/);assert.equal(f.starts,3);}
    else{await ensureFamilyParent(f.deps,f.child,'alpha',signal);assert.equal(f.starts,4);}
  }
});

test('a failed parent recovered as paused can apply new defaults after its retry ceiling',async()=>{
  const f=fixture(3),signal=new AbortController().signal;
  await assert.rejects(ensureFamilyParent(f.deps,f.child,'alpha',signal),/Fix title/);
  f.tasks.at(-1)!.status='PAUSED';
  f.deps.amazon.applyBusinessDefaults=()=>{f.parent.revision++;return structuredClone(f.parent);};
  await ensureFamilyParent(f.deps,f.child,'alpha',signal);
  assert.equal(f.starts,4);
  assert.equal(f.tasks.length,4);
  assert.equal(f.tasks[2].status,'CANCELLED');
});
test('family observation requires the correct marketplace, parent and variation theme',()=>{
  const f=fixture();f.child.marketplaceId='US';
  const response=(parent='H2-261008-1',theme='COLOR_NAME',market='US')=>({relationships:[{marketplaceId:market,relationships:[{type:'VARIATION',parentSkus:[parent],variationTheme:{theme,attributes:['color']}}]}]});
  assert.equal(observeFamilyRelationship(f.child,{relationships:[]}).status,'WAITING');
  assert.equal(observeFamilyRelationship(f.child,response()).status,'MATCHED');
  assert.equal(observeFamilyRelationship(f.child,response('OTHER')).status,'MISMATCHED');
  assert.equal(observeFamilyRelationship(f.child,response('H2-261008-1','SIZE')).status,'MISMATCHED');
  assert.equal(observeFamilyRelationship(f.child,response('H2-261008-1','COLOR','CA')).status,'WAITING');
});
