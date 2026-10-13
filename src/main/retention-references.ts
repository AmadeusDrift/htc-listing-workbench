import { CompletionJournal, completionOperations } from './listing-ai/completion-journal.ts';
import type { DatabaseSync } from 'node:sqlite';
/** Read authoritative owner records, including newly registered module tables. Never
 * trust a possibly stale reference projection when deciding to delete evidence. */
export function referencedDatabaseValues(db:DatabaseSync,needles:readonly string[],exclude:readonly string[]=[]):Set<string>{
 const wanted=new Set(needles),found=new Set<string>();
 const inspect=(value:unknown):void=>{if(typeof value==='string'){if(wanted.has(value))found.add(value);for(const id of value.matchAll(/[a-f0-9]{8}-[a-f0-9-]{27}/g))if(wanted.has(id[0]))found.add(id[0]);}else if(Array.isArray(value)){for(const item of value)inspect(item);}else if(value&&typeof value==='object'){for(const [key,item] of Object.entries(value)){inspect(key);inspect(item);}}};
 for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
 const name=String(table.name);if(exclude.includes(name)||!/^[a-z_]+$/.test(name))continue;
 const columns=db.prepare(`PRAGMA table_info("${name}")`).all().filter(c=>String(c.type).toUpperCase()==='TEXT').map(c=>String(c.name));if(!columns.length)continue;
 for(const row of db.prepare(`SELECT ${columns.map(c=>'"'+c+'"').join(',')} FROM "${name}"`).iterate())for(const value of Object.values(row)){
 if(typeof value!=='string')continue;inspect(value);
 if(value.startsWith('{')||value.startsWith('[')){try{inspect(JSON.parse(value));}catch{return new Set(needles);}}
 }
 }return found;
}
export function databaseReferences(db:DatabaseSync,needles:readonly string[],exclude:readonly string[]=[]):boolean{return referencedDatabaseValues(db,needles,exclude).size>0;}
export function protectedDraftIds(db:DatabaseSync):Set<string>{
 const rows=db.prepare('SELECT id,state,record_json FROM listing_drafts').all(),protectedIds=referencedDatabaseValues(db,rows.map(row=>String(row.id)),['listing_drafts','issues','amazon_exchanges','audit_events','listing_completion_operations','ai_calls','ai_results','ai_usage_ledger']);
 const journal=new CompletionJournal(db);for(const op of completionOperations(db))if(journal.unknown(op.id))protectedIds.add(op.draftId);
 for(const row of rows)if(['UNKNOWN','SUBMITTING','SENDING'].includes(String(row.state)))protectedIds.add(String(row.id));return protectedIds;
}

