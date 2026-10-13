import { appendAuditEvent } from '../storage/audit.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AmazonService } from '../amazon/service.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ProcurementBatch, ProcurementBatchSummary, ProcurementCandidate, ProcurementLine } from '../../shared/procurement-contracts.ts';
import { identifier, record, text } from '../../shared/validation.ts';
import { sourceProductUrl } from '../../shared/source-links.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { openDatabase } from '../database.ts';
import { getReceipt } from '../miaoshou/persistence.ts';
import { localPrice, safeUrl } from '../miaoshou/validation.ts';
import { validateProcurementBatch, price, quantity, shipmentId } from './records.ts';
import type { ItemLabelStatus } from '../../shared/item-label-contracts.ts';
import { projectSalesProduct } from '../sales-plans/records.ts';
import { validateItemLabelRecord } from '../item-labels/records.ts';

type ProcurementAmazon = Pick<AmazonService, 'listDrafts' | 'getDraft' | 'getTarget' | 'getListingObservation'>;
interface Products { listProducts(): { id: string }[]; getProduct(id: string): ProductDetail }
export class ProcurementService {
  private db: DatabaseSync;
  private store: Products;
  private amazon: ProcurementAmazon;
  constructor(directory: string, store: Products, amazon: ProcurementAmazon) { this.db = openDatabase(directory); this.store = store; this.amazon = amazon; }
  close(): void { this.db.close(); }
  private candidate(draft: AmazonDraft): ProcurementCandidate {
    const product = this.store.getProduct(draft.productId), receipt = getReceipt(this.db, product.id);
    let projectionValid=true,variant=product.variants.find(item=>item.id===draft.variantId);
    try{variant=projectSalesProduct(product,draft.salesPlan,draft.variantId).variants.find(item=>item.id===draft.variantId);}catch{projectionValid=false;}
    const mapping = receipt?.skuMappings.find(item => item.localVariantId === draft.variantId), sourceSku = receipt?.snapshot.skus.find(item => item.key === mapping?.sourceKey);
    const source = receipt?.snapshot.sources.find(item => item.source === '1688') ?? receipt?.snapshot.sources[0];
    const productUrl = product.sourceUrl ? source?.source === '1688'
      ? sourceProductUrl({ ...source, sourceItemUrl: product.sourceUrl })
      : sourceProductUrl({ source: '1688', sourceItemId: '', sourceItemUrl: product.sourceUrl }) || safeUrl(product.sourceUrl) : '';
    const receiptUrl = source ? source.source === '1688' ? sourceProductUrl(source) : safeUrl(source.sourceItemUrl) : '';
    const sourceUrl = productUrl || receiptUrl, image = product.assets.find(item => item.variantIds.includes(draft.variantId)) ?? product.assets.find(item => item.role === 'main') ?? product.assets[0];
    const sourceImage = receipt?.snapshot.images.find(item => mapping?.imageIds.includes(item.id)) ?? receipt?.snapshot.images.find(item => item.role === 'main');
    const observation = this.amazon.getListingObservation(draft.id);
    const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const basis={productRevision:product.revision,sourceHash:hash(receipt?.snapshot ?? product),recipeHash:draft.salesPlan?hash(draft.salesPlan.recipe):null,observationHash:observation?hash(observation):null};
    let reason = '', targetMatches = false, requiresAttention = false;
    try { const target = this.amazon.getTarget(draft.targetId); targetMatches = target.sellerId === draft.sellerId && target.marketplaceId === draft.marketplaceId && target.mode === draft.mode; } catch { /* retained result can outlive the connection */ }
    if (draft.schema.parentageLevel === 'PARENT') reason = '父体不参与实物备货';
    else if (!projectionValid || !variant || variant.sku !== draft.sku) { reason = '本地 SKU 已变化，请核对商品'; requiresAttention = true; }
    else if (!targetMatches) { reason = '店铺身份已变化，请核对连接'; requiresAttention = true; }
    else if (draft.mode === 'live' && product.origin === 'sample') { reason = '示例商品不能进入正式备货'; requiresAttention = true; }
    else if (draft.state === 'UNKNOWN' || draft.state === 'SUBMITTING') { reason = '提交结果未知，等待核对'; requiresAttention = draft.state === 'UNKNOWN'; }
    else if (!draft.submittedAt) reason = '尚未正式提交';
    else if (!observation || observation.draftId !== draft.id || observation.sku !== draft.sku || observation.targetId !== draft.targetId || observation.sellerId !== draft.sellerId || observation.marketplaceId !== draft.marketplaceId || observation.checkedAt !== draft.checkedAt || !(Date.parse(observation.checkedAt) >= Date.parse(draft.submittedAt))) reason = '等待平台回读确认建档';
    else if (observation.issues.some(issue => issue.severity === 'ERROR') || draft.listingIssues.some(issue => issue.severity === 'ERROR') || draft.state === 'BLOCKED') { reason = '平台返回待处理问题'; requiresAttention = true; }
    else if (!observation.asin && !observation.statuses.some(status => ['BUYABLE','DISCOVERABLE'].includes(status))) reason = '尚未取得建档确认';
    else if(draft.salesPlan?.parentage==='CHILD'&&observation.familyRelationship?.status!=='MATCHED'){
      requiresAttention=observation.familyRelationship?.status==='MISMATCHED';
      reason=requiresAttention?'父 SKU 或变体主题与计划不一致':'等待平台确认父子体关联';
    }
    return { ...(draft.salesPlan?{salesRecipe:structuredClone(draft.salesPlan.recipe)}:{}), draftId: draft.id, productId: product.id, variantId: draft.variantId, title: product.title, spec: draft.salesPlan?.recipe.specification || variant?.sourceSpec || variant?.originalSpec || '', sku: draft.sku,
      basis, targetId: draft.targetId, targetName: draft.targetName, sellerId: draft.sellerId, marketplaceId: draft.marketplaceId, mode: draft.mode,
      sourceUrl, sourceItemId: source?.sourceItemId ?? '', sourceSkuKey: mapping?.sourceKey ?? '', sourceUrlBasis: productUrl ? 'product' : receiptUrl ? source?.sourceItemUrl ? 'miaoshou' : 'item-id' : 'missing',
      imageAssetId: image?.id ?? null, sourceImageUrl: safeUrl(sourceImage?.url ?? ''),
      sourcePurchasePrice: localPrice(variant?.purchasePrice ?? null) || localPrice(variant?.sourcePurchasePrice ?? null) || localPrice(sourceSku?.price ?? null),
      currency: draft.salesPlan?.recipe.totalCostCny!==undefined && draft.salesPlan.recipe.totalCostCny!==null ? 'CNY' : receipt?.mapping.currency ?? 'unknown', asin: observation?.asin ?? null, fnsku: observation?.fnsku ?? null, checkedAt: observation?.checkedAt ?? null,
      eligible: !reason, requiresAttention, reason: reason || (draft.mode === 'demo' ? '本地演示建档结果' : '平台建档已确认；入库资格需在发／补货时确认') };
  }
  candidates(): ProcurementCandidate[] {
    const newest = new Map<string, AmazonDraft>();
    for (const product of this.store.listProducts()) for (const draft of this.amazon.listDrafts(product.id)) {
      const key = JSON.stringify([draft.mode,draft.targetId,draft.sellerId,draft.marketplaceId,draft.sku]), prior = newest.get(key);
      const attempted = (item: AmazonDraft) => Boolean(item.submittedAt || ['UNKNOWN','SUBMITTING'].includes(item.state));
      if (!prior || attempted(draft) && !attempted(prior) || attempted(draft) === attempted(prior) && (draft.submittedAt ?? draft.updatedAt) > (prior.submittedAt ?? prior.updatedAt)) newest.set(key, draft);
    }
    return [...newest.values()].map(draft => this.candidate(draft));
  }
  list(): ProcurementBatchSummary[] {
    return this.db.prepare('SELECT id,record_json FROM procurement_batches ORDER BY rowid DESC').all().map(row => {
      const b = validateProcurementBatch(JSON.parse(String(row.record_json))); if (b.id !== row.id) throw new UserFacingError('备货批次身份不一致');
      return { id: b.id, code: b.code, name: b.name, mode: b.mode, lineCount: b.lines.length, updatedAt: b.updatedAt };
    });
  }
  get(rawId: unknown): ProcurementBatch {
    const id = identifier(rawId), row = this.db.prepare('SELECT record_json FROM procurement_batches WHERE id=?').get(id);
    if (!row) throw new UserFacingError('备货批次不存在'); const result = validateProcurementBatch(JSON.parse(String(row.record_json)));
    if (result.id !== id) throw new UserFacingError('备货批次身份不一致');
    const labels=this.db.prepare("SELECT record_json FROM item_labels WHERE json_extract(record_json,'$.batchId')=? AND json_extract(record_json,'$.current')=1").all(id).map(row=>validateItemLabelRecord(JSON.parse(String(row.record_json))));
    for(const line of result.lines){const label=labels.find(row=>row.lineId===line.id);line.labelStatus=label?((label.batchRevision===undefined||label.batchRevision===result.revision)&&label.quantity===line.stockQuantity?label.status:'STALE'):'NOT_REQUESTED';}
    return result;
  }
  create(raw: unknown): ProcurementBatch {
    const input = record(raw, '创建备货批次', ['name','draftIds']), name = text(input.name, '批次名称', 100, true);
    if (!Array.isArray(input.draftIds) || !input.draftIds.length || input.draftIds.length > 5000) throw new UserFacingError('请选择 1–5000 个 SKU');
    const ids = input.draftIds.map(identifier); if (new Set(ids).size !== ids.length) throw new UserFacingError('不能重复选择 SKU');
    const current = new Map(this.candidates().map(candidate => [candidate.draftId, candidate]));
    const candidates = ids.map(id => { const candidate = current.get(id); if (!candidate) throw new UserFacingError('所选 SKU 已有更新的提交，请刷新候选'); return candidate; });
    if (candidates.some(row => !row.eligible)) throw new UserFacingError(candidates.find(row => !row.eligible)!.reason);
    if (new Set(candidates.map(row => row.mode)).size !== 1) throw new UserFacingError('正式商品和演示商品不能放入同一批次');
    const id = randomUUID(), at = new Date().toISOString();
    const lines: ProcurementLine[] = candidates.map(({ mode: _mode, eligible: _eligible, reason: _reason, requiresAttention: _requiresAttention, ...row }) => ({ ...row, id: randomUUID(),
      purchaseQuantity: null, stockQuantity: null, purchasePrice: row.sourcePurchasePrice, purchaseUnit: '', priceConfirmed: false, labelStatus: 'NOT_REQUESTED' }));
    const batch = validateProcurementBatch({ id, code: `HTC-${at.slice(0,10).replaceAll('-','')}-${id.slice(0,8).toUpperCase()}`, name, revision: 1, mode: candidates[0].mode, createdAt: at, updatedAt: at, lines, shipment: null });
    this.db.prepare('INSERT INTO procurement_batches(id,record_json) VALUES(?,?)').run(id, JSON.stringify(batch)); return batch;
  }
  /** Called only by persisted main-process tasks; stock quantities are sales units. */
  ensureAutomaticBatch(rawJobId: string, draftIds: string[], stockQuantities: Record<string, number>): ProcurementBatch[] {
    const jobId = identifier(rawJobId), ids = draftIds.map(identifier);
    if (!ids.length || ids.length > 5000 || new Set(ids).size !== ids.length) throw new UserFacingError('自动备货 SKU 范围无效');
    const current = new Map(this.candidates().map(row => [row.draftId,row])), groups = new Map<string,ProcurementCandidate[]>();
    for (const id of ids) {
      const row = current.get(id); if (!row?.eligible) throw new UserFacingError(row?.reason ?? '自动备货商品已变化');
      const count = quantity(stockQuantities[id]); if (count === null || count < 1) throw new UserFacingError('自动备货需要明确的销售单位数量');
      const key = JSON.stringify([row.mode,row.targetId,row.sellerId,row.marketplaceId]); groups.set(key,[...(groups.get(key) ?? []),row]);
    }
    const result: ProcurementBatch[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key,candidates] of groups) {
        let batch = this.list().map(row=>this.get(row.id)).find(row=>row.automaticJobId===jobId && JSON.stringify([row.mode,row.lines[0].targetId,row.lines[0].sellerId,row.lines[0].marketplaceId])===key);
        if (!batch) { batch = this.create({name:`自动备货 ${jobId.slice(0,8)}`,draftIds:candidates.map(row=>row.draftId)}); batch.automaticJobId=jobId; }
        let changed = !this.get(batch.id).automaticJobId;
        for (const candidate of candidates) {
          let line = batch.lines.find(row=>row.sku===candidate.sku);
          if (!line) { const {mode:_mode,eligible:_eligible,reason:_reason,requiresAttention:_attention,...data}=candidate; line={...data,id:randomUUID(),purchaseQuantity:null,stockQuantity:stockQuantities[candidate.draftId],purchasePrice:candidate.sourcePurchasePrice,purchaseUnit:'',priceConfirmed:false,labelStatus:'NOT_REQUESTED'};batch.lines.push(line);changed=true; }
          // Once created, manual edits are authoritative; repeated readbacks never reset quantities.
          else if (line.stockQuantity === null && line.labelStatus === 'NOT_REQUESTED' && batch.revision === 1) {line.stockQuantity=stockQuantities[candidate.draftId];changed=true;}
          if(line.salesRecipe&&line.purchaseQuantity===null&&line.stockQuantity!==null){
            line.purchaseQuantity=line.stockQuantity;line.purchaseUnit='套（按组合明细采购）';
            line.purchasePrice=line.salesRecipe.totalCostCny===null?'':String(Number(line.salesRecipe.totalCostCny.toFixed(4)));
            line.priceConfirmed=line.salesRecipe.totalCostCny!==null;changed=true;
          }
        }
        if (changed) {batch.revision++;batch.updatedAt=new Date().toISOString();batch=validateProcurementBatch(batch);this.db.prepare('UPDATE procurement_batches SET record_json=? WHERE id=?').run(JSON.stringify(batch),batch.id);}
        result.push(batch);
      }
      this.db.exec('COMMIT'); return result;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  setLabelStatus(batchId: string, lineId: string, _status: ItemLabelStatus): void {
    // Compatibility notification only; item_labels owns status, get() projects it.
    if (!this.get(batchId).lines.some(row=>row.id===lineId)) throw new UserFacingError('标签备货行不存在');
  }
  update(raw: unknown): ProcurementBatch {
    const input = record(raw, '更新备货批次', ['id','revision','lines','shipmentConfirmationId']), batch = this.get(input.id);
    if (input.revision !== batch.revision) throw new UserFacingError('备货批次已更新，请刷新后再保存');
    const previous = structuredClone(batch);
    if (!Array.isArray(input.lines) || input.lines.length !== batch.lines.length) throw new UserFacingError('备货行必须完整保存');
    const seen = new Set<string>();
    for (const value of input.lines) {
      const row = record(value, '备货行编辑', ['id','purchaseQuantity','stockQuantity','purchasePrice','purchaseUnit','priceConfirmed']), id = identifier(row.id), line = batch.lines.find(item => item.id === id);
      if (!line || seen.has(id) || typeof row.priceConfirmed !== 'boolean') throw new UserFacingError('备货行身份或状态无效'); seen.add(id);
      const purchasePrice=price(row.purchasePrice), purchaseUnit=text(row.purchaseUnit,'采购单位',40);
      const priceConfirmed=row.priceConfirmed && purchasePrice===line.purchasePrice && purchaseUnit===line.purchaseUnit;
      Object.assign(line, { purchaseQuantity: quantity(row.purchaseQuantity), stockQuantity: quantity(row.stockQuantity), purchasePrice, purchaseUnit, priceConfirmed });
    }
    const at = new Date().toISOString(), confirmationId = shipmentId(input.shipmentConfirmationId);
    batch.shipment = !confirmationId ? null : confirmationId === batch.shipment?.confirmationId ? batch.shipment : { confirmationId, status: 'LINKED_UNVERIFIED', linkedAt: at };
    batch.revision++; batch.updatedAt = at;
    const validated = validateProcurementBatch(batch);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare("UPDATE procurement_batches SET record_json=? WHERE id=? AND json_extract(record_json,'$.revision')=?").run(JSON.stringify(validated), batch.id, input.revision as number);
      if (result.changes !== 1) throw new UserFacingError('备货批次已更新，请刷新后再保存');
      appendAuditEvent(this.db,randomUUID(),null,'procurement.revised','采购人工修订；原始来源与销售计划保持',JSON.stringify({previous,current:validated}),at);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
    return this.get(validated.id);
  }
}
