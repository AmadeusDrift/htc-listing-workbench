import {readdir,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readCandidateFiles} from './candidate.ts';
import {hashBackupFile,type BackupFile} from '../backup-stream.ts';
import {RestorePathGuard,writeRestoreFile} from '../restore-paths.ts';
import {UserFacingError} from '../../shared/errors.ts';
export const CANDIDATE_DIRECTORY='image-generation/candidates';
export const candidateBackupPath=(path:string)=>/^image-generation\/candidates\/[a-f0-9-]{36}\/(?:candidate\.json|image\.png|preview\.png)$/.test(path);
/** All retained paid candidates are history, including candidates absent from an older database. */
export async function candidateBackupFiles(root:string):Promise<BackupFile[]>{
 const directory=join(root,CANDIDATE_DIRECTORY);if(!existsSync(directory))return[];
 const guard=new RestorePathGuard(root);guard.assertTree(directory);const files:BackupFile[]=[];
 for(const name of await readdir(directory)){
  if(!/^[a-f0-9-]{36}$/.test(name))continue;
  await readCandidateFiles(root,name);
  for(const part of ['candidate.json','image.png','preview.png']){
   const path=`${CANDIDATE_DIRECTORY}/${name}/${part}`;guard.assertFile(join(root,path));files.push({path,...await hashBackupFile(join(root,path)),role:'generated-candidate'});
  }
 }
 guard.assertTree(directory);return files;
}
export async function retainCandidateFiles(current:string,staging:string):Promise<void>{
 const sourceGuard=new RestorePathGuard(current),targetGuard=new RestorePathGuard(staging);
 if(existsSync(join(current,CANDIDATE_DIRECTORY))&&(await readdir(join(current,CANDIDATE_DIRECTORY))).some(name=>!/^[a-f0-9-]{36}$/.test(name)))throw new UserFacingError('候选目录包含未识别历史文件，未替换或删除');
 for(const file of await candidateBackupFiles(current)){
  const source=join(current,file.path),target=join(staging,file.path);sourceGuard.assertFile(source);
  const bytes=await readFile(source);sourceGuard.assertFile(source);
  if(bytes.length!==file.byteSize||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new UserFacingError('图片候选在恢复期间发生变化');
  if(existsSync(target)){targetGuard.assertFile(target);const actual=await hashBackupFile(target);if(actual.sha256!==file.sha256||actual.byteSize!==file.byteSize)throw new UserFacingError('同一图片候选身份的内容冲突，未覆盖已有成果');}
  else writeRestoreFile(targetGuard,target,bytes);
 }
 await candidateBackupFiles(staging);
}
