import type { AmazonDraft,ListingIssue } from '../../shared/amazon-contracts.ts';
import type { BusinessIssue,IssueLocation,Stage } from '../../shared/workflow-context-contracts.ts';
import { listingFingerprint } from '../json-fingerprint.ts';

/** Preserve exact explanations. A field location is emitted only from verified schema keys. */
export function listingProblems(draft:AmazonDraft,remaining:string[],operation?:{id:string;revision:number}):BusinessIssue[]{
  const schemaFields=new Set(Object.keys(draft.schema.schema.properties??{}));
  const pointer=(field:string)=>'/attributes/'+field.replaceAll('~','~0').replaceAll('/','~1');
  const context={productId:draft.productId,sourceVariantIds:[draft.variantId],sku:draft.sku,target:{targetId:draft.targetId,sellerId:draft.sellerId,marketplaceId:draft.marketplaceId,mode:draft.mode},draft:{owner:'listing' as const,id:draft.id,revision:String(draft.revision)},...(operation?{operation:{owner:'listing' as const,id:operation.id,revision:String(operation.revision)}}:{})};
  const blocked=['SUBMITTING','SUBMITTED','PROCESSING','BUYABLE','DISCOVERABLE','UNKNOWN'].includes(draft.state);
  const issues=new Map<string,BusinessIssue>();
  const add=(code:string,message:string,fields:string[],stage:Stage,source?:ListingIssue['source'])=>{
    const located=fields.filter(f=>schemaFields.has(f)),locations:IssueLocation[]=located.length?located.map(field=>({kind:'field',pointer:pointer(field),label:field,relatedPointers:located.filter(f=>f!==field).map(pointer)})):[{kind:'unknown',reason:'原记录没有足以定位到具体字段的结构化路径'}];
    const id=listingFingerprint({draftId:draft.id,revision:draft.revision,code,message,stage,fields});
    const outputError=/\[(?:FIELD_REFERENCE|FIELD_FORMAT|FIELD_CONFLICT|LOCAL_[A-Za-z]+)\]|引用不存在的来源|来源引用无法对应|来源引用格式无效/.test(message);
    issues.set(id,{id,owner:'listing',context,stage,code,kind:draft.state==='UNKNOWN'?'unknown-result':source==='amazon'?'platform-rejection':outputError?'system-failure':'needs-input',summary:message,rawMessage:message,locations,evidenceRefs:operation?[context.operation!]:[],allowedActions:blocked?['inspect-evidence','review-original-submission']:['edit-draft','inspect-evidence'],status:'open',observedAt:draft.updatedAt});
  };
  const structured:[ListingIssue[],Stage][]=[[draft.localIssues,'validation'],[draft.previewIssues,'validation'],[draft.listingIssues,'submission']];
  for(const [list,stage] of structured)for(const issue of list)if(issue.severity==='ERROR')add(issue.code,issue.message,issue.attributeNames,stage,issue.source);
  for(const message of remaining){
    if([...issues.values()].some(i=>message===i.rawMessage||message.endsWith('：'+i.rawMessage)))continue;
    const prefix=message.split('：',1)[0],fields=prefix.split('、').filter(f=>schemaFields.has(f));add('LISTING_REMAINING',message,fields,'fields');
  }
  return [...issues.values()];
}

/** Keep the original diagnosis only while its exact field still has a current problem. */
export function unresolvedCompletionReasons(draft:AmazonDraft,current:string[],previous:string[]):string[]{
  const schemaFields=new Set(Object.keys(draft.schema.schema.properties??{}));
  const fields=(message:string)=>message.split('：',1)[0].split('、').filter(field=>schemaFields.has(field));
  const unresolved=new Set(current.flatMap(fields));
  return [...new Set([...current,...previous.filter(message=>fields(message).some(field=>unresolved.has(field)))])].slice(0,100).map(value=>value.slice(0,2000));
}
