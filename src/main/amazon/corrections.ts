import {validateCorrectionRecord} from './correction-record.ts';
import {createHash,randomUUID} from 'node:crypto';
import type {AmazonSchema,AmazonTarget,JsonObject,JsonValue} from '../../shared/amazon-contracts.ts';
import type {ListingCorrection,ListingCorrectionAttempt,ListingCorrectionState} from '../../shared/listing-correction-contracts.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {AmazonPersistence} from './persistence.ts';
import type {DraftRecord} from './persistence.ts';
import {AmazonTransportError} from './transport.ts';
import type {AmazonTransport} from './transport.ts';
import {isObject,listingHash} from './context.ts';
import {semanticJson} from './preparation.ts';
import {validateAttributes} from './schema.ts';
import {deterministicFieldCorrections} from './correction-rules.ts';
import {resolveSchemaNode} from './field-catalog.ts';

export const correctionHash=(v:unknown)=>createHash('sha256').update(semanticJson(v as JsonValue)).digest('hex');
const matchingField=(left:JsonObject,right:JsonObject,field:string)=>Object.hasOwn(left,field)===Object.hasOwn(right,field)&&(!Object.hasOwn(left,field)||correctionHash(left[field])===correctionHash(right[field]));
function fail(message:string):never {throw new UserFacingError(message);}
const readableIssues=(value:unknown)=>Array.isArray(value)&&value.every(i=>isObject(i)&&typeof i.code==='string'&&!!i.code.trim()&&typeof i.message==='string'&&!!i.message.trim()&&['ERROR','WARNING','INFO'].includes(String(i.severity)));
const stamp=(r:DraftRecord)=>correctionHash({id:r.draft.id,revision:r.draft.revision,productId:r.draft.productId,variantId:r.draft.variantId,sku:r.draft.sku,sellerId:r.draft.sellerId,marketplaceId:r.draft.marketplaceId,targetId:r.draft.targetId,attributes:r.draft.attributes,schema:r.draft.schema,submittedAt:r.draft.submittedAt,submissionId:r.draft.submissionId,submitResponse:r.submitResponse,request:r.request});
const targetStamp=(t:AmazonTarget)=>correctionHash({id:t.id,sellerId:t.sellerId,marketplaceId:t.marketplaceId,region:t.region,locale:t.locale,mode:t.mode});
export function trustedAccepted(r:DraftRecord):boolean {
 const a=r.submitResponse;return !!r.draft.submittedAt&&!r.unresolvedWrite&&r.draft.state!=='UNKNOWN'&&r.draft.state!=='SUBMITTING'&&!!a&&a.status==='ACCEPTED'&&a.sku===r.draft.sku&&typeof a.submissionId==='string'&&!!a.submissionId&&a.submissionId===r.draft.submissionId&&(a.issues===undefined||Array.isArray(a.issues)&&!a.issues.some(i=>isObject(i)&&i.severity==='ERROR'));
}
/** This first correction supports exactly a self package edge, never arbitrary edits. */
export function selfPackageDeletion(attributes:JsonObject,sku:string,marketplaceId:string,schema?:AmazonSchema){
 const edges=attributes.package_contains_sku;
 if(!Array.isArray(edges)||edges.length!==1||!isObject(edges[0])||edges[0].sku!==sku||edges[0].marketplace_id!==marketplaceId)fail('仅支持一个已核实的 package_contains_sku 自引用；其他包装关系请另行核对');
 if(Object.keys(edges[0]).some(k=>!['sku','marketplace_id','quantity'].includes(k)))fail('包装关系包含尚未支持的 selector，未生成修正');
 if(schema){const props=schema.schema.properties;if(!isObject(props)||!isObject(props.package_contains_sku))fail('当前 Schema 未定义包装关系');const node=resolveSchemaNode(schema.schema,props.package_contains_sku);if(!Array.isArray(node.selectors)||node.selectors.length!==2||!node.selectors.includes('sku')||!node.selectors.includes('marketplace_id'))fail('当前 Schema 的包装关系 selectors 不受此修正支持');}
 const after=structuredClone(attributes);delete after.package_contains_sku;
 return {after,patch:{op:'delete',path:'/attributes/package_contains_sku',value:[structuredClone(edges[0])]} as JsonObject};
}
interface Hooks {active:(id:string)=>AmazonTarget;schema:(record:DraftRecord)=>Promise<AmazonSchema>;api:AmazonTransport['api'];now?:()=>number}
export class ListingCorrections {
 private busy=new Set<string>();private p:AmazonPersistence;private hooks:Hooks;
 constructor(p:AmazonPersistence,hooks:Hooks){this.p=p;this.hooks=hooks;}
 private at(){return new Date((this.hooks.now??Date.now)()).toISOString();}
 get(id:string):ListingCorrection {const row=this.p.db.prepare('SELECT record_json FROM listing_corrections WHERE id=?').get(id);if(!row)fail('原 SKU 修正记录不存在');return validateCorrectionRecord(JSON.parse(String(row.record_json)));}
 list(draftId:string):ListingCorrection[]{return this.p.db.prepare('SELECT record_json FROM listing_corrections WHERE draft_id=? ORDER BY rowid DESC').all(draftId).map(r=>validateCorrectionRecord(JSON.parse(String(r.record_json))));}
 private save(c:ListingCorrection){validateCorrectionRecord(c);c.updatedAt=this.at();this.p.db.prepare('INSERT INTO listing_corrections(id,draft_id,listing_hash,record_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(c.id,c.draftId,c.listingHash,JSON.stringify(c));}
 private reference(raw:unknown):ListingCorrection {if(!isObject(raw)||Object.keys(raw).some(k=>!['id','revision','patchHash'].includes(k))||typeof raw.id!=='string')fail('修正参数仅允许编号、版本和补丁指纹');const c=this.get(raw.id);if(c.revision!==raw.revision||c.patchHash!==raw.patchHash)fail('修正版本已变化，请重新加载');return c;}
 private active(c:ListingCorrection){const t=this.hooks.active(c.targetId);if(this.p.generation(c.targetId)!==c.generation||targetStamp(t)!==c.targetStamp)fail('店铺配置已变化，修正授权失效');return t;}
 private original(c:ListingCorrection){const r=this.p.record(c.draftId);if(stamp(r)!==c.draftStamp)fail('原 SKU 提交身份或历史已变化');this.eligible(r,c.id);return r;}
 private eligible(r:DraftRecord,ownId?:string){
  const d=r.draft;if(d.mode!=='live'||!trustedAccepted(r))fail('原提交必须具有可信 ACCEPTED 回执；未知提交不能修正');
  if(d.schema.parentageLevel!=='NONE'||d.salesPlan&&(!d.salesPlan.familyResolved||d.salesPlan.parentage!=='NONE'))fail('需人工处理复杂父子关系；仅支持已确认独立销售 SKU 的局部修正');
  const hash=listingHash(d,d.sku),lock=this.p.lock(hash);
  if(lock&&!(lock.ownerKind==='correction'&&lock.ownerId===ownId)&&!(lock.ownerKind==='draft'&&lock.draftId===d.id&&lock.state==='SUBMITTED'))fail('同 SKU 存在尚未核实的写入锁');
  for(const other of this.p.records().filter(other=>listingHash(other.draft,other.draft.sku)===hash)){
   if(other.unresolvedWrite||['UNKNOWN','SUBMITTING'].includes(other.draft.state))fail('同 SKU 仍有未知提交意图');
   const intent=this.p.db.prepare("SELECT 1 FROM execution_tasks t,json_each(t.record_json,'$.items') i WHERE json_extract(i.value,'$.draftId')=? AND json_extract(i.value,'$.submitStarted')=1").get(other.draft.id);
   if(intent&&!trustedAccepted(other))fail('同 SKU 存在没有可信回执的提交意图');
  }
 }
 private path(c:ListingCorrection){return `/listings/2021-08-01/items/${encodeURIComponent(c.sellerId)}/${encodeURIComponent(c.sku)}`;}
 private query(c:ListingCorrection){return {marketplaceIds:c.marketplaceId,issueLocale:c.locale};}
 private async remote(c:ListingCorrection,readOnly=false){
  const target=readOnly?this.hooks.active(c.targetId):this.active(c),generation=this.p.generation(c.targetId);
  const guard=()=>{const current=readOnly?this.hooks.active(c.targetId):this.active(c);if(targetStamp(current)!==c.targetStamp||this.p.generation(c.targetId)!==generation)fail('核对期间店铺身份或授权已变化');};guard();
  const result=await this.hooks.api(target,'getListingsItem',this.path(c),{...this.query(c),includedData:'attributes,summaries,issues,productTypes'},undefined,guard);guard();const data=result.data;
  if(data.sku!==c.sku||!isObject(data.attributes)||!Array.isArray(data.summaries))fail('Amazon 回读缺少匹配的原 SKU、summaries 或属性');
  const matching=(values:JsonValue)=>Array.isArray(values)&&values.every(s=>isObject(s)&&s.marketplaceId===c.marketplaceId&&s.productType===c.productType);
  if(!matching(data.summaries)||data.productTypes!==undefined&&!matching(data.productTypes))fail('Amazon 回读的站点或商品类型不匹配');
  const inspect=(v:JsonValue):void=>{if(Array.isArray(v)){for(const child of v)inspect(child);}else if(isObject(v)){for(const [key,child] of Object.entries(v)){if(key==='marketplace_id'&&child!==c.marketplaceId)fail('Amazon 回读属性包含其他站点');inspect(child);}}};inspect(data.attributes);
  return data;
 }
 private state(c:ListingCorrection,state:ListingCorrectionState,message:string){
  const next={...c,state,message,revision:c.revision+1,updatedAt:this.at()};
  const result=this.p.db.prepare("UPDATE listing_corrections SET record_json=? WHERE id=? AND json_extract(record_json,'$.revision')=?").run(JSON.stringify(next),c.id,c.revision);
  if(result.changes!==1)fail('修正状态已由另一操作推进，请重新加载');Object.assign(c,next);return structuredClone(c);
 }
 async prepare(raw:unknown):Promise<ListingCorrection>{
  if(!isObject(raw)||Object.keys(raw).some(k=>!['id','revision'].includes(k))||typeof raw.id!=='string')fail('修正准备参数无效');
  const r=this.p.record(raw.id),d=r.draft;if(d.revision!==raw.revision)fail('原草稿版本已变化');this.eligible(r);
  const target=this.hooks.active(d.targetId),hash=listingHash(d,d.sku);if(this.busy.has(hash))fail('修正正在处理中');this.busy.add(hash);
  try{
   const prior=this.p.db.prepare('SELECT record_json FROM listing_corrections WHERE listing_hash=? ORDER BY rowid DESC').all(hash).map(row=>JSON.parse(String(row.record_json)) as ListingCorrection);
   if(prior.some(c=>!['REJECTED','CANCELLED','STALE','VERIFIED'].includes(c.state)))fail('已有修正案，请继续该案核对');
   const c:ListingCorrection={id:randomUUID(),revision:1,patchHash:'',draftId:d.id,draftRevision:d.revision,draftStamp:stamp(r),listingHash:hash,previousId:prior[0]?.id??null,targetId:d.targetId,sellerId:d.sellerId,marketplaceId:d.marketplaceId,sku:d.sku,productType:d.schema.productType,locale:d.schema.locale,generation:this.p.generation(d.targetId),targetStamp:targetStamp(target),typeEvidence:'',submittedAttributesHash:'',remoteLocalIssues:[],state:'PREPARED',request:{},before:{},after:{},baselineHash:'',schemaHash:'',createdAt:this.at(),updatedAt:this.at(),readyAt:null,message:'',preview:null,response:null,readback:null,remainingIssues:[]};
   const remote=await this.remote(c),schema=await this.hooks.schema(r);this.active(c);this.original(c);
   const before=remote.attributes as JsonObject;
   const accepted=r.exchanges?.findLast(e=>e.operation==='submit'&&e.response?.status==='ACCEPTED'&&e.response?.submissionId===d.submissionId&&e.response?.sku===d.sku),submitted=accepted?.request??r.request;
   if(submitted.productType!==c.productType||!isObject(submitted.attributes)||correctionHash(submitted.attributes)!==correctionHash(d.attributes))fail('原可信提交请求或原草稿不一致');
   const trustedFacts=structuredClone(submitted.attributes);
   for(const old of [...prior].reverse())if(old.state==='VERIFIED'&&old.response?.status==='ACCEPTED'&&old.response.sku===c.sku&&old.listingHash===c.listingHash&&isObject(old.readback?.attributes)&&old.draftStamp===c.draftStamp){
    for(const field of old.scope??['package_contains_sku'])if(matchingField(old.readback!.attributes as JsonObject,old.after,field)&&matchingField(before,old.after,field)){
     if(Object.hasOwn(old.after,field))trustedFacts[field]=structuredClone(old.after[field]);else delete trustedFacts[field];
    }
   }
   let after:JsonObject,originalAfter:JsonObject,patches:JsonObject[];
   const edges=before.package_contains_sku,selfEdge=Array.isArray(edges)&&edges.some(e=>isObject(e)&&e.sku===c.sku);
   if(selfEdge){
    if(!matchingField(submitted.attributes,before,'package_contains_sku'))fail('远端目标关系与原可信提交不一致');
    const change=selfPackageDeletion(before,c.sku,c.marketplaceId,schema);after=change.after;patches=[change.patch];originalAfter=selfPackageDeletion(trustedFacts,c.sku,c.marketplaceId,schema).after;
    c.scope=['package_contains_sku'];c.evidence=['已核实独立 SKU + 原可信提交与远端一致的包装自引用'];
   }else{
    let change:ReturnType<typeof deterministicFieldCorrections>;try{change=deterministicFieldCorrections(before,trustedFacts,schema,remote.issues??[]);}catch(error){fail((error instanceof Error?error.message:'需人工核对')+'；平台回读：'+JSON.stringify(remote.issues??[]).slice(0,1800));}after=change.after;patches=change.patches;c.scope=change.fields;c.evidence=change.evidence;
    originalAfter=structuredClone(trustedFacts);for(const field of change.fields)originalAfter[field]=after[field];
   }
   c.correctionVersion=2;c.problemKey=correctionHash([...c.scope].sort());
   const issues=validateAttributes(schema.schema,originalAfter,schema.metaSchema);
   c.submittedAttributesHash=correctionHash(submitted.attributes);c.remoteLocalIssues=validateAttributes(schema.schema,after,schema.metaSchema);
   if(issues.some(i=>i.severity==='ERROR'))fail('原可信提交局部修正后的当前 Schema 校验未通过：'+issues.map(i=>i.message).join('；'));
   c.typeEvidence=Array.isArray(remote.productTypes)&&remote.productTypes.length?'当前回读 productTypes 确认':Array.isArray(remote.summaries)&&remote.summaries.length?'当前回读 summaries 确认':'原可信提交商品类型 + 当前对应 PTD；回读无商品类型摘要，仍须 PATCH 验证预览';
   c.request={productType:c.productType,patches};c.patchHash=correctionHash(c.request);c.round=this.assertSendBudget(c);c.before=before;c.after=after;c.baselineHash=correctionHash(before);c.schemaHash=correctionHash({schema:schema.schema,meta:schema.metaSchema,version:schema.version,checksum:schema.checksum});c.message=`第 ${c.round}/2 轮：仅修正 ${c.scope.join('、')}；尚未发送验证预览或正式修正`;
   this.p.transaction(()=>{this.original(c);if(this.p.db.prepare("SELECT 1 FROM listing_corrections WHERE listing_hash=? AND json_extract(record_json,'$.state') NOT IN ('REJECTED','CANCELLED','STALE','VERIFIED')").get(hash))fail('同 SKU 已有修正案');this.save(c);});return structuredClone(c);
  }finally{this.busy.delete(hash);}
 }
 /** One native confirmation authorizes only this frozen field scope, for at most two distinct attempts. */
 async continue(raw:unknown,confirmed:boolean):Promise<ListingCorrection>{
  if(!confirmed)fail('继续修正需要确认范围');
  let c=this.reference(raw);
  if(['UNKNOWN','ACCEPTED'].includes(c.state))return this.readback(raw);
  if(!['PREPARED','READY'].includes(c.state))fail('此修正案不能继续，请重新准备范围');
  const allowed=new Set(c.scope??['package_contains_sku']);
  for(let round=0;round<2;round++){
   if(c.state==='PREPARED')c=await this.preview({id:c.id,revision:c.revision,patchHash:c.patchHash});
   if(c.state!=='READY')return c;
   c=await this.send({id:c.id,revision:c.revision,patchHash:c.patchHash},true);
   if(['ACCEPTED','UNKNOWN'].includes(c.state))c=await this.readback({id:c.id,revision:c.revision,patchHash:c.patchHash});
   if(c.state!=='REJECTED'||c.response?.status!=='INVALID'||c.response.sku!==c.sku||!readableIssues(c.response.issues)||!Array.isArray(c.response.issues)||!c.response.issues.some(i=>isObject(i)&&i.severity==='ERROR')||(c.round??1)>=2)return c;
   let next:ListingCorrection;
   try{next=await this.prepare({id:c.draftId,revision:c.draftRevision});}
   catch(error){return this.state(c,c.state,c.message+'；停止自动接续：'+(error instanceof Error?error.message:'无法准备可靠修正'));}
   if((next.scope??['package_contains_sku']).some(field=>!allowed.has(field)))return this.state(next,'CANCELLED','新问题超出已确认修正范围；未预览或发送第二轮，需重新确认');
   c=next;
  }
  return c;
 }
 private assertSendBudget(c:ListingCorrection):number {
  const fields=(request:JsonObject)=>Array.isArray(request.patches)?request.patches.filter(isObject).map(p=>String(p.path)):[];
  const scope=fields(c.request),sent=this.p.db.prepare("SELECT record_json FROM listing_correction_attempts WHERE json_extract(record_json,'$.listingHash')=?").all(c.listingHash).map(row=>JSON.parse(String(row.record_json)) as ListingCorrectionAttempt);
  const related=sent.filter(attempt=>fields(attempt.request).some(path=>scope.includes(path)));
  if(related.length>=2)fail('同一问题已达两轮修正上限；请查看两轮结果并人工处理');
  if(sent.some(attempt=>attempt.patchHash===c.patchHash))fail('与已发送修正载荷无实质变化，禁止重复发送；请查看原轮次结果');
  return related.length+1;
 }
 private async fresh(c:ListingCorrection){this.original(c);const remote=await this.remote(c),schema=await this.hooks.schema(this.p.record(c.draftId));this.active(c);this.original(c);
  if(correctionHash(remote.attributes)!==c.baselineHash||correctionHash({schema:schema.schema,meta:schema.metaSchema,version:schema.version,checksum:schema.checksum})!==c.schemaHash||correctionHash(c.request)!==c.patchHash)fail('远端属性、Schema 或修正指纹已变化');
 }
 async preview(raw:unknown){const c=this.reference(raw);if(c.state!=='PREPARED')fail('仅准备完成的修正案可以预览');if(this.busy.has(c.listingHash))fail('修正正在处理中');this.busy.add(c.listingHash);
  try{await this.fresh(c);const result=await this.hooks.api(this.active(c),'previewPatchListingsItem',this.path(c),{...this.query(c),mode:'VALIDATION_PREVIEW',includedData:'issues'},c.request,()=>{this.active(c);this.original(c);});this.reference(raw);c.preview=result.data;await this.fresh(c);this.reference(raw);
   if(result.data.sku!==c.sku||result.data.status!=='VALID'||!readableIssues(result.data.issues)||Array.isArray(result.data.issues)&&result.data.issues.some(i=>isObject(i)&&i.severity==='ERROR'))return this.state(c,'REJECTED','修正验证预览未通过；正式 PATCH 未发送');
   c.readyAt=this.at();return this.state(c,'READY','修正预览通过；请确认差异后正式发送一次');
  }catch(error){this.state(c,'STALE',error instanceof Error?error.message:'修正预览失败');throw error;}finally{this.busy.delete(c.listingHash);}
 }
 async send(raw:unknown,confirmed:boolean){if(!confirmed)fail('正式修正需要原生窗口确认');const c=this.reference(raw);if(c.state!=='READY'||!c.readyAt||Date.parse(this.at())-Date.parse(c.readyAt)>15*60_000)fail('修正预览已过期或状态不可发送');if(this.busy.has(c.listingHash))fail('同 SKU 正在处理中');this.busy.add(c.listingHash);let begun=false;
  try{await this.fresh(c);this.p.transaction(()=>{this.reference(raw);this.original(c);this.active(c);this.assertSendBudget(c);if(this.p.db.prepare('SELECT 1 FROM listing_correction_attempts WHERE correction_id=?').get(c.id))fail('此案已有正式发送意图，禁止重放');
    const lock=this.p.lock(c.listingHash);if(lock)this.p.releaseAccepted(c.listingHash,c.draftId);if(this.p.locked(c.listingHash))fail('同 SKU 已有写入锁');
    this.p.db.prepare("INSERT INTO amazon_write_locks(listing_hash,draft_id,state,created_at,owner_kind,owner_id) VALUES(?,?,'SENDING',?,'correction',?)").run(c.listingHash,c.draftId,this.at(),c.id);
    const attempt:ListingCorrectionAttempt={id:randomUUID(),correctionId:c.id,listingHash:c.listingHash,intentAt:this.at(),request:c.request,patchHash:c.patchHash,identity:{draftId:c.draftId,targetId:c.targetId,sellerId:c.sellerId,marketplaceId:c.marketplaceId,sku:c.sku,productType:c.productType,generation:c.generation},state:'SENDING',response:null,readback:null};this.p.db.prepare('INSERT INTO listing_correction_attempts(id,correction_id,record_json) VALUES(?,?,?)').run(attempt.id,c.id,JSON.stringify(attempt));this.state(c,'SENDING','已冻结正式修正请求及发送意图；禁止自动重发');});begun=true;
   const result=await this.hooks.api(this.active(c),'patchListingsItem',this.path(c),{...this.query(c),includedData:'issues'},c.request,()=>{this.active(c);const current=this.get(c.id),lock=this.p.lock(c.listingHash);if(current.state!=='SENDING'||lock?.ownerKind!=='correction'||lock.ownerId!==c.id)fail('修正写锁已变化');this.original(c);});c.response=result.data;
   const validIssues=result.data.issues===undefined||readableIssues(result.data.issues),errors=Array.isArray(result.data.issues)&&result.data.issues.some(i=>isObject(i)&&i.severity==='ERROR');
   if(result.data.sku===c.sku&&result.data.status==='ACCEPTED'&&typeof result.data.submissionId==='string'&&!!result.data.submissionId&&validIssues&&!errors)return this.finish(c,'ACCEPTED','Amazon 接受了修正请求；尚未核实目标关系是否消除');
   if(result.data.sku===c.sku&&result.data.status==='INVALID'&&validIssues&&errors)return this.finish(c,'REJECTED','Amazon 拒绝修正；此案不可重发');
   return this.finish(c,'UNKNOWN','修正响应不完整，结果未知；保持锁定，禁止重发');
  }catch(error){if(begun){c.response=error instanceof AmazonTransportError?error.response:null;return this.finish(c,error instanceof AmazonTransportError&&!error.unknownWrite?'REJECTED':'UNKNOWN',error instanceof Error?error.message:'修正结果未知');}this.state(c,'STALE',error instanceof Error?error.message:'修正准备失效');throw error;}finally{this.busy.delete(c.listingHash);}
 }
 private finish(c:ListingCorrection,state:ListingCorrectionState,message:string){return this.p.transaction(()=>{this.state(c,state,message);const row=this.p.db.prepare('SELECT id,record_json FROM listing_correction_attempts WHERE correction_id=?').get(c.id);if(row){const a=JSON.parse(String(row.record_json)) as ListingCorrectionAttempt;a.state=state;a.response=c.response;a.readback=c.readback;this.p.db.prepare('UPDATE listing_correction_attempts SET record_json=? WHERE id=?').run(JSON.stringify(a),row.id);}
   if(['VERIFIED','REJECTED'].includes(state))this.p.db.prepare("DELETE FROM amazon_write_locks WHERE listing_hash=? AND owner_kind='correction' AND owner_id=?").run(c.listingHash,c.id);else this.p.db.prepare("UPDATE amazon_write_locks SET state=? WHERE listing_hash=? AND owner_kind='correction' AND owner_id=?").run(state,c.listingHash,c.id);return structuredClone(c);});}
 async readback(raw:unknown){const c=this.reference(raw);if(!['ACCEPTED','UNKNOWN'].includes(c.state))fail('此案尚未发送或不需要继续核对');if(this.busy.has(c.listingHash))fail('修正正在处理中');this.busy.add(c.listingHash);try{const remote=await this.remote(c,true);this.reference(raw);c.readback=remote;c.remainingIssues=Array.isArray(remote.issues)?remote.issues:[];
   const relevantError=c.remainingIssues.some(i=>isObject(i)&&i.severity==='ERROR'&&Array.isArray(i.attributeNames)&&i.attributeNames.some(field=>(c.scope??['package_contains_sku']).includes(String(field))));
   if(c.state==='ACCEPTED'&&relevantError)return this.finish(c,'ACCEPTED','仍在等待本轮修正处理结果；回读问题可能来自原提交，未证实本轮失败。保留 ACCEPTED 写锁继续核对，不发送第二轮');
   if(c.scope&&c.scope.some(field=>field!=='package_contains_sku')){
    const attributes=remote.attributes as JsonObject,matched=c.scope.every(field=>matchingField(attributes,c.after,field));
    if(c.state==='UNKNOWN')return this.finish(c,'UNKNOWN',matched?'目标字段已匹配，但发送结果仍未知；保留写锁，禁止重发':'字段仍未匹配；发送结果未知，保留写锁');
    return this.finish(c,matched?'VERIFIED':'ACCEPTED',matched?'已核实范围内字段匹配；其他平台问题保留，不代表可售':'目标字段尚未匹配，保留写锁，请稍后核对');
   }
   const edges=(remote.attributes as JsonObject).package_contains_sku;
   const readable=edges===undefined||Array.isArray(edges)&&edges.every(e=>isObject(e)&&typeof e.sku==='string'&&!!e.sku.trim()&&e.marketplace_id===c.marketplaceId&&(e.quantity===undefined||typeof e.quantity==='number'&&Number.isSafeInteger(e.quantity)&&e.quantity>0));
   if(!readable)return this.finish(c,c.state,'回读包装关系结构不完整，无法核实目标是否消除；已保留观测和原写入锁');
   const removed=edges===undefined||Array.isArray(edges)&&!edges.some(e=>isObject(e)&&e.sku===c.sku);
   if(c.state==='UNKNOWN')return this.finish(c,'UNKNOWN',removed?'回读已不含目标自引用，但发送结果仍未知；锁保留，不能重发':'回读仍有目标关系；发送结果未知，锁保留');
   return this.finish(c,removed?'VERIFIED':'ACCEPTED',removed?'已核实目标自引用消除；不代表可售，其他平台问题仍需处理':'目标关系尚未消除，请稍后由用户再次核对');
  }finally{this.busy.delete(c.listingHash);}}
 cancel(raw:unknown){const c=this.reference(raw);if(!['PREPARED','READY'].includes(c.state)||this.busy.has(c.listingHash))fail('此修正案不能取消');return this.state(c,'CANCELLED','用户取消未发送修正；历史保留');}
}
