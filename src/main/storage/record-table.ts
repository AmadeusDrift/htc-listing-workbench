import type { DatabaseSync } from 'node:sqlite';
import { UserFacingError } from '../../shared/errors.ts';
import { assertUnambiguousRecordJson } from '../record-json.ts';

/** Validate the canonical two-column record tables, including their actual uniqueness constraints. */
export function assertRecordTable(db:DatabaseSync,table:string):void{
  if(!/^[a-z_]+$/.test(table))throw new UserFacingError('记录表名无效');
  const columns=db.prepare('SELECT * FROM pragma_table_xinfo(?)').all(table);
  const indexes=db.prepare('SELECT * FROM pragma_index_list(?)').all(table);
  const meta=db.prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND name=?").get(table);
  if(!meta||meta.wr!==0||columns.length!==2||columns.some(c=>!['id','record_json'].includes(String(c.name))||c.type!=='TEXT'||c.notnull!==1||c.hidden!==0||c.dflt_value!==null||c.pk!==(c.name==='id'?1:0))
    ||indexes.length!==1||indexes[0].origin!=='pk'||indexes[0].unique!==1||indexes[0].partial!==0)throw new UserFacingError('来源记录表结构或索引无效');
  const keys=db.prepare('SELECT * FROM pragma_index_xinfo(?) WHERE key=1').all(String(indexes[0].name));
  if(keys.length!==1||keys[0].name!=='id'||keys[0].coll!=='BINARY'||keys[0].desc!==0)throw new UserFacingError('来源记录表索引无效');
  assertUnambiguousRecordJson(db,table);
  if(db.prepare(`SELECT 1 FROM ${table} WHERE typeof(record_json)!='text' OR length(CAST(record_json AS BLOB))>? LIMIT 1`).get(4*1024*1024))throw new UserFacingError('来源记录过大或结构无效');
}
