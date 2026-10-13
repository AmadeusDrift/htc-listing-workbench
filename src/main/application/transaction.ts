import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { UserFacingError } from '../../shared/errors.ts';

let nextSavepoint=0;
/** Local, synchronous owner writes on one connection. Never await network in this boundary. */
export function transaction<T>(db:DatabaseSync,work:()=>T):T {
  const invalid=()=>new UserFacingError('事务只接受同步回调，不允许 async/Promise 或网络等待');
  if(types.isAsyncFunction(work))throw invalid();
  const savepoint=db.isTransaction?`htc_owner_${++nextSavepoint}`:null;
  db.exec(savepoint?`SAVEPOINT ${savepoint}`:'BEGIN IMMEDIATE');
  try {
    const result=work();
    if(result!==null&&(typeof result==='object'||typeof result==='function')&&typeof (result as {then?:unknown}).then==='function')throw invalid();
    db.exec(savepoint?`RELEASE SAVEPOINT ${savepoint}`:'COMMIT');
    return result;
  } catch(error) {
    db.exec(savepoint?`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`:'ROLLBACK');
    throw error;
  }
}
