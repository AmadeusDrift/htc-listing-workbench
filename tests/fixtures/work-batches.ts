import type { AutomaticListingDependencies } from '../../src/main/automatic-listing/service.ts';
import { AutomaticListingService } from '../../src/main/automatic-listing/service.ts';
import { WorkspaceStore } from '../../src/main/store.ts';
import { defaultListingRules } from '../../src/shared/listing-rules.ts';
/** Only creates a durable task; every execution/remote entrypoint fails loudly. */
export async function createInertBatchTask(directory:string,productId:string) {
 const store=new WorkspaceStore(directory),blocked=()=>{throw new Error('synthetic fixture forbids execution');};
 const target={target:{id:'batch-fixture',name:'合成批次店铺',mode:'demo',sellerId:'fixture-seller',marketplaceId:'ATVPDKIKX0DER',locale:'en_US',configured:true,paused:false},generation:1};
 const dependencies={store,rules:defaultListingRules,amazon:{executionTargetScope:()=>structuredClone(target),listDrafts:()=>[],getDraft:blocked},hosting:{getProfile:()=>({id:'alpha',configured:true,enabled:true})},images:{getProgress:()=>null,cancel:blocked,cancelSources:blocked},execution:{list:()=>[],waitForIdle:async()=>{},get:blocked},followup:{},procurement:{},labels:{}} as unknown as AutomaticListingDependencies;
 const service=new AutomaticListingService(directory,dependencies);
 try{return await service.create({productIds:[productId],targetId:'batch-fixture',profileId:'alpha'});}finally{await service.close();store.close();}
}
