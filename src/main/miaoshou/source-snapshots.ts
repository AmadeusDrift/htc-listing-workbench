import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MiaoshouProduct, MiaoshouReceipt } from '../../shared/miaoshou-contracts.ts';
import { validateMiaoshouReceipt } from './validation.ts';
import { UserFacingError } from '../../shared/errors.ts';

export const SOURCE_TABLES={source_snapshots:['id','record_json'],product_source_adoptions:['id','record_json'],product_fact_scopes:['id','record_json']};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function sourceIdentity(snapshot:MiaoshouProduct,accountScope:string,mode:string):string {
  const identities=new Set<string>();
  for(const source of snapshot.sources){
    try{
      const url=new URL(source.sourceItemUrl),match=/^\/offer\/(\d+)\.html$/.exec(url.pathname);
      if(url.protocol==='https:'&&!url.username&&!url.password&&/(^|\.)1688\.com$/i.test(url.hostname)&&match
        &&(!source.sourceItemId||source.sourceItemId===match[1]))identities.add('1688:'+match[1]);
    }catch{/* Missing reliable supplier identity stays scoped to the collection record. */}
  }
  return hash(JSON.stringify([mode,accountScope,identities.size===1?[...identities][0]:'collection:'+snapshot.remoteId]));
}
export interface SourceSnapshot {version:1;id:string;identity:string;receipt:MiaoshouReceipt}
export function saveSourceSnapshot(db:DatabaseSync,receipt:MiaoshouReceipt):SourceSnapshot {
  const parsed=validateMiaoshouReceipt(receipt),id=hash('source/v1:'+parsed.fingerprint);
  const previous=readSourceSnapshot(db,id);if(previous){if(previous.receipt.productId!==parsed.productId)throw new UserFacingError('来源版本归属冲突');return previous;}
  const record:SourceSnapshot={version:1,id,identity:sourceIdentity(parsed.snapshot,parsed.accountScope,parsed.mode),receipt:parsed};
  db.prepare('INSERT INTO source_snapshots(id,record_json) VALUES(?,?)').run(id,JSON.stringify(record));return record;
}
export function readSourceSnapshot(db:DatabaseSync,id:string):SourceSnapshot|null {
  const row=db.prepare('SELECT record_json FROM source_snapshots WHERE id=?').get(id);if(!row)return null;
  const value=JSON.parse(String(row.record_json)) as SourceSnapshot;
  if(value.version!==1||value.id!==id||Object.keys(value).sort().join()!=='id,identity,receipt,version')throw new UserFacingError('来源版本记录无效');
  value.receipt=validateMiaoshouReceipt(value.receipt);
  if(hash('source/v1:'+value.receipt.fingerprint)!==id||value.identity!==sourceIdentity(value.receipt.snapshot,value.receipt.accountScope,value.receipt.mode))throw new UserFacingError('来源版本指纹不一致');
  return value;
}
