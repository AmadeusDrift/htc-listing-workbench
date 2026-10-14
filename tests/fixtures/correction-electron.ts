// Test-only Electron entry: real correction service, public IPC/preload and production panel.
import {app,BrowserWindow,ipcMain} from 'electron';
import {resolve,join} from 'node:path';
import {WorkspaceStore} from '../../src/main/store.ts';
import {AmazonService} from '../../src/main/amazon/service.ts';
import {AmazonPersistence} from '../../src/main/amazon/persistence.ts';
import {ListingCorrections} from '../../src/main/amazon/corrections.ts';
import {installAmazonIpc} from '../../src/main/amazon-ipc.ts';
import type {JsonObject} from '../../src/shared/amazon-contracts.ts';
const root=resolve(process.env.RED_DATA_DIR!);app.setPath('userData',root);app.enableSandbox();
void app.whenReady().then(async()=>{
 const store=new WorkspaceStore(root),product=store.createProduct();
 const amazon=new AmazonService(root,id=>store.getProduct(id),{isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s),decryptString:(b:Buffer)=>b.toString()});
 const target=amazon.enableDemo(),draft=await amazon.createDraft({productId:product.id,variantId:product.variants[0].id,targetId:target.id,productType:'HTC_DEMO_STORAGE_BAG',parentageLevel:'NONE',requirements:'LISTING',locale:'en_US'});
 const p=(amazon as unknown as {persistence:AmazonPersistence}).persistence,r=p.record(draft.id);
 Object.assign(r.draft,{mode:'live',state:'SUBMITTED',submittedAt:new Date().toISOString(),submissionId:'original'});r.draft.schema.mode='live';r.draft.schema.schema={type:'object',properties:{color:{type:'array',items:{type:'object',properties:{value:{enum:['Blue']}}}}},additionalProperties:true};r.draft.schema.metaSchema={};
 r.draft.attributes={color:[{value:' blue ',marketplace_id:draft.marketplaceId}],main_product_image_locator:[{media_location:'https://retained.invalid/image.jpg'}]};r.request={productType:draft.schema.productType,attributes:r.draft.attributes};r.submitResponse={sku:draft.sku,status:'ACCEPTED',submissionId:'original',issues:[]};p.putRecord(r);
 const live={...target,mode:'live' as const,paused:false};p.putTarget(live);let remote=structuredClone(r.draft.attributes),sends=0,reads=0;
 const corrections=new ListingCorrections(p,{active:()=>live,schema:async()=>r.draft.schema,api:async(_t,op,_path,_query,body,guard):Promise<{status:number;requestId:string;data:JsonObject}>=>{guard?.();if(op==='getListingsItem'){reads++;return {status:200,requestId:'fake-read',data:{sku:draft.sku,summaries:[],attributes:remote,issues:sends?[]:[{code:'90244',severity:'ERROR',message:'Invalid enum',attributeNames:['color']}]}};}if(op==='previewPatchListingsItem')return {status:200,requestId:'fake-preview',data:{sku:draft.sku,status:'VALID',issues:[]}};if(op!=='patchListingsItem')throw Error('Unexpected fake operation');sends++;const patches=(body as JsonObject).patches as JsonObject[];for(const patch of patches)remote[String(patch.path).slice('/attributes/'.length)]=patch.value;return {status:200,requestId:'fake-patch',data:{sku:draft.sku,status:'ACCEPTED',submissionId:'correction',issues:[]}};}});
 (amazon as unknown as {corrections:ListingCorrections}).corrections=corrections;
 const win=new BrowserWindow({show:false,width:980,height:800,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true,preload:join(root,'preload.cjs')}});
 installAmazonIpc(win,amazon,(channel,count,callback)=>ipcMain.handle(channel,async(_event,...args)=>{try{if(args.length!==count)throw Error('Argument count');return {ok:true,data:await callback(...args)};}catch(e){return {ok:false,error:e instanceof Error?e.message:'error'};}}),async()=>0);
 Object.assign(globalThis,{__correctionHarness:{draft:r.draft,snapshot:()=>({sends,reads,original:p.record(draft.id),corrections:corrections.list(draft.id)})}});
 await win.loadFile(join(root,'index.html'));app.on('window-all-closed',()=>app.quit());
}).catch(error=>{console.error(error);app.exit(1);});