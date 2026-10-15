import { app } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactPixels, previewPixels } from './pixels.ts';

// nativeImage is unavailable in utilityProcess; use a separate Electron main process.
if(!process.send)process.exit(2);
const profile=mkdtempSync(join(tmpdir(),'htc-image-worker-'));
app.setPath('userData',profile);app.setPath('sessionData',join(profile,'session'));
app.disableHardwareAcceleration();
let idle:NodeJS.Timeout;
function armIdle(){clearTimeout(idle);idle=setTimeout(()=>app.quit(),5000);}
process.on('disconnect',()=>app.quit());
app.on('quit',()=>{try{rmSync(profile,{recursive:true,force:true});}catch{/* OS temp may still be held during exit. */}});
app.whenReady().then(()=>{
  process.on('message',(raw:unknown)=>{
    clearTimeout(idle);
    const request=raw as {id?:unknown;kind?:unknown;bytes?:unknown};
    if(request.kind==='close'){app.quit();return;}
    if(!Number.isSafeInteger(request.id)||!Buffer.isBuffer(request.bytes)||request.bytes.length>20*1024*1024){process.send?.({id:request.id,error:'图片本地处理输入无效'});armIdle();return;}
    try {
      if(request.kind!=='preview'&&request.kind!=='artifact')throw Error('图片本地处理类型无效');
      const result=request.kind==='preview'?previewPixels(request.bytes):artifactPixels(request.bytes);
      process.send?.({id:request.id,result});
    } catch(error){process.send?.({id:request.id,error:error instanceof Error?error.message:'图片本地处理失败'});}
    armIdle();
  });
  process.send?.({ready:true});armIdle();
}).catch(()=>app.exit(2));
