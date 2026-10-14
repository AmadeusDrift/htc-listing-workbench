import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';

const related=['tests/ai-spend-budget.test.ts','tests/ai-spend-receipts.test.ts','tests/controlled-run-scope.test.ts','tests/image-spend-budget.test.ts','tests/image-generation-service.test.ts','tests/image-generation-failures.test.ts','tests/openrouter-images.test.ts','tests/image-retry-allowance.test.ts','tests/module-migrations.test.ts','tests/module-contracts.test.ts','tests/module-transactions.test.ts'];
const backups=['tests/ai-request-identity.test.ts','tests/provider-receipt-recovery.test.ts','tests/ai-backup.test.ts','tests/image-generation-backup.test.ts','tests/image-candidate-backup.test.ts','tests/listing-ai-backup.test.ts','tests/listing-completion-backup.test.ts','tests/backup.test.ts','tests/backup-v2.test.ts','tests/work-batches-backup.test.ts'];
const mode=process.argv[2],label=process.argv[3];if(!['related','backups','typecheck','boundaries'].includes(mode)||!label||!/^[a-z0-9-]+$/.test(label))throw Error('Use related/backups/typecheck/boundaries plus a safe label');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
const sourceCommit=git('rev-parse','HEAD'),worktreeStatus=git('status','--short');if(worktreeStatus)throw Error('S08 verification requires a clean committed source');
const require=createRequire(import.meta.url),{worktreeRoot,assertTrustedWithin}=require(resolve('tests/fixtures/stabilization/trusted-path.cjs'));
const dataRoot=resolve('.test-data/s08-guard'),output=resolve('artifacts/stabilization/s08');for(const path of [dataRoot,output]){assertTrustedWithin(worktreeRoot,path);await mkdir(path,{recursive:true});assertTrustedWithin(worktreeRoot,path);}
process.env.HTC_STABILIZATION_DATA_DIR=dataRoot;require(resolve('tests/fixtures/stabilization/network-guard.cjs'));
const files=git('ls-files','--','src','tests','scripts','package.json','package-lock.json').split('\n'),inventory=async()=>{const hashes={};for(const file of files)hashes[file]=createHash('sha256').update(await readFile(resolve(file))).digest('hex');return hashes;};
const hashes=await inventory(),args=['related','backups'].includes(mode)?['--test','--test-concurrency=1',...(mode==='related'?related:backups)]:[resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'run',mode==='typecheck'?'typecheck':'check:boundaries'];
const startedAt=new Date().toISOString(),stem=resolve(output,`${mode}-${label}`),history=resolve(output,'history');assertTrustedWithin(worktreeRoot,history);await mkdir(history,{recursive:true});for(const extension of ['log','json']){const path=`${stem}.${extension}`,archive=resolve(history,`${mode}-${label}-${startedAt.replaceAll(':','-')}.${extension}`);assertTrustedWithin(worktreeRoot,path);assertTrustedWithin(worktreeRoot,archive);try{await copyFile(path,archive);}catch(error){if(error.code!=='ENOENT')throw error;}}
const env={...process.env,NODE_OPTIONS:`--require="${resolve('tests/fixtures/stabilization/network-guard.cjs').replaceAll('\\','/')}"`};delete env.ELECTRON_RUN_AS_NODE;
const log=createWriteStream(`${stem}.log`),child=spawn(process.execPath,args,{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const evidence={version:1,sourceCommit,worktreeStatus,sourceTrees:{src:git('rev-parse','HEAD:src'),tests:git('rev-parse','HEAD:tests'),scripts:git('rev-parse','HEAD:scripts')},hashes,mode,label,executable:process.execPath,args,startedAt,node:process.version,dataRoot,logPath:`${stem}.log`,runnerPid:process.pid,childPid:child.pid,networkPolicy:'S00 trusted-path preload; this worktree synthetic data; loopback only; inherited credentials removed'};
await writeFile(`${stem}.json`,JSON.stringify({...evidence,status:'running'},null,2));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
const exitCode=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});await new Promise(done=>log.end(done));
const postHashes=await inventory(),postSourceCommit=git('rev-parse','HEAD'),postWorktreeStatus=git('status','--short'),sourceUnchanged=postSourceCommit===sourceCommit&&!postWorktreeStatus&&Object.keys(hashes).every(file=>hashes[file]===postHashes[file]);
await writeFile(`${stem}.json`,JSON.stringify({...evidence,status:'completed',finishedAt:new Date().toISOString(),exitCode,postSourceCommit,postWorktreeStatus,postHashes,sourceUnchanged},null,2));console.log(JSON.stringify({sourceCommit,mode,exitCode,sourceUnchanged,metadata:`${stem}.json`}));process.exitCode=sourceUnchanged?(exitCode??1):1;
