import { DIRECT_HOSTING_ROUTE, profileWithHostingRoute } from '../../shared/hosting-contracts.ts';
import type { HostingRoute } from '../../shared/hosting-contracts.ts';
import {createHash} from 'node:crypto';
import {readdir,readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import type {WorkspaceStore} from '../store.ts';
import type {ImageGenerationService} from '../image-generation/service.ts';
import type {HostingService} from './service.ts';
import type {AutomaticListingTask} from '../../shared/automatic-listing-contracts.ts';
import type {AiDependencies} from '../ai/service.ts';
import {taskAiContext} from '../ai/batch/task-context.ts';
import {openDatabase} from '../database.ts';
import {ReferencePinService,type ReferencePinDependencies} from './reference-pins.ts';
import {createReferenceVersionReader} from './reference-version-reader.ts';
import {RestorePathGuard} from '../restore-paths.ts';
import {AiError,throwIfAborted} from '../ai/errors.ts';
import {UserFacingError} from '../../shared/errors.ts';
type Owner={taskId:string;operationId:string;productId:string;productRevision:number};
type Deps={directory:string;store:WorkspaceStore;generation:Pick<ImageGenerationService,'readCandidate'>;hosting:Pick<HostingService,'getProfile'|'listUploads'|'uploadReferenceVersion'>;task:(id:string)=>AutomaticListingTask;probe:ReferencePinDependencies['probe']};
/** Main-only composition. Each reference is resolved to an owned immutable local version before upload. */
export function createBatchReferencePort(deps:Deps):NonNullable<AiDependencies['batchReferences']>&{close():Promise<void>}{
 let closed=false;const active=new Map<AbortController,Promise<unknown>>();
 const readVersion=createReferenceVersionReader(deps.directory,deps.store,deps.generation);
 async function resolveImage(url:string,owner:Owner){
  const product=deps.store.getProduct(owner.productId);if(product.revision!==owner.productRevision)throw new AiError('SOURCE_CHANGED');
  let hash:string;
  if(url.startsWith('data:')){
   const match=/^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);if(!match||match[1].length>4*Math.ceil(20*1024*1024/3))throw new AiError('IMAGE_INVALID');
   const bytes=Buffer.from(match[1],'base64');if(!bytes.length||bytes.toString('base64')!==match[1])throw new AiError('IMAGE_INVALID');hash=createHash('sha256').update(bytes).digest('hex');
  }else{
   const known=deps.hosting.listUploads().find(upload=>upload.publicUrl===url&&upload.status==='AVAILABLE'&&product.assets.some(asset=>asset.id===upload.assetId));
   if(!known)throw new UserFacingError('视觉Batch引用URL没有当前商品的本地版本证明');hash=known.sha256;
  }
  for(const asset of product.assets){const stored=deps.store.getAssetRecord(asset.id);if(stored?.sha256===hash)return{assetId:asset.id,sha256:hash,purpose:'source-reference' as const};}
  const base=join(deps.directory,'image-generation','candidates');let names:string[]=[];
  try{names=await readdir(base);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(names.length>10000)throw new UserFacingError('候选历史过多，请先核对需要用于批次的原候选');
  const guard=new RestorePathGuard(deps.directory);
  for(const id of names.sort()){
   if(!/^[a-f0-9-]{36}$/.test(id))continue;const file=join(base,id,'candidate.json');guard.assertFile(file);if((await lstat(file)).size>32768)throw new AiError('OUTPUT_INVALID');
   const raw=JSON.parse(await readFile(file,'utf8'));guard.assertFile(file);
   if(raw.sha256!==hash||raw.productId!==owner.productId||raw.productRevision!==owner.productRevision)continue;
   const {candidate}=await deps.generation.readCandidate(id);if(candidate.sha256===hash&&candidate.productId===owner.productId&&candidate.productRevision===owner.productRevision)return{assetId:id,sha256:hash,purpose:'candidate-review' as const};
  }
  throw new UserFacingError('视觉Batch图片不属于当前商品版本，未更换参考图或发送');
 }
 async function prepare(body:Record<string,unknown>,owner:Owner,signal?:AbortSignal){
  if(closed)throw new AiError('SERVICE_CLOSED');const scope=taskAiContext.getStore(),controller=new AbortController();
  const cancel=()=>controller.abort(signal?.reason);if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const run=async()=>{
   const db=openDatabase(deps.directory);
   try{
    const task=deps.task(owner.taskId) as AutomaticListingTask & {hostingRoute?:HostingRoute},profile=profileWithHostingRoute(deps.hosting.getProfile(task.profileId),task.hostingRoute),profileStamp=JSON.stringify(profile);
    const assertFresh=()=>{throwIfAborted(controller.signal);if(closed||scope?.taskId!==owner.taskId||!scope.authorize())throw new AiError('CANCELLED');if(deps.store.getProduct(owner.productId).revision!==owner.productRevision)throw new AiError('SOURCE_CHANGED');const current=deps.task(owner.taskId);if(current.profileId!==task.profileId||current.profileStamp!==task.profileStamp||JSON.stringify(profileWithHostingRoute(deps.hosting.getProfile(task.profileId),task.hostingRoute))!==profileStamp)throw new AiError('CONFIG_CHANGED');};
    assertFresh();if(createHash('sha256').update(profileStamp).digest('hex')!==task.profileStamp)throw new AiError('CONFIG_CHANGED');if(!profile.configured||!profile.enabled)throw new UserFacingError('视觉Batch需要任务所选图床的有效连接');
    const pins=new ReferencePinService(db,{readVersion,probe:deps.probe,uploadVersion:async(version,bytes,activeSignal)=>{assertFresh();const url=await deps.hosting.uploadReferenceVersion(profile.id,profile.generation,version,bytes,activeSignal,task.hostingRoute??DIRECT_HOSTING_ROUTE);assertFresh();return url;}});
    const copy=structuredClone(body),references:Awaited<ReturnType<NonNullable<AiDependencies['batchReferences']>['prepare']>>['references']=[];
    if(!Array.isArray(copy.messages))throw new AiError('INVALID_INPUT');
    for(const message of copy.messages){if(!message||!Array.isArray(message.content))continue;for(const part of message.content){if(part?.type!=='image_url')continue;if(typeof part.image_url?.url!=='string')throw new AiError('IMAGE_INVALID');assertFresh();const version=await resolveImage(part.image_url.url,owner);assertFresh();const pin=await pins.prepare({operationId:owner.operationId,...version},controller.signal);assertFresh();const reference=pins.reference(pin.id);if(!pins.validateReference(reference))throw new AiError('IMAGE_INVALID');part.image_url={...part.image_url,url:reference.url};if(!references.some(ref=>ref.pinId===reference.pinId))references.push(reference);}}
    return{body:copy,references};
   }finally{db.close();}
  };
  const pending=run();active.set(controller,pending);try{return await pending;}finally{active.delete(controller);signal?.removeEventListener('abort',cancel);}
 }
 return{prepare,validate(reference){if(closed)return false;const db=openDatabase(deps.directory);try{return new ReferencePinService(db,{readVersion,probe:deps.probe,uploadVersion:async()=>{throw new Error('read only');}}).validateReference(reference);}finally{db.close();}},async close(){closed=true;for(const controller of active.keys())controller.abort(new AiError('SERVICE_CLOSED'));await Promise.allSettled(active.values());}};
}
