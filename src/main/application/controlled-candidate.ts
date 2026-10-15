import {createHash} from 'node:crypto';
import {createReadStream,lstatSync,realpathSync,readdirSync,readFileSync} from 'node:fs';
import type {Stats} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {UserFacingError} from '../../shared/errors.ts';
import {parseUnambiguousJson} from '../collection/validation.ts';

export interface ControlledCandidateIdentity {sourceCommit:string;sourceDigest:string;executableSha256:string;packageManifestSha256:string}
export interface VerifiedControlledCandidate {readonly identity:Readonly<ControlledCandidateIdentity>;assertUnchanged():void}
const verified=new WeakSet<object>(),canonical=(path:string)=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const fail=():never=>{throw new UserFacingError('受控验收候选文件、来源或完整性不匹配；未发送');};
const same=(a:Stats,b:Stats)=>b.isFile()&&!b.isSymbolicLink()&&b.nlink===1&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
function safe(root:string,path:string,file=true):Stats{
 if(canonical(realpathSync.native(root))!==canonical(root))fail();
 const rel=relative(root,path);if(rel.startsWith('..')||rel.includes(':'))fail();let at=root;
 for(const part of rel.split(/[\\/]/).filter(Boolean)){at=join(at,part);const stat=lstatSync(at);if(stat.isSymbolicLink()||canonical(realpathSync.native(at))!==canonical(at)||at!==path&&!stat.isDirectory())fail();}
 const stat=lstatSync(path);if(file&&(!stat.isFile()||stat.nlink!==1))fail();return stat;
}
function paths(root:string,at=root):string[]{return readdirSync(at,{withFileTypes:true}).flatMap(entry=>{const path=join(at,entry.name);safe(root,path,false);if(entry.isDirectory())return paths(root,path);if(!entry.isFile())fail();return[relative(root,path).replaceAll('\\','/')];});}
export function assertVerifiedControlledCandidate(candidate:VerifiedControlledCandidate):void{if(!verified.has(candidate))fail();candidate.assertUnchanged();}
/** Verification uses actual files, not the diagnostics' reported provenance.
 * Root still reviews this exact candidate and digest; no renderer supplies it. */
export async function verifyControlledCandidate(appPath:string,executable:string):Promise<VerifiedControlledCandidate>{
 try{
  const root=resolve(appPath,'..','..');if(canonical(appPath)!==canonical(join(root,'resources/app'))||canonical(executable)!==canonical(join(root,'HTC.exe')))fail();
  const manifestPath=join(root,'版本与摘要.json'),manifestStat=safe(root,manifestPath);if(manifestStat.size>4*1024*1024)fail();const manifestBytes=readFileSync(manifestPath),m:any=parseUnambiguousJson(manifestBytes,4*1024*1024);if(!same(manifestStat,safe(root,manifestPath)))fail();
  if(m.schema!=='htc-package/v1'||!m.source||!/^[a-f0-9]{40}$/.test(m.source.commit)||!/^[a-f0-9]{64}$/.test(m.source.sourceDigest)||m.build?.schema!=='htc-build/v1'||m.build.sourceCommit!==m.source.commit||m.build.sourceDigest!==m.source.sourceDigest||!Array.isArray(m.files)||!m.files.length||m.files.length>20_000||!Array.isArray(m.build.files))fail();
  const snapshots=new Map<string,Stats>([[manifestPath,manifestStat]]),entries=new Map<string,any>();let total=0;
  for(const file of m.files){if(!file||typeof file.path!=='string'||!file.path||file.path.includes('\\')||file.path.split('/').some((p:string)=>!p||p==='.'||p==='..'||p.includes(':'))||entries.has(file.path)||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256))fail();entries.set(file.path,file);const path=join(root,file.path),before=safe(root,path);total+=before.size;if(before.size!==file.size||total>4*1024*1024*1024)fail();const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);if(hash.digest('hex')!==file.sha256||!same(before,safe(root,path)))fail();snapshots.set(path,before);}
  for(const required of ['HTC.exe','resources/app/package.json','resources/app/dist-electron/main.cjs','resources/app/dist-electron/preload.cjs','resources/app/dist/index.html'])if(!entries.has(required))fail();
  for(const file of m.build.files){if(typeof file.path!=='string'||!file.path.startsWith('dist/')&&!file.path.startsWith('dist-electron/'))fail();if(file.path.endsWith('.map'))continue;const actual=entries.get('resources/app/'+file.path);if(!actual||actual.size!==file.size||actual.sha256!==file.sha256)fail();}
  for(const required of ['dist-electron/main.cjs','dist-electron/preload.cjs','dist/index.html'])if(!m.build.files.some((file:any)=>file.path===required))fail();
  const actual=paths(root).filter(path=>path!=='版本与摘要.json').sort();if(JSON.stringify(actual)!==JSON.stringify([...entries.keys()].sort()))fail();
  const pkg=JSON.parse(readFileSync(join(appPath,'package.json'),'utf8'));if(pkg.main!=='dist-electron/main.cjs')fail();
  const identity=Object.freeze({sourceCommit:m.source.commit,sourceDigest:m.source.sourceDigest,executableSha256:entries.get('HTC.exe').sha256,packageManifestSha256:createHash('sha256').update(manifestBytes).digest('hex')});
  const result=Object.freeze({identity,assertUnchanged(){try{for(const [path,before]of snapshots)if(!same(before,safe(root,path)))fail();if(paths(root).length!==snapshots.size)fail();}catch{fail();}}});verified.add(result);return result;
 }catch{return fail();}
}
