import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { UserFacingError } from '../../shared/errors.ts';
import type { DecodedArtifact } from '../image-versions/service.ts';

let child:ChildProcess|undefined,ready:Promise<ChildProcess>|undefined;
let tail:Promise<unknown>=Promise.resolve(),sequence=0,closed=false;
let rejectActive:((error:Error)=>void)|undefined;
const localFailure=()=>new UserFacingError('图片后台本地处理未完成；原生图请求未重新发送');
function worker():Promise<ChildProcess>{
  if(ready)return ready;
  const args=process.defaultApp?[join(__dirname,'main.cjs'),'--htc-image-worker']:['--htc-image-worker'];
  const processChild=spawn(process.execPath,args,{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',windowsHide:true});
  child=processChild;
  ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(child===processChild){child=undefined;ready=undefined;}reject(localFailure());processChild.kill();},10000);
    const fail=()=>{clearTimeout(timer);reject(localFailure());};
    processChild.once('error',fail);processChild.once('exit',fail);
    const receive=(message:unknown)=>{if((message as {ready?:boolean})?.ready){clearTimeout(timer);processChild.removeListener('message',receive);resolve(processChild);}};
    processChild.on('message',receive);
  });
  processChild.on('error',()=>{if(child===processChild){child=undefined;ready=undefined;rejectActive?.(localFailure());}});
  processChild.once('exit',()=>{if(child===processChild){child=undefined;ready=undefined;rejectActive?.(localFailure());}});
  return ready;
}
function processImage(kind:'preview'|'artifact',bytes:Buffer):Promise<Buffer|DecodedArtifact>{
  if(closed||!Buffer.isBuffer(bytes)||bytes.length>20*1024*1024)return Promise.reject(localFailure());
  // One image at a time across callers; CPU work never executes in this process.
  const result=tail.then(async()=>{
    if(closed)throw localFailure();
    const target=await worker();if(closed||!target.connected)throw localFailure();
    return new Promise<Buffer|DecodedArtifact>((resolve,reject)=>{
      const id=++sequence;
      const cleanup=()=>{clearTimeout(timer);target.removeListener('message',receive);rejectActive=undefined;};
      const fail=(error:Error)=>{cleanup();reject(error);};
      const receive=(raw:unknown)=>{const message=raw as {id?:number;result?:Buffer|DecodedArtifact;error?:string};if(message?.id!==id)return;cleanup();if(message.error)reject(new UserFacingError(message.error));else if(message.result)resolve(message.result);else reject(localFailure());};
      const timer=setTimeout(()=>{if(child===target){child=undefined;ready=undefined;}fail(localFailure());target.kill();},60000);
      rejectActive=fail;target.on('message',receive);
      target.send({id,kind,bytes},error=>{if(error)fail(localFailure());});
    });
  });
  tail=result.catch(()=>{});return result;
}
export async function decodePreviewInBackground(bytes:Buffer):Promise<Buffer>{
  const result=await processImage('preview',bytes);if(!Buffer.isBuffer(result))throw localFailure();return result;
}
export async function decodeArtifactInBackground(bytes:Buffer):Promise<DecodedArtifact>{
  const result=await processImage('artifact',bytes);if(Buffer.isBuffer(result)||!Buffer.isBuffer(result.preview))throw localFailure();return result;
}
/** Close only this module's worker; no business process or request is restarted. */
export async function closeImageProcessing():Promise<void> {
  closed=true;rejectActive?.(localFailure());
  if(child){
    const target=child;child=undefined;ready=undefined;
    await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>{target.kill();resolve();},1000);
      target.once('exit',()=>{clearTimeout(timer);resolve();});
      if(target.connected)target.send({kind:'close'},error=>{if(error)target.kill();});
      else target.kill();
    });
  }
}
