import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const command = process.argv[2];
const label = process.argv[3] ?? '';
if (label && !/^[a-z0-9-]+$/.test(label)) throw Error('Invalid log label');
const runName = command + (label ? '-' + label : '');
const choices = { typecheck: ['run','typecheck'], boundaries: ['run','check:boundaries'], test: ['test'], reproduce: null };
if (!(command in choices)) throw Error('Use typecheck, boundaries, test or reproduce');
if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node 24+ required');
const root = resolve('.test-data/stabilization');
const output = resolve('artifacts/stabilization');
const {worktreeRoot,assertTrustedWithin}=createRequire(import.meta.url)(resolve('tests/fixtures/stabilization/trusted-path.cjs'));
assertTrustedWithin(worktreeRoot,root);assertTrustedWithin(worktreeRoot,output);
await mkdir(root,{recursive:true}); await mkdir(output,{recursive:true});
assertTrustedWithin(worktreeRoot,root);assertTrustedWithin(worktreeRoot,output);
process.env.HTC_STABILIZATION_DATA_DIR = root;
createRequire(import.meta.url)(resolve('tests/fixtures/stabilization/network-guard.cjs'));
const env = { ...process.env, NODE_OPTIONS: `--require="${resolve('tests/fixtures/stabilization/network-guard.cjs').replaceAll('\\','/')}"` };
delete env.ELECTRON_RUN_AS_NODE;
const args = command === 'reproduce' ? ['--test','tests/fixtures/stabilization/reproduce.ts'] : [resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),...choices[command]];
const startedAt = new Date().toISOString();
const logPath = resolve(output,`${runName}.log`);
assertTrustedWithin(worktreeRoot,logPath);assertTrustedWithin(worktreeRoot,resolve(output,`${runName}.json`));
const history=resolve(output,'history');assertTrustedWithin(worktreeRoot,history);
await mkdir(history,{recursive:true});assertTrustedWithin(worktreeRoot,history);
const archivedName=resolve(history,`${runName}-${startedAt.replaceAll(':','-')}`);
for(const extension of ['log','json']) {
  assertTrustedWithin(worktreeRoot,resolve(output,`${runName}.${extension}`));assertTrustedWithin(worktreeRoot,`${archivedName}.${extension}`);
  try { await copyFile(resolve(output,`${runName}.${extension}`),`${archivedName}.${extension}`); } catch(error) { if(error.code!=='ENOENT')throw error; }
}
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const worktreeStatus=execFileSync('git',['status','--short'],{encoding:'utf8',windowsHide:true}).trim();
const hashes={};
for(const path of ['scripts/stabilization-baseline.mjs','tests/stabilization-isolation.test.ts','tests/fixtures/stabilization/network-guard.cjs','tests/fixtures/stabilization/trusted-path.cjs','tests/fixtures/stabilization/reproduce.ts','tests/fixtures/stabilization/review-fixture.ts','tests/fixtures/stabilization/samples.ts']) {
  hashes[path]=createHash('sha256').update(await readFile(resolve(path))).digest('hex');
}
const log = createWriteStream(logPath);
const child = spawn(process.execPath,args,{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const evidence = {command,args,sourceCommit,worktreeStatus,hashes,startedAt,node:process.version,dataRoot:root,logPath,runnerPid:process.pid,childPid:child.pid,externalNetworkPolicy:'loopback-only; no inherited service credentials'};
await writeFile(resolve(output,`${runName}.json`),JSON.stringify({...evidence,status:'running'},null,2));
child.stdout.pipe(log,{end:false}); child.stderr.pipe(log,{end:false});
const code = await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});
await new Promise(done=>log.end(done));
await writeFile(resolve(output,`${runName}.json`),JSON.stringify({...evidence,status:'completed',finishedAt:new Date().toISOString(),exitCode:code},null,2));
console.log(JSON.stringify({command,exitCode:code,logPath}));
process.exitCode = code ?? 1;
