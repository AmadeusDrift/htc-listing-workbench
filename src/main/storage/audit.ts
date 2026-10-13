import type { DatabaseSync } from 'node:sqlite';

/** Common append-only audit port. Uses the caller connection, so enclosing owner writes roll back together. */
export function appendAuditEvent(db:DatabaseSync,id:string,productId:string|null,action:string,summary:string,detailJson:string,at:string):void {
  db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(id,productId,action,summary,detailJson,at);
}
