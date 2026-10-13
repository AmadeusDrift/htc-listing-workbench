import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('cross-domain orchestrators do not write foreign tables',()=>{
  for(const [file,tables] of [
    ['image-workflow/service.ts',['assets','variant_assets']],
    ['image-upstream-trace.ts',['variant_assets']],
    ['listing-ai/legacy-completion.ts',['image_workflow_runs']],
  ] as const){
    const source=readFileSync(new URL('../src/main/'+file,import.meta.url),'utf8');
    for(const table of tables)assert.doesNotMatch(source,new RegExp('(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+'+table+'\\b','i'),file+' writes '+table);
  }
});
import {scanSql,sqlWrites,ownershipViolations} from '../scripts/sql-ownership.mjs';
import {dataOwner} from '../src/main/storage/owners.ts';
import {writeOwnedSetting} from '../src/main/storage/settings.ts';
import {DatabaseSync} from 'node:sqlite';
const registry=JSON.parse(readFileSync(new URL('../scripts/sql-writer-registry.json',import.meta.url),'utf8'));
test('SQL tokenizer excludes UPSERT SET and handles quoted/schema targets and destructive writes',()=>{
 assert.deepEqual(sqlWrites("INSERT INTO assets VALUES(?) ON CONFLICT(id) DO UPDATE SET title='UPDATE fake SET'; -- DELETE FROM hidden\n"),[{operation:'INSERT',table:'assets'}]);
 assert.deepEqual(sqlWrites('UPDATE main."assets" SET role=?; DELETE FROM [variant_assets]; REPLACE INTO `facts` VALUES(?); ALTER TABLE assets ADD COLUMN x; DROP TABLE IF EXISTS facts;').map(w=>w.table),['assets','variant_assets','facts','assets','facts']);
 assert.deepEqual(sqlWrites('inbox-update-label'),[]);
});
test('gate rejects new cross-domain writes, dynamic SQL and changed existing privileged statement',()=>{
 const check=(file:string,source:string)=>ownershipViolations(scanSql(file,source),registry,(table:string)=>table==='amazon_settings'?'settings':dataOwner(table));
 assert.ok(check('main/ai/new-writer.ts',"db.prepare('UPDATE products SET title=?')").some(e=>e.includes('unregistered')));
 assert.ok(check('main/image-workflow/service.ts',"class X { save(){ db.prepare('INSERT INTO assets VALUES(?)'); } }").some(e=>e.includes('unregistered')));
 assert.ok(check('main/storage/audit.ts',"function appendAuditEvent(){db.prepare('DELETE FROM audit_events');}").some(e=>e.includes('unregistered')));
 assert.ok(check('main/storage/audit.ts',"function appendAuditEvent(){db.prepare('INSERT INTO audit_events VALUES(1,2,3,4,5,6)');}").some(e=>e.includes('changed privileged')));
 assert.ok(check('main/ai/new-writer.ts','db.prepare(`UPDATE ${table} SET title=?`)').some(e=>e.includes('$dynamic')));
 assert.ok(check('main/ai/new-writer.ts','db.prepare(sql)').some(e=>e.includes('unreviewed SQL')));
});
test('shared settings port checks the actual owner/key including appearance policy',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('CREATE TABLE amazon_settings(key TEXT PRIMARY KEY,value_json TEXT)');
 writeOwnedSetting(db,'images','image_appearance_review_v1','{}');
 assert.equal(dataOwner('amazon_settings','image_appearance_review_v1'),'images');
 assert.throws(()=>writeOwnedSetting(db,'ai','image_appearance_review_v1','{}'),/跨所有者/);
 assert.throws(()=>writeOwnedSetting(db,'images','invented_key','{}'),/未登记/);
 assert.equal(db.prepare('SELECT count(*) n FROM amazon_settings').get()!.n,1);
});
test('dynamic schema set additions need both explicit review and a unique owner',()=>{
 const inventory=scanSql('main/miaoshou/source-snapshots.ts',"export const SOURCE_TABLES={source_snapshots:[],product_source_adoptions:[],product_fact_scopes:[],foreign_new_table:[]};");
 const errors=ownershipViolations(inventory,registry,dataOwner);
 assert.ok(errors.some(e=>e.includes('unreviewed dynamic table set')));
 assert.ok(errors.some(e=>e.includes('unowned dynamic table')));
});
