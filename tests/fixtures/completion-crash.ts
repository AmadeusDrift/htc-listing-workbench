import { WorkspaceStore } from '../../src/main/store.ts';
import { AmazonService } from '../../src/main/amazon/service.ts';
import { HostingService } from '../../src/main/hosting/service.ts';
import { AiService } from '../../src/main/ai/service.ts';
import { ListingAiService } from '../../src/main/listing-ai/service.ts';
import { mockStorage } from './listing-ai.ts';
const [directory,draftId,mode]=process.argv.slice(2),store=new WorkspaceStore(directory),amazon=new AmazonService(directory,id=>store.getProduct(id),mockStorage),hosting=new HostingService(directory,store,mockStorage);
const ai=new AiService(directory,store,hosting,mockStorage,{fetch:async()=>{process.stdout.write('FETCH_ENTERED\n');if(mode==='crash')process.exit(73);throw new Error('Unexpected replay');}}),listing=new ListingAiService(store,amazon,ai);
amazon.previewDraft=async()=>({...amazon.getDraft(draftId),state:'BLOCKED',previewIssues:[{code:'90220',message:'Missing material',severity:'ERROR',attributeNames:['material'],autoFixable:false,source:'amazon',category:'field'}]});
try{await listing.complete({draftId,draftRevision:amazon.getDraft(draftId).revision});throw new Error('Unexpected completion');}
catch(error){if(mode==='recover'&&listing.completionOperations(draftId).some(op=>listing.completionUnknown(op.id)))process.stdout.write('UNKNOWN_PRESERVED\n');else if(mode==='recover')throw error;}
finally{await ai.close();await hosting.close();amazon.close();store.close();}
