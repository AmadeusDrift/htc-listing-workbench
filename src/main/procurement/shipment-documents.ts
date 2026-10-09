import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ShipmentDocument } from '../../shared/shipment-document-contracts.ts';
import { identifier, record, text } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { openDatabase } from '../database.ts';
import { validateLabelPdf } from '../item-labels/files.ts';
import type { ProcurementService } from './service.ts';
import { shipmentId } from './records.ts';

export function validateShipmentDocument(raw: unknown): ShipmentDocument {
  const value = record(raw, '箱唛文件', ['id','batchId','shipmentId','fileName','relativePath','sha256','byteSize','createdAt','status']);
  const id = identifier(value.id), batchId = identifier(value.batchId), shipment = shipmentId(value.shipmentId);
  const fileName = text(value.fileName, '箱唛文件名', 255);
  if (!shipment || !fileName || /[\\/\u0000-\u001f]/.test(fileName) || !fileName.toLowerCase().endsWith('.pdf')
    || value.relativePath !== `documents/shipments/${id}.pdf` || !/^[a-f0-9]{64}$/.test(String(value.sha256))
    || !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 64 || Number(value.byteSize) > 32*1024*1024
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || value.status !== 'LINKED_UNVERIFIED') throw new UserFacingError('箱唛文件记录无效');
  return { id, batchId, shipmentId: shipment, fileName, relativePath: String(value.relativePath), sha256: String(value.sha256), byteSize: Number(value.byteSize), createdAt: value.createdAt, status: 'LINKED_UNVERIFIED' };
}

export class ShipmentDocumentService {
  private db: DatabaseSync;
  private directory: string;
  private procurement: Pick<ProcurementService, 'get'>;
  constructor(directory: string, procurement: Pick<ProcurementService, 'get'>) { this.directory = directory; this.procurement = procurement; this.db = openDatabase(directory); }
  close(): void { this.db.close(); }
  list(batchId: string): ShipmentDocument[] {
    this.procurement.get(identifier(batchId));
    return this.db.prepare('SELECT id,record_json FROM shipment_documents ORDER BY rowid DESC').all().map(row => {
      const doc = validateShipmentDocument(JSON.parse(String(row.record_json)));
      if (doc.id !== row.id) throw new UserFacingError('箱唛文件身份不一致');
      return doc;
    }).filter(doc => doc.batchId === batchId);
  }
  private async path(id: string): Promise<string> {
    identifier(id); const root = await realpath(this.directory);
    for (const folder of [join(root, 'documents'), join(root, 'documents', 'shipments')]) {
      try { const stat = await lstat(folder); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UserFacingError('箱唛目录不能使用链接'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(folder); }
    }
    return join(root, 'documents', 'shipments', id + '.pdf');
  }
  async importDocument(batchId: string, sourcePath: string): Promise<ShipmentDocument> {
    const batch = this.procurement.get(identifier(batchId));
    const shipment = shipmentId(batch.shipment?.confirmationId ?? '');
    if (!shipment) throw new UserFacingError('请先在备货批次填写已创建的货件编号，再归档箱唛');
    const metadata = await lstat(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32*1024*1024) throw new UserFacingError('请选择不超过 32 MB 的普通 PDF 文件');
    const bytes = await readFile(sourcePath); await validateLabelPdf(bytes);
    const id = randomUUID(), path = await this.path(id), temp = join(dirname(path), id + '.tmp');
    const doc = validateShipmentDocument({ id, batchId, shipmentId: shipment, fileName: basename(sourcePath), relativePath: `documents/shipments/${id}.pdf`, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length, createdAt: new Date().toISOString(), status: 'LINKED_UNVERIFIED' });
    try {
      const handle = await open(temp, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      if (this.procurement.get(batchId).shipment?.confirmationId !== shipment) throw new UserFacingError('货件编号已变化，请重新归档');
      await rename(temp, path);
      this.db.prepare('INSERT INTO shipment_documents(id,record_json) VALUES(?,?)').run(id, JSON.stringify(doc));
    } finally { await rm(temp, { force: true }); }
    return doc;
  }
  async file(id: string): Promise<string> {
    const row = this.db.prepare('SELECT record_json FROM shipment_documents WHERE id=?').get(identifier(id));
    if (!row) throw new UserFacingError('箱唛文件不存在');
    const doc = validateShipmentDocument(JSON.parse(String(row.record_json)));
    if (doc.id !== id) throw new UserFacingError('箱唛文件身份不一致');
    const path = await this.path(id), metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== doc.byteSize || resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new UserFacingError('箱唛文件校验失败');
    const bytes = await readFile(path); await validateLabelPdf(bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256) throw new UserFacingError('箱唛文件校验值不匹配');
    return path;
  }
}
