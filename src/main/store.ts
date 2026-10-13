import { readFactScope, saveFactScopes, readProductFactModel, writeProductFactModel } from './products/public.ts';
import { appendAuditEvent } from './storage/audit.ts';
import { readNativeImageReceipt } from './source-images.ts';
import { transaction } from './application/transaction.ts';
import { freezeSourceForProduct } from './products/public.ts';
import { restoreWorkflowSourceBindings } from './image-upstream-trace.ts';
import { recordConsistencyBinding,assertConsistencyHistory } from './source-image-consistency/history.ts';
import { assertProductConsistency } from './source-image-consistency/proof.ts';
import { UserFacingError } from '../shared/errors.ts';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Asset, AuditEvent, Fact, ProductDetail, ProductMutation, ProductOrigin, ProductSummary, SaveProductInput, Variant } from '../shared/contracts.ts';
import { identifier, parseAssetUpdate, parseMutation, parseSaveProduct } from '../shared/validation.ts';
import { openDatabase, SCHEMA_VERSION } from './database.ts';
import type { WorkspacePlacement } from '../shared/workspace-contracts.ts';
import { parseMoveWorkspaceProducts, readWorkspacePlacements } from './workspaces.ts';
import type { CollectionCaptureRecord, CollectionReceipt, CollectionReceiveResult } from '../shared/collection-contracts.ts';
import { CollectionError, collectionFingerprint, collectionId, localCollectionPrice, validateCollectionCapture, validateCollectionReceipt, validateCollectionSnapshot } from './collection/validation.ts';
import { assertSourceImageHistory, assertSourceImageProvenance, validateSourceImageProvenance } from './source-image-provenance.ts';

export interface NewAsset {
  id: string; fileName: string; mimeType: string; width: number; height: number; byteSize: number;
  originalPath: string; previewPath: string; sha256: string;
}
export interface StoredAsset extends NewAsset { productId: string }
export type ImportedProduct = Omit<SaveProductInput, 'id' | 'revision'> & {factScopeModelVersion?:1};
export type SampleLane = 'manual' | 'inbox' | 'automatic';
type Row = Record<string, string | number | bigint | Uint8Array | null>;
const now = () => new Date().toISOString();

export class WorkspaceStore {
  private db: DatabaseSync;
  private directory:string;
  constructor(directory: string) { this.directory=directory;this.db = openDatabase(directory);try{assertSourceImageHistory(this.db,directory);assertConsistencyHistory(this.db,directory);}catch(error){this.db.close();throw error;} }
  close(): void { this.db.close(); }
  freezeSourceVersion(productId:string,revision:number):void{
    this.transaction(()=>{this.assertRevision({productId,revision});freezeSourceForProduct(this.db,productId);});
  }
  assertSourceConsistency(productId:string,variantIds:string[]):void { assertProductConsistency(this.db,this.getProduct(productId),variantIds); }

  private transaction<T>(operation: () => T): T {
    try { return transaction(this.db,operation); }
    catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: variants.sku')) throw new UserFacingError('SKU 已存在，请使用不同的 SKU；本次修改未保存');
      throw error;
    }
  }
  recordWorkspaceEvent(action: string, summary: string, detail: unknown = {}): void { this.audit(null, action, summary, detail); }
  private audit(productId: string | null, action: string, summary: string, detail: unknown): void {
    appendAuditEvent(this.db,randomUUID(), productId, action, summary, JSON.stringify(detail), now());
  }
  private insertProduct(origin: ProductOrigin, title = '未命名商品'): string {
    const id = randomUUID(), date = now();
    this.db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?)').run(id, title, '', '', 'draft', origin, 1, date, date);
    this.db.prepare('INSERT INTO product_workspaces(product_id,lane,updated_at) VALUES (?,?,?)').run(id, origin === 'import' ? 'inbox' : 'manual', date);
    return id;
  }
  createProduct(): ProductDetail {
    return this.transaction(() => {
      const id = this.insertProduct('manual');
      this.db.prepare('INSERT INTO variants VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, `HTC-${id.slice(0, 8).toUpperCase()}-01`, '', '', '', null, '', '', 0);
      this.audit(id, 'product.created', '新建商品', {});
      return this.getProduct(id);
    });
  }
  getProduct(rawId: string): ProductDetail {
    restoreWorkflowSourceBindings(this.db,identifier(rawId));
    return this.getProductSnapshot(rawId);
  }
  /** Snapshot read: never repairs bindings, metadata, or source history. */
  getProductSnapshot(rawId: string): ProductDetail {
    const id = identifier(rawId);
    const p = this.db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if (!p) throw new UserFacingError('商品不存在，请返回商品库重新选择');
    const variants: Variant[] = this.db.prepare('SELECT * FROM variants WHERE product_id=? ORDER BY position').all(id).map(v => ({
      id: String(v.id), sku: String(v.sku), originalSpec: String(v.original_spec), normalizedSpec: String(v.normalized_spec),
      purchasePrice: String(v.purchase_price), inventory: v.inventory === null ? null : Number(v.inventory),
      sourceSpec: String(v.source_spec), sourcePurchasePrice: String(v.source_purchase_price),
    }));
    const facts: Fact[] = this.db.prepare('SELECT * FROM facts WHERE product_id=? ORDER BY position').all(id).map(f => ({
      ...readFactScope(this.db,String(f.id)), id: String(f.id), name: String(f.name), value: String(f.value), source: f.source as Fact['source'],
      sourceRef: String(f.source_ref), state: f.state as Fact['state'],
    }));
    const assets: Asset[] = this.db.prepare('SELECT * FROM assets WHERE product_id=? ORDER BY created_at,rowid').all(id).map(a => ({
      id: String(a.id), fileName: String(a.file_name), role: a.role as Asset['role'], mimeType: String(a.mime_type),
      width: Number(a.width), height: Number(a.height), byteSize: Number(a.byte_size), previewUrl: `red-asset://image/${a.id}`,
      createdAt: String(a.created_at), variantIds: this.db.prepare('SELECT variant_id FROM variant_assets WHERE asset_id=? ORDER BY rowid').all(a.id).map(r => String(r.variant_id)),
    }));
    const factScopeModelVersion=readProductFactModel(this.db,id);
    return { ...(factScopeModelVersion?{factScopeModelVersion}:{}), id, title: String(p.title), sourceUrl: String(p.source_url), description: String(p.description), status: p.status as ProductDetail['status'],
      origin: p.origin as ProductOrigin, revision: Number(p.revision), createdAt: String(p.created_at), updatedAt: String(p.updated_at), variants, facts, assets };
  }
  listProducts(): ProductSummary[] {
    const rows = this.db.prepare(`SELECT p.*, (SELECT count(*) FROM variants v WHERE v.product_id=p.id) AS variant_count,
      (SELECT count(*) FROM assets a WHERE a.product_id=p.id) AS asset_count,
      (SELECT id FROM assets a WHERE a.product_id=p.id ORDER BY CASE role WHEN 'main' THEN 0 ELSE 1 END,created_at LIMIT 1) AS cover_id
      FROM products p ORDER BY updated_at DESC,rowid DESC`).all();
    return rows.map(p => ({ id: String(p.id), title: String(p.title), sourceUrl: String(p.source_url), status: p.status as ProductSummary['status'],
      origin: p.origin as ProductOrigin, variantCount: Number(p.variant_count), assetCount: Number(p.asset_count),
      coverUrl: p.cover_id ? `red-asset://image/${p.cover_id}` : null, updatedAt: String(p.updated_at) }));
  }
  listWorkspacePlacements(): WorkspacePlacement[] { return readWorkspacePlacements(this.db); }
  moveWorkspaceProducts(raw: unknown): WorkspacePlacement[] {
    const input = parseMoveWorkspaceProducts(raw);
    return this.transaction(() => {
      const placements = new Map(readWorkspacePlacements(this.db, input.productIds).map(p => [p.productId, p]));
      if (input.productIds.some(id => !placements.has(id))) throw new UserFacingError('移动的商品不存在，请刷新列表后重试；本次移动未保存');
      const updatedAt = now(), names = { inbox: '采集收件箱', manual: '人工上架', automatic: '自动准备', ignored: '已忽略' };
      const save = this.db.prepare(`INSERT INTO product_workspaces(product_id,lane,updated_at) VALUES(?,?,?)
        ON CONFLICT(product_id) DO UPDATE SET lane=excluded.lane,updated_at=excluded.updated_at`);
      return input.productIds.map(productId => {
        const previous = placements.get(productId)!;
        if (previous.lane === input.destination) return previous;
        save.run(productId, input.destination, updatedAt);
        this.audit(productId, 'workspace.moved', `从${names[previous.lane]}移至${names[input.destination]}`, { from: previous.lane, to: input.destination });
        return { productId, lane: input.destination, updatedAt };
      });
    });
  }
  assertRevision(input: ProductMutation): ProductDetail {
    const { productId, revision } = parseMutation(input);
    const current = this.getProduct(productId);
    if (current.revision !== revision) throw new UserFacingError('商品已更新，请重新加载后再保存；当前编辑尚未覆盖新数据');
    return current;
  }
  saveProduct(raw: unknown): ProductDetail {
    const input = parseSaveProduct(raw);
    return this.transaction(() => this.saveInsideTransaction(input));
  }
  private saveInsideTransaction(input: SaveProductInput): ProductDetail {
    const previous = this.assertRevision({ productId: input.id, revision: input.revision });
    for (const v of input.variants) {
      const owner = this.db.prepare('SELECT product_id FROM variants WHERE id=?').get(v.id);
      if (owner && owner.product_id !== input.id) throw new UserFacingError('不能使用其他商品的 SKU ID');
    }
    for (const f of input.facts) {
      const owner = this.db.prepare('SELECT product_id FROM facts WHERE id=?').get(f.id);
      if (owner && owner.product_id !== input.id) throw new UserFacingError('不能使用其他商品的事实 ID');
    }
    const retained = new Set(input.variants.map(v => v.id));
    for (const v of previous.variants) if (!retained.has(v.id)) this.db.prepare('DELETE FROM variants WHERE id=?').run(v.id);
    // Release renamed codes inside this transaction so A/B can become B/A without
    // deleting stable variant IDs or their image relationships. No temporary code escapes COMMIT.
    const releaseCode = this.db.prepare('UPDATE variants SET sku=? WHERE id=?');
    for (const v of previous.variants) {
      const next = input.variants.find(row => row.id === v.id);
      if (next && next.sku !== v.sku) releaseCode.run(`__RED_RENAME_${randomUUID()}`, v.id);
    }
    const upsert = this.db.prepare(`INSERT INTO variants VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      sku=excluded.sku,original_spec=excluded.original_spec,normalized_spec=excluded.normalized_spec,purchase_price=excluded.purchase_price,
      inventory=excluded.inventory,source_spec=excluded.source_spec,source_purchase_price=excluded.source_purchase_price,position=excluded.position`);
    input.variants.forEach((v, index) => {
      const old = previous.variants.find(row => row.id === v.id);
      upsert.run(v.id, input.id, v.sku, v.originalSpec, v.normalizedSpec, v.purchasePrice, v.inventory,
        old?.sourceSpec || v.originalSpec, old?.sourcePurchasePrice || v.purchasePrice, index);
    });
    saveFactScopes(this.db,previous,input);
    this.db.prepare('DELETE FROM facts WHERE product_id=?').run(input.id);
    const insertFact = this.db.prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?)');
    input.facts.forEach((f, index) => insertFact.run(f.id, input.id, f.name, f.value, f.source, f.sourceRef, f.state, index));
    this.db.prepare('UPDATE products SET title=?,source_url=?,description=?,status=?,revision=revision+1,updated_at=? WHERE id=?')
      .run(input.title, input.sourceUrl, input.description, input.status, now(), input.id);
    this.audit(input.id, 'product.updated', `保存「${input.title}」 · ${input.variants.length} 个 SKU`, { before: previous, after: input });
    return this.getProduct(input.id);
  }
  listAudit(productId?: string): AuditEvent[] {
    const rows = productId
      ? this.db.prepare('SELECT * FROM audit_events WHERE product_id=? ORDER BY rowid DESC LIMIT 200').all(identifier(productId))
      : this.db.prepare('SELECT * FROM audit_events ORDER BY rowid DESC LIMIT 200').all();
    return rows.map(e => ({ id: String(e.id), productId: e.product_id === null ? null : String(e.product_id), action: String(e.action), summary: String(e.summary), createdAt: String(e.created_at) }));
  }
  addAssets(raw: ProductMutation, assets: NewAsset[]): ProductDetail {
    const input = parseMutation(raw);
    return this.transaction(() => {
      const previous = this.assertRevision(input);
      if (!assets.length) return previous;
      let hasMain = previous.assets.some(a => a.role === 'main');
      const insert = this.db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const a of assets) {
        insert.run(a.id, input.productId, a.fileName, hasMain ? 'gallery' : 'main', a.mimeType, a.width, a.height, a.byteSize, a.originalPath, a.previewPath, a.sha256, now());
        hasMain = true;
      }
      this.db.prepare('UPDATE products SET revision=revision+1,updated_at=? WHERE id=?').run(now(), input.productId);
      this.audit(input.productId, 'assets.imported', `导入 ${assets.length} 张图片`, { assetIds: assets.map(a => a.id) });
      return this.getProduct(input.productId);
    });
  }
  updateAsset(raw: unknown): ProductDetail {
    const input = parseAssetUpdate(raw);
    return this.transaction(() => {
      const previous = this.assertRevision(input);
      const asset = previous.assets.find(a => a.id === input.assetId);
      if (!asset) throw new UserFacingError('图片不属于当前商品');
      if (input.variantIds.some(id => !previous.variants.some(v => v.id === id))) throw new UserFacingError('图片关联的 SKU 不属于当前商品');
      for(const variant of previous.variants){
        const was=asset.variantIds.includes(variant.id),next=input.variantIds.includes(variant.id);
        if(was!==next||asset.role!==input.role&&(was||next))recordConsistencyBinding(this.db,previous.id,variant.id,asset.id);
      }
      if(input.role==='main')for(const other of previous.assets.filter(a=>a.id!==asset.id&&a.role==='main'))for(const variant of previous.variants.filter(v=>other.variantIds.includes(v.id)||previous.variants.length===1))recordConsistencyBinding(this.db,previous.id,variant.id,other.id);
      if (input.role === 'main') this.db.prepare("UPDATE assets SET role='gallery' WHERE product_id=? AND role='main'").run(input.productId);
      this.db.prepare('UPDATE assets SET role=? WHERE id=?').run(input.role, input.assetId);
      this.db.prepare('DELETE FROM variant_assets WHERE asset_id=?').run(input.assetId);
      const insert = this.db.prepare('INSERT INTO variant_assets VALUES (?,?,1,?)');
      input.variantIds.forEach(id => insert.run(input.assetId, id, now()));
      this.db.prepare('UPDATE products SET revision=revision+1,updated_at=? WHERE id=?').run(now(), input.productId);
      this.audit(input.productId, 'asset.updated', `调整「${asset.fileName}」 · 关联 ${input.variantIds.length} 个 SKU`, { before: asset, after: input });
      return this.getProduct(input.productId);
    });
  }
  /** Append authentic byte identity and only this download session's new bindings atomically. */
  anchorSourceImage(input:ProductMutation,raw:unknown,variantIds:string[],newRole?:Asset['role']):ProductDetail {
    const anchor=validateSourceImageProvenance(raw);
    return this.transaction(()=>{
      const product=this.assertRevision(input);
      if(anchor.productId!==product.id)throw new UserFacingError('来源图片不属于该商品');
      if(newRole!==undefined&&!['main','gallery','detail'].includes(newRole))throw new UserFacingError('图片角色无效');
      assertSourceImageProvenance(this.db,anchor,this.directory);
      if(variantIds.some(id=>!product.variants.some(v=>v.id===id)||!anchor.mappings.some(m=>m.localVariantId===id)))throw new UserFacingError('来源图片映射已变化');
      const previous=this.db.prepare("SELECT record_json FROM source_image_provenance WHERE json_extract(record_json,'$.receiptId')=? AND json_extract(record_json,'$.imageId')=? AND json_extract(record_json,'$.assetId')=?").get(anchor.receiptId,anchor.imageId,anchor.assetId);
      if(!previous)this.db.prepare('INSERT INTO source_image_provenance VALUES(?,?)').run(anchor.id,JSON.stringify(anchor));
      let changed=false;
      if(newRole!==undefined&&product.assets.find(a=>a.id===anchor.assetId)?.role!=='main'){
        this.db.prepare('UPDATE assets SET role=? WHERE id=?').run(newRole==='main'?'gallery':newRole,anchor.assetId);changed=true;
      }
      for(const id of variantIds){
        // Existing confirmed=0 rows must never be reconfirmed by an automatic download.
        if(!this.db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=?').get(anchor.assetId,id)){
          recordConsistencyBinding(this.db,product.id,id,anchor.assetId);
          this.db.prepare('INSERT INTO variant_assets VALUES(?,?,1,?)').run(anchor.assetId,id,now());changed=true;
        }
      }
      if(changed)this.db.prepare('UPDATE products SET revision=revision+1,updated_at=? WHERE id=?').run(now(),product.id);
      return this.getProduct(product.id);
    });
  }
  getAssetRecord(id: string): StoredAsset | null {
    const a = this.db.prepare('SELECT * FROM assets WHERE id=?').get(identifier(id));
    return a ? this.assetRecord(a) : null;
  }
  findAssetByHash(productId: string, sha256: string): StoredAsset | null {
    const a = this.db.prepare('SELECT * FROM assets WHERE product_id=? AND sha256=?').get(identifier(productId), sha256);
    return a ? this.assetRecord(a) : null;
  }
  private assetRecord(a: Row): StoredAsset {
    return { id: String(a.id), productId: String(a.product_id), fileName: String(a.file_name), mimeType: String(a.mime_type),
      width: Number(a.width), height: Number(a.height), byteSize: Number(a.byte_size), originalPath: String(a.original_path), previewPath: String(a.preview_path), sha256: String(a.sha256) };
  }
  importProducts(products: ImportedProduct[], origin: ProductOrigin = 'import'): string[] {
    // Parse the entire batch before opening a write transaction.
    const validated = products.map(p => {
      const {factScopeModelVersion,...value}=p;
      if(factScopeModelVersion!==undefined&&factScopeModelVersion!==1)throw new UserFacingError('事实模型版本无效');
      return {...parseSaveProduct({ ...value, id: randomUUID(), revision: 1 }),...(factScopeModelVersion?{factScopeModelVersion}:{})};
    });
    return this.transaction(() => validated.map(input => {
      const id = this.insertProduct(origin, input.title);
      if(input.factScopeModelVersion)writeProductFactModel(this.db,id);
      this.saveInsideTransaction({ ...input, id });
      this.audit(id, 'product.imported', origin === 'sample' ? '载入示例商品' : '导入商品资料', { origin });
      return id;
    }));
  }
  /** Immutable import metadata identifies the group even after every title, SKU or placement is edited. */
  getSampleProductIds(lane: SampleLane): string[] {
    const rows = this.db.prepare(`SELECT p.id, (SELECT json_extract(e.detail_json,'$.sampleLane') FROM audit_events e
      WHERE e.product_id=p.id AND e.action='product.imported' AND json_extract(e.detail_json,'$.origin')='sample'
      ORDER BY e.rowid LIMIT 1) AS sample_lane FROM products p WHERE p.origin='sample' ORDER BY p.rowid`).all();
    // rc.2 examples have no group marker and belong to the original manual group.
    return rows.filter(row => (row.sample_lane ?? 'manual') === lane).map(row => String(row.id));
  }
  /** All files are prepared first; group identity, placement and SKU images commit together. */
  importSampleProducts(lane: SampleLane, products: ImportedProduct[], assets: NewAsset[][]): { productIds: string[]; created: boolean } {
    const validated = products.map(product => parseSaveProduct({ ...product, id: randomUUID(), revision: 1 }));
    if (validated.length !== 2 || assets.length !== validated.length || assets.some((items, index) => items.length !== validated[index].variants.length)) {
      throw new UserFacingError('本地示例图片与商品规格不一致');
    }
    return this.transaction(() => {
      const existing = this.getSampleProductIds(lane);
      if (existing.length) return { productIds: existing, created: false };
      const insertAsset = this.db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      const linkVariant = this.db.prepare('INSERT INTO variant_assets VALUES (?,?,1,?)');
      const productIds = validated.map((input, index) => {
        const id = this.insertProduct('sample', input.title), date = now();
        this.saveInsideTransaction({ ...input, id });
        this.db.prepare('UPDATE product_workspaces SET lane=? WHERE product_id=?').run(lane, id);
        assets[index].forEach((asset, variantIndex) => {
          insertAsset.run(asset.id, id, asset.fileName, variantIndex === 0 ? 'main' : 'gallery', asset.mimeType, asset.width, asset.height,
            asset.byteSize, asset.originalPath, asset.previewPath, asset.sha256, date);
          linkVariant.run(asset.id, input.variants[variantIndex].id, date);
        });
        this.audit(id, 'product.imported', '载入本地示例商品', { origin: 'sample', sampleLane: lane });
        return id;
      });
      return { productIds, created: true };
    });
  }
  /** This method owns the only transaction for a capture: never call importProducts from inside it. */
  receiveCollectionSnapshot(rawCaptureId: unknown, rawSnapshot: unknown): CollectionReceiveResult {
    const captureId = collectionId(rawCaptureId, 'INVALID_MESSAGE'), snapshot = validateCollectionSnapshot(rawSnapshot), fingerprint = collectionFingerprint(snapshot);
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT record_json FROM collection_captures WHERE id=?').get(captureId);
      if (prior) {
        const capture = validateCollectionCapture(JSON.parse(String(prior.record_json)));
        if (capture.fingerprint !== fingerprint) throw new CollectionError('CAPTURE_CONFLICT');
        const receiptRow = this.db.prepare('SELECT record_json FROM collection_receipts WHERE id=?').get(capture.receiptId);
        if (!receiptRow) throw new CollectionError('INTERNAL_ERROR');
        return this.collectionResult(capture, validateCollectionReceipt(JSON.parse(String(receiptRow.record_json))));
      }
      const sameContent = this.db.prepare("SELECT record_json FROM collection_receipts WHERE json_extract(record_json,'$.fingerprint')=?").get(fingerprint);
      let receipt: CollectionReceipt; const receivedAt = now();
      if (sameContent) receipt = validateCollectionReceipt(JSON.parse(String(sameContent.record_json)));
      else {
        const productId = this.insertProduct('import', snapshot.title || `1688 商品 ${snapshot.offerId}`), receiptId = randomUUID();
        this.db.prepare('UPDATE products SET source_url=? WHERE id=?').run(snapshot.sourceUrl, productId);
        const insert = this.db.prepare('INSERT INTO variants VALUES(?,?,?,?,?,?,?,?,?,?)');
        const skuMappings = snapshot.skus.map((sku, index) => {
          const localVariantId = randomUUID();
          insert.run(localVariantId, productId, `HTC-${localVariantId.toUpperCase()}`, sku.originalSpec, '', localCollectionPrice(sku.purchasePrice), null, sku.originalSpec, sku.purchasePrice ?? '', index);
          return { providerSkuId: sku.providerSkuId, localVariantId };
        });
        receipt = { id: receiptId, firstCaptureId: captureId, productId, fingerprint, receivedAt, snapshot, skuMappings };
        this.db.prepare('INSERT INTO collection_receipts VALUES(?,?)').run(receipt.id, JSON.stringify(receipt));
        this.audit(productId, 'collection.received', '1688 来源快照已加入采集收件箱', { receiptId, captureId });
      }
      const capture: CollectionCaptureRecord = { id: captureId, receiptId: receipt.id, fingerprint, capturedAt: snapshot.capturedAt, receivedAt, duplicate: Boolean(sameContent) };
      this.db.prepare('INSERT INTO collection_captures VALUES(?,?)').run(captureId, JSON.stringify(capture));
      return this.collectionResult(capture, receipt);
    });
  }
  private collectionResult(capture: CollectionCaptureRecord, receipt: CollectionReceipt): CollectionReceiveResult {
    return { captureId: capture.id, receiptId: receipt.id, productId: receipt.productId, duplicate: capture.duplicate, receivedAt: capture.receivedAt, warnings: receipt.snapshot.warnings, variantCount: receipt.snapshot.skus.length };
  }
  getCollectionReceipt(rawProductId: string): CollectionReceipt | null {
    return readNativeImageReceipt(this.db,identifier(rawProductId));
  }
  getStats(): { schemaVersion: number; productCount: number; assetCount: number } {
    return { schemaVersion: SCHEMA_VERSION, productCount: Number(this.db.prepare('SELECT count(*) AS n FROM products').get()!.n),
      assetCount: Number(this.db.prepare('SELECT count(*) AS n FROM assets').get()!.n) };
  }
}
