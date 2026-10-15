import { createHash,randomUUID } from 'node:crypto';
import { fixture,saveInput } from './listing-ai.ts';
import { SkuNamingService } from '../../src/main/sku-naming/service.ts';
import { realAmazonSchema } from './amazon/schema-fixture.ts';
import { defaultListingRules } from '../../src/shared/listing-rules.ts';
import { applyBusinessRules } from '../../src/main/amazon/business-rules.ts';
import { openDatabase } from '../../src/main/database.ts';
import {AutomaticListingService} from '../../src/main/automatic-listing/service.ts';
import type {AutomaticListingDependencies} from '../../src/main/automatic-listing/service.ts';
import {sourceStamp,validateAutomaticListingTask} from '../../src/main/automatic-listing/records.ts';
import {fingerprint} from '../../src/main/execution/records.ts';
import {readListingRules} from '../../src/main/listing-rules.ts';
import {DEFAULT_ITEM_LABEL_FORMAT} from '../../src/shared/item-label-contracts.ts';

export async function oldKit(t:any){
 const f=await fixture(t),p=f.store.saveProduct({...saveInput(f.product),title:'过滤网支架',facts:[...f.product.facts,{id:randomUUID(),name:'采购币种',value:'CNY',state:'human_confirmed',source:'manual',sourceRef:'fixture'}],variants:saveInput(f.product).variants.map(v=>({...v,normalizedSpec:'',originalSpec:'黄色 / 支架+贴片+50只过滤网',purchasePrice:'8.2'}))});
 const v=p.variants[0],c={variantId:v.id,sourceKey:v.id,sourceSku:v.sku,specification:v.originalSpec,color:'Yellow',quantity:50,quotedCostCny:8.2,piecesPerQuote:50,sourcePackPieces:50};
 const key=createHash('sha256').update(JSON.stringify([[v.id,50]])).digest('hex'),recipe={key,groupKey:'a'.repeat(64),specification:v.originalSpec+' · 50 pc',color:'Yellow',components:[c],totalPieces:50,totalCostCny:8.2};
 const naming=new SkuNamingService(f.directory),target=f.amazon.listTargets()[0],sourceGroupKey=`local:${p.id}:${recipe.groupKey}`;
 const group=naming.allocate({storeScope:JSON.stringify([target.mode,target.sellerId]),storeCode:'U2',sourceGroupKey,collectedAt:p.createdAt,childKeys:[key]});naming.close();
 const plan={namingGroupId:group.id,sourceGroupKey,collectedAt:group.collectedAt,collectionBasis:'first_import' as const,sku:group.children[0].sku,baseSku:group.baseSku,recipe,parentage:'NONE' as const,parentSku:null,variationTheme:null,relationReason:'历史独立套装',familyResolved:true,namingChildKey:key};
 const db=openDatabase(f.directory),rules=defaultListingRules();rules.pricing.maxPrice=100;rules.pricing.promoEnabled=false;db.prepare('INSERT OR REPLACE INTO amazon_settings VALUES(?,?)').run('listing_rules_v1',JSON.stringify(rules));
 const schema={...realAmazonSchema(),...{targetId:target.id,mode:target.mode,key:f.draft.schema.key}},normal={...p,title:'普通夹子',variants:[{...v,originalSpec:'50 pc'}]};
 const result=applyBusinessRules({product:normal,variant:normal.variants[0],target,schema,attributes:{},measurements:{},costCny:8.2,saleUnit:{...recipe,components:[{...c,specification:'50pc'}]},packageMatchesSaleUnit:true,now:new Date()},rules);
 const persistence=(f.amazon as any).persistence,r=persistence.record(f.draft.id);Object.assign(r.draft,{productRevision:p.revision,sku:plan.sku,salesPlan:plan,listingProgram:'haul',schema,attributes:result.attributes,businessRules:result.report});r.previewResponse={history:'keep preview'};persistence.putRecord(r);
 db.close();return {...f,p,plan,db:persistence.db,persistence,ref:{id:r.draft.id,revision:r.draft.revision}};
}
export async function taskKit(t:any){
 const f=await oldKit(t),draft=f.amazon.getDraft(f.ref.id),target=f.amazon.getTarget(draft.targetId),profile={id:'fixture',enabled:true,configured:true},at=new Date().toISOString();
 const task={id:randomUUID(),revision:1,status:'PAUSED',targetId:target.id,targetName:target.name,sellerId:target.sellerId,marketplaceId:target.marketplaceId,mode:target.mode,targetStamp:fingerprint(f.amazon.executionTargetScope(target.id)),profileId:profile.id,profileStamp:fingerprint(profile),rulesStamp:fingerprint(readListingRules(f.db)),ruleRevision:readListingRules(f.db).revision,productType:draft.schema.productType,locale:draft.schema.locale,labelFormat:DEFAULT_ITEM_LABEL_FORMAT,createdAt:at,updatedAt:at,error:'历史计量待核对',items:[{key:f.p.id+':'+f.plan.recipe.key,productId:f.p.id,productRevision:f.p.revision,sourceStamp:sourceStamp(f.p),productTitle:f.p.title,variantId:f.p.variants[0].id,sku:f.plan.sku,stockSets:5,sourcesPrepared:true,status:'FAILED',stage:'DRAFT',draftId:draft.id,executionTaskIds:[],imageStarted:false,imageAttempts:0,repairAttempts:0,repair:null,batchId:null,error:'历史计量待核对',salesPlan:f.plan}]};
 f.db.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(task.id,JSON.stringify(validateAutomaticListingTask(task)));
 const deps={store:f.store,amazon:f.amazon,rules:()=>readListingRules(f.db),hosting:{getProfile:()=>profile},images:{getProgress:()=>null},execution:{list:()=>[]},followup:{},procurement:{},labels:{}} as unknown as AutomaticListingDependencies;
 const owner=new AutomaticListingService(f.directory,deps);return {...f,owner,task:owner.get(task.id),deps};
}
