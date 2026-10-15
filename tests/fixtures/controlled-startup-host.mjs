// Real bundled main/startup owners; only Electron APIs are stubbed. Not an EXE/UI acceptance.
import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdtempSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
import {candidateFixture} from './controlled-candidate.ts';
import {registerManagedBackup} from '../../src/main/backup-retention.ts';
import {WorkspaceStore} from '../../src/main/store.ts';
import {AmazonService} from '../../src/main/amazon/service.ts';
import {preflightControlledAcceptance} from '../../src/main/application/controlled-startup.ts';
const controlled=process.argv[2]==='controlled',output=resolve(process.argv[3]),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
if(!['controlled','ordinary'].includes(process.argv[2]))throw Error('Expected isolated startup mode');
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const pkg=candidateFixture(),dataRoot=mkdtempSync(resolve('.test-data/s08-backup-startup-')),storage={isEncryptionAvailable:()=>false,encryptString:()=>Buffer.alloc(0),decryptString:()=>''},store=new WorkspaceStore(dataRoot),amazon=new AmazonService(dataRoot,id=>store.getProductSnapshot(id),storage,{preserveHistoricalRecords:true});
amazon.saveDataPolicy({retentionDays:30});amazon.close();store.close();
const snapshotRoot=join(dataRoot,'database-snapshots');mkdirSync(snapshotRoot);const databaseBytes=readFileSync(join(dataRoot,'red.sqlite'));
for(let day=1;day<=11;day++)writeFileSync(join(snapshotRoot,`2026-01-${String(day).padStart(2,'0')}T00-00-00.000Z-${randomUUID()}.sqlite`),databaseBytes);
const snapshots=()=>Object.fromEntries(readdirSync(snapshotRoot).filter(name=>name.endsWith('.sqlite')).map(name=>[name,hash(readFileSync(join(snapshotRoot,name)))])),beforeSnapshots=snapshots();
const backup=join(dataRoot,'old-unrelated.htcbackup'),bytes=Buffer.concat([Buffer.from('HTC-BACKUP-1\n'),Buffer.alloc(100,71)]);writeFileSync(backup,bytes);
await registerManagedBackup(dataRoot,{path:backup,sha256:hash(bytes),byteSize:bytes.length,createdAt:'2026-01-02T00:00:00.000Z',retention:{amazonDays:30,logDays:365,dataOldestAt:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-31T00:00:00.000Z'}});
preflightControlledAcceptance(dataRoot);const registryPath=join(dataRoot,'.backup-registry.json'),beforeRegistry=readFileSync(registryPath,'utf8');
await build({entryPoints:['src/main/index.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:join(pkg.app,'dist-electron/main.cjs'),logLevel:'silent'});
for(const entry of pkg.manifest.files){const b=readFileSync(join(pkg.root,entry.path));entry.size=b.length;entry.sha256=hash(b);}
pkg.manifest.source.commit=source;pkg.manifest.build.sourceCommit=source;pkg.manifest.build.files=pkg.manifest.files.filter(f=>f.path.startsWith('resources/app/dist')).map(f=>({...f,path:f.path.slice('resources/app/'.length)}));writeFileSync(join(pkg.root,'版本与摘要.json'),JSON.stringify(pkg.manifest));
let stop;const finished=new Promise(resolve=>stop=resolve),app=new EventEmitter();let external=0,windowReached=false;
Object.assign(app,{setName(){},enableSandbox(){},getPath(){return dataRoot;},setPath(){},getAppPath(){return pkg.app;},getVersion(){return'2.5.0';},requestSingleInstanceLock(){return true;},whenReady(){return Promise.resolve();},exit(code){stop({code});},quit(){stop({quit:true});}});
const nativeTheme=new EventEmitter();nativeTheme.shouldUseDarkColors=false;
const electron={app,nativeTheme,safeStorage:storage,net:{fetch:async()=>{external++;throw Error('ISOLATED_NO_NETWORK');}},protocol:{registerSchemesAsPrivileged(){},handle(){}},session:{defaultSession:{setPermissionRequestHandler(){},setPermissionCheckHandler(){},resolveProxy:async()=> 'DIRECT'}},dialog:{showErrorBox(){}},BrowserWindow:class{constructor(){windowReached=true;throw Error('ISOLATED_STOP_AFTER_STARTUP_HOUSEKEEPING');}}};
const require=createRequire(import.meta.url),Module=require('node:module'),originalLoad=Module._load,originalExe=process.execPath;
Module._load=function(name,...args){return name==='electron'?electron:originalLoad.call(this,name,...args);};
process.env.RED_DATA_DIR=dataRoot;process.env.RED_E2E='1';if(controlled)process.argv.push('--htc-controlled-acceptance');process.execPath=pkg.exe;
const messages=[],oldError=console.error;console.error=(...args)=>{messages.push(args.map(String).join(' '));};
let afterStartupSnapshots,afterCloseSnapshots,closeReached=false;
try{require(join(pkg.app,'dist-electron/main.cjs'));await Promise.race([finished,new Promise((_,reject)=>setTimeout(()=>reject(Error('ISOLATED_STARTUP_TIMEOUT')),15000))]);afterStartupSnapshots=snapshots();
 let finishClose;const closed=new Promise(resolve=>finishClose=resolve);app.quit=()=>{closeReached=true;finishClose();};app.exit=code=>finishClose({code});app.emit('will-quit',{preventDefault(){}});await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('ISOLATED_CLOSE_TIMEOUT')),15000))]);afterCloseSnapshots=snapshots();}
finally{Module._load=originalLoad;process.execPath=originalExe;console.error=oldError;}
const report={source,testSurface:'Actual bundled index Node host with stubbed Electron APIs; real candidate verifier/cold preflight/constructors/backup owner/startup and will-quit safety snapshots; not actual EXE or UI acceptance',dataRoot,controlled,before:{backupPresent:true,backupSha256:hash(bytes),registry:beforeRegistry,snapshots:beforeSnapshots},after:{backupPresent:existsSync(backup),backupSha256:existsSync(backup)?hash(readFileSync(backup)):null,registry:readFileSync(registryPath,'utf8'),startupSnapshots:afterStartupSnapshots,closeSnapshots:afterCloseSnapshots},windowReached,closeReached,external,messages};
writeFileSync(output,JSON.stringify(report,null,2));process.exit(windowReached&&closeReached&&external===0?0:1);
