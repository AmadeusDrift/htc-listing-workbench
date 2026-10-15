import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ImageReviewRequestV2,ImageWorkflowRun} from '../../shared/image-workflow-contracts.ts';
import type {AiCall,AiResult} from '../../shared/ai-contracts.ts';
import type {ProductImageContext} from '../../shared/image-ai-contracts.ts';
import {keys,uuid,sha256,integer} from '../ai/primitives.ts';
import {validateAiCall,validateStoredAiResult} from '../ai/validation.ts';
import {validateProductImageContext} from '../ai/image-validation.ts';
import {resultHasOwner} from '../ai/result-owner.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {validateStoredImageWorkflowRun} from './records.ts';
import {validateImageReviewRequest} from './review-checkpoint.ts';
import {assertRecordTable} from '../storage/record-table.ts';
import {RestorePathGuard,writeRestoreFile} from '../restore-paths.ts';
import {UserFacingError} from '../../shared/errors.ts';
export const IMAGE_REVIEW_TABLES={image_review_journal:['id','record_json']};
interface ReviewFile{path:string;sha256:string;byteSize:number}
export interface ImageReviewLedger {version:1;id:string;request:ImageReviewRequestV2;context:ProductImageContext;frozenRun:ImageWorkflowRun;files:ReviewFile[];call:AiCall|null;result:AiResult|null;adopted:{assetId:string;file:ReviewFile}|null}
const invalid=():never=>{throw new UserFacingError('图片审核安全账身份、许可或原始成果不一致，未发送或覆盖');};
const has=(db:DatabaseSync)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_review_journal'").get();
export function initializeImageReviewLedger(db:DatabaseSync):void {db.exec('CREATE TABLE image_review_journal(id TEXT PRIMARY KEY NOT NULL,record_json TEXT NOT NULL)');}
export function reviewRequestIdentity(r:ImageReviewRequestV2):string {const {state,resultId,reservedAt,requestFingerprint,effects,...identity}=r;return listingFingerprint({...identity,effects:effects.map(e=>({id:e.id,kind:e.kind}))});}
function file(raw:unknown):ReviewFile {const v=keys(raw,['path','sha256','byteSize']);if(typeof v.path!=='string'||!(/^(?:assets\/[a-zA-Z0-9_.-]+|image-generation\/candidates\/[a-f0-9-]{36}\/(?:candidate.json|image.png|preview.png))$/.test(v.path)))invalid();return {path:v.path as string,sha256:sha256(v.sha256),byteSize:integer(v.byteSize,1,32*1024*1024)};}
export function validateImageReviewLedger(raw:unknown):ImageReviewLedger {
 const v=keys(raw,['version','id','request','context','frozenRun','files','call','result','adopted']);if(v.version!==1||!Array.isArray(v.files)||v.files.length<3||v.files.length>20)invalid();
 const parsedRequest=validateImageReviewRequest(v.request);if(parsedRequest.version!==2||v.id!==parsedRequest.requestId)invalid();const request=parsedRequest as ImageReviewRequestV2;
 const context=validateProductImageContext(v.context,{storedVersion:(v.frozenRun as ImageWorkflowRun)?.listingEvidenceContractVersion??null}),frozenRun=validateStoredImageWorkflowRun(v.frozenRun),original=frozenRun.reviewRequests?.find(r=>r.requestId===request.requestId);
 if(!original||original.version!==2||original.state!=='PREPARED'||reviewRequestIdentity(original as ImageReviewRequestV2)!==reviewRequestIdentity(request)||listingFingerprint(context)!==request.contextSha256||context.listing.draftId!==request.draftId||context.listing.sku!==request.sku||(context.slot?.index??0)!==request.slot)invalid();
 const files=(v.files as unknown[]).map(file);if(new Set(files.map(f=>f.path)).size!==files.length)invalid();
 const candidate=files.find(f=>f.path===`image-generation/candidates/${request.candidate.id}/image.png`);if(!candidate||candidate.sha256!==request.candidate.sha256||!['candidate.json','preview.png'].every(name=>files.some(f=>f.path===`image-generation/candidates/${request.candidate.id}/${name}`)))invalid();
 const call=v.call===null?null:validateAiCall(v.call),result=v.result===null?null:validateStoredAiResult(v.result);
 if(call&&(call.id!==request.requestId||call.requestFingerprint!==request.requestFingerprint||call.productId!==request.productId||call.productRevision!==request.productRevision||call.providerId!==request.execution.providerId||call.model!==request.execution.model||call.generation!==request.execution.generation||call.presentationContext?.sourceSha256!==request.contextSha256||call.requestScope?.candidateSha256!==request.candidate.sha256))invalid();
 if(result&&(!call||!resultHasOwner(result,call)||result.id!==request.resultId||result.callId!==request.requestId)||request.state==='RESULT_STORED'&&!result||request.state==='PREPARED'&&call)invalid();
 let adopted:ImageReviewLedger['adopted']=null;if(v.adopted!==null){const a=keys(v.adopted,['assetId','file']);adopted={assetId:uuid(a.assetId),file:file(a.file)};if(request.state!=='RESULT_STORED'||adopted.file.sha256!==request.candidate.sha256||!adopted.file.path.startsWith('assets/'))invalid();}
 return {version:1,id:uuid(v.id),request,context,frozenRun,files,call,result,adopted};
}
export function readImageReviewLedger(db:DatabaseSync,id:string):ImageReviewLedger|null {if(!has(db))return null;const row=db.prepare('SELECT record_json FROM image_review_journal WHERE id=?').get(uuid(id));if(!row)return null;const value=validateImageReviewLedger(JSON.parse(String(row.record_json)));if(value.id!==id)invalid();return value;}
export function imageReviewLedgerRows(db:DatabaseSync):ImageReviewLedger[]{if(!has(db))return [];assertRecordTable(db,'image_review_journal');return db.prepare('SELECT id,record_json FROM image_review_journal').all().map(row=>{const value=validateImageReviewLedger(JSON.parse(String(row.record_json)));if(value.id!==row.id)invalid();return value;});}
/** Writes only the images safety owner on the currently borrowed physical transaction. */
export function writeImageReviewLedger(db:DatabaseSync,raw:ImageReviewLedger):void {
 if(!db.isTransaction)invalid();const value=validateImageReviewLedger(raw),old=readImageReviewLedger(db,value.id);
 if(old&&(reviewRequestIdentity(old.request)!==reviewRequestIdentity(value.request)||listingFingerprint(old.frozenRun)!==listingFingerprint(value.frozenRun)||listingFingerprint(old.context)!==listingFingerprint(value.context)||listingFingerprint(old.files)!==listingFingerprint(value.files)||old.request.effects.some((e,i)=>e.state!=='UNPERMITTED'&&value.request.effects[i].state==='UNPERMITTED')||old.result&&listingFingerprint(old.result)!==listingFingerprint(value.result)||old.adopted&&listingFingerprint(old.adopted)!==listingFingerprint(value.adopted)))invalid();
 db.prepare('INSERT INTO image_review_journal(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(value.id,JSON.stringify(value));
}
export function reviewEvidenceFile(directory:string,path:string):ReviewFile {const guard=new RestorePathGuard(directory),full=join(directory,path),before=guard.assertFile(full),bytes=readFileSync(full),after=guard.assertFile(full);if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs||bytes.length!==before.size)invalid();return file({path,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length});}
export function reviewLedgerFiles(db:DatabaseSync):ReviewFile[]{const selected=new Map<string,ReviewFile>();for(const row of imageReviewLedgerRows(db))for(const f of [...row.files,...(row.adopted?[row.adopted.file]:[])]){const old=selected.get(f.path);if(old&&listingFingerprint(old)!==listingFingerprint(f))invalid();selected.set(f.path,f);}return [...selected.values()];}
/** Retain safe identities/evidence only; never insert an active workflow or adopt results. */
export function retainImageReviewLedger(current:DatabaseSync,snapshot:DatabaseSync,currentDirectory:string,snapshotDirectory:string):void {
 if(!has(current))return;if(!has(snapshot))invalid();
 for(const value of imageReviewLedgerRows(current)){
  const old=readImageReviewLedger(snapshot,value.id);let selected=value;
  if(old){if(reviewRequestIdentity(old.request)!==reviewRequestIdentity(value.request)||listingFingerprint(old.frozenRun)!==listingFingerprint(value.frozenRun))invalid();if(old.result&&!value.result)selected=old;else if(old.request.state!=='PREPARED'&&value.request.state==='PREPARED')selected=old;}
  if(selected===value)writeImageReviewLedger(snapshot,selected);
 }
 const source=new RestorePathGuard(currentDirectory),target=new RestorePathGuard(snapshotDirectory);
 for(const f of reviewLedgerFiles(current)){
  source.assertFile(join(currentDirectory,f.path));const bytes=readFileSync(join(currentDirectory,f.path));source.assertFile(join(currentDirectory,f.path));if(bytes.length!==f.byteSize||createHash('sha256').update(bytes).digest('hex')!==f.sha256)invalid();
  const path=join(snapshotDirectory,f.path);if(existsSync(path)){target.assertFile(path);const old=readFileSync(path);if(old.length!==f.byteSize||createHash('sha256').update(old).digest('hex')!==f.sha256)invalid();}else writeRestoreFile(target,path,bytes);
 }
}
