import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AiSpendReceiptProof} from '../../shared/ai-spend-contracts.ts';
import type {ProviderReceipt} from './receipts.ts';
import type {ProviderReceiptCapture} from './transport.ts';
import {providerReceiptFiles} from './receipts.ts';
import {openRouterReceiptState} from './adapters/openrouter-http.ts';
import {decodeOpenRouterImage} from './adapters/openrouter-images.ts';
import {spendHash,spendInvalid,spendObject} from './spend-records.ts';

const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const prepared=new WeakSet<object>();
export function assertPreparedSpendReceiptProof(proof:AiSpendReceiptProof):void{if(!prepared.has(proof))spendInvalid();}
/** Called after the actual private receipt is saved, before entering the monetary write transaction. */
export function prepareImageSpendReceiptProof(record:ProviderReceipt,capture:ProviderReceiptCapture):AiSpendReceiptProof{
 const bytes=Buffer.from(JSON.stringify({version:1,callId:record.callId,purpose:null,...capture}));
 if(record.gateway!=='openrouter'||record.endpoint!=='/api/v1/images'||record.gateway!==capture.gateway||record.endpoint!==capture.endpoint||record.model!==capture.model||record.status!==capture.status||record.requestId!==capture.requestId||record.receivedAt!==capture.receivedAt||record.costUsd!==capture.costUsd||record.sha256!==hash(bytes)||record.byteSize!==bytes.length||record.id!==hash(record.callId+':'+record.sha256))spendInvalid();
 const state=Object.hasOwn(capture,'body')?openRouterReceiptState(capture.status,capture.body):'unknown';
 let certainty:AiSpendReceiptProof['certainty']=state==='unknown'?'SENT_UNKNOWN':state==='rejected'?'DEFINITIVE_REJECTION':state==='invalid'?'RECEIVED_INVALID':'RECEIVED_VALID';
 if(certainty==='RECEIVED_VALID')try{decodeOpenRouterImage(capture.body);}catch{certainty='RECEIVED_INVALID';}
 const proof=Object.freeze({receiptId:record.id,sha256:record.sha256,certainty});prepared.add(proof);return proof;
}
export function validateSpendReceiptProof(raw:unknown):AiSpendReceiptProof{
 const r=spendObject(raw,['receiptId','sha256','certainty']);spendHash(r.receiptId);spendHash(r.sha256);if(!['SENT_UNKNOWN','RECEIVED_INVALID','RECEIVED_VALID','DEFINITIVE_REJECTION'].includes(r.certainty))spendInvalid();return r as AiSpendReceiptProof;
}
/** Backup verification only: private file I/O is forbidden inside a monetary transaction. */
export function readImageSpendReceiptProof(db:DatabaseSync,root:string,receiptId:string):AiSpendReceiptProof{
 if(db.isTransaction)spendInvalid();const record=providerReceiptFiles(db).find(r=>r.id===receiptId);if(!record||record.relativePath!==`ai-receipts/${receiptId}.json`)spendInvalid();
 const folder=lstatSync(join(root,'ai-receipts'));if(!folder.isDirectory()||folder.isSymbolicLink())spendInvalid();const path=join(root,record.relativePath),before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==record.byteSize)spendInvalid();
 const bytes=readFileSync(path),after=lstatSync(path);if(bytes.length!==record.byteSize||hash(bytes)!==record.sha256||before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs)spendInvalid();
 const raw=JSON.parse(bytes.toString('utf8'));if(raw.version!==1||raw.callId!==record.callId||raw.purpose!==null)spendInvalid();const {version:_v,callId:_c,purpose:_p,...capture}=raw;return prepareImageSpendReceiptProof(record,capture);
}
