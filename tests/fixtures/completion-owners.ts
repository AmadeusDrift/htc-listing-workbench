import { confirmSourceConsistencyFixture } from '../helpers/source-consistency-proof.ts';
import {UserFacingError} from '../../src/shared/errors.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { TestContext } from 'node:test';
import { WorkspaceStore } from '../../src/main/store.ts';
import { HostingService } from '../../src/main/hosting/service.ts';
import { AmazonService } from '../../src/main/amazon/service.ts';
import { AiService } from '../../src/main/ai/service.ts';
import { ListingAiService } from '../../src/main/listing-ai/service.ts';
import { ImageWorkflowService } from '../../src/main/image-workflow/service.ts';
import { AutomaticListingService } from '../../src/main/automatic-listing/service.ts';
import type { AutomaticListingDependencies } from '../../src/main/automatic-listing/service.ts';
import { defaultListingRules } from '../../src/shared/listing-rules.ts';
import { imageWorkflowDraftStamp } from '../../src/main/image-workflow/records.ts';
import { mockStorage, saveInput, chat, candidateFor, reviewFor } from './listing-ai.ts';

export function originalPng():Buffer {
  const crc=(data:Buffer)=>{let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(32,0);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;const pixels=Buffer.alloc(32*97,190);for(let y=0;y<32;y++)pixels[y*97]=0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
/** All source files and SQLite state are real; only network responses and unrelated downstream work are injected. */
export async function completionOwnerFixture(t:TestContext,owner:'automatic'|'images',color=false,optionalClosure=false){
  t.mock.method(globalThis,'fetch',()=>{throw new Error('No external network permitted');});
  const boundary=resolve('.test-data');mkdirSync(boundary,{recursive:true});const root=mkdtempSync(join(boundary,'field-owner-')),directory=join(root,'workspace'),store=new WorkspaceStore(directory);
  let product=store.createProduct();product=store.saveProduct({...saveInput(product),title:'Coaster',variants:saveInput(product).variants.map(v=>({...v,originalSpec:color?'602Q':'Blue',normalizedSpec:color?'':'Blue'})),facts:[{id:randomUUID(),name:'材质',value:'硅胶',source:'manual',sourceRef:'fixture',state:'human_confirmed'},{id:randomUUID(),name:'产品类型',value:'Coaster',source:'manual',sourceRef:'fixture',state:'human_confirmed'}]});
  if(optionalClosure)product=store.saveProduct({...saveInput(product),facts:[...product.facts,{id:randomUUID(),name:'closure',value:'Zipper',source:'manual',sourceRef:'fixture',state:'human_confirmed'}]});
  const png=originalPng(),assetId=randomUUID();mkdirSync(join(directory,'assets'),{recursive:true});writeFileSync(join(directory,'assets',assetId+'.png'),png);writeFileSync(join(directory,'assets',assetId+'.preview.png'),png);
  product=store.addAssets({productId:product.id,revision:product.revision},[{id:assetId,fileName:'original.png',mimeType:'image/png',width:32,height:32,byteSize:png.length,originalPath:'assets/'+assetId+'.png',previewPath:'assets/'+assetId+'.preview.png',sha256:createHash('sha256').update(png).digest('hex')}]);
  product=store.updateAsset({productId:product.id,revision:product.revision,assetId,role:'main',variantIds:[product.variants[0].id]});
  await confirmSourceConsistencyFixture(directory,store,product.id);
  const field={type:'array',items:{type:'object',properties:{value:{type:'string'},marketplace_id:{type:'string'},language_tag:{type:'string'}},required:['value'],additionalProperties:false}};
  const schema={$schema:'https://json-schema.org/draft/2019-09/schema',type:'object',properties:{item_name:field,material:field,color:field,...(optionalClosure?{closure:field}:{})},required:[],additionalProperties:true};
  const meta={$id:'https://schemas.amazon.com/selling-partners/definitions/product-types/meta-schema/v1',$schema:schema.$schema,type:['object','boolean']};
  const link=(name:string,data:unknown)=>({link:{verb:'GET',resource:'https://fixture.s3.amazonaws.com/'+name+'.json'},checksum:createHash('md5').update(JSON.stringify(data)).digest('base64')});
  let previewFail=false,previews=0;const requests:any[]=[];
  const amazon=new AmazonService(directory,id=>store.getProduct(id),mockStorage,{resolveAddresses:async()=>['52.0.0.1'],sleep:async()=>{},fetch:async(input,init={})=>{
    const url=new URL(String(input));
    if(url.hostname==='api.amazon.com')return new Response(JSON.stringify({access_token:'fixture_access',token_type:'bearer',expires_in:3600}));
    if(url.hostname==='fixture.s3.amazonaws.com')return new Response(JSON.stringify(url.pathname==='/meta.json'?meta:schema));
    if(url.pathname.includes('/productTypes/'))return new Response(JSON.stringify({marketplaceIds:['ATVPDKIKX0DER'],productType:'COASTER',locale:'en_US',requirements:'LISTING',requirementsEnforced:'ENFORCED',productTypeVersion:{version:'fixture-v1'},propertyGroups:{},schema:link('schema',schema),metaSchema:link('meta',meta)}));
    if(!url.pathname.includes('/listings/')||init.method!=='PUT'||url.searchParams.get('mode')!=='VALIDATION_PREVIEW')throw new Error('Only validation previews permitted');
    previews++;if(previewFail)throw new Error('Injected preview network failure');const attributes=JSON.parse(String(init.body)).attributes,missingField=optionalClosure?'closure':color&&!attributes.color?'color':'material',missing=!attributes[missingField];
    return new Response(JSON.stringify({sku:decodeURIComponent(url.pathname.split('/').at(-1)!),status:missing?'INVALID':'VALID',submissionId:'fixture-preview',issues:missing?[{code:'90220',message:'Missing '+missingField,severity:'ERROR',attributeNames:[missingField]}]:[]}));
  }});
  const target=await amazon.importCredentials({name:'Isolated fixture',sellerId:'FIXTURE_SELLER',marketplaceId:'ATVPDKIKX0DER',region:'na',locale:'en_US',clientId:'fixture_client',clientSecret:'fixture_secret',refreshToken:'fixture_refresh'});
  let draft=await amazon.createDraft({targetId:target.id,productId:product.id,variantId:product.variants[0].id,productType:'COASTER',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
  const attributes:import('../../src/shared/amazon-contracts.ts').JsonObject={...draft.attributes,item_name:[{value:'Blue Silicone Coaster',marketplace_id:target.marketplaceId,language_tag:'en_US'}]};delete attributes.material;if(optionalClosure)delete attributes.closure;if(color)delete attributes.color;draft=amazon.saveDraft({id:draft.id,revision:draft.revision,attributes});
  if(color)draft=await amazon.previewDraft({id:draft.id,revision:draft.revision});
  const hosting=new HostingService(directory,store,mockStorage);let response=(p:any):Response|Promise<Response>=>chat(p.operation==='source-color'?{kind:'source-color',verdict:'DETERMINED',colors:['Blue'],reason:'Visible blue product body',referenceAssetIds:p.referenceImages.map((r:any)=>r.assetId)}:p.candidate?reviewFor(p):candidateFor(p));
  const ai=new AiService(directory,store,hosting,mockStorage,{fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body)),content=body.messages[1].content,p=JSON.parse(typeof content==='string'?content:content[0].text);requests.push(p);return response(p);}});
  ai.saveConnection({id:'deepseek',apiKey:'fixture-only'});ai.saveFunctionSettings({id:'deepseek',model:'deepseek-flash',enabled:true});ai.saveFunctionSettings({id:'deepseek-review',model:'deepseek-v4-pro',enabled:true});
  const listing=new ListingAiService(store,amazon,ai,()=>false),reference=()=>({draftId:draft.id,draftRevision:amazon.getDraft(draft.id).revision});
  let images:ImageWorkflowService|undefined,automatic:AutomaticListingService|undefined,taskId:string|undefined;
  const profile={id:'alpha',name:'Alpha',generation:1,enabled:true,configured:true,host:'ftp.example.test',port:21,secure:true,remoteRoot:'/',publicBaseUrl:'https://images.example.test/'};
  const prior={id:randomUUID(),draftId:draft.id,status:'COMPLETED',stage:'complete',attempt:7,approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64),slots:Array.from({length:7},(_,i)=>({index:i+1,status:'PASSED',approvedAssetId:randomUUID(),approvedSha256:'a'.repeat(64)}))};
  const child:any={id:randomUUID(),status:'NEEDS_ATTENTION',items:[{draftId:draft.id,submitStarted:false,steps:[]}]};
  const dependencies={store,rules:()=>defaultListingRules(),amazon,hosting:{getProfile:()=>profile},images:{getProgress:()=>prior,cancel:()=>({cancelled:false}),cancelSources:()=>({cancelled:false})},
    execution:{get:()=>child,list:()=>[child]},followup:{},procurement:{},labels:{},
    beginFieldRepair:()=>listing.beginCompletion(reference()).id,repairFields:(_id:string,signal:AbortSignal,operationId?:string)=>listing.complete(reference(),signal,operationId),
    recheckImage:async()=>{throw new Error('Downstream image recheck sentinel');}} as unknown as AutomaticListingDependencies;
  const openOwner=async()=>{
    if(owner==='images'){
      const imageAi=new Proxy(ai,{get(target,key){if(key==='getProfile')return(id:string)=>({...target.getProfile(id),enabled:true,configured:true});if(key==='imagePlan'||key==='recognize')return async()=>{throw new UserFacingError('Downstream image plan sentinel');};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
      images=new ImageWorkflowService(directory,store,amazon,imageAi,{getConnection:()=>({configured:true,enabled:true}),configurationScope:()=> 'fixture-generator'} as any,{listing});images.saveRiskSettings({enabled:false});images.saveCopyReviewSettings({enabled:false});
    }else{
      automatic=new AutomaticListingService(directory,dependencies);
      if(!taskId){const task=await automatic.create({productIds:[product.id],targetId:target.id,productType:'COASTER',profileId:'alpha'});taskId=task.id;const stored=(automatic as any).tasks.get(taskId),row=stored.items[0];Object.assign(row,{sourcesPrepared:true,stage:'IMAGES',draftId:draft.id,imageStarted:true,imageAttempts:1,executionTaskIds:[child.id],repair:{phase:'FIELDS_PENDING',sourceWorkflowId:prior.id,draftRevision:draft.revision,draftStamp:imageWorkflowDraftStamp(draft)}});(automatic as any).save(stored);}
    }
  };
  const closeOwner=async()=>{await images?.close();images=undefined;await automatic?.close();automatic=undefined;};await openOwner();
  t.after(async()=>{await closeOwner();await ai.close();await hosting.close();amazon.close();store.close();if(!root.startsWith(boundary+'\\')&&!root.startsWith(boundary+'/'))throw new Error('Unsafe fixture cleanup');rmSync(root,{recursive:true,force:true});});
  return {root,directory,store,amazon,ai,listing,draft,product,target,requests,reference,child,previewFailure:(value:boolean)=>{previewFail=value;},previews:()=>previews,respond:(fn:typeof response)=>{response=fn;},reopen:async()=>{await closeOwner();await openOwner();},
    run:async()=>{if(images){const value=await images.complete(reference());if(value.workflow.error)throw new Error(value.workflow.error);return value;}const task=(automatic as any).tasks.get(taskId);task.status='RUNNING';(automatic as any).grants.add(task.id);(automatic as any).controller=new AbortController();try{return await (automatic as any).finishRepair(task,task.items[0]);}finally{task.status='PAUSED';(automatic as any).save(task);}},
    classifyFailure:async()=>{const task=(automatic as any).tasks.get(taskId);await (automatic as any).classifyFailure(task,task.items[0]);return task.items[0].outcome;},
    progress:()=>images?.getProgress(draft.id)??automatic!.get(taskId!).items[0],queue:()=>automatic?.queue({productIds:[product.id],targetId:target.id})};
}
