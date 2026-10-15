// Controller-owned external fixtures. No application service or domain state stub.
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {authorizeNormalRoute} from './pipeline-normal-controller.mjs';
import {createFakeProvider} from './fake-http-provider.mjs';
import {materializeFixtures} from './pipeline-runtime.mjs';
import {sourceFixture,schemaFixture} from './pipeline-normal-draft.mjs';
import {normalChatResponse,normalDecisionResponse,normalPng} from './pipeline-normal-responses.mjs';
const {issue,sha}=createRequire(import.meta.url)('./pipeline-route-permit.cjs'),{assertTrustedWithin,worktreeRoot}=createRequire(import.meta.url)('./trusted-path.cjs');
export async function createNormalProvider({directory,fixtureDirectory}){
  const fixtures=await materializeFixtures(fixtureDirectory),source=sourceFixture(),schema=await schemaFixture('drink-coaster-us'),clock=new Date().toISOString();
  const keys={openrouter:'s10-normal-openrouter',deepseek:'s10-normal-deepseek',accessKeyId:'s10-normal-acs-id',accessKeySecret:'s10-normal-acs-secret',appKey:'s10-normal-mia-key',appSecret:'s10-normal-mia-secret'};
  const facts=[['产品类型','Drink coaster'],['材质','Silicone'],['颜色','Blue'],['净重','20 g'],['毛重','30 g'],['商品长度','9 cm'],['商品宽度','9 cm'],['商品高度','0.5 cm'],['包装长度','10 cm'],['包装宽度','10 cm'],['包装高度','1 cm'],['每包件数','1 pc'],['计价单位','每原包1件报价3.20元'],['原产国','China'],['电池要求','No']];
  source.detail.data.editCommonCollectBoxDetail.sourceAttrs=facts.map(([name,value])=>({name,value}));source.detail.data.editCommonCollectBoxDetail.skuMap.blue.weight='0.03';
  const mia={kind:'miaoshou',appKey:keys.appKey,appSecret:keys.appSecret,timestamp:String(Math.floor(Date.parse(clock)/1000))},token='s10-normal-amazon-token';
  const base='https://sellingpartnerapi-na.amazon.com',sellerId='S10SELLER',marketplaceId='ATVPDKIKX0DER',locale='en_US',auth={kind:'amazon',sellerId,sku:'S10-UNASSIGNED',accessToken:token,now:clock};
  const routes=[
    {id:'normal-openrouter-chat',method:'POST',path:'/normal/openrouter-chat',publicUrl:'https://openrouter.ai/api/v1/chat/completions',credential:{header:'authorization',value:'Bearer '+keys.openrouter}},
    {id:'normal-deepseek-chat',method:'POST',path:'/normal/deepseek-chat',publicUrl:'https://api.deepseek.com/chat/completions',credential:{header:'authorization',value:'Bearer '+keys.deepseek}},
    {id:'normal-decisions',method:'POST',path:'/normal/decisions',publicUrl:'https://openrouter.ai/api/alpha/decisions',credential:{header:'authorization',value:'Bearer '+keys.openrouter}},
    {id:'normal-images',method:'POST',path:'/normal/images',publicUrl:'https://openrouter.ai/api/v1/images',credential:{header:'authorization',value:'Bearer '+keys.openrouter}},
    {id:'normal-price',method:'GET',path:'/normal/price',publicUrl:'https://openrouter.ai/api/v1/images/models/openai/gpt-image-2.5-sunburst/endpoints',protocol:{kind:'openrouter-price',apiKey:keys.openrouter},response:{json:{id:'openai/gpt-image-2.5-sunburst',endpoints:[{provider_name:'Synthetic',provider_slug:'synthetic',pricing:[{billable:'output_image',unit:'image',cost_usd:0.02}]}]}}},
    {id:'normal-risk-token',method:'POST',path:'/normal/risk-token',publicUrl:'https://green-cip.cn-shanghai.aliyuncs.com/',protocol:{kind:'acs3',action:'DescribeUploadToken',version:'2022-03-02',contentType:'application/x-www-form-urlencoded',bodySha256:sha(Buffer.alloc(0)),accessKeyId:keys.accessKeyId,accessKeySecret:keys.accessKeySecret,now:clock,nonce:'s10-normal-nonce'}},
    {id:'normal-register',method:'POST',path:'/normal/register',credential:{header:'authorization',value:'Bearer s10-normal-controller'}},
    {id:'normal-source-list',method:'POST',path:'/normal/source-list',publicUrl:'https://openapi-erp.91miaoshou.com/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list',protocol:mia,response:{json:source.list}},
    {id:'normal-source-detail',method:'POST',path:'/normal/source-detail',publicUrl:'https://openapi-erp.91miaoshou.com/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail',protocol:mia,response:{json:source.detail}},
    {id:'normal-source-image',method:'GET',path:'/normal/source-image',publicUrl:'https://cbu01.alicdn.com/s10/blue-coaster.png',protocol:{kind:'public-source'},response:{bytes:await readFile(fixtures[0].absolutePath),contentType:'image/png'}},
    {id:'normal-lwa',method:'POST',path:'/normal/lwa',publicUrl:'https://api.amazon.com/auth/o2/token',protocol:{kind:'lwa',clientId:'s10-normal-client',clientSecret:'s10-normal-client-secret',refreshToken:'s10-normal-refresh'},response:{json:{access_token:token,token_type:'bearer',expires_in:3600}}},
    {id:'normal-library',method:'GET',path:'/normal/library',publicUrl:base+'/definitions/2020-09-01/productTypes?'+new URLSearchParams({marketplaceIds:marketplaceId,locale}),protocol:{...auth,operation:'library'},response:{json:{productTypes:[{name:'DRINK_COASTER',displayName:'Drink coaster',marketplaceIds:[marketplaceId]}]}}},
    {id:'normal-definition',method:'GET',path:'/normal/definition',publicUrl:base+'/definitions/2020-09-01/productTypes/DRINK_COASTER?'+new URLSearchParams({sellerId,marketplaceIds:marketplaceId,requirements:'LISTING',requirementsEnforced:'ENFORCED',parentageLevel:'NONE',locale,productTypeVersion:'LATEST'}),protocol:{...auth,operation:'definitions',productType:'DRINK_COASTER',parentageLevel:'NONE'},response:{json:schema.definition}},
    ...[['schema',schema.schema],['meta-schema',schema.metaSchema]].map(([id,item])=>({id:'normal-'+id,method:'GET',path:'/normal/'+id,publicUrl:item.url,protocol:{kind:'public-bytes'},response:{bytes:item.bytes,contentType:'application/json'}})),
  ];
  const responders=Object.fromEntries(['normal-openrouter-chat','normal-deepseek-chat'].map(id=>[id,({body,requestId})=>normalChatResponse(body,requestId)]));
  responders['normal-decisions']=({body,requestId})=>normalDecisionResponse(body,requestId);
  let imageCount=0,workspace,sequence=0;const permitAuthority={runId:'s10-'+randomUUID(),key:'s10-'+randomBytes(32).toString('hex')},registered=new Set(),imageTexts=new Map();
  responders['normal-images']=({body,requestId})=>{const request=JSON.parse(body);if(request.model!=='openai/gpt-image-2.5-sunburst'||imageCount>=7)return {status:422,json:{error:{message:'S10_IMAGE_FIXTURE_SCOPE'}}};imageTexts.set(requestId,imageCount===1?'9 cm':null);return {json:{id:requestId,created:Math.floor(Date.parse(clock)/1000),data:[{b64_json:normalPng(++imageCount).toString('base64')}],usage:{cost:0.013}}};};
  responders['normal-risk-token']=()=>({json:{Code:200,Data:{AccessKeyId:'s10-temporary-id',AccessKeySecret:'s10-temporary-secret',SecurityToken:'s10-temporary-token',BucketName:'s10-normal-bucket',FileNamePrefix:'s10/',OssInternetEndPoint:'https://oss-cn-shanghai.aliyuncs.com',Expiration:Date.parse(clock)/1000+1800}}});
  responders['normal-register']=async({body})=>{try{const authorized=await authorizeNormalRoute({workspace,config:provider.normalConfig,provider,input:JSON.parse(body)});if(!registered.has(authorized.route.id)){provider.register(authorized.route,()=>authorized.response);registered.add(authorized.route.id);}return {json:issue(permitAuthority,++sequence,authorized.route,authorized.headers,authorized.bytes)};}catch(error){return {status:403,json:{error:'S10_CONTROLLER_DENIED',reason:error.code??String(error.message).slice(0,150)}};}};
  const provider=await createFakeProvider({directory,routes:routes.map(route=>route.publicUrl?({...route,native:true}):route),responders,ftp:true,maxRequestBytes:32*1024*1024});
  return Object.assign(provider,{permitAuthority,normalImageText:id=>imageTexts.get(id)??'',bindWorkspace(root){assertTrustedWithin(worktreeRoot,root);if(workspace)throw Error('S10_CONTROLLER_ALREADY_BOUND');workspace=root;},normalConfig:{version:1,clock,nonce:'s10-normal-nonce',keys,remoteId:source.remoteId,ftp:provider.ftp,registerUrl:provider.origin+'/normal/register',staticRequests:routes.filter(route=>route.publicUrl).map(route=>({url:route.publicUrl,method:route.method,action:route.protocol?.action})),amazon:{name:'S10 synthetic U2',sellerId,marketplaceId,region:'na',locale,clientId:'s10-normal-client',clientSecret:'s10-normal-client-secret',refreshToken:'s10-normal-refresh'}}});
}
