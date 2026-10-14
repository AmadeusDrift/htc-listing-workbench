import test from 'node:test';
import assert from 'node:assert/strict';
import {oldKit} from './fixtures/mixed-kit.ts';
import {mockStorage,chat} from './fixtures/listing-ai.ts';
import {sceneSet} from './fixtures/image-set.ts';
import {confirmSourceConsistencyFixture} from './helpers/source-consistency-proof.ts';
import {ImageGenerationService} from '../src/main/image-generation/service.ts';
import {ImageWorkflowService} from '../src/main/image-workflow/service.ts';
import {originalPng} from './fixtures/completion-owners.ts';
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {saveInput} from './fixtures/listing-ai.ts';
import {SkuNamingService} from '../src/main/sku-naming/service.ts';
import {deflateSync} from 'node:zlib';
import {workflowRuns} from '../src/main/image-workflow/records.ts';
import {AutomaticListingService} from '../src/main/automatic-listing/service.ts';
import {sourceStamp} from '../src/main/automatic-listing/records.ts';
import {fingerprint} from '../src/main/execution/records.ts';
import {readListingRules} from '../src/main/listing-rules.ts';
import {DEFAULT_ITEM_LABEL_FORMAT} from '../src/shared/item-label-contracts.ts';

function syntheticScene(marker:number):Buffer{
 const crc=(data:Buffer)=>{let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
 const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(32,0);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;const pixels=Buffer.alloc(32*97,190+marker);for(let y=0;y<32;y++)pixels[y*97]=0;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
import {join} from 'node:path';

for(const partial of [false,true])test(partial?'actual two-of-seven candidates remain locked for partial unit recheck without regeneration':'actual image services recheck a corrected unit using original seven candidates without new generation',async t=>{
 const f=await oldKit(t);let generated=0;const operations:string[]=[];
 // Standard demo isolates the image mechanism from Haul price admission; the
 // frozen Haul unit/pricing guards are covered separately in mixed-kit-units.
 let product=f.store.createProduct();product=f.store.saveProduct({...saveInput(product),title:'Filter Support Kit',variants:saveInput(product).variants.map(v=>({...v,originalSpec:'黄色 / 支架+贴片+50只过滤网',normalizedSpec:'黄色 50pc',purchasePrice:'8.2'})),facts:[{id:randomUUID(),name:'材质',value:'Silicone',state:'human_confirmed',source:'manual',sourceRef:'synthetic'},{id:randomUUID(),name:'产品类型',value:'Filter Support Kit',state:'human_confirmed',source:'manual',sourceRef:'synthetic'}]});
 const bytes=originalPng(),assetId=randomUUID(),sha=createHash('sha256').update(bytes).digest('hex');mkdirSync(join(f.directory,'assets'),{recursive:true});writeFileSync(join(f.directory,'assets',assetId+'.png'),bytes);
 product=f.store.addAssets({productId:product.id,revision:product.revision},[{id:assetId,fileName:'synthetic.png',mimeType:'image/png',width:32,height:32,byteSize:bytes.length,originalPath:'assets/'+assetId+'.png',previewPath:'assets/'+assetId+'.png',sha256:sha}]);product=f.store.updateAsset({productId:product.id,revision:product.revision,assetId,role:'main',variantIds:[product.variants[0].id]});
 await confirmSourceConsistencyFixture(f.directory,f.store,product.id);
 const target=f.amazon.getTarget(f.amazon.getDraft(f.ref.id).targetId),v=product.variants[0],component={variantId:v.id,sourceKey:v.id,sourceSku:v.sku,specification:v.originalSpec,color:'Yellow',quantity:50,quotedCostCny:8.2,piecesPerQuote:50,sourcePackPieces:50},key=createHash('sha256').update(JSON.stringify([[v.id,50]])).digest('hex');
 const naming=new SkuNamingService(f.directory),group=naming.allocate({storeScope:JSON.stringify([target.mode,target.sellerId]),storeCode:'U2',sourceGroupKey:`local:${product.id}:${'a'.repeat(64)}`,collectedAt:product.createdAt,childKeys:[key]});naming.close();
 const plan={...f.plan,namingGroupId:group.id,sourceGroupKey:group.sourceGroupKey,collectedAt:group.collectedAt,sku:group.children[0].sku,baseSku:group.baseSku,namingChildKey:key,recipe:{key,groupKey:'a'.repeat(64),specification:v.originalSpec,color:'Yellow',components:[component],totalPieces:50,totalCostCny:8.2}};
 const created=await f.amazon.createDraft({productId:product.id,variantId:v.id,targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'}),ref={id:created.id,revision:created.revision},record=f.persistence.record(ref.id),market=record.draft.marketplaceId;record.draft.sku=plan.sku;record.draft.salesPlan=plan;
 record.draft.attributes={item_name:[{value:'Yellow Silicone Filter Support Kit',marketplace_id:market,language_tag:'en_US'}],brand:[{value:'Generic',marketplace_id:market}],material:[{value:'Silicone',marketplace_id:market}],color:[{value:'Yellow',marketplace_id:market}],batteries_required:[{value:false,marketplace_id:market}],purchasable_offer:[{marketplace_id:market,currency:'USD',audience:'ALL',our_price:[{schedule:[{value_with_tax:2.5}]}]}]};f.persistence.putRecord(record);
 const sourceAsset=f.store.getAssetRecord(assetId)!;
 const respond=(payload:any)=>{
  operations.push(payload.operation);
  if(payload.operation==='listing-current-review')return chat({kind:'amazon-fields-review',verdict:'PASS',checks:payload.candidate.candidates.flatMap((c:any)=>c.items.map((i:any,index:number)=>({field:c.field,index,verdict:'SUPPORTED',evidenceIds:payload.evidence.map((e:any)=>e.id),reason:'Synthetic source evidence.',claims:[{text:i.value,verdict:'SUPPORTED',evidenceIds:payload.evidence.map((e:any)=>e.id),reason:'Synthetic source evidence.'}]}))),issues:[]});
  if(payload.operation==='image-plan')return chat({kind:'image-plan',...(payload.setPolicy&&!payload.slot?{setPlan:sceneSet()}:{}),prompt:'Preserve the source product without visible text.',textMode:'none',expectedText:[],ipRisk:{verdict:'PASS',findings:[]},productUnderstanding:{summary:'Synthetic filter support kit.',referenceAssetIds:payload.referenceImages.map((r:any)=>r.assetId),uncertainties:['Dimensions are unknown.'],sufficient:true}});
  if(payload.operation==='image-appearance-review')return chat({verdict:'PASS',checks:[{aspect:'identity',expected:'Synthetic source kit',observed:'Synthetic source kit',reason:'Controlled provider response; byte identity checked locally.',referenceAssetIds:payload.referenceImages.map((r:any)=>r.assetId)}]});
  if(payload.operation==='image-text-review')return chat({verdict:'PASS',checks:[],expectedTextChecks:[],noTextVerified:true,issues:[]});
  throw Error('Unexpected copy generation after verified fields: '+payload.operation);
 };
 const generation=new ImageGenerationService(f.directory,f.store,mockStorage,{decodePreview:b=>b,fetch:async(url,init)=>{assert.equal(String(url),'https://openrouter.ai/api/v1/images');assert.equal(init?.method,'POST');generated++;return new Response(JSON.stringify({data:[{b64_json:syntheticScene(generated).toString('base64')}]}));}});
 generation.attachOpenRouterConnection({read:()=> 'synthetic-image-key',save:()=>{},disconnect:()=>{}});generation.saveConnection({provider:'openrouter',model:'openai/gpt-image-2.5-sunburst',enabled:true,size:'1024x1024',quality:'high'});
 for(const purposeId of ['appearance_review','appearance_review_difficult'] as const){const profile=f.ai.getPurposeProfiles().find(p=>p.purposeId===purposeId)!;f.ai.savePurposeProfile({purposeId,expectedRevision:profile.revision,patch:{gateway:'deepseek',model:'deepseek-flash',effort:'none',upgradePurposeId:null}});}
 const flow=new ImageWorkflowService(f.directory,f.store,f.amazon,f.ai,generation,{listing:f.listing});flow.saveRiskSettings({enabled:true});flow.saveCopyReviewSettings({enabled:true});flow.saveAppearanceReviewSettings({enabled:true});
 // Keep actual OCR adapter/service; only its external HTTP reply is injected.
 f.ai.importProfile({id:'aliyun-ocr',accessKeyId:'synthetic-ocr-id',accessKeySecret:'synthetic-ocr-secret'});f.ai.setEnabled({id:'aliyun-ocr',enabled:true});
 f.ai.importProfile({id:'aliyun-image-risk',accessKeyId:'synthetic-risk-id',accessKeySecret:'synthetic-risk-secret'});f.ai.setEnabled({id:'aliyun-image-risk',enabled:true});
 (f.ai as any).context.fetch=async(url:any,init:any)=>{
  if(String(url).includes('ocr-api.'))return new Response(JSON.stringify({Code:'success',RequestId:'synthetic-ocr',Data:{Width:sourceAsset.width,Height:sourceAsset.height,Content:'',SubImageCount:0,SubImages:[]}}));
  if(String(url).includes('green-cip.')||String(url).includes('.oss-cn-shanghai.')){
    const action=new Headers(init.headers).get('x-acs-action')??'ip-upload';operations.push(action);
    if(action==='DescribeUploadToken')return new Response(JSON.stringify({Code:200,Data:{AccessKeyId:'synthetic-upload-id',AccessKeySecret:'synthetic-upload-secret',SecurityToken:'synthetic-upload-token',BucketName:'oss-cip-shanghai',FileNamePrefix:'upload/synthetic/',OssInternetEndPoint:'https://oss-cn-shanghai.aliyuncs.com',Expiration:Math.floor(Date.now()/1000)+1800}}));
    if(action==='ip-upload')return new Response(null,{status:200});
    const params=new URLSearchParams(Buffer.from(init.body).toString()),payload=JSON.parse(params.get('ServiceParameters')!);
    return new Response(JSON.stringify({Code:200,RequestId:'synthetic-risk',Data:{DataId:payload.dataId,RiskLevel:partial&&generated>2?'high':'none',Result:[{Label:partial&&generated>2?'trademark':'nonLabel',Description:partial&&generated>2?'Controlled explicit synthetic risk':'No synthetic risk',Confidence:partial&&generated>2?100:0}]}}));
  }
  assert.equal(String(url),'https://api.deepseek.com/chat/completions');const body=JSON.parse(String(init.body)),content=body.messages[1].content,payload=JSON.parse(Array.isArray(content)?content[0].text:content);f.requests.push(body);return respond(payload);
 };
 let owner:AutomaticListingService|undefined;
 try{
  const first=await flow.complete({draftId:ref.id,draftRevision:f.amazon.getDraft(ref.id).revision});if(first.workflow.status!==(partial?'BLOCKED':'COMPLETED'))console.log(JSON.stringify({stage:first.workflow.stage,operations,calls:f.ai.listCalls().map(c=>({status:c.status,error:c.errorCode,purpose:c.purposeSnapshot?.purposeId})),remaining:first.remaining,rejection:first.workflow.rejection}));assert.equal(first.workflow.status,partial?'BLOCKED':'COMPLETED',first.workflow.error??'actual image chain did not complete');assert.equal(generated,partial?3:7);assert.equal(first.workflow.slots?.filter(s=>s.status==='PASSED').length,partial?2:7);
  const old=JSON.stringify(workflowRuns(f.db,ref.id).find(run=>run.id===first.workflow.id)),candidateIds=[...first.workflow.candidateIds],images=first.workflow.slots!.map(s=>({id:s.approvedAssetId,sha:s.approvedSha256})),before=generated;
  const historyTables=['ai_calls','ai_results','ai_usage_ledger','ai_provider_receipts','ai_image_requests'] as const,oldRows=new Map(historyTables.map(table=>[table,f.db.prepare('SELECT id,record_json FROM '+table).all()]));
  const profile={id:'synthetic-profile',enabled:true,configured:true},now=new Date().toISOString(),rules=readListingRules(f.db),task={id:randomUUID(),revision:1,status:'PAUSED',targetId:target.id,targetName:target.name,sellerId:target.sellerId,marketplaceId:target.marketplaceId,mode:target.mode,targetStamp:fingerprint(f.amazon.executionTargetScope(target.id)),profileId:profile.id,profileStamp:fingerprint(profile),rulesStamp:fingerprint(rules),ruleRevision:rules.revision,productType:'HTC_DEMO_STORAGE_BAG',locale:'en_US',labelFormat:DEFAULT_ITEM_LABEL_FORMAT,createdAt:now,updatedAt:now,error:'Legacy units',items:[{key:product.id+':'+plan.recipe.key,productId:product.id,productRevision:product.revision,sourceStamp:sourceStamp(f.store.getProductSnapshot(product.id)),productTitle:product.title,variantId:v.id,sku:plan.sku,stockSets:5,sourcesPrepared:true,status:'FAILED',stage:'DRAFT',draftId:ref.id,executionTaskIds:[],imageStarted:true,imageAttempts:partial?3:7,repairAttempts:0,repair:null,batchId:null,error:'Legacy units',salesPlan:plan}]};
  f.db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(task));
  const deps:any={store:f.store,amazon:f.amazon,rules:()=>readListingRules(f.db),hosting:{getProfile:()=>profile},images:flow,execution:{list:()=>[]},followup:{},procurement:{},labels:{},recheckImage:async(input:any)=>{const result=await flow.recheck(input);if(result.workflow.status!=='COMPLETED')throw Error(result.workflow.error??'Recheck failed');return result.draft;}};
  owner=new AutomaticListingService(f.directory,deps);const input={taskId:task.id,taskRevision:task.revision,itemKey:task.items[0].key,platformPieces:1,basis:'Synthetic full kit sale unit'},preview=owner.previewSalesUnitAdoption(input);assert.equal(preview.unitPreview.canApply,true,preview.unitPreview.blockers.join(';'));
  const adopted=owner.adoptSalesUnit({...input,token:preview.token,confirmed:true});assert.equal(adopted.status,'PAUSED');assert.equal(adopted.items[0].imageAttempts,partial?3:7);assert.equal(adopted.items[0].unitRecheck?.sourceWorkflowId,first.workflow.id);
  const active=(owner as any).tasks.get(task.id);active.status='RUNNING';(owner as any).grants.add(task.id);(owner as any).save(active);
  if(partial){
   const marker=structuredClone(active.items[0].unitRecheck),calls=f.requests.length;
   await assert.rejects((owner as any).finishUnitRecheck(active,active.items[0]),/当前原七图或复核服务不完整/);
   assert.deepEqual(owner.get(task.id).items[0].unitRecheck,marker);assert.equal(generated,3);assert.equal(f.requests.length,calls);
   assert.equal(JSON.stringify(workflowRuns(f.db,ref.id).find(run=>run.id===first.workflow.id)),old);
   for(const [table,rows]of oldRows)for(const row of rows)assert.equal(f.db.prepare('SELECT record_json FROM '+table+' WHERE id=?').get(row.id)?.record_json,row.record_json);
   owner.pause(task.id);await owner.close();owner=new AutomaticListingService(f.directory,deps);assert.equal(owner.get(task.id).status,'PAUSED');assert.deepEqual(owner.get(task.id).items[0].unitRecheck,marker);
   t.diagnostic('Partial 2/7 unit continuation remains blocked pending S05 original-workflow partial recheck; no marker removal or replacement generation permitted.');return;
  }
  const checkpoint=structuredClone(active.items[0].unitRecheck);(owner as any).db.exec("CREATE TEMP TRIGGER fail_after_real_recheck BEFORE UPDATE ON automatic_listing_tasks BEGIN SELECT RAISE(ABORT,'after image result before task checkpoint'); END");
  await assert.rejects((owner as any).finishUnitRecheck(active,active.items[0]),/after image result before task checkpoint/);assert.deepEqual(owner.get(task.id).items[0].unitRecheck,checkpoint,'failed task write preserves the in-memory unit checkpoint');
  (owner as any).db.exec('DROP TRIGGER fail_after_real_recheck');owner.pause(task.id);await owner.close();owner=new AutomaticListingService(f.directory,deps);assert.equal(owner.get(task.id).status,'PAUSED');const resumed=(owner as any).tasks.get(task.id);resumed.status='RUNNING';(owner as any).grants.add(task.id);(owner as any).save(resumed);const callsBeforeResume=f.requests.length;
  await (owner as any).finishUnitRecheck(resumed,resumed.items[0]);assert.equal(f.requests.length,callsBeforeResume,'saved actual image result resumes locally without more AI calls');const rechecked={workflow:flow.getProgress(ref.id)!};assert.equal(rechecked.workflow.status,'COMPLETED',rechecked.workflow.error??'actual recheck blocked');assert.equal(owner.get(task.id).items[0].unitRecheck,undefined);owner.pause(task.id);
  assert.equal(generated,before);assert.equal(rechecked.workflow.recheckedFromRunId,first.workflow.id);assert.deepEqual(rechecked.workflow.slots!.map(s=>({id:s.approvedAssetId,sha:s.approvedSha256})),images);assert.deepEqual(rechecked.workflow.candidateIds,candidateIds);
  assert.equal(JSON.stringify(workflowRuns(f.db,ref.id).find(run=>run.id===first.workflow.id)),old);for(const [table,rows] of oldRows)for(const row of rows)assert.equal(f.db.prepare('SELECT record_json FROM '+table+' WHERE id=?').get(row.id)?.record_json,row.record_json,'original '+table+' record remains exact');
  assert.ok(operations.includes('image-appearance-review'));assert.ok(operations.includes('image-text-review'));assert.equal(operations.filter(op=>op==='ImageModeration').length,14);
 }finally{await owner?.close();await flow.close();await generation.close();}
});
