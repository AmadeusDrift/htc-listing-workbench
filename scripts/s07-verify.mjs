import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';

const related=['tests/source-reference-aliases.test.ts','tests/source-reference-alias-service.test.ts','tests/source-observation-authority.test.ts','tests/listing-source-color.test.ts','tests/source-observations-v2.test.ts','tests/source-color-restore.test.ts','tests/listing-full-schema.test.ts','tests/source-image-consistency.test.ts','tests/source-image-consistency-service.test.ts','tests/source-image-consistency-history.test.ts','tests/source-image-consistency-proof.test.ts','tests/source-image-consistency-gates.test.ts','tests/source-sales-purpose.test.ts','tests/source-empty-eof-projection.test.ts','tests/ai-purpose-routing.test.ts','tests/openrouter-chat.test.ts','tests/openrouter-call-identity.test.ts','tests/provider-receipt-recovery.test.ts','tests/ai-request-identity.test.ts'];
const backups=['tests/ai-backup.test.ts','tests/image-generation-backup.test.ts','tests/image-candidate-backup.test.ts','tests/listing-ai-backup.test.ts','tests/listing-completion-backup.test.ts','tests/backup.test.ts','tests/backup-v2.test.ts','tests/work-batches-backup.test.ts'];
const [mode,label]=process.argv.slice(2);if(!['related','backups','typecheck','boundaries'].includes(mode)||!/^[a-z0-9-]+$/.test(label??''))throw Error('Expected S07 mode and safe label');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim(),sourceCommit=git('rev-parse','HEAD'),worktreeStatus=git('status','--short');if(worktreeStatus)throw Error('S07 verification requires clean committed source');
const require=createRequire(import.meta.url),{worktreeRoot,assertTrustedWithin}=require(resolve('tests/fixtures/stabilization/trusted-path.cjs'));
const dataRoot=resolve('.test-data/s07-alias-guard'),output=resolve('artifacts/stabilization/s07-alias-final');for(const path of [dataRoot,output]){assertTrustedWithin(worktreeRoot,path);await mkdir(path,{recursive:true});}
process.env.HTC_STABILIZATION_DATA_DIR=dataRoot;require(resolve('tests/fixtures/stabilization/network-guard.cjs'));
const files=git('ls-files','--','src','tests','scripts','package.json','package-lock.json').split('\n'),inventory=async()=>{const hashes={};for(const file of files)hashes[file]=createHash('sha256').update(await readFile(resolve(file))).digest('hex');return hashes;};
const hashes=await inventory(),args=['related','backups'].includes(mode)?['--test','--test-concurrency=1',...(mode==='related'?related:backups)]:[resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'run',mode==='typecheck'?'typecheck':'check:boundaries'];
const stem=resolve(output,`${mode}-${label}`);for(const extension of ['json','log']){try{await readFile(`${stem}.${extension}`);throw Error('S07 evidence label already exists');}catch(error){if(error.code!=='ENOENT')throw error;}}
const startedAt=new Date().toISOString(),env={...process.env,NODE_OPTIONS:`--require="${resolve('tests/fixtures/stabilization/network-guard.cjs').replaceAll('\\','/')}"`};delete env.ELECTRON_RUN_AS_NODE;
const log=createWriteStream(`${stem}.log`),child=spawn(process.execPath,args,{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const evidence={version:1,sourceCommit,worktreeStatus,sourceTrees:{src:git('rev-parse','HEAD:src'),tests:git('rev-parse','HEAD:tests'),scripts:git('rev-parse','HEAD:scripts')},hashes,mode,label,executable:process.execPath,args,startedAt,node:process.version,dataRoot,runnerPid:process.pid,childPid:child.pid,networkPolicy:'Original S00 preload; worktree synthetic data; loopback only; inherited credentials removed'};
await writeFile(`${stem}.json`,JSON.stringify({...evidence,status:'running'},null,2));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
const exitCode=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});await new Promise(done=>log.end(done));
const postHashes=await inventory(),postSourceCommit=git('rev-parse','HEAD'),postWorktreeStatus=git('status','--short'),sourceUnchanged=postSourceCommit===sourceCommit&&!postWorktreeStatus&&Object.keys(hashes).every(file=>hashes[file]===postHashes[file]);
await writeFile(`${stem}.json`,JSON.stringify({...evidence,status:'completed',finishedAt:new Date().toISOString(),exitCode,postSourceCommit,postWorktreeStatus,postHashes,sourceUnchanged},null,2));console.log(JSON.stringify({sourceCommit,mode,exitCode,sourceUnchanged,metadata:`${stem}.json`}));process.exitCode=sourceUnchanged?(exitCode??1):1;
