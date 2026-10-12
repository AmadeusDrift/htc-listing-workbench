import { isDeepStrictEqual } from 'node:util';
import type { AmazonSchema, AmazonTarget, JsonObject, JsonValue, SourceFieldMapping } from '../../shared/amazon-contracts.ts';
import type { ProductDetail, Variant } from '../../shared/contracts.ts';
import { bundleQuantity, ListingQuoteError, promotionSchedule, quoteListing } from '../../shared/listing-rules.ts';
import type { BusinessRuleReport, ListingRules, PackageInputBasis, PricingDecision, PricingDecisionCode, PricingPackageInputs } from '../../shared/listing-rules.ts';
import { isObject } from './context.ts';
import { resolveSchemaNode } from './field-catalog.ts';
import { convertMeasurement, DIMENSION_FIELDS, mapMeasurementFields, validateFieldValues, wrapCandidateValues } from './field-mapping.ts';
import type { ConfirmedMeasurements, MeasurementSet } from './field-mapping.ts';
import { effectiveSourceMeasurements, sourceFactValue, sourceFieldName } from './demo.ts';
import { productSourceQuantity, sourceQuantity } from '../../shared/source-quantity.ts';
import { pricingAttributeInputs } from './pricing-inputs.ts';
import { currentFactAuthority } from './fact-authority.ts';
import { declarationRisks } from './declaration-safety.ts';
import type { DeclarationScope } from './declaration-safety.ts';

export interface BusinessRuleInput {
  product: ProductDetail; variant: Variant; schema: AmazonSchema; target: AmazonTarget; attributes: JsonObject;
  measurements: ConfirmedMeasurements; costCny: number | null; now: Date;
  previousBusinessReport?: BusinessRuleReport;
  saleUnit?: { totalPieces:number; totalCostCny:number|null };
  /** Supplied by the sales recipe boundary; component packages do not prove a mixed/bundled package. */
  packageMatchesSaleUnit?: boolean;
  baseSku?: string;
  /** Raw selected source variants, before sales-display projection. */
  declarationScope?: DeclarationScope;
}

/** Deterministic business inputs. Original source records are never modified. */
export function applyBusinessRules(input: BusinessRuleInput, rules: ListingRules): { attributes: JsonObject; report: BusinessRuleReport } {
  const { schema, target, product, variant } = input, p = rules.product;
  const attributes = structuredClone(input.attributes), properties = isObject(schema.schema.properties) ? schema.schema.properties : {};
  const report: BusinessRuleReport = { revision: rules.revision, fields: {}, notices: [], quote: null, bundleQuantity: 1 };
  // Reapplying rules must not turn an unchanged default into a measured value.
  for (const [field, entry] of Object.entries(input.previousBusinessReport?.fields ?? {})) {
    if (JSON.stringify(entry.value) === JSON.stringify(attributes[field])) report.fields[field] = structuredClone(entry);
  }
  const first = (name: string) => Array.isArray(attributes[name]) && isObject(attributes[name][0]) ? attributes[name][0] as JsonObject : null;
  const note = (message: string) => { if (!report.notices.includes(message)) report.notices.push(message); };
  const explicitFields = new Set<string>();
  // Refresh only untouched program-generated declarations; user edits remain distinct.
  const configuredFields = new Set(['model_number','model_name','part_number','brand','manufacturer']);
  for (const field of configuredFields) if (report.fields[field]) { delete attributes[field]; delete report.fields[field]; }
  const sourceFields = ['brand','manufacturer','country_of_origin','import_designation','model_number','model_name','part_number','condition_type',
    'gpsr_safety_attestation','batteries_required','supplier_declared_dg_hz_regulation','required_product_compliance_certificate','number_of_items'];
  for (const field of sourceFields) {
    if (!Object.hasOwn(properties, field) || field === 'number_of_items' && product.variants.length !== 1) continue;
    const facts = product.facts.filter(fact => sourceFieldName(fact.name, 'haul') === field && ['source_confirmed','human_confirmed','conflicting'].includes(fact.state));
    if (!facts.length) continue;
    explicitFields.add(field);
    if (Object.hasOwn(attributes, field)) continue;
    const values = new Map(facts.filter(fact => fact.value.trim()).map(fact => { const value = sourceFactValue(schema, field, fact.value.trim()); return [JSON.stringify(value), value]; }));
    if (facts.some(fact => fact.state === 'conflicting') || values.size !== 1) { note(`${field} 的来源事实存在冲突或缺少有效值，未套用业务默认`); continue; }
    const value = [...values.values()][0];
    if (validateFieldValues(schema, target.marketplaceId, field, [value], attributes).length) note(`${field} 已有明确来源但尚未满足当前 Schema，保留待确认；未套用相反默认值`);
    else attributes[field] = wrapCandidateValues(schema, target.marketplaceId, field, [value]);
  }
  const add = (field: string, value: JsonValue, reason: string, replace = false): boolean => {
    if (!Object.hasOwn(properties, field) || !replace && (Object.hasOwn(attributes, field) || explicitFields.has(field))) return false;
    if (validateFieldValues(schema, target.marketplaceId, field, [value], attributes).length) { report.notices.push(`${field} 的业务值与当前类目结构不匹配，留待预览核对`); return false; }
    const wrapped = wrapCandidateValues(schema, target.marketplaceId, field, [value]);
    attributes[field] = wrapped; report.fields[field] = { value: structuredClone(wrapped), reason }; return true;
  };
  const fallback = '业务默认；缺少对应实测值，须按实际包装核实';
  add('brand', p.brand, '品牌固定规则；原供应商品牌保留在来源与 IP 检查中', true);
  const code = p.targetShops[target.id] ?? (Object.hasOwn(p.manufacturers, target.name) ? target.name : null);
  if (code && p.manufacturers[code]) add('manufacturer', p.manufacturers[code], `店铺 ${code} 制造商规则`);
  else if (!attributes.manufacturer && properties.manufacturer) note('请在商品规则中为此店铺选择制造商映射');
  for (const field of ['model_number','model_name','part_number']) add(field, schema.parentageLevel === 'PARENT' ? input.baseSku??variant.sku : variant.sku, '缺失型号标识使用本行销售 SKU');
  add('country_of_origin', 'CN', '普通商品原产国规则');
  if(target.marketplaceId==='ATVPDKIKX0DER'&&first('country_of_origin')?.value==='CN')add('import_designation','Imported','中国原产国在美国站对应进口商品；不沿用来源网站国内是否进口标签');
  const risk = declarationRisks(product,input.declarationScope??{variants:[variant],componentSpecifications:[]});
  if (p.ordinaryDeclarations) {
    add('gpsr_safety_attestation', true, '已确认的 GPSR 安全声明规则');
    // A chemical or certificate concern does not establish powered operation.
    if (!risk.battery) add('batteries_required', false, '普通无电池商品声明规则');
    else note('来源含电池、供电或电池声明冲突信息，未自动套用不需要电池的默认值');
    if (!risk.compliance) {
      add('supplier_declared_dg_hz_regulation', 'not_applicable', '普通商品危险品法规不适用规则');
      add('required_product_compliance_certificate', 'Not Applicable', '普通商品适用证书类别规则');
    } else note('来源含电池、特殊物品或合规冲突信息，未自动套用危险品／证书不适用声明');
  }

  // Parent schemas can require origin and declarations even though the parent
  // has no sale offer, condition, physical package or quantity of its own.
  if (schema.parentageLevel === 'PARENT') return { attributes, report };
  if(schema.productType==='KEYCHAIN'&&!attributes.size){
    const sourceSizes=new Set<string>();
    for(const spec of [variant.sourceSpec,variant.originalSpec]){
      for(const match of spec.matchAll(/(?:高度|尺寸|长度|宽度|height|length|width|size)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(厘米|毫米|英寸|cm\b|mm\b|inches?\b)/giu)){
        const value=Number(match[1]);if(value>0&&Number.isFinite(value))sourceSizes.add(`${value} ${/厘米|cm/iu.test(match[2])?'cm':/毫米|mm/iu.test(match[2])?'mm':'in'}`);
      }
    }
    const conflicting=product.facts.some(fact=>fact.state==='conflicting'&&/尺寸|高度|长度|宽度|size|height|length|width/iu.test(fact.name));
    if(sourceSizes.size===1&&!conflicting)add('size',[...sourceSizes][0],'当前 SKU 原始规格中明确的尺寸和单位');
  }
  add('condition_type', 'new_new', '新品规则');
  if (properties.list_price && !attributes.list_price) {
    const value = { value: p.listPrice, currency: 'USD' };
    if (!validateFieldValues(schema, target.marketplaceId, 'list_price', [value], attributes).length) add('list_price', value, '独立美元标价规则，与销售报价分开');
    else note('当前类目不接受已确认的美元标价，未套用标价规则');
  }

  // Recompute only unchanged rule fallback fields; fresh source values now take precedence.
  for (const [field, entry] of Object.entries(report.fields)) if (entry.reason.includes('业务默认') && /dimension|length|width|height|weight/.test(field)) {
    delete attributes[field]; delete report.fields[field];
  }
  const { measurements, blocked } = effectiveSourceMeasurements(product, input.measurements);
  // Capture source evidence before draft values or business fallbacks can overwrite it.
  const sourceMapped = mapMeasurementFields(schema, target.marketplaceId, measurements).attributes;
  const sourceBlocked = { ...blocked };
  // Only independently resolved source measurements may create actual fields.
  // A supplied partial object stays intact; schema validation owns missing siblings.
  for (const [field,value] of Object.entries(sourceMapped)) if (!Object.hasOwn(attributes,field)) {
    attributes[field] = value;
    report.fields[field] = {value:structuredClone(value),reason:'当前 SKU 来源参数与字段允许单位的换算规则'};
  }
  const packageInputs = (record: JsonObject): PricingPackageInputs => {
    const entry = (field: string) => Array.isArray(record[field]) && isObject(record[field][0]) ? record[field][0] : null;
    const converted = (value: JsonValue | undefined, kind: 'length' | 'weight'): number | null => {
      if (!isObject(value)) return null;
      const result = convertMeasurement(value.value, value.unit, kind);
      return result.status === 'mapped' ? result.value : null;
    };
    const dimensions = entry('item_package_dimensions');
    const axes = ['length','width','height'].map(axis => converted(dimensions?.[axis], 'length'));
    return { dimensionsInches: axes.every(value => value !== null) ? axes as [number,number,number] : null, weightPounds: converted(entry('item_package_weight') ?? undefined, 'weight') };
  };
  const sourcePackage = packageInputs(sourceMapped);
  const scopeFallback = new Set<string>();
  const scopeConflict = new Set<string>();
  for (const fact of product.facts) if (fact.state === 'conflicting' && /尺寸|长|宽|高|重量|weight|length|width|height|dimension/i.test(fact.name)) scopeConflict.add(/包装|package/i.test(fact.name) ? 'package' : 'item');
  // Editable values are estimator inputs, never affirmative fact authority.
  for (const field of [...DIMENSION_FIELDS, 'item_weight', 'item_package_weight']) {
    const current = first(field); if (!current) continue;
    const scope = field.startsWith('item_package_') ? 'package' : 'item', set = measurements[scope] ?? {};
    const copy = (axis: keyof MeasurementSet, value: JsonValue | undefined) => {
      if (!isObject(value)) return;
      const number = value.value ?? value.decimal_value;
      if (number === undefined) return;
      set[axis] = { value: number, ...(typeof value.unit === 'string' ? { unit: value.unit } : {}) };
      delete blocked[`${scope}.${axis}`];
    };
    for (const axis of ['length','width','height','depth','thickness'] as const) copy(axis, current[axis]);
    const scalar = /_(length|width|height|depth|thickness|weight)$/.exec(field)?.[1] as keyof MeasurementSet | undefined;
    if (scalar) copy(scalar, current);
    measurements[scope] = set;
  }
  for (const scope of ['item','package'] as const) {
    const set = measurements[scope] ?? {};
    for (const [index,axis] of (['length','width','height'] as const).entries()) {
      if (!set[axis] && p.dimensionFallback && !scopeConflict.has(scope) && !blocked[`${scope}.${axis}`]) { set[axis] = { value: p.dimensions[index], unit: p.dimensionUnit }; scopeFallback.add(scope); }
    }
    if (blocked[`${scope}.depth`] && !set.depth) set.depth = { value: null };
    if (scope === 'package' && !set.weight && p.weightFallback && !scopeConflict.has(scope) && !blocked['package.weight']) { set.weight = { value: p.packageWeight, unit: p.weightUnit }; scopeFallback.add('weight'); }
    measurements[scope] = set;
  }
  const mapped = mapMeasurementFields(schema, target.marketplaceId, measurements);
  for (const [field,value] of Object.entries(mapped.attributes)) {
    let combined = value;
    if (Object.hasOwn(attributes, field)) {
      if (!DIMENSION_FIELDS.includes(field as typeof DIMENSION_FIELDS[number]) || !Array.isArray(value) || value.length !== 1 || !isObject(value[0])
        || !Array.isArray(attributes[field]) || attributes[field].length !== 1 || !first(field)) continue;
      const merged = { ...value[0], ...first(field)! };
      if (validateFieldValues(schema, target.marketplaceId, field, [merged], attributes).length) continue;
      combined = [merged];
      if (JSON.stringify(combined) === JSON.stringify(attributes[field])) continue;
    }
    const scope = /package/.test(field) ? 'package' : 'item';
    const isDefault = field === 'item_package_weight' ? scopeFallback.has('weight') : scopeFallback.has(scope);
    attributes[field] = combined; report.fields[field] = { value: structuredClone(combined), reason: isDefault ? fallback : '当前 SKU 来源参数与字段允许单位的换算规则' };
  }

  for (const reason of Object.values(blocked)) note(`${reason}，未用业务默认掩盖`);
  if (scopeConflict.size) note('来源尺寸／重量存在冲突，未用业务默认掩盖冲突');
  if (scopeFallback.size) note('部分尺寸或包装重量使用已确认业务默认填报，不能作为图片实测依据');

  const itemCount = first('number_of_items')?.value;
  const existingCount = typeof itemCount === 'number' && Number.isSafeInteger(itemCount) && itemCount > 0 ? itemCount : null;
  const hasCount = Object.hasOwn(attributes, 'unit_count') || Object.hasOwn(attributes, 'number_of_items') || blocked.unitCount !== undefined || explicitFields.has('number_of_items');
  const sourceUnits = input.saleUnit ? sourceQuantity(`${input.saleUnit.totalPieces} pc`) : productSourceQuantity(product,variant);
  const quantityFacts = product.variants.length === 1 ? product.facts.filter(fact => sourceFieldName(fact.name, 'haul') === 'number_of_items'
    && ['source_confirmed','human_confirmed','conflicting'].includes(fact.state)) : [];
  const quantityFactValues = quantityFacts.map(fact => Object.hasOwn(properties, 'number_of_items')
    ? sourceFactValue(schema, 'number_of_items', fact.value.trim()) : fact.value.trim());
  // A blocked count cannot be promoted by the quantity parser's default 1 pc.
  // unit_count itself may describe another unit; compare piece counts only via number_of_items.
  const quantityUnconfirmed = sourceBlocked.unitCount !== undefined
    || Object.hasOwn(attributes, 'number_of_items') && (existingCount === null || !Array.isArray(attributes.number_of_items) || attributes.number_of_items.length !== 1)
    || quantityFacts.some(fact => fact.state === 'conflicting') || new Set(quantityFactValues.map(value => JSON.stringify(value))).size > 1
    || quantityFactValues.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    || input.saleUnit !== undefined && existingCount !== null && existingCount !== input.saleUnit.totalPieces;
  const hasPackClaim = sourceUnits.source === 'explicit' || /随机|咨询|补差/iu.test(variant.originalSpec);
  report.bundleQuantity = existingCount ?? (sourceUnits.conflict ? 1 : sourceUnits.piecesPerPack);
  const previousReport = input.previousBusinessReport, previousBasis = previousReport?.pricingBasis;
  const autoBasis = previousBasis?.kind === 'auto_bundle' ? previousBasis : null;
  const legacyCount = !previousBasis ? previousReport?.fields.number_of_items : undefined;
  const legacyUnitCount = !previousBasis ? previousReport?.fields.unit_count : undefined;
  const recordedCount = (entry: BusinessRuleReport['fields'][string] | undefined): number | null => {
    const value = entry && Array.isArray(entry.value) && entry.value.length === 1 && isObject(entry.value[0]) ? entry.value[0].value : null;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? value : null;
  };
  const legacyValue = recordedCount(legacyCount), legacyUnitValue = recordedCount(legacyUnitCount);
  // With no number_of_items property, the old generator could record only
  // unit_count. Its report bundle quantity distinguishes it from a mapped source count.
  const legacyQuantity = legacyValue !== null && legacyValue >= 2 ? legacyValue
    : !Object.hasOwn(properties, 'number_of_items') && legacyUnitValue !== null && legacyUnitValue >= 2 && previousReport?.bundleQuantity === legacyUnitValue ? legacyUnitValue : null;
  const legacyConflict = legacyQuantity !== null && (Boolean(legacyCount) && legacyValue !== legacyQuantity || Boolean(legacyUnitCount) && legacyUnitValue !== legacyQuantity);
  const autoQuantity = autoBasis?.quantity ?? legacyQuantity;
  // Retain automatic-bundle lineage through unsuccessful attempts. Otherwise
  // a later attempt could mistake generated counts for a supplier pack price.
  if (autoBasis) report.pricingBasis = structuredClone(autoBasis);
  // Older snapshots recorded the generated count itself. Preserve that evidence
  // until a valid source cost can upgrade it to an explicit pricing basis.
  if (legacyQuantity !== null) {
    if (legacyCount) report.fields.number_of_items = structuredClone(legacyCount);
    if (legacyUnitCount) report.fields.unit_count = structuredClone(legacyUnitCount);
  }
  const countChanged = autoQuantity !== null && ['number_of_items', 'unit_count'].some(field => Object.hasOwn(attributes, field) && first(field)?.value !== autoQuantity);
  if (autoQuantity !== null && !countChanged) report.bundleQuantity = autoQuantity;
  if (legacyQuantity !== null && (countChanged || legacyConflict)) report.bundleQuantity = legacyQuantity;
  const currentPackage = packageInputs(mapped.attributes);
  const packageAuthority=currentFactAuthority(product,schema,target,attributes,input.measurements);
  const packageBasis = (kind: 'dimensions' | 'weight'): PackageInputBasis => {
    const key = kind === 'dimensions' ? 'dimensionsInches' : 'weightPounds', value = currentPackage[key];
    const conflicts = product.facts.some(fact => fact.state === 'conflicting' && /包装|package/i.test(fact.name)
      && (kind === 'weight' ? /重量|weight/i : /尺寸|长|宽|高|深|length|width|height|depth|dimension/i).test(fact.name));
    if (conflicts) return 'conflicting';
    if (value === null) return 'missing';
    const blockedSource = Object.keys(sourceBlocked).some(name => name.startsWith('package.') && (kind === 'weight' ? name === 'package.weight' : name !== 'package.weight'));
    if (!blockedSource && packageAuthority.fields.get(kind==='dimensions'?'item_package_dimensions':'item_package_weight')?.supported
      && sourcePackage[key] !== null && JSON.stringify(sourcePackage[key]) === JSON.stringify(value)) return 'confirmed_source';
    const previous = previousReport?.pricingDecision;
    const inheritedDefault = previous !== undefined && previous.evidence?.[kind] === 'business_default'
      && JSON.stringify(previous.inputs?.[key]) === JSON.stringify(value);
    if (scopeFallback.has(kind === 'weight' ? 'weight' : 'package') || inheritedDefault) return 'business_default';
    return 'unverified';
  };
  const costCny = input.costCny !== null && Number.isFinite(input.costCny) && input.costCny > 0 ? input.costCny : null;
  const decision: PricingDecision = {
    version: 2, attributeInputs: pricingAttributeInputs(attributes), status: 'needs_input', code: 'COST_CNY_UNCONFIRMED', quoteError: null,
    inputs: { costCny, ...currentPackage },
    evidence: { cost: costCny !== null ? 'confirmed_cny' : 'unconfirmed', dimensions: packageBasis('dimensions'), weight: packageBasis('weight'),
      packageScope: 'unconfirmed', saleUnit: legacyConflict ? 'conflicting' : countChanged ? 'unconfirmed' : sourceUnits.conflict ? 'conflicting' : quantityUnconfirmed ? 'unconfirmed' : 'confirmed', sourcePackage },
  };
  report.pricingDecision = decision;
  const needInput = (code: PricingDecisionCode, message: string) => { decision.code = code; decision.status = 'needs_input'; note(message); };
  if (costCny === null) needInput('COST_CNY_UNCONFIRMED', '采购成本或人民币币种尚未确认，未计算销售报价');
  else if (target.marketplaceId !== 'ATVPDKIKX0DER') needInput('MARKETPLACE_UNSUPPORTED', '定价规则以美元计价，仅用于已确认的美国站');
  else {
    const axes = currentPackage.dimensionsInches, pounds = currentPackage.weightPounds;
    if (axes === null || pounds === null) needInput('PACKAGE_MEASUREMENTS_MISSING', '缺少可用的完整包装尺寸／重量，未计算销售报价');
    else {
      // A selected pack quote already includes its pieces; explicit per-piece quotes do not.
      if (autoQuantity === null && !previousBasis && !hasCount && !hasPackClaim) report.bundleQuantity = bundleQuantity(costCny, product.variants.length, rules.pricing);
      const automaticBundle = autoQuantity !== null || !previousBasis && !hasCount && !hasPackClaim && report.bundleQuantity > 1;
      decision.evidence.packageScope = !automaticBundle && !quantityUnconfirmed && input.packageMatchesSaleUnit !== false
        && (input.saleUnit ? input.packageMatchesSaleUnit === true : report.bundleQuantity === sourceUnits.piecesPerPack) ? 'source_sale_unit' : 'unconfirmed';
      try {
        const quantityFailure = legacyConflict ? ['LEGACY_QUANTITY_CONFLICT', '旧组套记录的生成件数存在冲突，请先核实每个销售单元的采购成本'] as const
          : countChanged ? ['SALE_QUANTITY_CHANGED', '自动组套件数已变更，请先重新核实每个销售单元的采购成本；未沿用单件成本报价'] as const
          : sourceUnits.conflict ? ['SOURCE_QUANTITY_CONFLICT', '当前规格包含互相冲突的件数或计价口径，无法计算该销售单元成本'] as const : null;
        if (quantityFailure) { needInput(quantityFailure[0], quantityFailure[1]); }
        else {
        const quantity = automaticBundle ? report.bundleQuantity : sourceUnits.quoteBasis === 'piece' && sourceUnits.source === 'explicit' ? report.bundleQuantity : previousBasis?.quantity ?? 1;
        report.pricingBasis = { kind: automaticBundle ? 'auto_bundle' : quantity>1 ? 'source_piece_quote' : 'source_sale_unit', sourceCostCny: costCny, quantity, saleUnitCostCny: costCny * quantity };
        decision.inputs.costCny = report.pricingBasis.saleUnitCostCny;
        report.quote = quoteListing({ costCny: report.pricingBasis.saleUnitCostCny, dimensionsInches: axes, weightPounds: pounds }, rules.pricing);
        decision.status = 'quoted'; decision.code = 'QUOTE_VALID';
        const existing = first('purchasable_offer');
        if (!existing?.our_price) {
          if (attributes.purchasable_offer && (!Array.isArray(attributes.purchasable_offer) || attributes.purchasable_offer.length !== 1 || !existing)) {
            throw new Error('已有报价结构需要人工核对，未用单条自动报价覆盖');
          }
          const quote = report.quote, schedule = promotionSchedule(input.now, rules.pricing);
          const offer: JsonObject = { audience: 'BZR', currency: 'USD', ...existing, our_price: [{ schedule: [{ value_with_tax: quote.price }] }] };
          const offerItem = resolveSchemaNode(schema.schema, resolveSchemaNode(schema.schema, properties.purchasable_offer).items);
          const addPromotion = !existing?.discounted_price && quote.promotionPrice !== null && isObject(offerItem.properties) && Boolean(offerItem.properties.discounted_price);
          if (addPromotion) offer.discounted_price = [{ schedule: [{ value_with_tax: quote.promotionPrice!, start_at: schedule.start, end_at: schedule.end }] }];
          if (addPromotion && validateFieldValues(schema, target.marketplaceId, 'purchasable_offer', [offer], attributes).length) {
            const base = { ...offer }; delete base.discounted_price;
            if (!validateFieldValues(schema, target.marketplaceId, 'purchasable_offer', [base], attributes).length) {
              delete offer.discounted_price; note('当前类目不接受 BZR 促销价格结构，已保留正常报价；促销设置仍保存');
            }
          }
          add('purchasable_offer', offer, '按人民币采购成本、包装参数与已保存费表计算；促销单独校验 ROI', true);
        }
        }
      } catch (error) {
        // A later offer-application problem does not invalidate a successfully calculated quote.
        if (report.quote === null) {
          if (error instanceof ListingQuoteError) {
            decision.quoteError = error.code;
            if (error.code === 'QUOTE_INVALID_INPUT') { decision.status = 'needs_input'; decision.code = error.code; }
            else if (quantityUnconfirmed) { decision.status = 'needs_input'; decision.code = 'SOURCE_QUANTITY_UNCONFIRMED'; }
            else if (decision.evidence.packageScope !== 'source_sale_unit') { decision.status = 'needs_input'; decision.code = 'PACKAGE_SCOPE_UNCONFIRMED'; }
            else if (!['confirmed_source','business_default'].includes(decision.evidence.dimensions) || !['confirmed_source','business_default'].includes(decision.evidence.weight)) { decision.status = 'needs_input'; decision.code = 'PACKAGE_INPUT_UNCONFIRMED'; }
            else { decision.status = 'business_blocked'; decision.code = error.code; }
          } else { decision.status = 'system_error'; decision.code = 'PRICING_SYSTEM_ERROR'; }
        }
        note(error instanceof Error ? error.message : '定价规则未得到可用报价');
      }
    }
  }
  const count = report.bundleQuantity;
  if (!sourceUnits.conflict && !blocked.unitCount && !attributes.unit_count) add('number_of_items', count, sourceUnits.source === 'explicit' ? `当前来源规格件数：${sourceUnits.evidence}` : count > 1 ? '按已确认组套规则计算的每套件数' : '未注明数量，默认 1 件 / 1 pc');
  const unitCount = mapMeasurementFields(schema, target.marketplaceId, { unitCount: count }).attributes.unit_count;
  const canFillUnitCount = !sourceUnits.conflict && !blocked.unitCount && (!explicitFields.has('number_of_items') || existingCount !== null);
  if (unitCount && !attributes.unit_count && canFillUnitCount) { attributes.unit_count = unitCount; report.fields.unit_count = { value: structuredClone(unitCount), reason: '售卖单位数量规则；不等于备货套数' }; }
  return { attributes, report };
}

export function ruleSourceMapping(mapping: SourceFieldMapping[], report: BusinessRuleReport | undefined, attributes: JsonObject): SourceFieldMapping[] {
  if (!report) return mapping;
  return mapping.map(entry => {
    // Current component authority wins over every historical rule label, including receipts without fact IDs.
    if (entry.status === 'conflicting' || entry.status === 'mapped' && entry.sourceFactIds.length) return entry;
    const rule = report.fields[entry.field];
    return rule && isDeepStrictEqual(rule.value, attributes[entry.field]) ? { ...entry, status: 'mapped', sourceFactIds: [], reason: `业务规则 v${report.revision}：${rule.reason}` } : entry;
  });
}
