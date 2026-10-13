import type { DatabaseSync } from 'node:sqlite';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
/** Main-only owner command: the result and caller's domain writes share one transaction. */
export interface TaskResultPort {
 prepare(db:DatabaseSync,command:{kind:'selected-firmness'|'fixed-brand';before:AmazonDraft;operationId:string}):{
  commit(after:AmazonDraft,remaining?:string[]):void;
 };
}
