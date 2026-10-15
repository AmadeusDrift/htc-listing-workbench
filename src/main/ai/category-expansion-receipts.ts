import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,linkSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {ProductTypeOption} from '../../shared/amazon-contracts.ts';
import type {CategoryExpansionOperation,CategoryExpansionSnapshot,CategoryExpansionCaptureProof,CategoryExpansionTargetScope} from '../../shared/category-operation-contracts.ts';
import {RestorePathGuard,writeRestoreFile} from '../restore-paths.ts';
import {readCategoryOperation,retainCategoryExpansionCapture} from './category-operations.ts';
import {parseCategoryOperation} from './category-operation-records.ts';
import {listingFingerprint} from '../json-fingerprint.ts';
import {AiError} from './errors.ts';
import {uuid,date,boundedText} from './primitives.ts';

export type CategoryLookupTarget=CategoryExpansionTargetScope;
export interface CategoryLookupCapture {requestId:string;targetScope:CategoryLookupTarget;targetGeneration:number;query:string;status:number;remoteRequestId:string|null;receivedAt:string;bytes:Buffer}
interface LookupRecord extends Omit<CategoryLookupCapture,'bytes'> {version:1;operationId:string;inputVersion:string;requestSha256:string;receiptSha256:string;byteSize:number;base64:string}
const folder='ai-receipts/category-expansions',maxBytes=2*1024*1024,hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export const categoryLookupPath=(id:string)=>`${folder}/${uuid(id)}.json`;
function invalid(requestId?:string):never {const error=new AiError('INTERRUPTED');error.certainty='SENT_UNKNOWN';error.diagnosticReason='CATEGORY_EXPANSION_RECEIPT_INVALID';error.requestId=requestId;error.message='类目扩展原回执身份不可核验；保留原请求，本次未重新检索';throw error;}
export function categoryLookupTarget(raw:CategoryLookupTarget):CategoryLookupTarget {
 if(!raw||Object.keys(raw).sort().join()!=='locale,marketplaceId,mode,region,sellerId,targetId'||!['na','eu','fe'].includes(raw.region)||!['live','demo'].includes(raw.mode))invalid();
 return {targetId:boundedText(raw.targetId,100),sellerId:boundedText(raw.sellerId,200),marketplaceId:boundedText(raw.marketplaceId,100),region:raw.region,locale:boundedText(raw.locale,100),mode:raw.mode};
}
function claim(db:DatabaseSync,productId:string,requestId:string):CategoryExpansionOperation {
 const expansion=readCategoryOperation(db,uuid(productId)).expansion;if(!expansion||expansion.requestId!==uuid(requestId)||!expansion.permittedAt)invalid(requestId);return expansion;
}
function parseRecord(db:DatabaseSync,bytes:Buffer,expansion:CategoryExpansionOperation):{record:LookupRecord;body:Buffer}{
 if(bytes.length<1||bytes.length>4*1024*1024)invalid(expansion.requestId);
 const text=bytes.toString('utf8');if(db.prepare('SELECT 1 FROM json_tree(?) WHERE parent IS NOT NULL GROUP BY parent,key COLLATE BINARY HAVING count(*)>1 LIMIT 1').get(text))invalid(expansion.requestId);
 let record:LookupRecord;try{record=JSON.parse(text);}catch{invalid(expansion.requestId);}
 if(!record||Object.keys(record).sort().join()!=='base64,byteSize,inputVersion,operationId,query,receiptSha256,receivedAt,remoteRequestId,requestId,requestSha256,status,targetGeneration,targetScope,version'||record.version!==1||record.requestId!==expansion.requestId||record.operationId!==expansion.operationId||record.inputVersion!==expansion.inputVersion||record.requestSha256!==expansion.requestSha256||record.query!==expansion.query||record.targetScope?.targetId!==expansion.targetId||!Number.isInteger(record.targetGeneration)||record.targetGeneration<1||!Number.isInteger(record.status)||record.status<100||record.status>599||record.remoteRequestId!==null&&(typeof record.remoteRequestId!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(record.remoteRequestId))||typeof record.base64!=='string'||!Number.isSafeInteger(record.byteSize)||record.byteSize<0||record.byteSize>maxBytes||typeof record.receiptSha256!=='string'||!/^[a-f0-9]{64}$/.test(record.receiptSha256))invalid(expansion.requestId);
 categoryLookupTarget(record.targetScope);if(date(record.receivedAt)<expansion.permittedAt!)invalid(expansion.requestId);
 const body=Buffer.from(record.base64,'base64');if(body.length!==record.byteSize||body.toString('base64')!==record.base64||hash(body)!==record.receiptSha256)invalid(expansion.requestId);
 return {record,body};
}
function read(db:DatabaseSync,directory:string,productId:string,requestId:string){
 const expansion=claim(db,productId,requestId),path=join(directory,categoryLookupPath(requestId));if(!existsSync(path))return null;
 const guard=new RestorePathGuard(directory),before=guard.assertFile(path);if(before.size>4*1024*1024)invalid(requestId);const fileBytes=readFileSync(path),after=guard.assertFile(path);
 if(before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs||fileBytes.length!==before.size)invalid(requestId);
 const proof=expansion.captureProof;if(!proof||fileBytes.length!==proof.fileByteSize||hash(fileBytes)!==proof.fileSha256)invalid(requestId);
 try{const parsed=parseRecord(db,fileBytes,expansion);if(metadataIdentity(parsed.record)!==metadataIdentity(proof)||hash(parsed.body)!==proof.receiptSha256)invalid(requestId);return {...parsed,fileBytes,path};}catch{invalid(requestId);}
}
function metadataIdentity(value:LookupRecord|CategoryExpansionCaptureProof):string {
 return listingFingerprint({version:value.version,operationId:value.operationId,inputVersion:value.inputVersion,requestSha256:value.requestSha256,requestId:value.requestId,targetScope:categoryLookupTarget(value.targetScope),targetGeneration:value.targetGeneration,query:value.query,status:value.status,remoteRequestId:value.remoteRequestId,receivedAt:value.receivedAt,receiptSha256:value.receiptSha256,byteSize:value.byteSize});
}
function writeOriginal(directory:string,path:string,bytes:Buffer):void {
 const guard=new RestorePathGuard(directory);guard.assertDirectory(dirname(path),true);const temporary=join(dirname(path),`.lookup-${randomUUID()}.tmp`);
 writeRestoreFile(guard,temporary,bytes);try{guard.assertDirectory(dirname(path));linkSync(temporary,path);}finally{unlinkSync(temporary);}guard.assertFile(path);
}
/** The one M07 owner captures complete original bytes before decoding or business linking. */
export function captureCategoryLookup(db:DatabaseSync,directory:string,productId:string,capture:CategoryLookupCapture):void {
 if(db.isTransaction)invalid(capture.requestId);
 const expansion=claim(db,productId,capture.requestId);if(!Buffer.isBuffer(capture.bytes)||capture.bytes.length>maxBytes)invalid(capture.requestId);
 const record:LookupRecord={version:1,operationId:expansion.operationId,inputVersion:expansion.inputVersion,requestSha256:expansion.requestSha256,requestId:capture.requestId,targetScope:categoryLookupTarget(capture.targetScope),targetGeneration:capture.targetGeneration,query:capture.query,status:capture.status,remoteRequestId:capture.remoteRequestId,receivedAt:capture.receivedAt,receiptSha256:hash(capture.bytes),byteSize:capture.bytes.length,base64:capture.bytes.toString('base64')};
 const bytes=Buffer.from(JSON.stringify(record));parseRecord(db,bytes,expansion);
 const {base64:_base64,...metadata}=record,proof:CategoryExpansionCaptureProof={...metadata,fileSha256:hash(bytes),fileByteSize:bytes.length};
 // Commit an independent immutable tuple before creating the file. A crash on
 // either side leaves the original used permit, never permission to resend.
 retainCategoryExpansionCapture(db,directory,productId,proof);const previous=read(db,directory,productId,capture.requestId);
 if(previous){if(!previous.fileBytes.equals(bytes))invalid(capture.requestId);return;}
 try{writeOriginal(directory,join(directory,categoryLookupPath(capture.requestId)),bytes);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=read(db,directory,productId,capture.requestId);if(!existing||!existing.fileBytes.equals(bytes))invalid(capture.requestId);}
}
function productTypes(db:DatabaseSync,record:LookupRecord,bytes:Buffer):ProductTypeOption[]{
 const fail=(certainty:'DEFINITIVE_REJECTION'|'RECEIVED_INVALID'):never=>{const error=new AiError('OUTPUT_INVALID');error.certainty=certainty;error.requestId=record.requestId;error.diagnosticReason='CATEGORY_EXPANSION_RESPONSE_INVALID';error.message='类目扩展已收到明确响应，但没有可采用的商品类型；原回执保留，本次未重发';throw error;};
 if(record.status<200||record.status>=300)fail('DEFINITIVE_REJECTION');
 let body:any;try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);body=JSON.parse(text);if(db.prepare('SELECT 1 FROM json_tree(?) WHERE parent IS NOT NULL GROUP BY parent,key COLLATE BINARY HAVING count(*)>1 LIMIT 1').get(text))fail('RECEIVED_INVALID');}catch{fail('RECEIVED_INVALID');}
 if(!body||typeof body!=='object'||Array.isArray(body)||body.errors||!Array.isArray(body.productTypes)||body.productTypes.length>20000)fail('RECEIVED_INVALID');
 const types:ProductTypeOption[]=[];
 for(const item of body.productTypes){if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.name!=='string'||!/^[A-Z0-9][A-Z0-9_]{0,99}$/.test(item.name)||typeof item.displayName!=='string'||!item.displayName.trim()||item.displayName.length>1000||item.marketplaceIds!==undefined&&(!Array.isArray(item.marketplaceIds)||item.marketplaceIds.some((id:unknown)=>typeof id!=='string')))fail('RECEIVED_INVALID');if(!item.marketplaceIds||item.marketplaceIds.includes(record.targetScope.marketplaceId))types.push({name:item.name,displayName:item.displayName});}
 if(new Set(types.map(type=>type.name)).size!==types.length)fail('RECEIVED_INVALID');return types;
}
export function readCategoryLookup(db:DatabaseSync,directory:string,productId:string,requestId:string,targetScope:CategoryLookupTarget){
 const saved=read(db,directory,productId,requestId);if(!saved){const expansion=claim(db,productId,requestId);if(expansion.captureProof||expansion.snapshot)invalid(requestId);return null;}if(listingFingerprint(saved.record.targetScope)!==listingFingerprint(categoryLookupTarget(targetScope)))invalid(requestId);
 return {requestId,candidates:productTypes(db,saved.record,saved.body),receiptSha256:saved.record.receiptSha256,receivedAt:saved.record.receivedAt};
}
/** Every production adoption and backup verifies the raw proof; a digest alone is not proof. */
export function assertCategoryLookupSnapshot(db:DatabaseSync,directory:string,productId:string,snapshot:CategoryExpansionSnapshot):void {
 const saved=read(db,directory,productId,snapshot.requestId);if(!saved||saved.record.receiptSha256!==snapshot.receiptSha256)invalid(snapshot.requestId);const types=productTypes(db,saved.record,saved.body);
 for(const item of snapshot.evidence)if(item.sources.includes('platform')&&!types.some(type=>type.name===item.name))invalid(snapshot.requestId);
}
export function categoryLookupFiles(db:DatabaseSync,directory:string){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_category_operations'").get())return[];
 const files:{path:string;sha256:string;byteSize:number}[]=[];
 for(const row of db.prepare('SELECT record_json FROM ai_category_operations').all()){
  const operation=parseCategoryOperation(JSON.parse(String(row.record_json))),expansion=operation.expansion;if(!expansion)continue;
  if(!expansion.permittedAt){if(existsSync(join(directory,categoryLookupPath(expansion.requestId))))invalid(expansion.requestId);continue;}
  const saved=read(db,directory,operation.productId,expansion.requestId);if(expansion.snapshot)assertCategoryLookupSnapshot(db,directory,operation.productId,expansion.snapshot);
  if(saved)files.push({path:categoryLookupPath(expansion.requestId),sha256:hash(saved.fileBytes),byteSize:saved.fileBytes.length});
 }
 return files;
}
export function retainCategoryLookupFiles(current:DatabaseSync,snapshot:DatabaseSync,from:string,to:string):void {
 for(const file of categoryLookupFiles(current,from)){
  const source=new RestorePathGuard(from);source.assertFile(join(from,file.path));const bytes=readFileSync(join(from,file.path));if(hash(bytes)!==file.sha256)invalid();
  const path=join(to,file.path),target=new RestorePathGuard(to);target.assertDirectory(dirname(path),true);
  if(existsSync(path)){target.assertFile(path);if(!readFileSync(path).equals(bytes))invalid();}else writeOriginal(to,path,bytes);
 }
 categoryLookupFiles(snapshot,to);
}
