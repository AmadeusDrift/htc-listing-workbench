import { plainColorValue } from './plain-colors.ts';
import { resultHasOwner } from '../ai/result-owner.ts';
import { isFullSchema,candidateNative } from './full-schema.ts';
import { assertStoredListingEvidence, assertStoredListingReview } from './stored-evidence.ts';
import type { AiCall, AiResult } from '../../shared/ai-contracts.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { LISTING_CANDIDATE_FIELDS } from '../../shared/listing-ai-contracts.ts';
import { attributesObject } from '../amazon/context.ts';
import { listingFingerprint } from './validation.ts';
import { validateSalesPlan } from '../sales-plans/records.ts';
import type { DatabaseSync } from 'node:sqlite';
import { adoptionSchema } from './schema-lineage.ts';
import { QUOTE_FAILURE_CODES } from '../../shared/listing-rules.ts';
import type { BusinessRuleReport } from '../../shared/listing-rules.ts';

const OPTIONAL_REVIEW_POLICY = 'haul-us-copy-2026-10-07-v2';
function exactKeys(raw: unknown, names: string[]): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).sort().join() === [...names].sort().join();
}
export function assertPricingDecision(report: BusinessRuleReport, draft: AmazonDraft): void {
  if (!Object.hasOwn(report, 'pricingDecision')) return;
  const invalid = (): never => { throw new UserFacingError('商品规则快照的定价原因或输入证据无效'); };
  const d = report.pricingDecision;
  if (!d || !exactKeys(d, ['version','status','code','quoteError','inputs','evidence', ...(d.version === 2 ? ['attributeInputs'] : [])]) || ![1,2].includes(d.version)
    || !exactKeys(d.inputs, ['costCny','dimensionsInches','weightPounds'])
    || !exactKeys(d.evidence, ['cost','dimensions','weight','packageScope','saleUnit','sourcePackage'])
    || !exactKeys(d.evidence.sourcePackage, ['dimensionsInches','weightPounds'])) return invalid();
  if (d.version === 2) {
    const snapshot = attributesObject(d.attributeInputs);
    if (Object.keys(snapshot).some(field => !['item_package_dimensions','item_package_weight'].includes(field))) invalid();
  }
  const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const dimensions = (value: unknown) => Array.isArray(value) && value.length === 3 && value.every(positive);
  const { inputs, evidence: e } = d;
  const marketplaceId = draft.marketplaceId, recipe = draft.salesPlan?.recipe;
  for (const pack of [inputs, e.sourcePackage]) {
    if (pack.dimensionsInches !== null && !dimensions(pack.dimensionsInches) || pack.weightPounds !== null && !positive(pack.weightPounds)) invalid();
  }
  if (inputs.costCny !== null && !positive(inputs.costCny) || !['confirmed_cny','unconfirmed'].includes(e.cost)
    || (e.cost === 'confirmed_cny') !== (inputs.costCny !== null)
    || !['source_sale_unit','unconfirmed'].includes(e.packageScope) || !['confirmed','conflicting','unconfirmed'].includes(e.saleUnit)) invalid();
  for (const kind of ['dimensions','weight'] as const) {
    const key = kind === 'dimensions' ? 'dimensionsInches' : 'weightPounds', basis = e[kind];
    if (!['confirmed_source','business_default','unverified','missing','conflicting'].includes(basis)) invalid();
    if (basis === 'confirmed_source' && (inputs[key] === null || e.sourcePackage[key] === null
      || JSON.stringify(inputs[key]) !== JSON.stringify(e.sourcePackage[key]))) invalid();
    if (basis === 'missing' && inputs[key] !== null || ['business_default','unverified'].includes(basis) && inputs[key] === null) invalid();
  }
  const quoteError = d.quoteError !== null && QUOTE_FAILURE_CODES.includes(d.quoteError);
  if (d.quoteError !== null && !quoteError) invalid();
  const businessFailure = quoteError && d.quoteError !== 'QUOTE_INVALID_INPUT';
  const complete = inputs.costCny !== null && inputs.dimensionsInches !== null && inputs.weightPounds !== null;
  const attempted = () => {
    const cost = report.pricingBasis?.saleUnitCostCny;
    if (!complete || cost === undefined || inputs.costCny === null || Math.abs(cost - inputs.costCny) > Math.max(cost, inputs.costCny) * 1e-10) invalid();
  };
  if (e.packageScope === 'source_sale_unit' && (report.pricingBasis?.kind === 'auto_bundle'
    || recipe && (recipe.components.length !== 1 || recipe.components[0].quantity !== recipe.components[0].sourcePackPieces || report.bundleQuantity !== recipe.totalPieces))) invalid();
  if (d.status === 'quoted') {
    if (d.code !== 'QUOTE_VALID' || d.quoteError !== null || report.quote === null || e.saleUnit === 'conflicting' || marketplaceId !== 'ATVPDKIKX0DER') invalid();
    attempted();
  } else if (d.status === 'business_blocked') {
    if (!businessFailure || d.code !== d.quoteError || report.quote !== null || e.cost !== 'confirmed_cny'
      || !['confirmed_source',...(d.version===2?['business_default']:[])].includes(e.dimensions) || !['confirmed_source',...(d.version===2?['business_default']:[])].includes(e.weight) || e.packageScope !== 'source_sale_unit'
      || e.saleUnit !== 'confirmed' || marketplaceId !== 'ATVPDKIKX0DER') invalid();
    attempted();
  } else if (d.status === 'system_error') {
    if (d.code !== 'PRICING_SYSTEM_ERROR' || d.quoteError !== null || report.quote !== null) invalid();
    attempted();
  } else if (d.status === 'needs_input') {
    if (report.quote !== null) invalid();
    switch (d.code) {
      case 'COST_CNY_UNCONFIRMED': if (inputs.costCny !== null || d.quoteError !== null) invalid(); break;
      case 'MARKETPLACE_UNSUPPORTED': if (marketplaceId === 'ATVPDKIKX0DER' || d.quoteError !== null) invalid(); break;
      case 'PACKAGE_MEASUREMENTS_MISSING': if (inputs.dimensionsInches !== null && inputs.weightPounds !== null || d.quoteError !== null) invalid(); break;
      case 'SOURCE_QUANTITY_CONFLICT': case 'LEGACY_QUANTITY_CONFLICT': if (e.saleUnit !== 'conflicting' || d.quoteError !== null) invalid(); break;
      case 'SOURCE_QUANTITY_UNCONFIRMED':
        if (!businessFailure || e.saleUnit !== 'unconfirmed' || e.packageScope !== 'unconfirmed') invalid();
        attempted(); break;
      case 'SALE_QUANTITY_CHANGED': if (e.saleUnit !== 'unconfirmed' || d.quoteError !== null) invalid(); break;
      case 'PACKAGE_INPUT_UNCONFIRMED':
        if (!businessFailure || e.dimensions === 'confirmed_source' && e.weight === 'confirmed_source' || e.packageScope !== 'source_sale_unit' || e.saleUnit !== 'confirmed') invalid();
        attempted(); break;
      case 'PACKAGE_SCOPE_UNCONFIRMED':
        if (!businessFailure || e.packageScope !== 'unconfirmed' || e.saleUnit !== 'confirmed') invalid();
        attempted(); break;
      case 'QUOTE_INVALID_INPUT': if (d.quoteError !== 'QUOTE_INVALID_INPUT') invalid(); break;
      default: invalid();
    }
  } else invalid();
}
export function assertBusinessRules(draft: AmazonDraft): void {
  const report = draft.businessRules; if (report === undefined) return;
  const invalid = (): never => { throw new UserFacingError('商品规则快照的字段或报价格式无效'); };
  const boundedText = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  const hasPricingBasis = report !== null && Object.hasOwn(report, 'pricingBasis');
  const hasPricingDecision = report !== null && Object.hasOwn(report, 'pricingDecision');
  if (!exactKeys(report, ['revision','fields','notices','quote','bundleQuantity', ...(hasPricingBasis ? ['pricingBasis'] : []), ...(hasPricingDecision ? ['pricingDecision'] : [])]) || !Number.isSafeInteger(report.revision) || report.revision < 0 || !Number.isSafeInteger(report.bundleQuantity) || report.bundleQuantity < 1) invalid();
  // Validate the complete snapshot as bounded JSON, including every wrapped field value.
  attributesObject({ businessRules: report });
  const properties = draft.schema.schema.properties;
  if (!report.fields || typeof report.fields !== 'object' || Array.isArray(report.fields) || Object.keys(report.fields).length > 5000 || !properties || typeof properties !== 'object' || Array.isArray(properties)) return invalid();
  for (const [field, entry] of Object.entries(report.fields)) {
    if (!Object.hasOwn(properties, field) || !exactKeys(entry, ['value','reason']) || !boundedText(entry.reason)) invalid();
  }
  if (!Array.isArray(report.notices) || report.notices.length > 5000 || report.notices.some(notice => !boundedText(notice))) invalid();
  if (hasPricingBasis) {
    const basis = report.pricingBasis;
    if (!basis || !exactKeys(basis, ['kind','sourceCostCny','quantity','saleUnitCostCny'])) return invalid();
    if (!['source_sale_unit','source_piece_quote','auto_bundle'].includes(basis.kind) || !Number.isSafeInteger(basis.quantity) || basis.quantity < 1 || basis.quantity > 100000 ||
      basis.kind === 'source_sale_unit' && basis.quantity !== 1 || basis.kind !== 'source_sale_unit' && basis.quantity < 2) invalid();
    for (const cost of [basis.sourceCostCny, basis.saleUnitCostCny]) if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) invalid();
    const expected = basis.sourceCostCny * basis.quantity;
    if (!Number.isFinite(expected) || Math.abs(expected - basis.saleUnitCostCny) > Math.max(expected, basis.saleUnitCostCny) * 1e-10) invalid();
  }
  assertPricingDecision(report, draft);
  if (report.quote === null) return;
  const quote = report.quote;
  if (!exactKeys(quote, ['price','minimum','roi','deliveryFee','commission','upfrontCny','dimensionalWeightGrams','billableWeightGrams','promotionPrice','promotionRoi'])) invalid();
  for (const [name, value] of Object.entries(quote)) {
    if ((name === 'promotionPrice' || name === 'promotionRoi') && value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || !['roi','promotionRoi'].includes(name) && value < 0) invalid();
  }
  if (quote.price <= 0 || quote.minimum <= 0 || (quote.promotionPrice === null) !== (quote.promotionRoi === null) || quote.promotionPrice !== null && quote.promotionPrice <= 0) invalid();
}

export function assertListingHistory(draft: AmazonDraft, results: Map<string,AiResult>, calls: Map<string,AiCall>, database?:DatabaseSync): void {
  const invalid = (): never => {throw new UserFacingError('AI 字段采纳记录的来源关联或内容不完整');};
  if (draft.listingProgram !== undefined && !['haul','standard'].includes(draft.listingProgram)) invalid();
  if(draft.salesPlan!==undefined){const plan=validateSalesPlan(draft.salesPlan);if(plan.sku!==draft.sku||plan.parentage!==draft.schema.parentageLevel||!plan.familyResolved||!plan.recipe.components.some(c=>c.variantId===draft.variantId))invalid();}
  if(draft.parentImageSourceDraftId!==undefined && (draft.salesPlan?.parentage!=='PARENT'||!/^[a-f0-9-]{36}$/i.test(draft.parentImageSourceDraftId)))invalid();
  assertBusinessRules(draft);
  if (draft.sourceMapping !== undefined) {
    if (!Array.isArray(draft.sourceMapping) || draft.sourceMapping.length > 5000 || new Set(draft.sourceMapping.map(f=>f.field)).size !== draft.sourceMapping.length) invalid();
    const properties = draft.schema.schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return invalid();
    for (const f of draft.sourceMapping) if (!f || Object.keys(f).sort().join() !== ['field','status','reason','sourceFactIds'].sort().join() || !Object.hasOwn(properties,f.field) || !['mapped','needs_input','not_applicable','conflicting'].includes(f.status) || typeof f.reason!=='string' || f.reason.length>4000 || !Array.isArray(f.sourceFactIds) || f.sourceFactIds.length>200 || f.sourceFactIds.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))) invalid();
  }
  const history = draft.fieldAdoptions ?? [];
  if (!Array.isArray(history) || history.length > 10000) invalid();
  let previous = 0; const ids = new Set<string>();
  for (const a of history) {
    const hasDisposition = !!a && Object.hasOwn(a, 'reviewDisposition');
    if (!a || typeof a !== 'object' || Object.keys(a).sort().join() !== ['id','at','suggestionResultId','reviewResultId','contextSha256','fromRevision','toRevision','fields','changes', ...(hasDisposition ? ['reviewDisposition'] : [])].sort().join() || !Number.isFinite(Date.parse(a.at)) || !Number.isSafeInteger(a.fromRevision) || a.fromRevision <= previous || a.toRevision !== a.fromRevision + 1 || a.toRevision > draft.revision || ids.has(a.id)) invalid();
    if (hasDisposition && (a.reviewDisposition !== 'SKIPPED_DISABLED' || a.reviewResultId !== null)) invalid();
    ids.add(a.id); previous = a.fromRevision;
    if (!Array.isArray(a.fields) || !a.fields.length || new Set(a.fields).size !== a.fields.length || a.fields.some(f=>typeof f!=='string') || !Array.isArray(a.changes) || a.changes.length !== a.fields.length) invalid();
    const suggestion = results.get(a.suggestionResultId), review = a.reviewResultId === null ? undefined : results.get(a.reviewResultId);
    if (!suggestion || suggestion.output.kind !== 'amazon-fields' || !suggestion.listingContext) return invalid();
    const c = suggestion.listingContext;
    if(a.fields.some(f=>isFullSchema(c)?!Object.hasOwn(c.fullSchema!.schema.properties as object??{},f):!LISTING_CANDIDATE_FIELDS.includes(f)))invalid();
    if (a.reviewResultId === null) { if (!hasDisposition && c.policyVersion !== OPTIONAL_REVIEW_POLICY) invalid(); }
    else {
      if (!review || review.output.kind !== 'amazon-fields-review' || review.output.verdict !== 'PASS' || review.sourceResultIds[0] !== suggestion.id || review.sourceSha256 !== a.contextSha256) return invalid();
      assertStoredListingReview(review.output,suggestion.output,c,suggestion.listingEvidenceContractVersion);
    }
    const schema=adoptionSchema(draft,c,a,database);
    if (!schema || c.draftId !== draft.id || c.draftRevision !== a.fromRevision || c.productId !== draft.productId || c.productRevision !== draft.productRevision || c.variantId !== draft.variantId || c.sku !== draft.sku || c.targetId !== draft.targetId || c.listingProgram !== (draft.listingProgram ?? 'standard') || a.contextSha256 !== listingFingerprint(c) || suggestion.sourceSha256 !== a.contextSha256) return invalid();
    for (const result of review ? [suggestion,review] : [suggestion]) {const call=calls.get(result.callId);if(!call||!resultHasOwner(result,call)||call.productId!==result.productId||call.productRevision!==result.productRevision||call.providerId!==result.providerId||call.model!==result.model)invalid();}
    assertStoredListingEvidence(suggestion.output,c,suggestion.listingEvidenceContractVersion);
    const expectedId=listingFingerprint({draftId:draft.id,revision:a.fromRevision,suggestion:suggestion.id,review:review?.id??null,fields:[...a.fields].sort(),...(hasDisposition?{reviewDisposition:a.reviewDisposition}:{})});if(a.id!==expectedId)invalid();
    if(a.changes.some(change=>!exactKeys(change,['field','before','after','evidence'])))invalid();
    if(new Set(a.changes.map(change=>change.field)).size!==a.fields.length)invalid();
    for(const change of a.changes){
      const candidate=suggestion.output.candidates.find(candidate=>candidate.field===change.field);if(!candidate||!a.fields.includes(change.field))return invalid();
      attributesObject({before:change.before,after:change.after});
      if(isFullSchema(c)&&JSON.stringify(c.currentAttributes?.[change.field]??null)!==JSON.stringify(change.before))invalid();
      const expected=candidateNative(candidate,schema,draft.marketplaceId,change.before??undefined);
      const evidenceIds=new Set(candidate.items.flatMap(item=>item.evidenceIds));
      const plain=change.field==='color'?plainColorValue(expected,c.evidence.filter(e=>e.meaning==='color'||e.id===`${c.variantId}:spec`).map(e=>e.value)):expected;
      if(JSON.stringify(expected)!==JSON.stringify(change.after)&&JSON.stringify(plain)!==JSON.stringify(change.after)||JSON.stringify(c.evidence.filter(e=>evidenceIds.has(e.id)))!==JSON.stringify(change.evidence))invalid();
    }
  }
}
