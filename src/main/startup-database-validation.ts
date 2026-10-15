import { statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Observer = { db: DatabaseSync; identity: string; proofs: Map<string,string> };
type StartupScope = { active: boolean; observers: Map<string,Observer> };
let startup: StartupScope | undefined;

/** Only the synchronous startup constructor segment may reuse history validation. */
export function beginDatabaseStartupValidation(): () => void {
  if (startup) throw new Error('Database startup validation already active');
  const scope: StartupScope = { active:true, observers:new Map() };
  startup=scope;
  return () => {
    scope.active=false;
    if(startup===scope)startup=undefined;
    for(const observer of scope.observers.values())try{observer.db.close();}catch{/* Never obstruct startup error handling. */}
    scope.observers.clear();
  };
}
function stamp(scope: StartupScope,path:string): { observer:Observer; token:string } | undefined {
  try {
    const file=statSync(path,{bigint:true});
    const identity=`${file.dev}:${file.ino}:${file.birthtimeNs}`;
    let observer=scope.observers.get(path);
    if(observer&&observer.identity!==identity){observer.db.close();scope.observers.delete(path);observer=undefined;}
    if(!observer){observer={db:new DatabaseSync(path,{readOnly:true}),identity,proofs:new Map()};scope.observers.set(path,observer);}
    const before=observer.db.prepare('PRAGMA data_version').get()!.data_version;
    const schema=observer.db.prepare('PRAGMA schema_version').get()!.schema_version;
    const user=observer.db.prepare('PRAGMA user_version').get()!.user_version;
    const after=observer.db.prepare('PRAGMA data_version').get()!.data_version;
    if(before!==after)return undefined;
    return {observer,token:`${identity}:${file.size}:${file.mtimeNs}:${file.ctimeNs}:${before}:${schema}:${user}`};
  } catch {
    const observer=scope.observers.get(path);
    if(observer)try{observer.db.close();}catch{/* Fallback is the ordinary full validator. */}
    scope.observers.delete(path);
    return undefined;
  }
}
/** This proof only suppresses repeated startup scans, never authorizes an external effect. */
export function validateStartupHistory(directory:string,check:string,validate:()=>void):void {
  const scope=startup;
  if(!scope?.active){validate();return;}
  const path=join(resolve(directory),'red.sqlite');
  const before=stamp(scope,path);
  if(before&&before.observer.proofs.get(check)===before.token)return;
  before?.observer.proofs.delete(check);
  validate();
  if(!scope.active)return;
  const after=stamp(scope,path);
  if(before&&after&&before.observer===after.observer&&before.token===after.token)after.observer.proofs.set(check,after.token);
}
