import type { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from '../../shared/errors.ts';

/** M09 metadata registration. Caller owns bytes, approval and the enclosing transaction. */
export function registerGeneratedAsset(db:DatabaseSync,input:{id:string;productId:string;fileName:string;width:number;height:number;byteSize:number;sha256:string;at:string}):void {
  if(!db.isTransaction)throw new UserFacingError('素材登记必须加入调用方事务');
  const {id,productId,fileName,width,height,byteSize,sha256,at}=input;
  db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,productId,fileName,'gallery','image/png',width,height,byteSize,`assets/${id}.png`,`assets/${id}.preview.png`,sha256,at);
}
