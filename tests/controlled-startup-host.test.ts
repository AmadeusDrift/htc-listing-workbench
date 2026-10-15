import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

for(const mode of ['controlled','ordinary']as const)test(`actual main startup ${mode==='controlled'?'preserves unrelated managed backup bytes and registry':'still removes its expired managed backup by the original policy'}`,{timeout:30000},()=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const out=mkdtempSync(resolve('.test-data/s08-startup-host-report-')),reportPath=join(out,'report.json'),env={...process.env,HTC_STABILIZATION_DATA_DIR:out};
 const child=spawnSync(process.execPath,['--require',resolve('tests/fixtures/stabilization/network-guard.cjs'),'tests/fixtures/controlled-startup-host.mjs',mode,reportPath],{cwd:resolve('.'),env,windowsHide:true,encoding:'utf8',timeout:25000});
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr);const report=JSON.parse(readFileSync(reportPath,'utf8'));
 assert.equal(report.windowReached,true,'must reach real index after the housekeeping boundary');assert.equal(report.external,0);assert.equal(report.controlled,mode==='controlled');assert.ok(report.messages.some((message:string)=>message.includes('ISOLATED_STOP_AFTER_STARTUP_HOUSEKEEPING')));
 if(mode==='controlled'){assert.equal(report.after.backupPresent,true);assert.equal(report.after.backupSha256,report.before.backupSha256);assert.equal(report.after.registry,report.before.registry);}
 else{assert.equal(report.after.backupPresent,false);assert.equal(report.after.backupSha256,null);assert.deepEqual(JSON.parse(report.after.registry),{version:1,backups:[]});}
});
