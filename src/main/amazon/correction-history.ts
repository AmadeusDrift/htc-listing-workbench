import type {DatabaseSync} from 'node:sqlite';
import type {ListingCorrection,ListingCorrectionAttempt} from '../../shared/listing-correction-contracts.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {correctionHash} from './corrections.ts';

export const CORRECTION_TABLES={listing_corrections:['id','draft_id','listing_hash','record_json'],listing_correction_attempts:['id','correction_id','record_json']};
const has=(db:DatabaseSync,table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
export function assertCorrectionHistory(db:DatabaseSync){
 for(const row of db.prepare('SELECT * FROM listing_corrections').all()){
  const c=JSON.parse(String(row.record_json)) as ListingCorrection;
  if(c.id!==row.id||c.draftId!==row.draft_id||c.listingHash!==row.listing_hash||correctionHash(c.request)!==c.patchHash||!Number.isSafeInteger(c.revision)||c.revision<1||!['PREPARED','READY','SENDING','ACCEPTED','VERIFIED','REJECTED','STALE','CANCELLED','UNKNOWN'].includes(c.state))throw new UserFacingError('修正历史身份或请求指纹无效');
 }
 for(const row of db.prepare('SELECT * FROM listing_correction_attempts').all()){
  const a=JSON.parse(String(row.record_json)) as ListingCorrectionAttempt,crow=db.prepare('SELECT record_json FROM listing_corrections WHERE id=?').get(a.correctionId);
  if(!crow)throw new UserFacingError('修正发送历史缺少所属修正案');const c=JSON.parse(String(crow.record_json)) as ListingCorrection;
  if(a.id!==row.id||a.correctionId!==row.correction_id||a.listingHash!==c.listingHash||correctionHash(a.request)!==a.patchHash||a.patchHash!==c.patchHash||['PREPARED','READY','CANCELLED','STALE'].includes(c.state)||a.identity.sku!==c.sku||a.identity.sellerId!==c.sellerId||a.identity.marketplaceId!==c.marketplaceId||a.identity.draftId!==c.draftId)throw new UserFacingError('修正发送历史与冻结请求不一致');
 }
}
/** Terminal attempt tombstones survive retention and a restore whose original draft is absent. */
export function retainCorrectionHistory(current:DatabaseSync,snapshot:DatabaseSync){
 if(!has(current,'listing_corrections'))return;
 for(const row of current.prepare('SELECT * FROM listing_corrections').all()){
  const c=JSON.parse(String(row.record_json)) as ListingCorrection,old=snapshot.prepare('SELECT record_json FROM listing_corrections WHERE id=?').get(c.id);
  const prior=old?JSON.parse(String(old.record_json)) as ListingCorrection:null;
  const sent=current.prepare('SELECT * FROM listing_correction_attempts WHERE correction_id=?').get(c.id);
  if(!sent&&prior)continue;
  if(sent&&prior&&prior.patchHash!==c.patchHash){c.state='UNKNOWN';c.message='恢复中发现修正请求历史冲突；禁止重发';c.revision++;}
  if(c.state==='SENDING'){c.state='UNKNOWN';c.revision++;c.message='恢复时修正发送未完成；禁止重发';}
  if(['PREPARED','READY'].includes(c.state)){c.state='STALE';c.readyAt=null;c.revision++;c.message='恢复后修正基线及授权失效';}
  snapshot.prepare('INSERT INTO listing_corrections(id,draft_id,listing_hash,record_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(c.id,c.draftId,c.listingHash,JSON.stringify(c));
  if(sent){const a=JSON.parse(String(sent.record_json)) as ListingCorrectionAttempt;a.state=c.state;snapshot.prepare('INSERT INTO listing_correction_attempts(id,correction_id,record_json) VALUES(?,?,?) ON CONFLICT(correction_id) DO UPDATE SET record_json=excluded.record_json').run(a.id,c.id,JSON.stringify(a));}
  if(['UNKNOWN','ACCEPTED'].includes(c.state))snapshot.prepare("INSERT INTO amazon_write_locks(listing_hash,draft_id,state,created_at,owner_kind,owner_id) VALUES(?,?,'UNKNOWN',?,'correction',?) ON CONFLICT(listing_hash) DO UPDATE SET state='UNKNOWN'").run(c.listingHash,c.draftId,c.createdAt,c.id);
 }
}
export function invalidateCorrectionAuthorizations(db:DatabaseSync){
 db.exec(`UPDATE listing_corrections SET record_json=json_set(record_json,'$.state','STALE','$.readyAt',NULL,'$.revision',json_extract(record_json,'$.revision')+1,'$.message','恢复后修正基线及授权失效') WHERE json_extract(record_json,'$.state') IN ('PREPARED','READY');
 UPDATE listing_corrections SET record_json=json_set(record_json,'$.state','UNKNOWN','$.revision',json_extract(record_json,'$.revision')+1,'$.message','修正发送曾中断；禁止重发') WHERE json_extract(record_json,'$.state')='SENDING';
 UPDATE listing_correction_attempts SET record_json=json_set(record_json,'$.state','UNKNOWN') WHERE json_extract(record_json,'$.state')='SENDING';
 UPDATE amazon_write_locks SET state='UNKNOWN' WHERE owner_kind='correction' AND state='SENDING';`);
}
