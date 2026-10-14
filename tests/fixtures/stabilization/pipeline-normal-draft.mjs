// Preparation only. This inventory neither installs a network policy nor runs a
// business worker. Responses model external wire payloads, never domain records.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const marketplaceId='ATVPDKIKX0DER',locale='en_US';
const sp='https://sellingpartnerapi-na.amazon.com',miaoshou='https://openapi-erp.91miaoshou.com';
const ptd='https://selling-partner-definitions-prod-iad.s3.amazonaws.com/schema/s10/';
const hash=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest(algorithm==='md5'?'base64':'hex');
function identity(value){assert.ok(typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value),'S10_FIXTURE_IDENTITY');return value;}
function immutable(value){if(value&&typeof value==='object'){for(const part of Object.values(value))immutable(part);Object.freeze(value);}return value;}
function query(path,values){return path+'?'+new URLSearchParams(values);}
const tokenAuth={kind:'amazon-lwa-token',headers:['x-amz-access-token','x-amz-date'],validation:'WIP: exact synthetic token/date before forwarding; transport uses no AWS SigV4'};
const acsAuth=(action,version)=>({kind:'acs3',action,version,headers:['host','x-acs-action','x-acs-version','x-acs-content-sha256','x-acs-date','x-acs-signature-nonce','authorization'],validation:'WIP: independently recompute ACS3 canonical signature over original URI and frozen bytes'});

export function normalPlan({sellerId,skus,productType='DRINK_COASTER',parentageLevel='NONE'}={}){
  identity(sellerId);assert.ok(Array.isArray(skus)&&skus.length&&skus.length<=4&&new Set(skus).size===skus.length);skus.forEach(identity);
  assert.ok(['DRINK_COASTER','FIGURINE'].includes(productType));assert.ok(['NONE','PARENT','CHILD'].includes(parentageLevel));
  const routes=[],add=(id,method,url,auth)=>routes.push({id,method,url,auth});
  const miaAuth={kind:'miaoshou-hmac',headers:['x-app-key','x-timestamp','x-sign'],validation:'WIP: secret+path+timestamp+appKey+rawBody+secret HMAC; exact synthetic credential only'};
  add('source-list','POST',miaoshou+'/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list',miaAuth);
  add('source-detail','POST',miaoshou+'/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail',miaAuth);
  add('source-image','GET','https://cbu01.alicdn.com/s10/blue-coaster.png',{kind:'none'});
  add('deepseek-chat','POST','https://api.deepseek.com/chat/completions',{kind:'synthetic-bearer',purpose:'DeepSeek only'});
  add('openrouter-chat','POST','https://openrouter.ai/api/v1/chat/completions',{kind:'synthetic-bearer',purpose:'exact OpenRouter key'});
  add('category-decisions','POST','https://openrouter.ai/api/alpha/decisions',{kind:'synthetic-bearer',purpose:'exact OpenRouter key'});
  add('image-generation','POST','https://openrouter.ai/api/v1/images',{kind:'synthetic-bearer',purpose:'exact OpenRouter key'});
  add('ocr','POST','https://ocr-api.cn-hangzhou.aliyuncs.com/?Type=Commerce',acsAuth('RecognizeAllText','2021-07-07'));
  add('risk-token','POST','https://green-cip.cn-shanghai.aliyuncs.com/',acsAuth('DescribeUploadToken','2022-03-02'));
  add('risk-moderation','POST','https://green-cip.cn-shanghai.aliyuncs.com/',acsAuth('ImageModeration','2022-03-02'));
  add('lwa','POST','https://api.amazon.com/auth/o2/token',{kind:'synthetic-form',keys:['grant_type','client_id','client_secret','refresh_token'],validation:'WIP: exact values and duplicates rejected; no arbitrary credentials'});
  add('category-library','GET',query(sp+'/definitions/2020-09-01/productTypes',{marketplaceIds:marketplaceId,locale}),tokenAuth);
  add('schema-definition','GET',query(sp+'/definitions/2020-09-01/productTypes/'+productType,{sellerId,marketplaceIds:marketplaceId,requirements:'LISTING',requirementsEnforced:'ENFORCED',parentageLevel,locale,productTypeVersion:'LATEST'}),tokenAuth);
  const fixture=productType==='DRINK_COASTER'?'drink-coaster-us':'figurine-parent-us';
  add('schema-download','GET',ptd+fixture+'/schema.json',{kind:'none'});
  add('meta-schema-download','GET',ptd+fixture+'/meta-schema.json',{kind:'none'});
  for(const [i,sku] of skus.entries()){
    const path=sp+`/listings/2021-08-01/items/${sellerId}/${sku}`,base={marketplaceIds:marketplaceId,issueLocale:locale};
    add('preview-'+i,'PUT',query(path,{...base,mode:'VALIDATION_PREVIEW',includedData:'issues'}),tokenAuth);
    add('submit-'+i,'PUT',query(path,{...base,includedData:'issues'}),tokenAuth);
    add('readback-'+i,'GET',query(path,{...base,includedData:'summaries,issues,attributes,offers,fulfillmentAvailability,relationships'}),tokenAuth);
  }
  return immutable({version:'s10-normal-draft/v1',listingProgram:'haul',normalExecutable:false,finalIntegrationPassed:false,protocolPolicyInstalled:false,routes,
    dynamicRegistrations:[{kind:'oss4',reason:'Exact bucket/prefix/candidate UUID from owned token/intent, region cn-shanghai; freeze PUT body hash/MD5/token/date/OSS4 signature. Never prefix-allow arbitrary object.'},{kind:'hosting-public-get',reason:'Exact HostingService path registered only after owned FTP STOR ledger; return actual uploaded bytes, not generated response substitute.'}],
    blockers:[{owner:'S10',reason:'Current foundation rejects query/non-Bearer credentials. Exact protocol policy + pre-send auth validation not installed. Source/schema/public probe strict resolver mapping also pending.'},{owner:'S03',reason:'Full-schema judge rejection provenance/six-layer outcome contracts not merged.'},{owner:'S04',reason:'Invocation snapshot/multipurpose model routing not frozen.'},{owner:'S05',reason:'Paid child-effect intents/partial checkpoint/result-saved-before-linked injection seams not merged.'},{owner:'S07-alias',reason:'Alias/old-unknown preserved scope identities not merged.'},{owner:'S08',reason:'Task begin/pause/cancel atomic side-effect holds not merged.'},{owner:'S09',reason:'Domain report valid/rejected separation + task stream views not merged.'}],
    requiredAssertions:['Real source receipt and full schema bytes','Real completion methods with seven distinct call/candidate/asset links','Risk/OCR/copy/appearance original result ownership','Actual FTP bytes/hash and public GET equality','Preview VALID, formal ACCEPTED, readback BUYABLE separate','Procurement bound to original SKU/sales unit/family observation','No task completion or image approval fixture mutation','External controller ledger survives worker restart/old backup; fees/UNKNOWN locks retained']});
}

// Exact lexical URI/method matching for review/unit tests only. This is not the
// installed guard and intentionally does not claim authentication validation.
export function matchExactRoute(routes,{id,method,url}){
  assert.ok(typeof url==='string'&&new URL(url).href===url,'S10_EXACT_ROUTE');
  const row=routes.find(route=>route.id===id&&route.method===method&&route.url===url);
  assert.ok(row,'S10_EXACT_ROUTE');return row;
}

export async function schemaFixture(name){
  assert.ok(['drink-coaster-us','figurine-parent-us'].includes(name),'S10_SCHEMA_FIXTURE');
  const root=new URL('../amazon/'+name+'/',import.meta.url);
  const [bytes,metaBytes,contextBytes]=await Promise.all(['schema.json','meta-schema.json','context.json'].map(file=>readFile(new URL(file,root))));
  const context=JSON.parse(contextBytes),schemaResource=ptd+name+'/schema.json',metaResource=ptd+name+'/meta-schema.json';
  return {schema:{url:schemaResource,bytes,sha256:hash('sha256',bytes)},metaSchema:{url:metaResource,bytes:metaBytes,sha256:hash('sha256',metaBytes)},definition:{
    productType:context.productType,marketplaceIds:[context.marketplaceId],requirements:context.requirements,requirementsEnforced:'ENFORCED',locale:context.locale,productTypeVersion:{version:context.version},propertyGroups:context.propertyGroups,
    schema:{link:{verb:'GET',resource:schemaResource},checksum:hash('md5',bytes)},metaSchema:{link:{verb:'GET',resource:metaResource},checksum:hash('md5',metaBytes)}}};
}

export function sourceFixture(){
  const remoteId='91015000000000001',sources=[{sourceItemId:'910150000001',source:'1688',sourceSite:'1688.com',sourceItemUrl:'https://detail.1688.com/offer/910150000001.html'}];
  const detail={result:'success',code:'success',data:{editCommonCollectBoxDetail:{commonCollectBoxDetailId:remoteId,title:'Blue silicone drink coaster',itemNum:'S10-SUPPLIER',notesText:'Synthetic isolated source. One coaster per quoted package.',notes:'',sourceAttrs:[{name:'产品类型',value:'Drink coaster'},{name:'材质',value:'Silicone'},{name:'颜色',value:'Blue'}],price:'3.20',stock:'100',imgUrls:['https://cbu01.alicdn.com/s10/blue-coaster.png'],colorPropName:'颜色',colorMap:{blue:{name:'Blue',imgUrls:['https://cbu01.alicdn.com/s10/blue-coaster.png']}},sizePropName:'',sizeMap:{},saleProp3Name:'',saleProp3Map:{},skuMap:{blue:{itemNum:'S10-SUPPLIER-BLUE',price:'3.20',oriPrice:'3.20',stock:'100',oriStock:'100',weight:'0.04',packageLength:'10',packageWidth:'10',packageHeight:'1'}},sourceList:sources}}};
  return {remoteId,detail,list:{result:'success',code:'success',data:{detailList:[{commonCollectBoxDetailId:remoteId,title:detail.data.editCommonCollectBoxDetail.title,minSkuPrice:'3.20',maxSkuPrice:'3.20',gmtModified:'2026-10-15 00:00:00',status:'NORMAL',sourceList:sources}],total:1}}};
}

export function listingReply(kind,{sku,marketplaceId:market=marketplaceId,parentSku,variationTheme}={}){
  identity(sku);assert.equal(market,marketplaceId);assert.ok(['preview','submit','readback'].includes(kind));
  if(kind!=='readback')return {sku,status:kind==='preview'?'VALID':'ACCEPTED',submissionId:'s10-'+kind+'-'+sku,issues:[]};
  if(parentSku){identity(parentSku);assert.ok(typeof variationTheme==='string'&&/^[A-Z_]+$/.test(variationTheme));}
  return {sku,summaries:[{marketplaceId:market,asin:'B0S10TEST01',status:['BUYABLE','DISCOVERABLE']}],issues:[],relationships:parentSku?[{marketplaceId:market,relationships:[{type:'VARIATION',parentSkus:[parentSku],variationTheme:{theme:variationTheme,attributes:[]}}]}]:[]};
}
