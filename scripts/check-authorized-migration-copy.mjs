import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,SCHEMA_VERSION} from '../src/main/database.ts';

// Explicit diagnostic input only. Never opens the source database for writing,
// copies credential files, instantiates app services or resumes tasks.
assert.ok(process.argv[2],'Provide an explicitly authorized standalone database snapshot');
const source=resolve(process.argv[2]);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceBefore=digest(await readFile(source));
await mkdir('.test-data',{recursive:true});
const root=await mkdtemp(resolve('.test-data/authorized-migration-'));
const target=join(root,'red.sqlite');
await copyFile(source,target,constants.COPYFILE_EXCL);
function state(path,names){
 const db=new DatabaseSync(path,{readOnly:true});
 try {
  const version=Number(db.prepare('PRAGMA user_version').get().user_version);
  const tables=names??db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'module_migration_journal' ORDER BY name").all().map(row=>String(row.name));
  const records={};
  for(const table of tables){const hash=createHash('sha256');let count=0;
   for(const row of db.prepare('SELECT * FROM "'+table.replaceAll('"','""')+'" ORDER BY rowid').iterate()){
    hash.update(JSON.stringify(row,(_key,value)=>typeof value==='bigint'?value.toString():value)+'\n');count++;
   }
   records[table]={count,sha256:hash.digest('hex')};
  }
  return {version,records};
 } finally {db.close();}
}
const before=state(target);let db;
try{db=openDatabase(root);assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version),SCHEMA_VERSION);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}
finally{db?.close();}
const after=state(target,Object.keys(before.records));
assert.deepEqual(after.records,before.records,'Existing domain records must remain byte-equivalent through the additive migration');
assert.equal(digest(await readFile(source)),sourceBefore,'Authorized source snapshot must remain unchanged');
const report={passed:true,from:before.version,to:after.version,unchangedTables:Object.keys(before.records),counts:Object.fromEntries(Object.entries(before.records).map(([name,value])=>[name,value.count])),sourceSha256:sourceBefore,isolatedCopy:root,scope:'Database-only additive migration of an explicitly authorized snapshot copy; no app services, key files, asset verification, task execution or online checks.'};
await writeFile(join(root,'migration-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
