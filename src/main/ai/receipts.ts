import { openRouterExecutionIdentity } from './execution-identity.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { mkdir,readFile,lstat } from 'node:fs/promises';
import { existsSync,lstatSync,readdirSync,readFileSync } from 'node:fs';
import { resolve,join,dirname } from 'node:path';
import { writeFileAtomically } from '../files.ts';
import type { ProviderReceiptCapture } from './transport.ts';
import type { AiPurposeSnapshot } from '../../shared/ai-purpose-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { assertRecordTable } from '../storage/record-table.ts';
import { openRouterMetadata } from './adapters/openrouter-http.ts';
import {assertOpaqueResponse} from './opaque-response.ts';
import {validateRequestScope} from './request-identity.ts';
import type {AiRequestScope} from '../../shared/ai-request-identity-contracts.ts';
import {listingFingerprint} from '../json-fingerprint.ts';

export const PROVIDER_RECEIPT_TABLES={ai_provider_receipts:['id','record_json'],ai_image_requests:['id','record_json']};
export interface ProviderReceiptV1 {executionIdentity?:{actualModel:string|null;actualProvider:string|null};version:1;id:string;callId:string;gateway:'openrouter'|'deepseek';endpoint:string;model:string;status:number;requestId:string|null;receivedAt:string;relativePath:string;sha256:string;byteSize:number;costUsd:number|null;reportedTokens:number|null}
export interface ProviderReceiptV2 extends Omit<ProviderReceiptV1,'version'|'gateway'>{version:2;gateway:'aliyun';aliyun:import('./transport.ts').AliyunFinalIdentity;requestFingerprint:string;scopeSha256:string}
export type ProviderReceipt=ProviderReceiptV1|ProviderReceiptV2;
function validAliyunIdentity(a:import('./transport.ts').AliyunFinalIdentity,endpoint:string):boolean{return !!a&&Object.keys(a).sort().join()==='action,apiVersion,candidateSha256,host,region'&&/^[a-f0-9]{64}$/.test(a.candidateSha256)&&(a.action==='RecognizeAllText'&&a.region==='cn-hangzhou'&&a.host==='ocr-api.cn-hangzhou.aliyuncs.com'&&a.apiVersion==='2021-07-07'&&endpoint==='/?Type=Commerce'||a.action==='ImageModeration'&&a.region==='cn-shanghai'&&a.host==='green-cip.cn-shanghai.aliyuncs.com'&&a.apiVersion==='2022-03-02'&&endpoint==='/');}

const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function parse(raw:unknown):ProviderReceipt{
  const r=raw as ProviderReceipt;
  if(r?.version===2&&r.executionIdentity!==undefined)throw new UserFacingError('阿里审核回执不能包含文本路由身份');
  if(r?.executionIdentity!==undefined){const e=r.executionIdentity;if(!e||Object.keys(e).sort().join()!=='actualModel,actualProvider'||[e.actualModel,e.actualProvider].some(v=>v!==null&&(typeof v!=='string'||v.length<1||v.length>200||!/^[-a-zA-Z0-9_.:/ ()]+$/.test(v))))throw new UserFacingError('AI实际路由记录无效');}
  if(!r||Object.keys(r).filter(key=>key!=='executionIdentity'&&!(r.version===2&&['aliyun','requestFingerprint','scopeSha256'].includes(key))).sort().join()!=='byteSize,callId,costUsd,endpoint,gateway,id,model,receivedAt,relativePath,reportedTokens,requestId,sha256,status,version'||![1,2].includes(r.version)||!/^[a-f0-9-]{36}$/.test(r.callId)||!Number.isInteger(r.status)||r.status<100||r.status>599||typeof r.model!=='string'||r.model.length>200||typeof r.endpoint!=='string'||!(r.version===2?validAliyunIdentity(r.aliyun,r.endpoint):r.endpoint.startsWith('/api/')||r.gateway==='deepseek'&&r.endpoint==='/chat/completions')||r.endpoint.length>200||r.requestId!==null&&(typeof r.requestId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(r.requestId))||!Number.isSafeInteger(r.byteSize)||r.byteSize<1||r.byteSize>200*1024*1024||!/^[a-f0-9]{64}$/.test(r.id)||!/^[a-f0-9]{64}$/.test(r.sha256)
    ||r.relativePath!==`ai-receipts/${r.id}.json`||!(r.version===2?r.gateway==='aliyun'&&/^[a-f0-9]{64}$/.test(r.requestFingerprint)&&/^[a-f0-9]{64}$/.test(r.scopeSha256):['openrouter','deepseek'].includes(r.gateway))||!Number.isFinite(Date.parse(r.receivedAt))
    ||r.costUsd!==null&&(typeof r.costUsd!=='number'||!Number.isFinite(r.costUsd)||r.costUsd<0)
    ||r.reportedTokens!==null&&(!Number.isSafeInteger(r.reportedTokens)||r.reportedTokens<0||r.reportedTokens>2_000_000_000))throw new UserFacingError('AI原始收据记录无效');return r;
}
export async function saveProviderReceipt(db:DatabaseSync,directory:string,callId:string,capture:ProviderReceiptCapture,purpose:AiPurposeSnapshot|undefined):Promise<ProviderReceipt>{
  assertOpaqueResponse(capture.body);
  if(!/^[a-f0-9-]{36}$/.test(callId))throw new UserFacingError('AI收据调用身份无效');
  let binding:{requestFingerprint:string;scopeSha256:string}|undefined;
  if(capture.gateway==='aliyun'){const row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(callId),call=row?JSON.parse(String(row.record_json)):null;if(!call?.requestFingerprint||!call.requestScope||call.requestScope.candidateSha256!==capture.aliyun.candidateSha256||call.providerId!==(capture.aliyun.action==='ImageModeration'?'aliyun-image-risk':'aliyun-ocr')||call.model!==capture.model||!validAliyunIdentity(capture.aliyun,capture.endpoint))throw new UserFacingError('阿里审核回执原请求身份不一致');binding={requestFingerprint:call.requestFingerprint,scopeSha256:listingFingerprint(validateRequestScope(call.requestScope))};}
  const version=capture.gateway==='aliyun'?2:1;
  const bytes=Buffer.from(JSON.stringify({version,callId,purpose:purpose??null,...capture,...binding})),sha256=hash(bytes),id=hash(callId+':'+sha256),relativePath=`ai-receipts/${id}.json`;
  const metadata=openRouterMetadata(capture.body);
  const executionIdentity=capture.gateway==='openrouter'?openRouterExecutionIdentity(capture.body,capture.status):undefined;
  const value={...(executionIdentity?{executionIdentity}:{}),...(capture.gateway==='aliyun'?{aliyun:capture.aliyun,...binding}:{}),reportedTokens:metadata.usageKnown?metadata.usage.promptTokens+metadata.usage.completionTokens:null,version,id,callId,gateway:capture.gateway,endpoint:capture.endpoint,model:capture.model,status:capture.status,requestId:capture.requestId,receivedAt:capture.receivedAt,relativePath,sha256,byteSize:bytes.length,costUsd:capture.costUsd} as ProviderReceipt;parse(value);
  await mkdir(join(directory,'ai-receipts'),{recursive:true});
  const folder=await lstat(join(directory,'ai-receipts'));if(!folder.isDirectory()||folder.isSymbolicLink())throw new UserFacingError('AI收据目录无效');
  const path=resolve(directory,relativePath);
  try{await writeFileAtomically(path,bytes,false);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||hash(await readFile(path))!==sha256)throw error;}
  await writeFileAtomically(join(directory,'ai-receipts',callId+'.receipt.json'),JSON.stringify(value));
  db.prepare('INSERT OR IGNORE INTO ai_provider_receipts(id,record_json) VALUES(?,?)').run(id,JSON.stringify(value));return value;
}
export async function readProviderReceipt(db:DatabaseSync,directory:string,callId:string):Promise<unknown|null>{
  if(!/^[a-f0-9-]{36}$/.test(callId))throw new UserFacingError('AI收据调用身份无效');
  try{const folder=await lstat(join(directory,'ai-receipts'));if(!folder.isDirectory()||folder.isSymbolicLink())throw new UserFacingError('AI收据目录无效');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  const row=db.prepare("SELECT record_json FROM ai_provider_receipts WHERE json_extract(record_json,'$.callId')=? ORDER BY rowid DESC LIMIT 1").get(callId);
  let record:ProviderReceipt;
  if(row)record=parse(JSON.parse(String(row.record_json)));
  else{try{const pointer=join(directory,'ai-receipts',callId+'.receipt.json'),stat=await lstat(pointer);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>8192)throw new UserFacingError('AI收据指针文件无效');record=parse(JSON.parse(await readFile(pointer,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
  if(record.callId!==callId)throw new UserFacingError('AI原始收据归属不一致');const path=resolve(directory,record.relativePath),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==record.byteSize)throw new UserFacingError('AI原始收据文件身份无效');const bytes=await readFile(path);
  if(bytes.length!==record.byteSize||hash(bytes)!==record.sha256)throw new UserFacingError('AI原始收据文件缺失或损坏');const capture=JSON.parse(bytes.toString('utf8'));assertOpaqueResponse(capture.body);return capture;
}
/** Read-only synchronous evidence at a local command boundary; never repairs the index. */
export function readCallReceiptSync(db:DatabaseSync,directory:string,call:import('../../shared/ai-contracts.ts').AiCall):{record:ProviderReceipt;capture:ProviderReceiptCapture}|null {
  if(!call.providerReceiptId)return null;
  try{
    const row=db.prepare('SELECT id,record_json FROM ai_provider_receipts WHERE id=?').get(call.providerReceiptId);if(!row)return null;
    const record=parse(JSON.parse(String(row.record_json)));
    const gateway=call.providerId.startsWith('openrouter')?'openrouter':call.providerId.startsWith('deepseek')?'deepseek':call.providerId==='aliyun-ocr'||call.providerId==='aliyun-image-risk'?'aliyun':null;
    const endpoint=gateway==='aliyun'?(call.providerId==='aliyun-ocr'?'/?Type=Commerce':'/'):gateway==='deepseek'?'/chat/completions':call.purposeSnapshot?.capability.endpoint==='decisions'?'/api/alpha/decisions':'/api/v1/chat/completions';
    if(record.id!==row.id||record.id!==call.providerReceiptId||record.callId!==call.id||record.model!==call.model||record.gateway!==gateway||record.endpoint!==endpoint||record.id!==hash(call.id+':'+record.sha256))return null;
    if(record.version===2&&(record.gateway!==gateway||record.requestFingerprint!==call.requestFingerprint||record.scopeSha256!==listingFingerprint(call.requestScope)||record.aliyun.candidateSha256!==call.requestScope?.candidateSha256||record.aliyun.action!==(call.providerId==='aliyun-ocr'?'RecognizeAllText':'ImageModeration')))return null;
    const folder=lstatSync(join(directory,'ai-receipts'));if(!folder.isDirectory()||folder.isSymbolicLink())return null;
    const path=join(directory,record.relativePath),before=lstatSync(path);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==record.byteSize)return null;
    const bytes=readFileSync(path),after=lstatSync(path);
    if(bytes.length!==record.byteSize||before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs||hash(bytes)!==record.sha256)return null;
    const capture=JSON.parse(bytes.toString('utf8'));
    assertOpaqueResponse(capture.body);
    if(!Object.hasOwn(capture,'body')||capture.version!==record.version||capture.callId!==call.id||capture.model!==record.model||capture.gateway!==record.gateway||capture.endpoint!==record.endpoint||capture.status!==record.status||capture.receivedAt!==record.receivedAt||capture.requestId!==record.requestId||capture.costUsd!==record.costUsd)return null;
    if(record.version===2&&(listingFingerprint(capture.aliyun)!==listingFingerprint(record.aliyun)||capture.requestFingerprint!==record.requestFingerprint||capture.scopeSha256!==record.scopeSha256))return null;
    return {record,capture};
  }catch{return null;}
}

/** Complete owned image receipt, used inside the synchronous intent guard. */
export function readImageReceiptSync(db:DatabaseSync,directory:string,intent:ImageRequestIntent):{record:ProviderReceipt;capture:ProviderReceiptCapture}|null{
  try{
    const row=db.prepare("SELECT id,record_json FROM ai_provider_receipts WHERE json_extract(record_json,'$.callId')=? ORDER BY rowid DESC LIMIT 1").get(intent.id);let record:ProviderReceipt;
    if(row){record=parse(JSON.parse(String(row.record_json)));if(record.id!==row.id)return null;}else{const path=join(directory,'ai-receipts',intent.id+'.receipt.json'),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>8192)return null;record=parse(JSON.parse(readFileSync(path,'utf8')));}
    if(record.callId!==intent.id||record.gateway!=='openrouter'||record.endpoint!=='/api/v1/images'||record.model!==intent.model||record.id!==hash(intent.id+':'+record.sha256))return null;
    const folder=lstatSync(join(directory,'ai-receipts'));if(!folder.isDirectory()||folder.isSymbolicLink())return null;
    const path=join(directory,record.relativePath),before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==record.byteSize)return null;
    const bytes=readFileSync(path),after=lstatSync(path);if(bytes.length!==record.byteSize||before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs||hash(bytes)!==record.sha256)return null;
    const capture=JSON.parse(bytes.toString('utf8'));assertOpaqueResponse(capture.body);
    if(!Object.hasOwn(capture,'body')||capture.version!==1||capture.callId!==intent.id||capture.model!==record.model||capture.gateway!==record.gateway||capture.endpoint!==record.endpoint||capture.status!==record.status||capture.receivedAt!==record.receivedAt||capture.requestId!==record.requestId||capture.costUsd!==record.costUsd)return null;
    return {record,capture};
  }catch{return null;}
}

export function providerReceiptFiles(db:DatabaseSync,directory?:string):ProviderReceipt[]{
  if(Number(db.prepare('PRAGMA user_version').get()!.user_version)<25)return[];
  assertRecordTable(db,'ai_provider_receipts');assertRecordTable(db,'ai_image_requests');
  for(const row of db.prepare('SELECT id,record_json FROM ai_image_requests').iterate()){const value=parseImageRequest(JSON.parse(String(row.record_json)));if(value.id!==row.id)throw new UserFacingError('生图请求身份不一致');}
  const records=db.prepare('SELECT id,record_json FROM ai_provider_receipts').all().map(row=>{const value=parse(JSON.parse(String(row.record_json)));if(value.id!==row.id)throw new UserFacingError('AI收据身份不一致');return value;});
  if(directory&&existsSync(join(directory,'ai-receipts'))){
    const folder=join(directory,'ai-receipts'),stat=lstatSync(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw new UserFacingError('AI收据目录无效');
    const known=new Set<string>();for(const table of ['ai_calls','ai_image_requests','ai_batches','ai_batch_items'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))for(const row of db.prepare(`SELECT id FROM ${table}`).iterate())known.add(String(row.id));
    const indexed=new Set(records.map(r=>r.id));
    for(const name of readdirSync(folder)){
      if(!/^[a-f0-9-]{36}\.receipt\.json$/.test(name)||!known.has(name.slice(0,36)))continue;
      const pointer=join(folder,name),s=lstatSync(pointer);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>8192)throw new UserFacingError('AI收据指针文件无效');
      const record=parse(JSON.parse(readFileSync(pointer,'utf8')));if(record.callId!==name.slice(0,36))throw new UserFacingError('AI收据指针归属无效');
      if(!indexed.has(record.id)){records.push(record);indexed.add(record.id);}
    }
  }
  return records;
}
/** Index validated pointer-only responses in a staged database, never mutate the live backup source. */
export function indexProviderReceiptPointers(db:DatabaseSync,directory:string):void{
  for(const record of providerReceiptFiles(db,directory)){
    const path=join(directory,record.relativePath),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==record.byteSize||hash(readFileSync(path))!==record.sha256)throw new UserFacingError('AI收据原文校验失败');
    db.prepare('INSERT OR IGNORE INTO ai_provider_receipts VALUES(?,?)').run(record.id,JSON.stringify(record));
  }
}
interface ImageRequestBase{id:string;provider:'openrouter';model:string;productId:string;productRevision:number;createdAt:string;mode:'generate'|'edit';sourceAssets:{id:string;sha256:string}[];editSource?:{id:string;sha256:string}}
export type ImageRequestIntent=ImageRequestBase&({version:1}|{version:2;requestScope:AiRequestScope;requestFingerprint:string;requestInput:{version:1;promptSha256:string;size:string;quality:string;background:string}});
export function imageRequestFingerprint(input:ImageRequestBase,requestInput:{version:1;promptSha256:string;size:string;quality:string;background:string}):string{return listingFingerprint({provider:input.provider,model:input.model,productId:input.productId,productRevision:input.productRevision,mode:input.mode,sourceAssets:input.sourceAssets,editSource:input.editSource??null,requestInput});}
function parseImageRequest(raw:unknown):ImageRequestIntent{
  const r=raw as ImageRequestIntent,uuid=(s:unknown)=>typeof s==='string'&&/^[a-f0-9-]{36}$/.test(s);
  if(!r||![1,2].includes(r.version)||r.provider!=='openrouter'||!uuid(r.id)||!uuid(r.productId)||typeof r.model!=='string'||r.model.length>200||!Number.isSafeInteger(r.productRevision)||r.productRevision<1||!Number.isFinite(Date.parse(r.createdAt))||!['generate','edit'].includes(r.mode)||!Array.isArray(r.sourceAssets)||r.sourceAssets.length>16||r.sourceAssets.some(a=>!uuid(a.id)||!/^[a-f0-9]{64}$/.test(a.sha256)))throw new UserFacingError('生图请求意图无效');
  if(Object.keys(r).some(k=>!['version','id','provider','model','productId','productRevision','createdAt','mode','sourceAssets','editSource',...(r.version===2?['requestScope','requestFingerprint','requestInput']:[])].includes(k)))throw new UserFacingError('生图意图包含未知字段');
  const asset=(a:unknown)=>{const v=a as {id:string;sha256:string};return !!v&&Object.keys(v).sort().join()==='id,sha256'&&uuid(v.id)&&/^[a-f0-9]{64}$/.test(v.sha256);};
  if(!r.sourceAssets.every(asset)||(r.editSource!==undefined&&(r.mode!=='edit'||!asset(r.editSource))))throw new UserFacingError('生图请求来源无效');
  if(r.version===2){const scope=validateRequestScope(r.requestScope),input=r.requestInput;if(scope.productId!==r.productId||scope.operation!=='image-generation'||!input||Object.keys(input).sort().join()!=='background,promptSha256,quality,size,version'||input.version!==1||!/^[a-f0-9]{64}$/.test(input.promptSha256)||!['auto','1024x1024','1536x1024','1024x1536'].includes(input.size)||!['auto','low','medium','high'].includes(input.quality)||!['auto','opaque','transparent'].includes(input.background)||r.requestFingerprint!==imageRequestFingerprint(r,input))throw new UserFacingError('生图请求冻结身份无效');}
  return r;
}
export function saveImageRequestIntent(db:DatabaseSync,intent:ImageRequestIntent):void{
  const value=parseImageRequest(intent);db.prepare('INSERT INTO ai_image_requests(id,record_json) VALUES(?,?)').run(value.id,JSON.stringify(value));
}
export function readImageRequestIntent(db:DatabaseSync,id:string):ImageRequestIntent|null{
  const row=db.prepare('SELECT record_json FROM ai_image_requests WHERE id=?').get(id);if(!row)return null;const value=parseImageRequest(JSON.parse(String(row.record_json)));if(value.id!==id)throw new UserFacingError('生图请求身份不一致');return value;
}

/** Only a recorded, matching HTTP denial is a terminal authentication failure. */
export function confirmedAuthenticationRejection(db:DatabaseSync,call:import('../../shared/ai-contracts.ts').AiCall):boolean {
 if(call.status!=='FAILED'||call.errorCode!=='AUTH_FAILED'||!call.providerReceiptId)return false;
 const row=db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(call.providerReceiptId);if(!row)return false;
 try {const r=parse(JSON.parse(String(row.record_json)));return r.id===call.providerReceiptId&&r.callId===call.id&&r.model===call.model&&r.gateway===(call.providerId.startsWith('openrouter')?'openrouter':'deepseek')&&(r.gateway==='openrouter'?r.status===401:[401,403].includes(r.status));}catch{return false;}
}

/** A legacy, definitively rejected region request may use the corrected provider policy once.
 * Read only the bounded error receipt and verify identity/hash; no raw text crosses IPC.
 */
export function confirmedForbiddenRejection(db:DatabaseSync,call:import('../../shared/ai-contracts.ts').AiCall):boolean {
 return readConfirmedForbidden(db,call)!==null;
}
export function confirmedLegacyRegionRejection(db:DatabaseSync,call:import('../../shared/ai-contracts.ts').AiCall):boolean {
 return call.errorCode==='AUTH_FAILED'&&readConfirmedForbidden(db,call)?.body?.error?.message==='This model is not available in your region.';
}
function readConfirmedForbidden(db:DatabaseSync,call:import('../../shared/ai-contracts.ts').AiCall):any|null {
 if(call.status!=='FAILED'||!['AUTH_FAILED','MODEL_REGION_RESTRICTED','ROUTING_FORBIDDEN','SERVICE_PERMISSION_REQUIRED'].includes(call.errorCode??'')||!call.providerId.startsWith('openrouter')||!call.providerReceiptId)return null;
 try{
  const row=db.prepare('SELECT record_json FROM ai_provider_receipts WHERE id=?').get(call.providerReceiptId);if(!row)return null;
  const r=parse(JSON.parse(String(row.record_json)));if(r.id!==call.providerReceiptId||r.callId!==call.id||r.model!==call.model||r.gateway!=='openrouter'||r.status!==403||r.endpoint!==(call.purposeSnapshot?.capability.endpoint==='decisions'?'/api/alpha/decisions':'/api/v1/chat/completions')||r.byteSize>65536)return null;
  const file=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;if(typeof file!=='string'||!file)return null;
  const directory=dirname(file),folder=lstatSync(join(directory,'ai-receipts'));if(!folder.isDirectory()||folder.isSymbolicLink())return null;
  const path=join(directory,r.relativePath),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==r.byteSize)return null;
  const bytes=readFileSync(path);if(hash(bytes)!==r.sha256)return null;
  const receipt=JSON.parse(bytes.toString('utf8'));
  return receipt.callId===call.id&&receipt.model===call.model&&receipt.gateway==='openrouter'&&receipt.endpoint===r.endpoint&&receipt.status===403&&receipt.receivedAt===r.receivedAt&&receipt.requestId===r.requestId&&typeof receipt.body?.error?.message==='string'&&receipt.body.error.message.trim()&&(!('code' in receipt.body.error)||receipt.body.error.code===403)?receipt:null;
 }catch{return null;}
}
