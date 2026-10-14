import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { BusinessRuleReport } from '../../shared/listing-rules.ts';
import { QUOTE_FAILURE_CODES } from '../../shared/listing-rules.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { attributesObject } from '../amazon/context.ts';
import { readPricingRuleInputs } from './dependencies.ts';
import { salesPlatformPieces } from '../../shared/source-quantity.ts';
import { validateUnitSemantics } from '../sales-plans/records.ts';
function exactKeys(raw: unknown, names: string[]): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).sort().join() === [...names].sort().join();
}
export function assertPricingDecision(report: BusinessRuleReport, draft: AmazonDraft): void {
  if (!Object.hasOwn(report, 'pricingDecision')) return;
  const invalid = (): never => { throw new UserFacingError('商品规则快照的定价原因或输入证据无效'); };
  const d = report.pricingDecision;
  if (!d || !exactKeys(d, ['version','status','code','quoteError','inputs','evidence', ...(d.version !== 1 ? ['attributeInputs'] : []), ...(d.version === 3 ? ['dependencies'] : [])]) || ![1,2,3].includes(d.version)
    || !exactKeys(d.inputs, ['costCny','dimensionsInches','weightPounds'])
    || !exactKeys(d.evidence, ['cost','dimensions','weight','packageScope','saleUnit','sourcePackage'])
    || !exactKeys(d.evidence.sourcePackage, ['dimensionsInches','weightPounds'])) return invalid();
  if (d.version !== 1) {
    const snapshot = attributesObject(d.attributeInputs);
    if (Object.keys(snapshot).some(field => !['item_package_dimensions','item_package_weight'].includes(field))) invalid();
  }
  const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const dimensions = (value: unknown) => Array.isArray(value) && value.length === 3 && value.every(positive);
  if (d.version === 3) {
    const dependency = d.dependencies;
    if (!exactKeys(dependency,['rules','saleUnit','quantityInputs','costCny','bundleQuantity'])
      || typeof dependency.rules !== 'string' || !dependency.rules || dependency.rules.length > 30000
      || dependency.costCny !== d.inputs.costCny || dependency.bundleQuantity !== report.bundleQuantity) invalid();
    try { readPricingRuleInputs(dependency.rules,d.evidence); } catch { invalid(); }
    const quantities = attributesObject(dependency.quantityInputs);
    if (Object.keys(quantities).some(field => !['number_of_items','unit_count'].includes(field))) invalid();
    if (dependency.saleUnit !== null) {
      const unit = dependency.saleUnit;
      if (!unit || typeof unit !== 'object' || Array.isArray(unit) || !exactKeys(unit,['totalPieces','totalCostCny','components',...(unit.quantityVersion===2?['quantityVersion','platformPieces']:[])])
        || !Number.isSafeInteger(unit.totalPieces) || Number(unit.totalPieces) < 1 || unit.totalCostCny !== null && !positive(unit.totalCostCny)
        || unit.components !== null && (!Array.isArray(unit.components) || !unit.components.length)) return invalid();
      if(unit.quantityVersion===2&&unit.platformPieces!==null&&(!Number.isSafeInteger(unit.platformPieces)||Number(unit.platformPieces)<1))invalid();
      for (const component of (Array.isArray(unit.components)?unit.components:[])) {
        if (!component || typeof component !== 'object' || Array.isArray(component)
          || !exactKeys(component,['variantId','quantity','quotedCostCny','piecesPerQuote','sourcePackPieces',...(Object.hasOwn(component,'unitSemantics')?['unitSemantics']:[])])
          || typeof component.variantId !== 'string' || !component.variantId
          || ['quantity','piecesPerQuote','sourcePackPieces'].some(key => !Number.isSafeInteger(component[key]) || Number(component[key]) < 1)
          || component.quotedCostCny !== null && !positive(component.quotedCostCny)) invalid();
        const c=attributesObject(component);
        if(Object.hasOwn(c,'unitSemantics')){
          if(unit.quantityVersion!==2||c.piecesPerQuote!==1||c.sourcePackPieces!==1)invalid();
          try{validateUnitSemantics(c.unitSemantics);}catch{invalid();}
        }
      }
    }
  }
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
    || recipe && (recipe.components.length !== 1 || recipe.components[0].quantity !== recipe.components[0].sourcePackPieces || report.bundleQuantity !== salesPlatformPieces(recipe)))) invalid();
  if (d.status === 'quoted') {
    if (d.code !== 'QUOTE_VALID' || d.quoteError !== null || report.quote === null || e.saleUnit === 'conflicting' || marketplaceId !== 'ATVPDKIKX0DER') invalid();
    attempted();
  } else if (d.status === 'business_blocked') {
    if (!businessFailure || d.code !== d.quoteError || report.quote !== null || e.cost !== 'confirmed_cny'
      || !['confirmed_source',...(d.version!==1?['business_default']:[])].includes(e.dimensions) || !['confirmed_source',...(d.version!==1?['business_default']:[])].includes(e.weight) || e.packageScope !== 'source_sale_unit'
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
