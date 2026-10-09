import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ShipmentDocumentService } from '../src/main/procurement/shipment-documents.ts';
import { simplePdf } from './fixtures/simple-pdf.ts';

test('manual shipment PDF is bound, hashed, and refuses a later damaged file', async t => {
  await mkdir(resolve('.test-data'),{recursive:true}); const directory=await mkdtemp(resolve('.test-data/shipment-docs-'));
  const batchId=randomUUID();const batches={get:()=>({id:batchId,shipment:{confirmationId:'FBA12345678'}})} as never;
  const service=new ShipmentDocumentService(directory,batches);
  t.after(async()=>{service.close();await rm(directory,{recursive:true,force:true});});
  const pdf=simplePdf();
  const source=join(directory,'source.pdf');await writeFile(source,pdf);
  const record=await service.importDocument(batchId,source);
  assert.equal(record.shipmentId,'FBA12345678');assert.equal(record.status,'LINKED_UNVERIFIED');
  assert.equal(service.list(batchId).length,1);assert.equal(service.list(batchId)[0].id,record.id);
  const file=await service.file(record.id);await writeFile(file,Buffer.from('broken'));
  await assert.rejects(service.file(record.id),/校验|PDF/);
});
