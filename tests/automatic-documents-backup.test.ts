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
import { defaultListingRules } from '../src/shared/listing-rules.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { simplePdf } from './fixtures/simple-pdf.ts';

test('v16 backup retains verified document bytes and pauses unfinished parent/label work', async t => {
  await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/automatic-documents-backup-')), source=join(root,'source'),destination=join(root,'restored');
  const store=new WorkspaceStore(source), product=store.createProduct(), target={id:'store-one',name:'Test',sellerId:'seller',marketplaceId:'ATVPDKIKX0DER',mode:'live',configured:true,paused:false,locale:'en_US'};
  const draft={id:randomUUID(),productId:product.id,variantId:product.variants[0].id,sku:product.variants[0].sku,targetId:target.id,targetName:target.name,sellerId:target.sellerId,marketplaceId:target.marketplaceId,mode:'live',state:'PROCESSING',submittedAt:'2026-10-07T00:00:00.000Z',checkedAt:'2026-10-07T00:10:00.000Z',updatedAt:'2026-10-07T00:10:00.000Z',listingIssues:[],schema:{parentageLevel:'NONE'}};
  const amazon={getTarget:()=>target,executionTargetScope:()=>({target,generation:1}),getDraft:()=>draft,listDrafts:()=>[draft],getListingObservation:()=>({...draft,draftId:draft.id,asin:'B012345678',fnsku:null,statuses:[],issues:[]}),
    createMarketplaceItemLabels:async()=>({data:{documentDownloads:[{downloadType:'URL',uri:'https://labels.amazon.com/a.pdf'}]},status:200,requestId:'test'}),downloadItemLabel:async()=>simplePdf()};
  const procurement=new ProcurementService(source,store,amazon as never),labels=new ItemLabelService(source,amazon as never,procurement),docs=new ShipmentDocumentService(source,procurement);
  const automatic=new AutomaticListingService(source,{store,amazon,hosting:{getProfile:()=>({id:'alpha',name:'Alpha',configured:true,enabled:true,generation:1})},rules:defaultListingRules,labels,procurement} as never);
  t.after(async()=>{await automatic.close();await labels.close();docs.close();procurement.close();store.close();await rm(root,{recursive:true,force:true});});
  const task=automatic.create({productIds:[product.id],targetId:target.id,productType:'BOX',profileId:'alpha'});
  const [batch]=procurement.ensureAutomaticBatch(task.id,[draft.id],{[draft.id]:5});
  const [label]=labels.syncBatch(batch.id,{jobId:task.id});await labels.runDue();const ready=labels.get(label.id);assert.equal(ready.status,'READY',JSON.stringify(ready));
  const current=procurement.get(batch.id);procurement.update({id:batch.id,revision:current.revision,lines:current.lines.map(({id,purchaseQuantity,stockQuantity,purchasePrice,purchaseUnit,priceConfirmed})=>({id,purchaseQuantity,stockQuantity,purchasePrice,purchaseUnit,priceConfirmed})),shipmentConfirmationId:'FBA12345678'});
  const input=join(root,'carton.pdf');await writeFile(input,simplePdf());const document=await docs.importDocument(batch.id,input);
  const readyArchive=join(root,'ready.htcbackup'),readyDestination=join(root,'ready-restored');await createWorkspaceBackup(source,readyArchive,'automatic-backup-test-2026');
  await commitWorkspaceRestore(readyDestination,await prepareWorkspaceRestore(readyDestination,readyArchive,'automatic-backup-test-2026'));
  assert.deepEqual(await readFile(join(readyDestination,ready.files[0].relativePath)),simplePdf());
  const db=openDatabase(source);const queued={...ready,status:'REQUESTING',files:[]};db.prepare('UPDATE item_labels SET record_json=? WHERE id=?').run(JSON.stringify(queued),ready.id);db.close();
  const archive=join(root,'backup.htcbackup');await createWorkspaceBackup(source,archive,'automatic-backup-test-2026');await commitWorkspaceRestore(destination,await prepareWorkspaceRestore(destination,archive,'automatic-backup-test-2026'));
  const restored=openDatabase(destination);
  try {const job=JSON.parse(String(restored.prepare('SELECT record_json FROM automatic_listing_tasks').get()!.record_json));assert.equal(job.status,'PAUSED');const interrupted=JSON.parse(String(restored.prepare('SELECT record_json FROM item_labels').get()!.record_json));assert.equal(interrupted.status,'FAILED');assert.equal(interrupted.errorCode,'INTERRUPTED');assert.equal(interrupted.paused,true);}
  finally {restored.close();}
  assert.deepEqual(await readFile(join(destination,document.relativePath)),simplePdf());
  await writeFile(join(source,document.relativePath),Buffer.from('corrupt'));
  await assert.rejects(createWorkspaceBackup(source,join(root,'broken.htcbackup'),'automatic-backup-test-2026'),/校验/);
});
