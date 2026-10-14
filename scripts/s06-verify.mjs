import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';

const files=['tests/mixed-kit-adoption.test.ts','tests/mixed-kit-units.test.ts','tests/source-quantity.test.ts','tests/sales-recipes.test.ts','tests/source-sales-purpose.test.ts','tests/automatic-pricing-resume.test.ts','tests/sales-plans.test.ts','tests/sales-family-binding.test.ts','tests/sales-draft-identity.test.ts','tests/pricing-actual-offer.test.ts','tests/amazon-business-rules.test.ts','tests/automatic-adaptation.test.ts','tests/mixed-kit-image-recheck.test.ts','tests/sales-unit-ipc.test.ts','tests/release-api-surface.test.ts','tests/mixed-kit-unit-restore.test.ts'];
const mode=process.argv[2],label=process.argv[3]??'core-p1';
if(!['related','typecheck','boundaries','ui'].includes(mode)||!/^[a-z0-9-]+$/u.test(label))throw Error('Use related/typecheck/boundaries/ui with a safe log label');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
const sourceCommit=git('rev-parse','HEAD'),worktreeStatus=git('status','--short');
if(worktreeStatus)throw Error('S06 verification requires a clean committed source');
const require=createRequire(import.meta.url),{worktreeRoot,assertTrustedWithin}=require(resolve('tests/fixtures/stabilization/trusted-path.cjs'));
const dataRoot=resolve('.test-data/stabilization'),output=resolve('artifacts/stabilization/s06');
for(const path of [dataRoot,output]){assertTrustedWithin(worktreeRoot,path);await mkdir(path,{recursive:true});assertTrustedWithin(worktreeRoot,path);}
process.env.HTC_STABILIZATION_DATA_DIR=dataRoot;require(resolve('tests/fixtures/stabilization/network-guard.cjs'));
const hashes={};
for(const file of [...git('ls-files','--','src','tests').split('\n'),'scripts/s06-verify.mjs','package.json','package-lock.json'])hashes[file]=createHash('sha256').update(await readFile(resolve(file))).digest('hex');
const args=mode==='related'||mode==='ui'?['--test','--test-concurrency=1',...(mode==='ui'?['tests/sales-unit-owner-ui.test.ts']:files)]:[resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'run',mode==='typecheck'?'typecheck':'check:boundaries'];
const startedAt=new Date().toISOString(),stem=resolve(output,`${mode}-${label}`),history=resolve(output,'history');
assertTrustedWithin(worktreeRoot,history);await mkdir(history,{recursive:true});
for(const extension of ['log','json']){const path=`${stem}.${extension}`,archived=resolve(history,`${mode}-${label}-${startedAt.replaceAll(':','-')}.${extension}`);assertTrustedWithin(worktreeRoot,path);assertTrustedWithin(worktreeRoot,archived);try{await copyFile(path,archived);}catch(error){if(error.code!=='ENOENT')throw error;}}
const env={...process.env,NODE_OPTIONS:`--require="${resolve('tests/fixtures/stabilization/network-guard.cjs').replaceAll('\\','/')}"`};delete env.ELECTRON_RUN_AS_NODE;
const log=createWriteStream(`${stem}.log`),child=spawn(process.execPath,args,{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const evidence={version:1,sourceCommit,worktreeStatus,sourceTrees:{src:git('rev-parse','HEAD:src'),tests:git('rev-parse','HEAD:tests'),scripts:git('rev-parse','HEAD:scripts')},hashes,mode,label,executable:process.execPath,args,startedAt,node:process.version,dataRoot,logPath:`${stem}.log`,runnerPid:process.pid,childPid:child.pid,networkPolicy:'S00 preload; synthetic data; loopback-only; inherited service credentials removed'};
await writeFile(`${stem}.json`,JSON.stringify({...evidence,status:'running'},null,2));child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
const exitCode=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});await new Promise(done=>log.end(done));
const postHashes={};for(const file of Object.keys(hashes))postHashes[file]=createHash('sha256').update(await readFile(resolve(file))).digest('hex');
const postSourceCommit=git('rev-parse','HEAD'),postWorktreeStatus=git('status','--short');
const sourceUnchanged=postSourceCommit===sourceCommit&&!postWorktreeStatus&&Object.keys(hashes).every(file=>hashes[file]===postHashes[file]);
await writeFile(`${stem}.json`,JSON.stringify({...evidence,status:'completed',finishedAt:new Date().toISOString(),exitCode,postSourceCommit,postWorktreeStatus,postHashes,sourceUnchanged},null,2));
console.log(JSON.stringify({sourceCommit,mode,exitCode,sourceUnchanged,metadata:`${stem}.json`}));process.exitCode=sourceUnchanged?(exitCode??1):1;
