import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { openDatabase } from '../src/main/database.ts';
import { ProcurementService } from '../src/main/procurement/service.ts';
import { ShipmentDocumentService } from '../src/main/procurement/shipment-documents.ts';
import { ItemLabelService } from '../src/main/item-labels/service.ts';
import { AutomaticListingService } from '../src/main/automatic-listing/service.ts';
import { outcomeScope, pricingOutcome } from '../src/main/automatic-listing/outcomes.ts';
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { applyBusinessRules } from '../src/main/amazon/business-rules.ts';
import { realAmazonSchema } from './fixtures/amazon/schema-fixture.ts';
import { simplePdf } from './fixtures/simple-pdf.ts';

test('changing a manual shipment keeps old attachments historical and new imports tied to the current ID',async t=>{
  const root=await mkdtemp(join(resolve('.test-data'),'shipment-history-')),id=randomUUID();
  const batch={id,shipment:{confirmationId:'FBA12345',status:'LINKED_UNVERIFIED',linkedAt:new Date().toISOString()}};
  const docs=new ShipmentDocumentService(root,{get:()=>structuredClone(batch)} as never);t.after(()=>docs.close());
  const input=join(root,'carton.pdf');await writeFile(input,simplePdf());
  const old=await docs.importDocument(id,input);batch.shipment.confirmationId='FBA67890';
  const current=await docs.importDocument(id,input),all=docs.list(id);
  assert.equal(all.find(row=>row.id===old.id)?.shipmentId,'FBA12345');
  assert.equal(all.filter(row=>row.shipmentId===batch.shipment.confirmationId).length,1);
  assert.equal(current.status,'LINKED_UNVERIFIED');assert.equal(old.status,'LINKED_UNVERIFIED');
  assert.deepEqual(await readFile(await docs.file(old.id)),simplePdf());
});

test('v16 backup retains verified document bytes and pauses unfinished parent/label work', async t => {
  await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/automatic-documents-backup-')), source=join(root,'source'),destination=join(root,'restored');
  const store=new WorkspaceStore(source), product=store.createProduct(), target={id:'store-one',name:'Test',sellerId:'seller',marketplaceId:'ATVPDKIKX0DER',mode:'live',configured:true,paused:false,locale:'en_US'};
  const draft={id:randomUUID(),productId:product.id,variantId:product.variants[0].id,sku:product.variants[0].sku,targetId:target.id,targetName:target.name,sellerId:target.sellerId,marketplaceId:target.marketplaceId,mode:'live',state:'PROCESSING',submittedAt:'2026-10-07T00:00:00.000Z',checkedAt:'2026-10-07T00:10:00.000Z',updatedAt:'2026-10-07T00:10:00.000Z',listingIssues:[],schema:{parentageLevel:'NONE'}};
  const amazon={getTarget:()=>target,executionTargetScope:()=>({target,generation:1}),getDraft:()=>draft,listDrafts:()=>[draft],getListingObservation:()=>({...draft,draftId:draft.id,asin:'B012345678',fnsku:null,statuses:[],issues:[]}),
    createMarketplaceItemLabels:async()=>({data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/a.pdf'}]},status:200,requestId:'test'}),downloadItemLabel:async()=>simplePdf()};
  const procurement=new ProcurementService(source,store,amazon as never),labels=new ItemLabelService(source,amazon as never,procurement),docs=new ShipmentDocumentService(source,procurement);
  const automatic=new AutomaticListingService(source,{store,amazon,images:{getProgress:()=>null},execution:{list:()=>[]},hosting:{getProfile:()=>({id:'alpha',name:'Alpha',configured:true,enabled:true,generation:1})},rules:defaultListingRules,labels,procurement} as never);
  t.after(async()=>{await automatic.close();await labels.close();docs.close();procurement.close();store.close();await rm(root,{recursive:true,force:true});});
  const task=await automatic.create({productIds:[product.id],targetId:target.id,productType:'BOX',profileId:'alpha'});
  const screened=structuredClone(task);screened.id=randomUUID();screened.status='COMPLETED';
  const screenRow=screened.items[0];screenRow.status='SCREENED';screenRow.stage='DRAFT';screenRow.draftId=draft.id;screenRow.error='Confirmed ROI rule';
  screenRow.outcome={version:1,kind:'RULE_FILTERED',code:'ROI_MAX_PRICE',message:screenRow.error,classifiedAt:screened.updatedAt,scope:outcomeScope(screened,screenRow),draftId:draft.id,draftRevision:1,
    pricingReport:{revision:screened.ruleRevision,fields:{},notices:[],quote:null,bundleQuantity:1,pricingBasis:{kind:'source_sale_unit',sourceCostCny:100,quantity:1,saleUnitCostCny:100},
      pricingDecision:{version:1,status:'business_blocked',code:'ROI_MAX_PRICE',quoteError:'ROI_MAX_PRICE',inputs:{costCny:100,dimensionsInches:[1,1,1],weightPounds:1},evidence:{cost:'confirmed_cny',dimensions:'confirmed_source',weight:'confirmed_source',packageScope:'source_sale_unit',saleUnit:'confirmed',sourcePackage:{dimensionsInches:[1,1,1],weightPounds:1}}}}};
  const currentScreen=structuredClone(screened);currentScreen.id=randomUUID();
  const confirmed=structuredClone(product);confirmed.facts=['包装长度','包装宽度','包装高度','包装重量'].map((name,i)=>({id:randomUUID(),name,value:i===3?'100 g':'5 cm',state:'human_confirmed',source:'manual',sourceRef:'Synthetic backup evidence'}));
  const currentResult=applyBusinessRules({product:confirmed,variant:confirmed.variants[0],schema:realAmazonSchema(),target:target as never,attributes:{},measurements:{},costCny:100,now:new Date()},defaultListingRules()),currentReport=currentResult.report;
  assert.equal(currentReport.pricingDecision?.version,3);assert.equal(currentReport.pricingDecision?.status,'business_blocked');
  const currentOutcome=currentScreen.items[0].outcome!;if(currentOutcome.kind!=='RULE_FILTERED')throw Error('fixture');const currentPricing=pricingOutcome({listingProgram:'haul',businessRules:currentReport,attributes:currentResult.attributes,marketplaceId:target.marketplaceId} as never,defaultListingRules());assert.equal(currentPricing?.kind,'RULE_FILTERED');assert.equal(currentPricing?.code,currentReport.pricingDecision?.code);currentOutcome.code=currentPricing!.code;currentOutcome.pricingReport=currentPricing!.pricingReport;
  const currentBytes=JSON.stringify(currentScreen),legacyBytes=JSON.stringify(screened);
  const history=openDatabase(source);history.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(currentScreen.id,currentBytes);history.prepare('INSERT INTO automatic_listing_tasks VALUES(?,?)').run(screened.id,JSON.stringify(screened));history.close();
  const [batch]=procurement.ensureAutomaticBatch(task.id,[draft.id],{[draft.id]:5});
  const [label]=labels.prepareBatch(batch.id);await labels.runDue();const ready=labels.get(label.id);assert.equal(ready.status,'READY',JSON.stringify(ready));
  const current=procurement.get(batch.id);procurement.update({id:batch.id,revision:current.revision,lines:current.lines.map(({id,purchaseQuantity,stockQuantity,purchasePrice,purchaseUnit,priceConfirmed})=>({id,purchaseQuantity,stockQuantity,purchasePrice,purchaseUnit,priceConfirmed})),shipmentConfirmationId:'FBA12345678'});
  const input=join(root,'carton.pdf');await writeFile(input,simplePdf());const document=await docs.importDocument(batch.id,input);
  assert.ok(ready.requestedAt);const legacyReady={...ready};delete legacyReady.requestedAt;const legacyDb=openDatabase(source);legacyDb.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(legacyReady),ready.id);legacyDb.close();
  const readyArchive=join(root,'ready.htcbackup'),readyDestination=join(root,'ready-restored');await createWorkspaceBackup(source,readyArchive,'automatic-backup-test-2026');
  await commitWorkspaceRestore(readyDestination,await prepareWorkspaceRestore(readyDestination,readyArchive,'automatic-backup-test-2026'));
  assert.deepEqual(await readFile(join(readyDestination,ready.files[0].relativePath)),simplePdf());
  const db=openDatabase(source);const queued={...ready,status:'REQUESTING',files:[]};db.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(queued),ready.id);db.close();
  const archive=join(root,'backup.htcbackup');await createWorkspaceBackup(source,archive,'automatic-backup-test-2026');await commitWorkspaceRestore(destination,await prepareWorkspaceRestore(destination,archive,'automatic-backup-test-2026'));
  const restored=openDatabase(destination);
  try {assert.equal(String(restored.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(currentScreen.id)!.record_json),currentBytes);assert.equal(String(restored.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(screened.id)!.record_json),legacyBytes);const job=JSON.parse(String(restored.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(task.id)!.record_json));assert.equal(job.status,'PAUSED');assert.deepEqual(JSON.parse(String(restored.prepare('SELECT record_json FROM automatic_listing_tasks WHERE id=?').get(screened.id)!.record_json)),screened);const interrupted=JSON.parse(String(restored.prepare('SELECT record_json FROM item_labels').get()!.record_json));assert.equal(interrupted.status,'FAILED');assert.equal(interrupted.errorCode,'REQUEST_UNKNOWN');assert.equal(interrupted.id,queued.id);assert.equal(interrupted.attempts,queued.attempts);assert.equal(interrupted.requestId,queued.requestId);assert.equal(interrupted.paused,true);}
  finally {restored.close();}
  assert.deepEqual(await readFile(join(destination,document.relativePath)),simplePdf());
  await writeFile(join(source,document.relativePath),Buffer.from('corrupt'));
  await assert.rejects(createWorkspaceBackup(source,join(root,'broken.htcbackup'),'automatic-backup-test-2026'),/校验/);
});
