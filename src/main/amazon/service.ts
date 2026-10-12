import { sameSchemaValidation } from './schema-compatibility.ts';
import { plainColorValue } from '../listing-ai/plain-colors.ts';
import type { DatabaseSync } from 'node:sqlite';
import { CompletionJournal, completionDraftStamp } from '../listing-ai/completion-journal.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { ProductDetail, Variant } from '../../shared/contracts.ts';
import type { ListingObservation } from '../../shared/followup-contracts.ts';
import type { AmazonCallEvent, AmazonDataPolicy, AmazonDraft, AmazonSchema, AmazonTarget, CleanupResult, DraftReference, JsonObject, JsonValue, ListingEvent, ListingIssue, ListingProgram, PreparedAmazonDraftItem, PrepareAmazonDraftsResult, ProductTypeOption } from '../../shared/amazon-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { credentialStatus } from '../../shared/credential-status.ts';
import type { CredentialStatus } from '../../shared/credential-status.ts';
import type { AmazonCredentialDiagnostics } from '../../shared/amazon-contracts.ts';
import { attributesObject, clone, isObject, listingHash, marketplace, object, schemaKey, selection, textField } from './context.ts';
import { demoSchema, DEMO_TYPE, sourceAttributes, sourceMappingReport } from './demo.ts';
import { observeFamilyRelationship } from './relationships.ts';
import { AmazonPersistence } from './persistence.ts';
import type { DraftRecord } from './persistence.ts';
import { compileAttributesSchema, validateAttributes } from './schema.ts';
import { nonDeferredImageIssues } from '../image-workflow/deferred-fields.ts';
import { AmazonTransport, AmazonTransportError } from './transport.ts';
import type { AmazonDependencies, ApiResult } from './transport.ts';
import type { ProductDataKind } from './read-data.ts';
import { CredentialVault, parseCredentials } from './vault.ts';
import type { SecretStorage } from './vault.ts';
import { TaskWriteNotSentError } from './task-errors.ts';
import type { ListingFieldAdoption } from '../../shared/listing-ai-contracts.ts';
import type { AcceptedAmazonSku } from '../../shared/product-data-contracts.ts';
import { LISTING_CANDIDATE_FIELDS } from '../../shared/listing-ai-contracts.ts';
import { candidateTextValues, validatePolicyOutputs, wrapCandidateValues } from './field-mapping.ts';
import { resolveSchemaNode } from './field-catalog.ts';
import { PREPARATION_MAX_BYTES, preparationInput, preparationSchemaIdentity, semanticJson } from './preparation.ts';
import { cleanHaulAttributes, haulCleanupReason, assertListingProgram, listingProgram, listingProgramIssues, programAttributes } from './listing-program.ts';
import { miaoshouMeasurementsForVariant } from '../miaoshou/measurements.ts';
import { getReceipt } from '../miaoshou/persistence.ts';
import { readListingRules } from '../listing-rules.ts';
import { applyBusinessRules, ruleSourceMapping } from './business-rules.ts';
import { declarationSafetyIssues, selectedDeclarationScope } from './declaration-safety.ts';
import { currentFactAuthority, FACT_PROTECTED_FIELDS } from './fact-authority.ts';
import { assertStoredPricingForPaid } from './pricing-guard.ts';
import type { BusinessRuleReport } from '../../shared/listing-rules.ts';
import { confirmedPurchaseCurrency } from './business-currency.ts';
import { canSendToPreview } from './preview-validation.ts';
import { assertPricingDecision } from '../listing-ai/history.ts';
import type { SalesRecipe, SalesListingPlan } from '../../shared/sales-plan-contracts.ts';
import { projectSalesProduct, validateSalesPlan } from '../sales-plans/records.ts';
import { salesStoreScope } from '../sales-plans/planning.ts';
import { relationshipAttributes } from '../sales-plans/families.ts';
import { buildSalesRecipes, sourceQuotedCost } from '../sales-plans/recipes.ts';
import { assertSalesPlanNamingIdentity } from '../sales-plans/history.ts';
import { getSalesParentIdentity, isSameSalesFamily } from '../sales-plans/family-binding.ts';

const PREVIEW_TTL = 15 * 60_000;
const FINAL_STATES = new Set(['SUBMITTING', 'SUBMITTED', 'PROCESSING', 'BUYABLE', 'DISCOVERABLE', 'UNKNOWN']);
export const FAMILY_REBIND_EVENT_SUMMARY = '已原地迁移未提交草稿的父子关系；原 SKU、销售配方、文案和图片保留，旧预览已失效';
function reference(input: unknown): DraftReference {
  const value = object(input); const id = textField(value.id, '草稿 ID', 100);
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) throw new UserFacingError('草稿版本无效，请重新加载');
  return { id, revision: value.revision as number };
}
function localIssue(code: string, message: string, attributeNames: string[] = [], category: ListingIssue['category'] = 'field'): ListingIssue {
  return { code, message, attributeNames, category, severity: 'ERROR', source: 'local', autoFixable: false };
}
function remoteIssues(raw: unknown, mode: AmazonTarget['mode']): ListingIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).map(value => {
    const issue = isObject(value) ? value : {};
    const categories = Array.isArray(issue.categories) ? issue.categories.filter(v => typeof v === 'string').join(' ') : '';
    const names = Array.isArray(issue.attributeNames) ? issue.attributeNames.filter((v): v is string => typeof v === 'string').map(v => v.slice(0, 100)) : [];
    const category: ListingIssue['category'] = /QUALIFICATION|APPROVAL/.test(categories) ? 'qualification' : /COMPLIANCE|RESTRICTED/.test(categories) ? 'compliance'
      : /IMAGE/.test(categories) || names.some(name => name.includes('image')) ? 'image' : /RATE_LIMIT/.test(categories) ? 'rate_limit' : 'field';
    return { code: typeof issue.code === 'string' ? issue.code.slice(0, 100) : 'AMAZON_ISSUE', message: typeof issue.message === 'string' ? issue.message.slice(0, 1200) : 'Amazon 返回未识别的问题，请核对平台信息',
      severity: issue.severity === 'WARNING' || issue.severity === 'INFO' ? issue.severity : 'ERROR', attributeNames: names, category, source: mode === 'demo' ? 'demo' : 'amazon', autoFixable: false };
  });
}
function imageIssues(attributes: JsonObject): ListingIssue[] {
  const issues: ListingIssue[] = [];
  function inspect(value: JsonValue, path: string[]): void {
    if (typeof value === 'string') {
      const locator = path.some(key => /image|media_location/i.test(key));
      if (/^(?:red-asset|file|blob|data):/i.test(value)) { issues.push(localIssue('LOCAL_ASSET_URL', '本地素材地址不能用于 Amazon 上架，请填写公开 HTTPS 图片地址', path.slice(0, 1), 'image')); return; }
      if (!locator || !/^(?:\w+:|\/\/)/.test(value)) return;
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname === 'localhost' || url.hostname.endsWith('.local') || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname) || url.hostname.startsWith('[')) throw new Error('private locator');
      } catch { issues.push(localIssue('IMAGE_URL_NOT_PUBLIC', '图片必须使用公开 HTTPS 地址', path.slice(0, 1), 'image')); }
    } else if (Array.isArray(value)) value.forEach((child, index) => inspect(child, [...path, String(index)]));
    else if (isObject(value)) for (const [key, child] of Object.entries(value)) inspect(child, [...path, key]);
  }
  inspect(attributes, []); return issues;
}
function copyPolicyIssues(draft: AmazonDraft): ListingIssue[] {
  if (draft.listingProgram !== 'haul' || draft.schema.locale !== 'en_US') return [];
  const values: Partial<Record<string,string[]>> = {};
  for (const name of LISTING_CANDIDATE_FIELDS) if (Array.isArray(draft.attributes[name])) {
    values[name] = candidateTextValues(name,draft.attributes[name])??[''];
  }
  try {
    const issues = validatePolicyOutputs(draft.schema, values);
    for (const [field,entries] of Object.entries(values)) if (entries?.some(v=>/[\p{Script=Han}\p{Script=Cyrillic}]/u.test(v))) issues.push(localIssue('POLICY_ENGLISH_REQUIRED','美国站文案字段需要英文内容',[field]));
    return issues;
  } catch { return [localIssue('POLICY_SCHEMA_UNSUPPORTED','当前 Schema 无法提取文案约束，请更新字段规则')]; }
}

/** Readback metadata may advance independently; identity and submitted content may not. */
function readbackDraftScope(draft: AmazonDraft): string {
  const { id, productId, productRevision, variantId, sku, targetId, sellerId, marketplaceId, mode, revision, schema, attributes, listingProgram, salesPlan, submittedAt, submissionId } = draft;
  return semanticJson({ id, productId, productRevision, variantId, sku, targetId, sellerId, marketplaceId, mode, revision, schema, attributes, listingProgram, salesPlan: salesPlan ?? null, submittedAt, submissionId } as unknown as JsonValue);
}
function readbackTargetScope(target: AmazonTarget): string {
  const { id, sellerId, marketplaceId, mode, region, locale } = target;
  return semanticJson({ id, sellerId, marketplaceId, mode, region, locale });
}

export class AmazonService {
  private persistence: AmazonPersistence;
  private vault: CredentialVault;
  private transport: AmazonTransport;
  private getProduct: (id: string) => ProductDetail;
  private now: () => number;
  private busy = new Set<string>();
  private closed = false;
  constructor(directory: string, getProduct: (id: string) => ProductDetail, secretStorage: SecretStorage, dependencies: AmazonDependencies = {}) {
    this.persistence = new AmazonPersistence(directory); this.vault = new CredentialVault(directory, secretStorage); this.getProduct = getProduct; this.now = dependencies.now ?? Date.now;
    this.transport = new AmazonTransport({ active: id => this.active(id), generation: id => this.persistence.generation(id), credentials: id => this.vault.read(id, this.persistence.generation(id)),
      pause: (id, message) => this.pauseForError(id, message), audit: event => this.persistence.addCall(event), redact: value => this.vault.redact(value), remember: value => this.vault.remember(value) }, dependencies);
    try {
      let liveEnabled = false;
      for (const target of this.persistence.targets()) if (target.mode === 'live' && target.configured) {
        this.targetCredentialStatus(target); // Register readable secrets for redaction without changing stored intent.
        // Enforce the single-store rule from stored intent; a temporary decrypt failure is read-only.
        if (!target.paused && liveEnabled) { target.paused = true; target.lastError = '当前只允许启用一个正式店铺'; this.persistence.putTarget(target); }
        if (!target.paused) liveEnabled = true;
      }
      this.persistence.recover(this.at()); this.persistence.cleanup(this.now());
    } catch (error) { this.persistence.close(); throw error; }
  }
  private at(): string { return new Date(this.now()).toISOString(); }
  private ensureOpen(): void { if (this.closed) throw new UserFacingError('Amazon 服务已关闭'); }
  close(): void { if (!this.closed) { this.transport.clear(); this.persistence.close(); this.closed = true; } }
  private targetCredentialStatus(target: AmazonTarget): CredentialStatus {
    const result = this.vault.inspect(target.id, this.persistence.generation(target.id));
    const state = result.state === 'readable' && (result.credentials.sellerId !== target.sellerId || result.credentials.marketplaceId !== target.marketplaceId || result.credentials.region !== target.region) ? 'metadata-mismatch' : result.state;
    return credentialStatus(state, target.configured, !target.paused);
  }
  private publicTarget(target: AmazonTarget): AmazonTarget {
    if (target.mode === 'demo') return this.vault.redact(target);
    const status = this.targetCredentialStatus(target), configured = status.state === 'ready' || status.state === 'configured-disabled';
    return this.vault.redact({ ...target, configured, paused: target.paused || !configured });
  }
  listTargets(): AmazonTarget[] { this.ensureOpen(); return this.persistence.targets().map(target => this.publicTarget(target)); }
  getTarget(id: string): AmazonTarget { this.ensureOpen(); return this.publicTarget(this.persistence.target(textField(id, '店铺 ID', 100))); }
  credentialDiagnostics(): AmazonCredentialDiagnostics {
    this.ensureOpen(); const stored = this.persistence.targets().filter(target => target.mode === 'live'), ids = new Set(stored.map(target => target.id));
    return { targets: stored.map(target => ({ targetId: target.id, ...this.targetCredentialStatus(target) })), orphanedCredentialCount: this.vault.savedIds().filter(id => !ids.has(id)).length };
  }
  /** Main-process task scope only; no credentials are exposed by this generation stamp. */
  executionTargetScope(id: string): { target: AmazonTarget; generation: number } { return { target: this.getTarget(id), generation: this.persistence.generation(id) }; }
  async readProductData(targetId: string, kind: ProductDataKind, query: Record<string,string>, beforeSend?: () => void): Promise<ApiResult> {
    this.ensureOpen(); return this.transport.readData(this.active(targetId),kind,query,beforeSend);
  }
  async createMarketplaceItemLabels(targetId: string, body: JsonObject, beforeSend?: () => void): Promise<ApiResult> {
    this.ensureOpen(); return this.transport.createMarketplaceItemLabels(this.active(targetId), body, beforeSend);
  }
  async downloadItemLabel(url: string): Promise<Buffer> { this.ensureOpen(); return this.transport.downloadItemLabel(url); }
  private active(id: string): AmazonTarget {
    const target = this.getTarget(id);
    if (!target.configured) throw new UserFacingError('店铺授权当前不可用，请在设置中检查凭据状态');
    if (target.paused) throw new UserFacingError('店铺已暂停，请在设置中核对后解除暂停');
    return target;
  }
  private invalidateTarget(id: string): void {
    for (const record of this.persistence.records()) if (record.draft.targetId === id && record.preview) {
      record.preview = null; record.draft.previewedAt = null; record.draft.previewIssues = [];
      if (!FINAL_STATES.has(record.draft.state)) record.draft.state = 'DRAFT';
      this.event(record, 'save', '店铺授权或状态已改变，请重新预览'); this.persistence.putRecord(record);
    }
  }
  private pauseForError(id: string, message: string): void {
    const target = this.persistence.target(id); target.paused = true; target.lastError = message; this.persistence.putTarget(target); this.invalidateTarget(id); this.transport.clear(id);
  }
  enableDemo(): AmazonTarget {
    this.ensureOpen(); const existing = this.persistence.targets().find(target => target.mode === 'demo');
    const target: AmazonTarget = existing ?? { id: randomUUID(), name: '本地演示店铺', mode: 'demo', sellerId: 'HTC_LOCAL_DEMO_SELLER', marketplaceId: 'ATVPDKIKX0DER', marketplaceName: '美国（本地演示）',
      region: 'na', locale: 'en_US', paused: false, configured: true, credentialUpdatedAt: null, lastError: null };
    target.paused = false; target.configured = true; target.lastError = null; this.persistence.putTarget(target); return clone(target);
  }
  async importCredentials(raw: unknown): Promise<AmazonTarget> {
    this.ensureOpen(); const credentials = parseCredentials(raw);
    const existing = this.persistence.targets().find(target => target.mode === 'live' && target.sellerId === credentials.sellerId && target.marketplaceId === credentials.marketplaceId && target.region === credentials.region);
    const id = existing?.id ?? randomUUID();
    const target: AmazonTarget = { id, name: credentials.name, mode: 'live', sellerId: credentials.sellerId, marketplaceId: credentials.marketplaceId,
      marketplaceName: marketplace(credentials.marketplaceId, credentials.region), region: credentials.region, locale: credentials.locale, configured: true, paused: false, credentialUpdatedAt: this.at(), lastError: null };
    if (JSON.stringify(this.vault.redact(target)) !== JSON.stringify(target)) throw new UserFacingError('店铺公开字段中不能包含敏感授权配置');
    const rollback = this.vault.write(id, credentials, this.persistence.generation(id) + 1); this.transport.clear(id);
    try {
      this.persistence.transaction(() => {
        for (const other of this.persistence.targets()) if (other.mode === 'live' && other.id !== id && !other.paused) {
          other.paused = true; other.lastError = '已切换到另一个正式店铺'; this.persistence.putTarget(other); this.invalidateTarget(other.id); this.transport.clear(other.id);
        }
        this.persistence.putTarget(target, true); this.invalidateTarget(id);
      });
    } catch {
      try { rollback(); } catch { throw new UserFacingError('授权更新未完成，原加密配置无法还原；请重新导入授权配置'); }
      throw new UserFacingError('授权更新未完成，原连接已保留；请检查数据目录后重试');
    }
    return this.vault.redact(target);
  }
  pauseTarget(input: unknown): AmazonTarget {
    this.ensureOpen(); const value = object(input); const target = this.persistence.target(textField(value.targetId, '店铺 ID', 100));
    if (typeof value.paused !== 'boolean') throw new UserFacingError('暂停状态无效');
    if (!value.paused && !this.publicTarget(target).configured) throw new UserFacingError('店铺授权当前不可用，不能解除暂停，请先检查凭据状态');
    if (!value.paused && target.mode === 'live') {
      this.vault.read(target.id, this.persistence.generation(target.id));
      for (const other of this.persistence.targets()) if (other.mode === 'live' && other.id !== target.id && !other.paused) {
        other.paused = true; this.persistence.putTarget(other); this.invalidateTarget(other.id); this.transport.clear(other.id);
      }
    }
    target.paused = value.paused; target.lastError = null; this.persistence.putTarget(target); this.invalidateTarget(target.id); this.transport.clear(target.id); return this.publicTarget(target);
  }
  disconnectTarget(id: string): void {
    this.ensureOpen(); const target = this.persistence.target(textField(id, '店铺 ID', 100)); if (target.mode === 'live') this.vault.remove(target.id);
    target.configured = false; target.paused = true; target.lastError = null; this.persistence.putTarget(target, true); this.invalidateTarget(id); this.transport.clear(id);
  }
  async searchProductTypes(input: unknown): Promise<ProductTypeOption[]> {
    const value = object(input); const target = this.active(textField(value.targetId, '店铺 ID', 100));
    const keywords = textField(value.keywords, '搜索关键词', 200);
    if (target.mode === 'demo') { this.demoCall(target, 'searchDefinitionsProductTypes'); return [{ name: DEMO_TYPE, displayName: '收纳袋（HTC 本地演示示例）' }]; }
    const result = await this.transport.api(target, 'searchDefinitionsProductTypes', '/definitions/2020-09-01/productTypes', { marketplaceIds: target.marketplaceId, keywords, locale: target.locale, searchLocale: target.locale });
    if (!Array.isArray(result.data.productTypes)) throw new UserFacingError('Amazon 商品类型响应无效');
    return result.data.productTypes.filter(isObject).filter(item => typeof item.name === 'string' && /^[A-Z0-9][A-Z0-9_]{0,99}$/.test(item.name)
      && (!Array.isArray(item.marketplaceIds) || item.marketplaceIds.includes(target.marketplaceId))).slice(0, 100).map(item => ({ name: String(item.name), displayName: typeof item.displayName === 'string' ? item.displayName.slice(0, 200) : String(item.name) }));
  }
  /** Full Product Type index; browse nodes and seller-specific Haul eligibility are separate. */
  async fetchProductTypeLibrary(targetId: string): Promise<ProductTypeOption[]> {
    const target = this.active(textField(targetId, '店铺 ID', 100)), generation = this.persistence.generation(target.id);
    if (target.mode === 'demo') return [{ name: DEMO_TYPE, displayName: '本地演示商品类型' }];
    const result = await this.transport.api(target, 'searchDefinitionsProductTypes', '/definitions/2020-09-01/productTypes', { marketplaceIds: target.marketplaceId, locale: target.locale });
    if (generation !== this.persistence.generation(target.id)) throw new UserFacingError('店铺授权已变化，请重新同步类目库');
    this.active(target.id);
    if (!Array.isArray(result.data.productTypes) || !result.data.productTypes.length || result.data.productTypes.length > 20000) throw new UserFacingError('Amazon 产品类型列表无效，已保留原类目缓存');
    return result.data.productTypes.map(item => {
      if (!isObject(item) || typeof item.name !== 'string' || !/^[A-Z0-9][A-Z0-9_]{0,99}$/.test(item.name) || typeof item.displayName !== 'string' || !item.displayName.trim() || item.displayName.length > 300
        || !Array.isArray(item.marketplaceIds) || !item.marketplaceIds.includes(target.marketplaceId)) throw new UserFacingError('Amazon 产品类型返回的站点或字段不匹配');
      return { name: item.name, displayName: item.displayName };
    });
  }
  async getSchema(input: unknown): Promise<AmazonSchema> {
    this.ensureOpen(); const selected = selection(input); const options = object(input); const target = this.active(selected.targetId);
    if (options.forceRefresh !== undefined && typeof options.forceRefresh !== 'boolean') throw new UserFacingError('Schema 刷新参数无效');
    const key = schemaKey(target, selected); const cached = this.persistence.schema(key);
    if (!options.forceRefresh && cached && Date.parse(cached.expiresAt) > this.now()) return { ...cached, fromCache: true };
    let snapshot: AmazonSchema;
    if (target.mode === 'demo') {
      if (selected.productType !== DEMO_TYPE) throw new UserFacingError('本地演示仅支持 HTC_DEMO_STORAGE_BAG，不代表正式 Amazon 商品类型');
      snapshot = demoSchema(target, selected, this.now()); this.demoCall(target, 'getDefinitionsProductType');
    } else {
      const generation = this.persistence.generation(target.id);
      const result = await this.transport.api(target, 'getDefinitionsProductType', `/definitions/2020-09-01/productTypes/${encodeURIComponent(selected.productType)}`, {
        sellerId: target.sellerId, marketplaceIds: target.marketplaceId, requirements: selected.requirements, requirementsEnforced: 'ENFORCED', parentageLevel: selected.parentageLevel, locale: selected.locale, productTypeVersion: 'LATEST' });
      const data = result.data;
      if (!Array.isArray(data.marketplaceIds) || data.marketplaceIds.length !== 1 || data.marketplaceIds[0] !== target.marketplaceId || data.productType !== selected.productType || data.requirements !== selected.requirements || data.requirementsEnforced !== 'ENFORCED'
        || (selected.locale !== 'DEFAULT' && data.locale !== selected.locale) || !isObject(data.productTypeVersion) || typeof data.productTypeVersion.version !== 'string') throw new UserFacingError('Amazon Schema 返回的站点、语言、类目或要求集不匹配');
      const schema = await this.transport.schemaLink(target, data.schema);
      const meta = data.metaSchema ? await this.transport.schemaLink(target, data.metaSchema) : { schema: {} };
      this.active(target.id); if (generation !== this.persistence.generation(target.id)) throw new UserFacingError('店铺授权已变化，请重新获取 Schema');
      try { compileAttributesSchema(schema.schema, meta.schema); } catch { throw new UserFacingError('Amazon Schema 包含当前版本不支持的约束，已阻止使用；请升级 HTC'); }
      const propertyGroups: AmazonSchema['propertyGroups'] = {};
      if (isObject(data.propertyGroups)) for (const [key, group] of Object.entries(data.propertyGroups)) if (isObject(group) && typeof group.title === 'string' && Array.isArray(group.propertyNames)) {
        propertyGroups[key] = { title: group.title.slice(0, 200), propertyNames: group.propertyNames.filter((name): name is string => typeof name === 'string') };
      }
      snapshot = { ...selected, key, mode: 'live', schema: schema.schema, metaSchema: meta.schema, checksum: schema.checksum, version: data.productTypeVersion.version,
        propertyGroups, fetchedAt: this.at(), expiresAt: new Date(this.now() + 86_400_000).toISOString(), fromCache: false };
    }
    this.persistence.putSchema(snapshot); return clone(snapshot);
  }
  listDrafts(productId: string): AmazonDraft[] { this.ensureOpen(); return this.persistence.records(textField(productId, '商品 ID', 100)).map(record => this.vault.redact(record.draft)); }
  listAcceptedSkus(targetId: string): AcceptedAmazonSku[] { this.ensureOpen(); return this.persistence.listAcceptedSkus(textField(targetId, '店铺 ID', 100)); }
  getDraft(id: string): AmazonDraft { this.ensureOpen(); return this.vault.redact(this.persistence.record(textField(id, '草稿 ID', 100)).draft); }
  /** A definitive INVALID response permits repair; absence of a response never does. Main process only. */
  wasSubmissionRejected(id: string): boolean {
    this.ensureOpen();const record=this.persistence.record(textField(id,'草稿 ID',100)),draft=record.draft;
    return !record.unresolvedWrite&&!draft.submittedAt&&!this.persistence.locked(listingHash(draft,draft.sku))
      &&record.submitResponse?.status==='INVALID'&&record.submitResponse.sku===draft.sku
      &&Array.isArray(record.submitResponse.issues)&&remoteIssues(record.submitResponse.issues,draft.mode).some(issue=>issue.severity==='ERROR');
  }
  getListingObservation(id: string):ListingObservation|null {
    this.ensureOpen();
    const record = this.persistence.record(textField(id, '草稿 ID', 100)), draft = record.draft, response = record.readResponse;
    if (!draft.checkedAt || record.unresolvedWrite || !response || response.sku !== draft.sku || !Array.isArray(response.summaries)) return null;
    // Backup recovery retains newer write locks even if their drafts were not in the old snapshot.
    // Old successful observations cannot clear that unresolved SKU-level write outcome.
    const lock = this.persistence.lock(listingHash(draft, draft.sku));
    if (lock && ['UNKNOWN','SUBMITTING'].includes(lock.state)) return null;
    const summary = response.summaries.find(value => isObject(value) && value.marketplaceId === draft.marketplaceId);
    if (!isObject(summary)) return null;
    const asin = typeof summary.asin === 'string' && /^[A-Z0-9]{10}$/.test(summary.asin) ? summary.asin : null;
    const fnsku = typeof summary.fnSku === 'string' && /^[A-Z0-9]{10}$/.test(summary.fnSku) ? summary.fnSku : null;
    return this.vault.redact({ draftId: draft.id, targetId: draft.targetId, sellerId: draft.sellerId, marketplaceId: draft.marketplaceId, sku: draft.sku,
      checkedAt: draft.checkedAt, requestId: draft.requestId, asin, fnsku, statuses: [...draft.statuses], issues: clone(draft.listingIssues),familyRelationship:observeFamilyRelationship(draft,response) });
  }
  private checked(input: unknown): DraftRecord {
    this.ensureOpen(); const ref = reference(input); const record = this.persistence.record(ref.id);
    if (record.draft.revision !== ref.revision) throw new UserFacingError('草稿已更新，请重新加载后操作');
    return record;
  }
  private mutable(record: DraftRecord): void {
    if (record.unresolvedWrite || this.persistence.locked(listingHash(record.draft, record.draft.sku))) throw new UserFacingError('此 SKU 提交结果未知或尚未确认，请回读并人工核对；禁止重复提交');
    if (FINAL_STATES.has(record.draft.state) || record.draft.submittedAt) throw new UserFacingError('此草稿已提交，请先回读；需要修改时新建草稿并重新校验');
  }
  private currentProduct(record: DraftRecord): ProductDetail {
    const product = projectSalesProduct(this.getProduct(record.draft.productId), record.draft.salesPlan, record.draft.variantId);
    if (product.revision !== record.draft.productRevision || !product.variants.some(variant => variant.id === record.draft.variantId && variant.sku === record.draft.sku)) throw new UserFacingError('来源商品资料已变化，请建立新草稿后重新校验和预览');
    return product;
  }
  findSalesDraft(productId:string,plan:SalesListingPlan,targetId:string):AmazonDraft|undefined {
    const target=this.getTarget(targetId);
    // Family classification can improve without changing the underlying sale.
    // Keep source identity + recipe stable across those changes, including imports.
    const sourceIdentity=(key:string)=>key.match(/^(.*):[a-f0-9]{64}$/u)?.[1]??null;
    const sameRecipe=(d:AmazonDraft)=>!!d.salesPlan&&d.salesPlan.recipe.key===plan.recipe.key
      &&(d.salesPlan.sourceGroupKey===plan.sourceGroupKey||!!sourceIdentity(plan.sourceGroupKey)&&sourceIdentity(d.salesPlan.sourceGroupKey)===sourceIdentity(plan.sourceGroupKey));
    const candidates=this.persistence.records().map(r=>r.draft).filter(d=>d.targetId===target.id&&d.sellerId===target.sellerId&&d.marketplaceId===target.marketplaceId&&d.mode===target.mode&&d.schema.parentageLevel!=='PARENT'
      &&(d.sku===plan.sku||sameRecipe(d)
        ||!d.salesPlan&&d.productId===productId&&plan.recipe.components.length===1&&d.variantId===plan.recipe.components[0].variantId&&(d.businessRules?.bundleQuantity??1)===plan.recipe.totalPieces));
    const sent=(d:AmazonDraft)=>!!d.submittedAt||['SUBMITTING','SUBMITTED','PROCESSING','BUYABLE','DISCOVERABLE','UNKNOWN'].includes(d.state);
    candidates.sort((a,b)=>Number(sent(b))-Number(sent(a))||b.updatedAt.localeCompare(a.updatedAt));
    return candidates[0]?clone(candidates[0]):undefined;
  }
  /** A non-buyable family parent may reuse its own child's approved main image. */
  useFamilyImage(parentId:string,childId:string):AmazonDraft {
    const parent=this.persistence.record(parentId),child=this.persistence.record(childId);
    this.mutable(parent);this.currentProduct(parent);this.currentProduct(child);
    if(parent.draft.salesPlan?.parentage!=='PARENT'||child.draft.salesPlan?.parentage!=='CHILD'
      ||!isSameSalesFamily(parent.draft.salesPlan,child.draft.salesPlan)||parent.draft.sku!==child.draft.salesPlan.parentSku
      ||parent.draft.targetId!==child.draft.targetId||parent.draft.productId!==child.draft.productId||parent.draft.sellerId!==child.draft.sellerId
      ||parent.draft.marketplaceId!==child.draft.marketplaceId||parent.draft.mode!==child.draft.mode)throw new UserFacingError('父体图片只能引用同商品组的子体');
    if(parent.draft.parentImageSourceDraftId===childId)return clone(parent.draft);
    parent.draft.parentImageSourceDraftId=childId;parent.draft.revision++;parent.preview=null;parent.draft.previewedAt=null;parent.draft.state='DRAFT';
    this.persistence.putRecord(parent);return clone(parent.draft);
  }
  /** Main-process migration only. The immutable sale identity is never reassigned. */
  async rebindUnsubmittedFamily(input:{id:string;revision:number;plan:SalesListingPlan},signal?:AbortSignal):Promise<AmazonDraft> {
    if(Object.keys(object(input)).some(key=>!['id','revision','plan'].includes(key)))throw new UserFacingError('父子关系迁移只接受草稿版本和已核对的销售关系');
    const record=this.checked(input),before=clone(record),draft=record.draft;
    const checkCancelled=()=>{if(signal?.aborted)throw new UserFacingError('父子关系迁移已取消');};
    checkCancelled();this.mutable(record);this.enter(draft.id);
    try {
      const prior=draft.salesPlan?validateSalesPlan(draft.salesPlan):null,plan=validateSalesPlan(input.plan);
      if(!prior||prior.parentage!=='NONE'||draft.schema.parentageLevel!=='NONE'||plan.parentage!=='CHILD'||!plan.familyResolved)throw new UserFacingError('只能原地迁移尚未提交的独立销售草稿');
      for(const key of ['namingGroupId','sourceGroupKey','collectedAt','collectionBasis','sku','baseSku','namingChildKey','recipe'] as const){
        if(semanticJson(prior[key] as unknown as JsonValue)!==semanticJson(plan[key] as unknown as JsonValue))throw new UserFacingError('关系迁移不能改变原 SKU 命名身份或销售配方');
      }
      const source=this.getProduct(draft.productId),target=this.active(draft.targetId),generation=this.persistence.generation(target.id);
      this.currentProduct(record);
      const receipt=getReceipt(this.persistence.db,source.id),rules=readListingRules(this.persistence.db);
      const assertCurrent=()=>{
        checkCancelled();const current=this.checked(input),nowTarget=this.active(target.id);this.mutable(current);this.currentProduct(current);
        if(JSON.stringify(current)!==JSON.stringify(before)||JSON.stringify(this.getProduct(source.id))!==JSON.stringify(source)
          ||JSON.stringify(getReceipt(this.persistence.db,source.id))!==JSON.stringify(receipt)||JSON.stringify(readListingRules(this.persistence.db))!==JSON.stringify(rules))throw new UserFacingError('迁移期间草稿、来源或规则已变化，请重新核对');
        if(this.persistence.generation(target.id)!==generation||nowTarget.mode!==draft.mode||nowTarget.sellerId!==draft.sellerId||nowTarget.marketplaceId!==draft.marketplaceId||nowTarget.region!==target.region)throw new UserFacingError('店铺授权或站点已变化，请重新核对关系');
        const hash=listingHash(draft,draft.sku);
        if(this.persistence.records().some(other=>other.draft.id!==draft.id&&listingHash(other.draft,other.draft.sku)===hash&&(other.unresolvedWrite||other.draft.submittedAt||FINAL_STATES.has(other.draft.state)))
          ||this.persistence.listAcceptedSkus(target.id).some(other=>other.sku===draft.sku&&other.sellerId===draft.sellerId&&other.marketplaceId===draft.marketplaceId&&other.mode===draft.mode))throw new UserFacingError('此 SKU 已有提交记录，不能作为未提交草稿迁移');
        assertSalesPlanNamingIdentity(this.persistence.db,prior,draft.mode,draft.sellerId);assertSalesPlanNamingIdentity(this.persistence.db,plan,draft.mode,draft.sellerId);
      };
      assertCurrent();
      if(receipt&&draft.mode==='live'&&receipt.mode!=='live')throw new UserFacingError('关系迁移需要当前正式商品的来源证据');
      const proposed=buildSalesRecipes(source,receipt,rules).filter(recipe=>recipe.key===prior.recipe.key);
      if(proposed.length!==1||proposed[0].totalPieces!==prior.recipe.totalPieces)throw new UserFacingError('当前来源无法证明原销售配方，请重新核对');
      if(getSalesParentIdentity(plan)!.sourceGroupKey.split(':').at(-1)!==proposed[0].groupKey)throw new UserFacingError('父体不是当前来源的同款同规格家族');
      const selected={targetId:target.id,productType:draft.schema.productType,parentageLevel:'CHILD' as const,requirements:draft.schema.requirements,locale:draft.schema.locale};
      const schema=await this.getSchema(selected);assertCurrent();
      if(schema.key!==schemaKey(target,selected)||schema.mode!==draft.mode||Object.entries(selected).some(([key,value])=>schema[key as keyof AmazonSchema]!==value)||!(Date.parse(schema.expiresAt)>this.now()))throw new UserFacingError('CHILD Schema 与当前草稿范围不一致或已过期');
      assertListingProgram(draft.listingProgram,schema);
      try{compileAttributesSchema(schema.schema,schema.metaSchema);}catch{throw new UserFacingError('CHILD Schema 含有当前版本不支持的约束');}
      const properties=schema.schema.properties;
      if(!isObject(properties)||!properties.variation_theme)throw new UserFacingError('当前 CHILD Schema 不支持变体关系');
      const field=resolveSchemaNode(schema.schema,properties.variation_theme),item=resolveSchemaNode(schema.schema,field.items);
      const name=isObject(item.properties)?resolveSchemaNode(schema.schema,item.properties.name):{};
      const theme=plan.variationTheme!,axes=theme.split('/');
      const deprecated=[field,item,name].some(value=>isObject(value.$lifecycle)&&Array.isArray(value.$lifecycle.enumDeprecated)&&value.$lifecycle.enumDeprecated.includes(theme));
      if(!Array.isArray(name.enum)||!name.enum.includes(theme)||deprecated||new Set(axes).size!==axes.length||axes.some(axis=>!['COLOR','COLOR_NAME','NUMBER_OF_ITEMS'].includes(axis)))throw new UserFacingError('当前类目不支持本次颜色或件数变体主题');
      const attributes={...clone(draft.attributes),...relationshipAttributes(schema,plan,draft.marketplaceId)},changed=['parentage_level','variation_theme','child_parent_sku_relationship'];
      if(axes.some(axis=>['COLOR','COLOR_NAME'].includes(axis))){
        if(!proposed[0].color||/随机|任选|可备注|可选|\brandom\b/iu.test(proposed[0].color))throw new UserFacingError('当前来源未确认确切颜色，不能建立颜色变体');
        attributes.color=wrapCandidateValues(schema,draft.marketplaceId,'color',[proposed[0].color]);changed.push('color');
      }
      if(axes.includes('NUMBER_OF_ITEMS')){attributes.number_of_items=wrapCandidateValues(schema,draft.marketplaceId,'number_of_items',[prior.recipe.totalPieces]);changed.push('number_of_items');}
      const issues=validateAttributes(schema.schema,attributes,schema.metaSchema);
      if(issues.some(issue=>issue.attributeNames.some(field=>changed.includes(field))))throw new UserFacingError('迁移的关系或规格字段不满足当前 CHILD Schema');
      const issueKey=(issue:ListingIssue)=>JSON.stringify([issue.code,[...issue.attributeNames].sort()]);
      const priorIssues=new Set(nonDeferredImageIssues({...draft,localIssues:validateAttributes(draft.schema.schema,draft.attributes,draft.schema.metaSchema),previewIssues:[]}).map(issueKey));
      const introduced=nonDeferredImageIssues({...draft,schema,attributes,localIssues:issues,previewIssues:[]}).filter(issue=>!priorIssues.has(issueKey(issue)));
      if(introduced.length){
        const fields=[...new Set(introduced.flatMap(issue=>issue.attributeNames.length?issue.attributeNames:[issue.code]))];
        throw new UserFacingError(`CHILD Schema 新增需要修复的字段：${fields.join('、')}；原草稿和已通过图片保持不变，请先处理这些字段再重组`);
      }
      assertListingProgram(draft.listingProgram,schema,attributes);
      return this.persistence.transaction(()=>{
        assertCurrent();
        record.draft={...draft,schema,attributes,salesPlan:plan,revision:draft.revision+1,state:'DRAFT',localIssues:issues,previewIssues:[],previewedAt:null,requestId:null};
        record.preview=null;record.previewResponse=null;record.request=this.request(record);
        const at=this.at();record.draft.updatedAt=at;record.draft.events.push({at,operation:'save',state:'DRAFT',requestId:null,summary:FAMILY_REBIND_EVENT_SUMMARY});this.persistence.putRecord(record);
        this.persistence.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),draft.productId,'listing.family.rebound',FAMILY_REBIND_EVENT_SUMMARY,
          JSON.stringify({draftId:draft.id,before,after:record}),record.draft.updatedAt);
        return clone(record.draft);
      });
    } finally {this.busy.delete(draft.id);}
  }
  /** Resolve the real parent ledger timestamp without rewriting the old child identity. */
  familyParentPlan(child:AmazonDraft):SalesListingPlan {
    const saved=this.checked(child).draft,plan=saved.salesPlan?validateSalesPlan(saved.salesPlan):null;
    if(!plan||plan.parentage!=='CHILD'||JSON.stringify(saved.salesPlan)!==JSON.stringify(child.salesPlan)||saved.sku!==child.sku)throw new UserFacingError('当前草稿没有已核对的子体关系');
    assertSalesPlanNamingIdentity(this.persistence.db,plan,saved.mode,saved.sellerId);
    const identity=getSalesParentIdentity(plan)!;
    const row=this.persistence.db.prepare('SELECT record_json FROM sku_naming_groups WHERE id=? AND store_scope=? AND source_group_key=?').get(identity.namingGroupId,salesStoreScope(saved),identity.sourceGroupKey);
    if(!row)throw new UserFacingError('父体命名记录不存在');
    const group=JSON.parse(String(row.record_json));
    const {familyBinding:_binding,...unbound}=plan;
    const parent=validateSalesPlan({...unbound,...identity,sku:identity.baseSku,collectedAt:group.collectedAt,collectionBasis:'first_import',parentage:'PARENT',parentSku:null,namingChildKey:null});
    assertSalesPlanNamingIdentity(this.persistence.db,parent,saved.mode,saved.sellerId);return parent;
  }
  private enter(id: string): void { if (this.busy.has(id)) throw new UserFacingError('此草稿正在处理，请等待完成后重新加载'); this.busy.add(id); }
  private event(record: DraftRecord, operation: ListingEvent['operation'], summary: string): void {
    record.draft.updatedAt = this.at(); record.draft.events.push({ at: this.at(), operation, state: record.draft.state, requestId: record.draft.requestId, summary });
  }
  private exchange(record: DraftRecord, operation: 'preview' | 'submit' | 'readback', result: { data?: JsonObject; status: number | null; requestId: string | null; response?: JsonObject | null }): void {
    const snapshot = this.vault.redact({ id: randomUUID(), at: this.at(), operation, revision: record.draft.revision,
      request: operation === 'readback' ? { sku: record.draft.sku, sellerId: record.draft.sellerId, marketplaceId: record.draft.marketplaceId } : this.request(record),
      response: result.data ?? result.response ?? null, status: result.status, requestId: result.requestId, schemaChecksum: record.draft.schema.checksum, schemaVersion: record.draft.schema.version });
    // A compact working tail avoids reloading an unbounded payload. Every entry
    // is also archived by its original timestamp in amazon_exchanges until cleanup.
    record.exchanges = [...(record.exchanges ?? []), clone(snapshot)].slice(-20);
    while (record.exchanges.length > 1 && Buffer.byteLength(JSON.stringify(record.exchanges)) > 16 * 1024 * 1024) record.exchanges.shift();
  }
  private request(record: DraftRecord): JsonObject { return { productType: record.draft.schema.productType, requirements: record.draft.schema.requirements, attributes: record.draft.attributes }; }
  assertPricingForPaid(draftId:string):void { this.ensureOpen(); assertStoredPricingForPaid(this.persistence.db,draftId); }
  private businessDefaults(product: ProductDetail, variant: Variant, target: AmazonTarget, schema: AmazonSchema, attributes: JsonObject, program: ListingProgram, previousBusinessReport?: BusinessRuleReport, salesPlan?: SalesListingPlan, sourceSnapshot?:ProductDetail): { attributes: JsonObject; report?: BusinessRuleReport } {
    if (program !== 'haul') return { attributes };
    const cleanup=cleanHaulAttributes(program,attributes); attributes=cleanup.attributes;
    const receipt = getReceipt(this.persistence.db, product.id);
    const validReceipt = receipt && (target.mode !== 'live' || receipt.mode === 'live') && receipt.skuMappings.some(row => row.localVariantId === variant.id);
    const currency = confirmedPurchaseCurrency(product.facts, Boolean(validReceipt && (receipt.snapshot.sources.some(s=>s.source==='1688') || receipt.mapping.currency === 'CNY' && receipt.mapping.priceField !== 'none')));
    const costCny = currency.cny ? salesPlan ? salesPlan.recipe.totalCostCny : sourceQuotedCost(variant,validReceipt?receipt:null) : null;
    const matchingPackage=!salesPlan || salesPlan.recipe.components.length===1 && salesPlan.recipe.components[0].quantity===salesPlan.recipe.components[0].sourcePackPieces;
    const result = applyBusinessRules({ product, variant, target, schema, attributes, costCny, previousBusinessReport, now: new Date(this.now()),
      declarationScope:selectedDeclarationScope(salesPlan?(sourceSnapshot??this.getProduct(product.id)):product,variant.id,salesPlan?.recipe.components),
      ...(salesPlan?{saleUnit:salesPlan.recipe,baseSku:salesPlan.baseSku}:{}), packageMatchesSaleUnit: matchingPackage,
      measurements: matchingPackage ? miaoshouMeasurementsForVariant(this.persistence.db, product.id, variant.id, target.mode) : {} }, readListingRules(this.persistence.db));
    if(cleanup.removed.length)result.report.notices.push(haulCleanupReason(cleanup.removed));
    if (currency.notice) result.report.notices.push(currency.notice);
    return result;
  }
  private declarationIssues(draft: AmazonDraft, sourceSnapshot?:ProductDetail): ListingIssue[] {
    if(draft.listingProgram!=='haul')return [];
    const source=sourceSnapshot??this.getProduct(draft.productId);
    // Validate identities against raw source SKUs, then read their original text.
    const product=projectSalesProduct(source,draft.salesPlan,draft.variantId);
    const risk=declarationSafetyIssues(source,selectedDeclarationScope(source,draft.variantId,draft.salesPlan?.recipe.components),draft.attributes);
    const matchingPackage=draft.schema.parentageLevel!=='PARENT'&&(!draft.salesPlan||draft.salesPlan.recipe.components.length===1&&draft.salesPlan.recipe.components[0].quantity===draft.salesPlan.recipe.components[0].sourcePackPieces);
    const target=this.getTarget(draft.targetId),variant=product.variants.find(value=>value.id===draft.variantId)!;
    const currentRules=this.businessDefaults(product,variant,target,draft.schema,{},'haul',undefined,draft.salesPlan,source).report;
    const ruleValues=Object.fromEntries(Object.entries(currentRules?.fields??{}).map(([field,entry])=>[field,entry.value]));
    const authority=currentFactAuthority(product,draft.schema,draft,draft.attributes,matchingPackage?miaoshouMeasurementsForVariant(this.persistence.db,product.id,draft.variantId,draft.mode):{},ruleValues);
    const riskFields=new Set(risk.flatMap(issue=>issue.attributeNames));
    const fixedField='supplier_declared_dg_hz_regulation';
    const missingRule=isObject(draft.schema.schema.properties)&&Object.hasOwn(draft.schema.schema.properties,fixedField)
      &&!Object.hasOwn(ruleValues,fixedField)&&!Object.hasOwn(draft.attributes,fixedField)
      ?[localIssue('FIXED_DECLARATION_SCHEMA',fixedField+' 的 not_applicable 固定规则未能按当前 Schema 生成，请核对字段结构或枚举；无需再次确认业务值',[fixedField],'compliance')]:[];
    return [...risk,...missingRule,...authority.issues.filter(issue=>!issue.attributeNames.some(field=>riskFields.has(field)))];
  }
  private newDraftRecord(product: ProductDetail, variant: Variant, target: AmazonTarget, schema: AmazonSchema, attributes: JsonObject, program: ListingProgram = 'standard', businessRules?: BusinessRuleReport): DraftRecord {
    const now = this.at();
    const draft: AmazonDraft = { listingProgram: program, id: randomUUID(), productId: product.id, productRevision: product.revision, variantId: variant.id, sku: variant.sku,
      targetId: target.id, targetName: target.name, sellerId: target.sellerId, marketplaceId: target.marketplaceId, mode: target.mode, revision: 1, schema, attributes, ...(businessRules ? { businessRules } : {}),
      state: 'DRAFT', localIssues: [], previewIssues: [], listingIssues: [], statuses: [], submissionId: null, requestId: null, previewedAt: null, submittedAt: null, checkedAt: null, createdAt: now, updatedAt: now,
      events: [{ at: now, operation: 'create', state: 'DRAFT', requestId: null, summary: target.mode === 'demo' ? '创建本地演示草稿；未请求 Amazon' : '按已选 SKU 和当前 Schema 创建草稿' }] };
    const record: DraftRecord = { draft, preview: null, request: {}, previewResponse: null, submitResponse: null, readResponse: null, unresolvedWrite: false, exchanges: [] };
    if (program === 'haul') draft.sourceMapping = ruleSourceMapping(sourceMappingReport(product, variant, schema, target, program, attributes, miaoshouMeasurementsForVariant(this.persistence.db, product.id, variant.id, target.mode)), businessRules, attributes);
    record.request = this.request(record); return record;
  }
  async createDraft(input: unknown): Promise<AmazonDraft> {
    const selected = selection(input); const value = object(input); const target = this.active(selected.targetId); const program = listingProgram(value.listingProgram);
    const product = this.getProduct(textField(value.productId, '商品 ID', 100)); const variantId = textField(value.variantId, 'SKU 身份', 100); const variant = product.variants.find(v => v.id === variantId);
    if (!variant) throw new UserFacingError('所选 SKU 不属于当前商品');
    if (['.', '..'].includes(textField(variant.sku, 'SKU', 100))) throw new UserFacingError('SKU 不能使用路径片段 . 或 ..');
    if (this.persistence.locked(listingHash(target, variant.sku))) throw new UserFacingError('此 SKU 有结果未知或未确认的提交，请先回读并人工核对；不能新建草稿重放');
    const schema = await this.getSchema(selected);
    if (this.getProduct(product.id).revision !== product.revision) throw new UserFacingError('来源商品已变化，请重新创建草稿');
    const measurements = program === 'haul' ? miaoshouMeasurementsForVariant(this.persistence.db, product.id, variant.id, target.mode) : {};
    const resolved = this.businessDefaults(product, variant, target, schema, { ...this.vault.redact(sourceAttributes(product, variant, schema, target, program, measurements)), ...programAttributes(program, target.marketplaceId, schema.parentageLevel) }, program);
    const attributes = resolved.attributes;
    assertListingProgram(program, schema, attributes);
    const record = this.newDraftRecord(product, variant, target, schema, attributes, program, resolved.report);
    this.persistence.putRecord(record); return clone(record.draft);
  }
  /** salesPlans is supplied only by the main-process automatic coordinator, never by IPC input. */
  async prepareDrafts(input: unknown, salesPlans?: readonly SalesListingPlan[]): Promise<PrepareAmazonDraftsResult> {
    this.ensureOpen(); const { items, listingProgram: program = 'standard', ...selected } = preparationInput(input,!!salesPlans); const target = this.active(selected.targetId);
    if(salesPlans && salesPlans.length!==items.length) throw new UserFacingError('销售组合数量与草稿不一致');
    const plans=salesPlans?.map(raw=>{
      const plan=validateSalesPlan(raw);
      if(!plan.familyResolved||plan.parentage!==selected.parentageLevel) throw new UserFacingError('销售组合尚未完成类目关系判断');
      const group=this.persistence.db.prepare('SELECT id FROM sku_naming_groups WHERE store_scope=? AND source_group_key=?').get(salesStoreScope(target),plan.sourceGroupKey);
      const identity=this.persistence.db.prepare('SELECT group_id,child_key FROM sku_naming_identities WHERE store_scope=? AND sku=?').get(salesStoreScope(target),plan.sku);
      if(!group||group.id!==plan.namingGroupId||identity?.group_id!==group.id||identity.child_key!==(plan.namingChildKey??'')) throw new UserFacingError('销售 SKU 未通过命名身份校验');
      return plan;
    });
    const generation = this.persistence.generation(target.id);
    // Capture source identities before the single asynchronous schema read.
    const snapshots = items.map((item,index) => {
      let sku: string | null = null;
      try {
        const product = projectSalesProduct(this.getProduct(item.productId),plans?.[index],item.variantId); const variant = product.variants.find(variant => variant.id === item.variantId);
        if (!variant) throw new UserFacingError('所选 SKU 不属于当前商品');
        sku = variant.sku;
        if (product.id !== item.productId || product.revision !== item.productRevision) throw new UserFacingError('来源商品版本已变化，请刷新后重新准备');
        if (['.', '..'].includes(textField(sku, 'SKU', 100))) throw new UserFacingError('SKU 不能使用路径片段 . 或 ..');
        return { sku, error: null };
      } catch (error) {
        if (!(error instanceof UserFacingError)) throw error;
        return { sku, error: error.message };
      }
    });
    const schema = await this.getSchema(selected);
    const assertTarget = (): AmazonTarget => {
      const current = this.active(target.id);
      if (this.persistence.generation(target.id) !== generation || current.mode !== target.mode || current.sellerId !== target.sellerId
        || current.marketplaceId !== target.marketplaceId || current.region !== target.region) throw new UserFacingError('店铺授权或站点已变化，请重新准备');
      return current;
    };
    assertTarget();
    assertListingProgram(program, schema);
    if (schema.key !== schemaKey(target, selected) || schema.mode !== target.mode || Object.entries(selected).some(([key, value]) => schema[key as keyof AmazonSchema] !== value)) throw new UserFacingError('Schema 与所选店铺、站点或要求集不匹配，请重新获取');
    try { compileAttributesSchema(schema.schema, schema.metaSchema); } catch { throw new UserFacingError('Amazon Schema 包含当前版本不支持的约束，已阻止批量准备；请刷新 Schema 或升级 HTC'); }
    const schemaIdentity = preparationSchemaIdentity(schema); const result: PrepareAmazonDraftsResult = { items: [] };
    // BEGIN IMMEDIATE serializes concurrent preparations and observes persisted
    // drafts/locks again after the await. A write failure rolls back the batch.
    this.persistence.transaction(() => {
      const currentTarget = assertTarget(); const records = this.persistence.records(); let bytes = 0;
      for (const [index, item] of items.entries()) {
        const snapshot = snapshots[index]; let sku = snapshot.sku;
        const reject = (message: string): PreparedAmazonDraftItem => ({ productId: item.productId, variantId: item.variantId, sku,
          disposition: 'REJECTED', draft: null, issues: [], error: message });
        if (snapshot.error) { result.items.push(reject(snapshot.error)); continue; }
        let product: ProductDetail; let variant: Variant; let attributes: JsonObject; let businessRules: BusinessRuleReport | undefined;
        try {
          product = projectSalesProduct(this.getProduct(item.productId),plans?.[index],item.variantId); const currentVariant = product.variants.find(candidate => candidate.id === item.variantId);
          if (product.id !== item.productId || product.revision !== item.productRevision || !currentVariant || currentVariant.sku !== snapshot.sku) throw new UserFacingError('来源商品版本或 SKU 身份已变化，请刷新后重新准备');
          variant = currentVariant; sku = variant.sku;
          const plan=plans?.[index], matchingPackage=!plan||plan.recipe.components.length===1&&plan.recipe.components[0].quantity===plan.recipe.components[0].sourcePackPieces;
          const measurements = program === 'haul' && matchingPackage ? miaoshouMeasurementsForVariant(this.persistence.db, product.id, variant.id, currentTarget.mode) : {};
          const source = sourceAttributes(product, variant, schema, currentTarget, program, measurements);
          if (product.variants.length > 1) { delete source.color; delete source.size; }
          const resolved = this.businessDefaults(product, variant, currentTarget, schema, { ...source, ...programAttributes(program, currentTarget.marketplaceId, schema.parentageLevel), ...item.attributes,
            ...(plan?relationshipAttributes(schema,plan,currentTarget.marketplaceId):{}) }, program,undefined,plan);
          attributes = attributesObject(resolved.attributes); businessRules = resolved.report;
          assertListingProgram(program, schema, attributes);
          if (JSON.stringify(this.vault.redact(attributes)) !== JSON.stringify(attributes)) throw new UserFacingError('attributes 中不能包含授权配置或令牌');
        } catch (error) {
          if (!(error instanceof UserFacingError)) throw error;
          result.items.push(reject(error.message)); continue;
        }
        bytes += Buffer.byteLength(JSON.stringify(attributes));
        if (bytes > PREPARATION_MAX_BYTES) throw new UserFacingError('批量准备合并来源后的 attributes 合计超过 2 MB');
        const hash = listingHash(currentTarget, variant.sku); const listingRecords = records.filter(record => listingHash(record.draft, record.draft.sku) === hash);
        if (this.persistence.locked(hash) || listingRecords.some(record => record.unresolvedWrite || FINAL_STATES.has(record.draft.state) || record.draft.submittedAt)) {
          result.items.push(reject('此 SKU 已提交或存在结果未知、未确认的提交，请先回读并人工核对；批量准备不能新建或重放')); continue;
        }
        if (listingRecords.some(record => this.busy.has(record.draft.id))) { result.items.push(reject('此 SKU 的草稿正在处理，请等待完成后重新准备')); continue; }
        const existing = listingRecords.filter(({ draft }) => draft.productId === item.productId && draft.productRevision === item.productRevision
          && draft.variantId === item.variantId && draft.targetId === currentTarget.id && draft.listingProgram === program && preparationSchemaIdentity(draft.schema) === schemaIdentity);
        const attributeIdentity = semanticJson(attributes);
        if (existing.some(record => semanticJson(cleanHaulAttributes(program,record.draft.attributes).attributes) !== attributeIdentity)) {
          result.items.push(reject('当前商品版本已有内容不同的草稿，可能已被人工修改；请核对已有草稿，不能覆盖或重复创建')); continue;
        }
        if (existing.length) {
          this.normalizeHaulRecord(existing[0]); this.persistence.putRecord(existing[0]);
          const draft = existing[0].draft;
          const declarationIssues=this.declarationIssues(draft);
          const issues = [...listingProgramIssues(program, schema, draft.attributes), ...validateAttributes(schema.schema, draft.attributes, schema.metaSchema), ...imageIssues(draft.attributes), ...copyPolicyIssues(draft), ...declarationIssues];
          if(declarationIssues.length){
            draft.localIssues=issues;draft.state='BLOCKED';draft.previewedAt=null;existing[0].preview=null;
            this.persistence.putRecord(existing[0]);
          }
          result.items.push({ productId: item.productId, variantId: item.variantId, sku, disposition: 'REUSED', draft: clone(draft), issues, error: null }); continue;
        }
        const record = this.newDraftRecord(product, variant, currentTarget, schema, attributes, program, businessRules);
        if(plans?.[index]) { record.draft.salesPlan=plans[index]; this.updateSourceMapping(record); }
        this.validate(record); records.push(record);
        result.items.push({ productId: item.productId, variantId: item.variantId, sku, disposition: 'CREATED', draft: clone(record.draft), issues: clone(record.draft.localIssues), error: null });
      }
    });
    return result;
  }
  saveDraft(input: unknown): AmazonDraft {
    const record = this.checked(input); if (this.busy.has(record.draft.id)) throw new UserFacingError('草稿正在处理，请等待完成后保存'); this.mutable(record);
    if (Object.hasOwn(object(input), 'listingProgram') && object(input).listingProgram !== record.draft.listingProgram) throw new UserFacingError('不能通过保存更改草稿的上架项目类型，请新建草稿');
    const rawAttributes = attributesObject(object(input).attributes), cleanup=cleanHaulAttributes(record.draft.listingProgram,rawAttributes);
    const attributes=cleanup.attributes, redacted = this.vault.redact(rawAttributes);
    assertListingProgram(record.draft.listingProgram, record.draft.schema, attributes);
    if (JSON.stringify(redacted) !== JSON.stringify(rawAttributes)) throw new UserFacingError('attributes 中不能包含授权配置或令牌');
    record.draft.attributes = attributes; record.draft.revision++; record.draft.state = 'DRAFT'; record.draft.localIssues = []; record.draft.previewIssues = []; record.draft.listingIssues = [];
    record.draft.previewedAt = null; record.draft.requestId = null; record.preview = null; record.previewResponse = null; record.request = this.request(record);
    this.updateSourceMapping(record); if(cleanup.removed.length)this.event(record,'save',haulCleanupReason(cleanup.removed)); this.event(record, 'save', '已保存独立 attributes；旧校验和预览已失效'); this.persistence.putRecord(record); return clone(record.draft);
  }
  private updateSourceMapping(record: DraftRecord): void {
    if (record.draft.listingProgram !== 'haul') return;
    const product = projectSalesProduct(this.getProduct(record.draft.productId),record.draft.salesPlan,record.draft.variantId), variant = product.variants.find(v=>v.id===record.draft.variantId);
    const plan=record.draft.salesPlan,matchingPackage=record.draft.schema.parentageLevel!=='PARENT'&&(!plan||plan.recipe.components.length===1&&plan.recipe.components[0].quantity===plan.recipe.components[0].sourcePackPieces);
    if (product.revision === record.draft.productRevision && variant) record.draft.sourceMapping = ruleSourceMapping(sourceMappingReport(product,variant,record.draft.schema,this.getTarget(record.draft.targetId),'haul',record.draft.attributes, matchingPackage?miaoshouMeasurementsForVariant(this.persistence.db, product.id, variant.id, record.draft.mode):{}), record.draft.businessRules, record.draft.attributes);
  }
  /** Read-only local gate for historical profit exclusions, also used by task adaptation.
   * Re-evaluate actual cost, quantity and package inputs; never trust global revisions
   * as permission to dispatch paid work. No draft, request or attempt is saved here.
   * The returned pricing projection is evidence only, never a replacement saved draft.
   */
  previewPricing(draftId:string, source:ProductDetail, recipe?:SalesRecipe):AmazonDraft {
    const draft=this.getDraft(draftId);
    if(source.id!==draft.productId)throw new UserFacingError('定价来源与原商品不一致');
    if(draft.businessRules)assertPricingDecision(draft.businessRules,draft);
    let plan=draft.salesPlan;
    if(plan){
      const current=recipe??buildSalesRecipes(source,getReceipt(this.persistence.db,source.id),readListingRules(this.persistence.db)).find(value=>value.key===plan!.recipe.key);
      if(!current)throw new UserFacingError('当前销售组合无法确认，保留原利润淘汰记录待补资料');
      plan={...clone(plan),recipe:clone(current),namingChildKey:plan.namingChildKey===null?null:current.key};
    }
    const product=projectSalesProduct(source,plan,draft.variantId),variant=product.variants.find(value=>value.id===draft.variantId);
    if(!variant)throw new UserFacingError('当前来源规格缺失，保留原利润淘汰记录待补资料');
    const attributes=Object.fromEntries(['item_package_dimensions','item_package_weight','number_of_items','unit_count']
      .filter(field=>Object.hasOwn(draft.attributes,field)).map(field=>[field,clone(draft.attributes[field])])) as JsonObject;
    // Refresh unchanged generated inputs from current source/default rules. Manual
    // edits stay visible, including contradictory or incomplete quantity values.
    for(const [field,entry] of Object.entries(draft.businessRules?.fields??{}))
      if(Object.hasOwn(attributes,field)&&semanticJson(attributes[field])===semanticJson(entry.value)
        && !(draft.businessRules?.pricingBasis?.kind==='auto_bundle'&&['number_of_items','unit_count'].includes(field)))delete attributes[field];
    const resolved=this.businessDefaults(product,variant,this.getTarget(draft.targetId),draft.schema,attributes,'haul',draft.businessRules,plan,source);
    return {...draft,productRevision:source.revision,...(plan?{salesPlan:plan}:{}),attributes:resolved.attributes,businessRules:resolved.report};
  }
  /** Local explicit adaptation. Frozen responses and adopted fields stay intact. */
  previewTaskAdaptation(draftId:string,source:ProductDetail,recipe?:SalesRecipe):AmazonDraft {
    const record=this.persistence.record(draftId);this.mutable(record);
    if(this.busy.has(draftId))throw new UserFacingError('草稿请求进行中，请等待完成');
    const draft=record.draft;
    if(source.id!==draft.productId)throw new UserFacingError('来源身份不一致');
    if(recipe&&draft.salesPlan)draft.salesPlan={...draft.salesPlan,recipe:clone(recipe)};
    const product=projectSalesProduct(source,draft.salesPlan,draft.variantId),variant=product.variants.find(v=>v.id===draft.variantId&&v.sku===draft.sku);
    if(!variant)throw new UserFacingError('原销售规格身份无法对应；保留历史待核对');
    const cached=this.persistence.schema(draft.schema.key);
    if(cached&&Date.parse(cached.fetchedAt)>Date.parse(draft.schema.fetchedAt)&&cached.targetId===draft.targetId&&cached.productType===draft.schema.productType&&cached.parentageLevel===draft.schema.parentageLevel&&cached.locale===draft.schema.locale&&(cached.checksum!==draft.schema.checksum||cached.version!==draft.schema.version||!sameSchemaValidation(cached,draft.schema)))draft.schema=cached;
    let attributes=clone(draft.attributes);
    // Only unchanged rule-owned values can be refreshed. Manual and AI edits survive.
    for(const [field,entry] of Object.entries(draft.businessRules?.fields??{}))if(semanticJson(attributes[field]??null)===semanticJson(entry.value))delete attributes[field];
    const resolved=this.businessDefaults(product,variant,this.getTarget(draft.targetId),draft.schema,attributes,draft.listingProgram,draft.businessRules,draft.salesPlan,source);
    draft.productRevision=source.revision;draft.attributes=resolved.attributes;if(resolved.report)draft.businessRules=resolved.report;
    draft.localIssues=[...listingProgramIssues(draft.listingProgram,draft.schema,draft.attributes),...validateAttributes(draft.schema.schema,draft.attributes,draft.schema.metaSchema),...imageIssues(draft.attributes),...copyPolicyIssues(draft),...this.declarationIssues(draft,source)];
    return clone(draft);
  }
  applyTaskAdaptation(draftId:string,source:ProductDetail,recipe:SalesRecipe|undefined,db:DatabaseSync):AmazonDraft {
    if(!db.isTransaction)throw new Error('Task adaptation requires owner transaction');
    const record=this.persistence.record(draftId),beforeRecord=clone(record),before=clone(record.draft),draft=this.previewTaskAdaptation(draftId,source,recipe);
    if(JSON.stringify(before)===JSON.stringify(draft))return before;
    draft.revision++;draft.state=draft.localIssues.some(i=>i.severity==='ERROR')?'BLOCKED':'LOCAL_VALIDATED';draft.previewedAt=null;
    record.draft=draft;record.preview=null;record.request=this.request(record);
    this.event(record,'local_validation','用户适配当前来源与规则；保留原属性、图片和平台响应，本地重新校验');
    const afterRecord=clone(record);
    db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),draft.productId,'listing.task-adapted','旧草稿原地适配',JSON.stringify({version:1,before,afterRevision:draft.revision,beforeRecord,afterRecord,beforeSha256:createHash('sha256').update(JSON.stringify(beforeRecord)).digest('hex'),afterSha256:createHash('sha256').update(JSON.stringify(afterRecord)).digest('hex')}),draft.updatedAt);
    db.prepare('UPDATE listing_drafts SET request_json=?,schema_checksum=?,validation_json=?,state=?,record_json=?,updated_at=? WHERE id=?').run(JSON.stringify(record.request),draft.schema.checksum,JSON.stringify(draft.localIssues),draft.state,JSON.stringify(record),draft.updatedAt,draft.id);
    return clone(draft);
  }
  /** Trusted preview coordinator: fill only missing business fields and retain manual edits. */
  applyBusinessDefaults(input: DraftReference, completionId?:string, revalidateLocal = false, checkpoint?: (draft:AmazonDraft, db:DatabaseSync)=>void): AmazonDraft {
    const record = this.checked(input); this.enter(record.draft.id);
    try { return this.persistence.transaction(() => {
      this.mutable(record); this.currentProduct(record);
      if (record.draft.listingProgram !== 'haul') return clone(record.draft);
      const platformIssues={preview:clone(record.draft.previewIssues),listing:clone(record.draft.listingIssues)};
      const target = this.active(record.draft.targetId), product = this.currentProduct(record);
      const variant = product.variants.find(variant => variant.id === record.draft.variantId)!;
      const resolved = this.businessDefaults(product, variant, target, record.draft.schema, record.draft.attributes, 'haul', record.draft.businessRules,record.draft.salesPlan);
      if(revalidateLocal&&resolved.report){
        const expected=this.businessDefaults(product,variant,target,record.draft.schema,{},'haul',undefined,record.draft.salesPlan).report;
        for(const [field,entry] of Object.entries(expected?.fields??{}))if(FACT_PROTECTED_FIELDS.has(field)&&resolved.attributes[field]!==undefined
          &&semanticJson(entry.value)===semanticJson(resolved.attributes[field]))resolved.report.fields[field]={...entry,value:clone(resolved.attributes[field])};
      }
      if (semanticJson(resolved.attributes) !== semanticJson(record.draft.attributes)) {
        record.draft.attributes = resolved.attributes; record.draft.revision++; record.draft.state = 'DRAFT';
        record.draft.localIssues = []; record.draft.previewIssues = []; record.draft.listingIssues = [];
        record.draft.previewedAt = null; record.draft.requestId = null; record.preview = null;
        if(!revalidateLocal)record.previewResponse = null;
        record.request = this.request(record);
        this.event(record, 'save', '已按当前业务规则补全缺失字段，已有填写内容保留');
      }
      if (resolved.report) {
        const retained = Object.fromEntries(Object.entries(record.draft.businessRules?.fields ?? {}).filter(([field,entry]) => JSON.stringify(record.draft.attributes[field]) === JSON.stringify(entry.value)));
        record.draft.businessRules = { ...resolved.report, fields: { ...retained, ...resolved.report.fields } };
      }
      if(revalidateLocal){
        this.validate(record);
        // Local migration is not a new platform acceptance; retain its independent errors.
        record.draft.previewIssues=platformIssues.preview;record.draft.listingIssues=platformIssues.listing;
      }
      this.updateSourceMapping(record); this.persistence.putRecord(record);
      if(completionId){const journal=new CompletionJournal(this.persistence.db),operation=journal.get(completionId);operation.draftRevision=record.draft.revision;operation.draftStamp=completionDraftStamp(record.draft);journal.save(operation);}
      checkpoint?.(clone(record.draft),this.persistence.db);
      return clone(record.draft);
    }); } finally { this.busy.delete(record.draft.id); }
  }
  /** Only the trusted listing AI coordinator calls this; it has no renderer IPC. */
  adoptFields(input: DraftReference, attributes: JsonObject, adoption: ListingFieldAdoption, assertFresh: () => void, preserveFeedback = false, checkpoint?: (draft:AmazonDraft,db:DatabaseSync)=>void): AmazonDraft {
    this.enter(input.id);
    try {
      return this.persistence.transaction(() => {
        const record = this.checked(input); this.mutable(record); this.currentProduct(record); assertFresh();
        if (adoption.fromRevision !== record.draft.revision || adoption.toRevision !== record.draft.revision + 1) throw new UserFacingError('采纳修订不匹配');
        const feedback={preview:clone(record.draft.previewIssues),listing:clone(record.draft.listingIssues)};
        if(preserveFeedback)this.persistence.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),record.draft.productId,'listing.local-field-recovery','原响应本地重评前的草稿与反馈留档',JSON.stringify({draftId:record.draft.id,sourceResultId:adoption.suggestionResultId,before:record}),new Date().toISOString());
        const supplied = attributesObject(attributes), cleanup=cleanHaulAttributes(record.draft.listingProgram,supplied), normalized=cleanup.attributes;
        if (JSON.stringify(this.vault.redact(supplied)) !== JSON.stringify(supplied)) throw new UserFacingError('属性不能包含授权配置');
        record.draft.attributes = normalized; record.draft.revision++;
        if(cleanup.removed.length)this.event(record,'save',haulCleanupReason(cleanup.removed));
        record.draft.fieldAdoptions = [...(record.draft.fieldAdoptions ?? []), clone(adoption)];
        record.draft.state = 'DRAFT'; record.draft.localIssues = []; record.draft.previewIssues = preserveFeedback?feedback.preview:[]; record.draft.listingIssues = preserveFeedback?feedback.listing:[];
        record.draft.previewedAt = null; record.draft.requestId = null; record.preview = null; record.previewResponse = null; record.request = this.request(record);
        this.event(record, 'save', `已采纳${adoption.reviewResultId ? '经复核的' : '经本地校验的'} AI 字段：${adoption.fields.join('、')}；旧预览已失效`);
        this.updateSourceMapping(record); this.validate(record); checkpoint?.(clone(record.draft),this.persistence.db); return clone(record.draft);
      });
    } finally { this.busy.delete(input.id); }
  }
  private normalizeHaulRecord(record: DraftRecord, completionId?: string): boolean {
    const cleanup=cleanHaulAttributes(record.draft.listingProgram,record.draft.attributes);
    const color=cleanup.attributes.color;
    let colorSources:string[]=[];
    if(color!==undefined)try{
      const product=this.getProduct(record.draft.productId),variant=product.variants.find(v=>v.id===record.draft.variantId);
      if(product.revision===record.draft.productRevision&&variant)colorSources=[variant.originalSpec,variant.normalizedSpec];
    }catch{/* Existing source validation reports missing products; color cleanup adds no gate. */}
    const plain=color===undefined?undefined:plainColorValue(color,colorSources);
    const colorChanged=JSON.stringify(color)!==JSON.stringify(plain);
    if(colorChanged)cleanup.attributes={...cleanup.attributes,color:plain!};
    if(!cleanup.removed.length&&!colorChanged)return false;
    this.mutable(record);this.currentProduct(record);
    const journal=completionId?new CompletionJournal(this.persistence.db):null,operation=completionId?journal!.get(completionId):null;
    if(operation&&(operation.draftId!==record.draft.id||operation.draftRevision!==record.draft.revision||operation.draftStamp!==completionDraftStamp(record.draft)))throw new UserFacingError('字段操作对应的草稿已修改，未自动清理');
    record.draft.attributes=cleanup.attributes;record.draft.revision++;record.preview=null;record.draft.previewedAt=null;
    // The response is an immutable historical receipt, not acceptance of the new color.
    if(!colorChanged)record.previewResponse=null;
    record.draft.state='DRAFT';record.draft.localIssues=[];if(!colorChanged)record.draft.previewIssues=[];record.request=this.request(record);
    this.updateSourceMapping(record);if(cleanup.removed.length)this.event(record,'save',haulCleanupReason(cleanup.removed));
    if(colorChanged)this.event(record,'save','已将销售颜色规范为普通英文颜色名；来源规格及原始响应保留');
    if(operation){operation.draftRevision=record.draft.revision;operation.draftStamp=completionDraftStamp(record.draft);journal!.save(operation);}
    return colorChanged;
  }
  private validate(record: DraftRecord, completionId?: string): boolean {
    const previousPreviewIssues=clone(record.draft.previewIssues),colorChanged=this.normalizeHaulRecord(record,completionId);
    record.draft.localIssues = [...listingProgramIssues(record.draft.listingProgram, record.draft.schema, record.draft.attributes), ...validateAttributes(record.draft.schema.schema, record.draft.attributes, record.draft.schema.metaSchema), ...imageIssues(record.draft.attributes), ...copyPolicyIssues(record.draft)];
    try { this.currentProduct(record); record.draft.localIssues.push(...this.declarationIssues(record.draft)); } catch { record.draft.localIssues.push(localIssue('SOURCE_CHANGED', '来源商品资料已变化，请建立新草稿', [], 'fact')); }
    const valid = !record.draft.localIssues.some(issue => issue.severity === 'ERROR');
    record.draft.state = valid ? 'LOCAL_VALIDATED' : 'BLOCKED'; record.preview = null; record.draft.previewedAt = null; record.draft.previewIssues = colorChanged?previousPreviewIssues:[];
    this.event(record, 'local_validation', valid ? '当前 Schema 的本地校验通过' : '本地校验未通过，请补全或核对问题字段'); this.persistence.putRecord(record); return valid;
  }
  async validateDraft(input: unknown): Promise<AmazonDraft> {
    const record = this.checked(input); this.enter(record.draft.id);
    try { return this.persistence.transaction(()=>{this.mutable(record); this.validate(record); return clone(record.draft);}); } finally { this.busy.delete(record.draft.id); }
  }
  private listingPath(record: DraftRecord): string { return `/listings/2021-08-01/items/${encodeURIComponent(record.draft.sellerId)}/${encodeURIComponent(record.draft.sku)}`; }
  private listingQuery(record: DraftRecord): Record<string, string> { return { marketplaceIds: record.draft.marketplaceId, issueLocale: record.draft.schema.locale }; }
  async previewDraft(input: unknown, completionId?: string): Promise<AmazonDraft> {
    const record = this.checked(input); this.enter(record.draft.id);
    try {
      this.mutable(record); const target = this.active(record.draft.targetId); const generation = this.persistence.generation(target.id);
      const locallyValid = this.persistence.transaction(()=>this.validate(record,completionId));
      const sendable = canSendToPreview(record.draft);
      if (!locallyValid && !sendable) throw new UserFacingError('本地校验未通过，请先处理字段问题');
      let result: ApiResult;
      if (target.mode === 'demo') { result = { data: { sku: record.draft.sku, status: locallyValid ? 'VALID' : 'INVALID', submissionId: `DEMO-PREVIEW-${randomUUID()}`, issues: locallyValid ? [] : record.draft.localIssues.map(issue => ({code:issue.code,message:issue.message,severity:issue.severity,attributeNames:issue.attributeNames})) }, status: 200, requestId: `DEMO-${randomUUID()}` }; this.demoCall(target, 'previewListingsItem'); }
      else result = await this.transport.api(target, 'previewListingsItem', this.listingPath(record), { ...this.listingQuery(record), mode: 'VALIDATION_PREVIEW', includedData: 'issues' }, this.request(record), () => this.currentProduct(record));
      record.previewResponse = result.data; record.draft.requestId = result.requestId; this.exchange(record, 'preview', result); this.persistence.putRecord(record);
      this.active(target.id); this.currentProduct(record);
      if (generation !== this.persistence.generation(target.id)) throw new UserFacingError('授权配置已变化，请重新预览');
      record.draft.previewIssues = remoteIssues(result.data.issues, target.mode);
      const valid = result.data.status === 'VALID' && result.data.sku === record.draft.sku && typeof result.data.submissionId === 'string' && !!result.data.submissionId
        && (result.data.issues === undefined || Array.isArray(result.data.issues)) && !record.draft.previewIssues.some(issue => issue.severity === 'ERROR');
      if (!valid && record.draft.previewIssues.length === 0) record.draft.previewIssues.push({ ...localIssue('PREVIEW_NOT_VALID', 'Amazon 未返回 VALID 状态；HTTP 成功不代表验证通过'), source: target.mode === 'demo' ? 'demo' : 'amazon' });
      record.draft.state = valid ? 'AMAZON_VALIDATED' : 'BLOCKED'; record.draft.previewedAt = valid ? this.at() : null;
      record.preview = valid ? { revision: record.draft.revision, productRevision: record.draft.productRevision, checksum: record.draft.schema.checksum, version: record.draft.schema.version, generation, at: this.at() } : null;
      this.event(record, 'preview', valid ? (target.mode === 'demo' ? '本地演示预览通过；未请求 Amazon' : 'Amazon VALIDATION_PREVIEW 通过，尚未正式提交') : '预览未通过，请处理返回问题'); this.persistence.putRecord(record); return clone(record.draft);
    } catch (error) {
      record.preview = null; record.draft.previewedAt = null;
      if (error instanceof AmazonTransportError) { record.previewResponse = error.response; this.exchange(record, 'preview', error); }
      if (record.draft.state === 'LOCAL_VALIDATED' || error instanceof AmazonTransportError) { record.draft.state = 'BLOCKED'; record.draft.previewIssues = [localIssue('PREVIEW_FAILED', error instanceof UserFacingError ? error.message : '预览请求未完成', [], 'network')]; this.persistence.putRecord(record); }
      throw error;
    } finally { this.busy.delete(record.draft.id); }
  }
  private requirePreview(record: DraftRecord, target: AmazonTarget, submitting = false): void {
    const proof = record.preview;
    if (!proof || record.draft.state !== (submitting ? 'SUBMITTING' : 'AMAZON_VALIDATED') || proof.revision !== record.draft.revision || proof.productRevision !== record.draft.productRevision || proof.checksum !== record.draft.schema.checksum || proof.version !== record.draft.schema.version
      || proof.generation !== this.persistence.generation(target.id)) throw new UserFacingError('请先对当前草稿完成有效预览；授权或内容变化后必须重新预览');
    if (this.now() < Date.parse(proof.at) || this.now() - Date.parse(proof.at) > PREVIEW_TTL) throw new UserFacingError('预览已过期，请重新预览后再提交');
    if (record.draft.previewIssues.some(issue => issue.severity === 'ERROR')) throw new UserFacingError('预览包含错误，不能提交');
  }
  async submitDraft(input: unknown, confirmed: boolean, taskGuard?: () => void): Promise<AmazonDraft> {
    if (confirmed !== true) throw new UserFacingError('正式提交需要原生确认对话框确认');
    const record = this.checked(input); this.enter(record.draft.id); let begun = false;
    const hash = listingHash(record.draft, record.draft.sku);
    try {
      taskGuard?.(); this.mutable(record); assertListingProgram(record.draft.listingProgram, record.draft.schema, record.draft.attributes); const target = this.active(record.draft.targetId); this.currentProduct(record); this.requirePreview(record, target);
      const current = await this.getSchema({ ...record.draft.schema, forceRefresh: true });
      if (current.checksum !== record.draft.schema.checksum || current.version !== record.draft.schema.version || JSON.stringify(current.metaSchema) !== JSON.stringify(record.draft.schema.metaSchema)) {
        record.preview = null; record.draft.previewedAt = null; record.draft.state = 'BLOCKED'; record.draft.localIssues = [localIssue('SCHEMA_CHANGED', 'Amazon Schema 已变化，请建立新草稿并重新预览')]; this.persistence.putRecord(record);
        throw new UserFacingError('Amazon Schema 版本或校验和已变化，请建立新草稿并重新校验和预览');
      }
      taskGuard?.(); this.currentProduct(record); this.requirePreview(this.persistence.record(record.draft.id), target); this.active(target.id);
      const declarationIssues=this.declarationIssues(record.draft);
      record.draft.localIssues = [...listingProgramIssues(record.draft.listingProgram, current, record.draft.attributes), ...validateAttributes(current.schema, record.draft.attributes, current.metaSchema), ...imageIssues(record.draft.attributes), ...copyPolicyIssues(record.draft), ...declarationIssues];
      if(declarationIssues.length){
        record.draft.state='BLOCKED';record.preview=null;record.draft.previewedAt=null;
        this.persistence.putRecord(record);
      }
      if (!canSendToPreview(record.draft)) throw new UserFacingError('本地校验未通过，不能正式提交');
      const guard = () => {
        try { taskGuard?.(); } catch { throw new TaskWriteNotSentError(); }
        this.currentProduct(record); this.active(target.id); this.requirePreview(this.persistence.record(record.draft.id), target, true);
        assertListingProgram(record.draft.listingProgram, current, record.draft.attributes);
        const issues=this.declarationIssues(record.draft);
        if(issues.length){record.draft.localIssues.push(...issues);throw new UserFacingError('本地校验未通过，安全声明须核对后再提交');}
      };
      record.draft.state = 'SUBMITTING'; record.draft.requestId = null; record.request = this.request(record); this.event(record, 'submit', '已记录提交意图；本次写入不会自动重试'); this.persistence.beginWrite(hash, record); begun = true;
      let result: ApiResult;
      if (target.mode === 'demo') { guard(); result = { data: { sku: record.draft.sku, status: 'ACCEPTED', submissionId: `DEMO-${randomUUID()}`, issues: [] }, status: 200, requestId: `DEMO-${randomUUID()}` }; this.demoCall(target, 'putListingsItem'); }
      else result = await this.transport.api(target, 'putListingsItem', this.listingPath(record), { ...this.listingQuery(record), includedData: 'issues' }, record.request, guard);
      record.submitResponse = result.data; record.draft.requestId = result.requestId; record.draft.listingIssues = remoteIssues(result.data.issues, target.mode);
      this.exchange(record, 'submit', result);
      if (result.data.status === 'ACCEPTED' && result.data.sku === record.draft.sku && typeof result.data.submissionId === 'string' && result.data.submissionId
        && (result.data.issues === undefined || Array.isArray(result.data.issues)) && !record.draft.listingIssues.some(issue => issue.severity === 'ERROR')) {
        record.draft.state = 'SUBMITTED'; record.draft.submissionId = result.data.submissionId; record.draft.submittedAt = this.at();
        this.event(record, 'submit', target.mode === 'demo' ? '本地演示已接受；未提交到 Amazon' : 'Amazon 已接受提交；请回读处理状态');
      } else if (result.data.status === 'INVALID' && result.data.sku === record.draft.sku && record.draft.listingIssues.some(issue => issue.severity === 'ERROR')) {
        record.draft.state = 'BLOCKED'; this.event(record, 'submit', 'Amazon 拒绝提交，请处理问题后重新预览');
      } else {
        record.unresolvedWrite = true; record.draft.state = 'UNKNOWN'; this.event(record, 'submit', '无法确认提交响应含义，结果未知；请回读并人工核对，禁止重放');
      }
      const invalidated = record.draft.state === 'SUBMITTED' ? this.persistence.records().filter(other => other.draft.id !== record.draft.id && listingHash(other.draft, other.draft.sku) === hash && !FINAL_STATES.has(other.draft.state)) : [];
      for (const other of invalidated) { other.preview = null; other.draft.previewedAt = null; other.draft.previewIssues = []; other.draft.state = 'DRAFT'; this.event(other, 'save', '同一 SKU 有新提交，旧预览已失效；先回读，再重新预览'); }
      record.preview = null; record.draft.previewedAt = null; this.persistence.finishWrite(hash, record, invalidated); return clone(record.draft);
    } catch (error) {
      if (!begun) throw error;
      record.preview = null; record.draft.previewedAt = null; record.draft.requestId = error instanceof AmazonTransportError ? error.requestId : null;
      if (error instanceof AmazonTransportError) { record.submitResponse = error.response; this.exchange(record, 'submit', error); }
      record.unresolvedWrite = error instanceof AmazonTransportError ? error.unknownWrite : !(error instanceof UserFacingError);
      record.draft.state = record.unresolvedWrite ? 'UNKNOWN' : 'BLOCKED';
      record.draft.listingIssues = [localIssue(record.unresolvedWrite ? 'SUBMISSION_UNKNOWN' : 'SUBMISSION_FAILED', error instanceof UserFacingError ? error.message : '提交未完成，请核对状态', [], error instanceof AmazonTransportError && error.status === 429 ? 'rate_limit' : 'network')];
      this.event(record, 'submit', record.unresolvedWrite ? '提交结果未知；已锁定此 SKU，禁止自动重放，请回读并人工核对' : '提交未通过，已清除旧预览'); this.persistence.finishWrite(hash, record);
      if (record.unresolvedWrite) return clone(record.draft); throw error;
    } finally { this.busy.delete(record.draft.id); }
  }
  async readListing(input: unknown, beforeSend?: () => void): Promise<AmazonDraft> {
    let record = this.checked(input);
    if (!record.draft.submittedAt && !['UNKNOWN', 'SUBMITTING'].includes(record.draft.state)) throw new UserFacingError('此草稿尚未正式提交，不能回读；请先完成校验、预览和确认提交');
    this.enter(record.draft.id);
    try {
      const target = this.active(record.draft.targetId); let result: ApiResult;
      if (target.sellerId !== record.draft.sellerId || target.marketplaceId !== record.draft.marketplaceId || target.mode !== record.draft.mode) throw new UserFacingError('回读草稿与店铺身份不匹配，请核对后重新操作');
      const draftId = record.draft.id, draftScope = readbackDraftScope(record.draft), targetScope = readbackTargetScope(target), generation = this.persistence.generation(target.id);
      const currentRecord = () => {
        this.ensureOpen();
        if (generation !== this.persistence.generation(target.id) || targetScope !== readbackTargetScope(this.persistence.target(target.id))) throw new UserFacingError('回读期间店铺身份或授权配置已变化，未采用本次响应');
        const current = this.persistence.record(draftId);
        if (draftScope !== readbackDraftScope(current.draft)) throw new UserFacingError('回读期间草稿身份或提交内容已变化，未采用本次响应');
        return current;
      };
      if (target.mode === 'demo') { beforeSend?.(); result = { data: { sku: record.draft.sku, summaries: record.draft.submittedAt ? [{ marketplaceId: target.marketplaceId, status: ['BUYABLE', 'DISCOVERABLE'] }] : [], issues: [],relationships:record.draft.salesPlan?.parentage==='CHILD'?[{marketplaceId:target.marketplaceId,relationships:[{type:'VARIATION',parentSkus:[record.draft.salesPlan.parentSku!],variationTheme:{theme:record.draft.salesPlan.variationTheme!,attributes:[]}}]}]:[] }, status: 200, requestId: `DEMO-${randomUUID()}` }; this.demoCall(target, 'getListingsItem'); }
      else {
        try { result = await this.transport.api(target, 'getListingsItem', this.listingPath(record), { ...this.listingQuery(record), includedData: 'summaries,issues,attributes,offers,fulfillmentAvailability,relationships' }, undefined, beforeSend); }
        catch (error) {
          record = currentRecord();
          if (error instanceof AmazonTransportError) { record.readResponse = error.response; this.exchange(record, 'readback', error); this.persistence.putRecord(record); }
          if (!(error instanceof AmazonTransportError) || error.status !== 404) throw error;
          record.draft.checkedAt = this.at(); record.draft.requestId = error.requestId; record.draft.statuses = [];
          if (!record.unresolvedWrite && record.draft.submittedAt) record.draft.state = 'PROCESSING';
          this.event(record, 'readback', 'Amazon 尚未查到此 SKU；不能据此推断前次写入未发生'); this.persistence.putRecord(record); return clone(record.draft);
        }
      }
      // An already-sent read may settle during maintenance pause. Do not rerun
      // beforeSend here: validate response ownership, then merge into current state.
      record = currentRecord();
      record.readResponse = result.data; record.draft.requestId = result.requestId; record.draft.checkedAt = this.at(); this.exchange(record, 'readback', result); this.persistence.putRecord(record);
      if (result.data.sku !== record.draft.sku || !Array.isArray(result.data.summaries)) throw new UserFacingError('Amazon 回读响应的 SKU 或数据结构不匹配');
      record.draft.listingIssues = remoteIssues(result.data.issues, target.mode);
      const statuses = result.data.summaries.filter(isObject).filter(summary => summary.marketplaceId === target.marketplaceId).flatMap(summary => Array.isArray(summary.status) ? summary.status.filter((value): value is string => typeof value === 'string') : []);
      record.draft.statuses = [...new Set(statuses)].slice(0, 30);
      const hash = listingHash(record.draft, record.draft.sku); const lock = this.persistence.lock(hash);
      if (!record.unresolvedWrite && lock?.state === 'SUBMITTED' && result.data.summaries.some(summary => isObject(summary) && summary.marketplaceId === target.marketplaceId)) this.persistence.releaseAccepted(hash, record.draft.id);
      if (record.unresolvedWrite || lock?.state === 'UNKNOWN' || lock?.state === 'SUBMITTING') record.draft.state = 'UNKNOWN';
      else record.draft.state = record.draft.statuses.includes('BUYABLE') ? 'BUYABLE' : record.draft.statuses.includes('DISCOVERABLE') ? 'DISCOVERABLE' : record.draft.listingIssues.some(issue => issue.severity === 'ERROR') ? 'BLOCKED' : 'PROCESSING';
      this.event(record, 'readback', record.unresolvedWrite ? '已回读远端状态；存在商品不能证明上次写入结果，未知结果锁仍保留' : target.mode === 'demo' ? '本地演示回读完成；这些状态不是 Amazon 实际销售状态' : '已回读 Amazon 当前状态；可售和可见标志分别保留'); this.persistence.putRecord(record); return clone(record.draft);
    } finally { this.busy.delete(record.draft.id); }
  }
  private demoCall(target: AmazonTarget, operation: string): void {
    this.persistence.addCall({ id: randomUUID(), at: this.at(), targetId: target.id, operation, mode: 'demo', status: 200, requestId: null, retries: 0, durationMs: 0, rateLimit: null, category: 'local_demo' });
  }
  listCalls(): AmazonCallEvent[] { this.ensureOpen(); return this.persistence.calls(); }
  getDataPolicy(): AmazonDataPolicy { this.ensureOpen(); return this.persistence.policy(); }
  saveDataPolicy(input: unknown): AmazonDataPolicy {
    const value = object(input); const days = value.retentionDays;
    if (!Number.isInteger(days) || Number(days) < 1 || Number(days) > 548) throw new UserFacingError('Amazon 数据保留期限必须是 1–548 天的整数');
    const policy = { ...this.getDataPolicy(), retentionDays: days as number, logRetentionDays: Math.max(365, Number(days)) }; this.persistence.savePolicy(policy); return policy;
  }
  cleanupData(): CleanupResult { this.ensureOpen(); if (this.busy.size) throw new UserFacingError('有 Amazon 操作正在处理，请完成后再清理'); return this.persistence.cleanup(this.now()); }
}
