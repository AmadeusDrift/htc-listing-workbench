// Frozen pre-contract evidence rules. History only; do not redirect these imports to current parsers.
import { createHash } from 'node:crypto';
import { LISTING_CANDIDATE_FIELDS, INFERABLE_CATEGORY_FIELDS, CATEGORY_ATTRIBUTE_FIELDS, LISTING_BOOLEAN_FIELDS, CATEGORY_INFERENCE_POLICY_VERSION } from '../../shared/listing-ai-contracts.ts';
import type { CandidateField, ListingAiContext, ListingClaim, ListingEvidence, ListingFieldsOutput, ListingFieldsReviewOutput, ListingFieldCandidate } from '../../shared/listing-ai-contracts.ts';
import { AiError } from '../ai/errors.ts';
import { hasSemanticEvidence, translatedFabricEvidence } from './evidence-semantic-v0.ts';
import { supportsColorClaims } from './evidence-colors-v0.ts';
import { validateSourceColorContext, validateSourceColorOutput } from '../ai/source-color-validation.ts';
import { categoryAttributeField, categoryAttributeValues, categoryAttributeSourceOptions } from './evidence-category-v0.ts';

export const CATEGORY_ATTRIBUTE_INFERENCE_RULES = `For these ordinary product-judgment attributes ONLY: ${INFERABLE_CATEGORY_FIELDS.join(', ')}, use explicit source/SKU facts first. A selected SKU specifying children, hard bristles or medium bristles overrides a product-wide Adult or Soft label, including in titles and bullets. When the exact attribute is not stated, make a reasoned product judgment from the supplied productType, actual category, material and selected SKU evidence using transformation="infer" and a nonempty inferenceReason explaining the basis; cite the real supporting evidence IDs. This is model inference, never a source-confirmed or human-confirmed fact. Do not ask the user to decide these ordinary category attributes one by one. ${LISTING_BOOLEAN_FIELDS.join(', ')} require true/false (native JSON booleans or strings). Ingredients are source extraction/translation ONLY: cite actual ingredient facts, preserve their meaning and do not invent chemical components or concentrations. Expiration-dated status is not a shelf-life duration; never invent dates, months, temperatures or measured performance. A cleaner's usage duration is not a shelf life, and a number without a unit is not volume. Never extend this permission to battery/dangerous-goods declarations, certification, medical/food safety, antibacterial/BPA-free claims, brand, measurements, prices or quantity. A schema enum restricts values but is not evidence; obey its exact allowed values. If the supplied data is contradictory or does not establish the product, report that specific limitation instead of an arbitrary default.`;

/** Only locally authored reasons are retained; never expose a provider exception. */
export class ListingValidationError extends AiError {
  readonly validationReason:string;
  constructor(reason:string){super('OUTPUT_INVALID');this.validationReason=reason;}
}
const fail = (reason='字段结构、字段名或条目格式不符合要求'): never => { throw new ListingValidationError(reason); };
function text(v:unknown,max=2000):string{
  if(typeof v!=='string'||!v.trim())return fail('字段文本不能为空');
  if(v.length>max)fail('字段文本长度超出上限');
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))fail('字段文本包含不支持的控制字符');
  return v;
}
function object(v: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
  const o = v as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => ![...required, ...optional].includes(k))) return fail();
  return o;
}
function array<T>(v: unknown, max: number, parse: (v: unknown) => T): T[] { return Array.isArray(v) && v.length <= max ? v.map(parse) : fail(); }
function field(v: unknown): CandidateField { return LISTING_CANDIDATE_FIELDS.includes(v as CandidateField) ? v as CandidateField : fail(); }
function ids(v: unknown): string[] { const a = array(v, 30, v => text(v, 150)); return new Set(a).size === a.length ? a : fail(); }
const supported = (v: unknown): ListingClaim['verdict'] => ['SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED'].includes(String(v)) ? v as ListingClaim['verdict'] : fail();
export const listingFingerprint = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validateListingFieldsOutput(raw: unknown): ListingFieldsOutput {
  const o = object(raw, ['kind', 'candidates', 'missing']); if (o.kind !== 'amazon-fields') fail();
  const candidates = array(o.candidates, LISTING_CANDIDATE_FIELDS.length, raw => {
    const c = object(raw, ['field', 'items']), name = field(c.field);
    const items = array(c.items, name === 'bullet_point' ? 5 : 1, raw => {
      const i = object(raw, ['value', 'evidenceIds', 'transformation'],['inferenceReason']);
      const boolean=(LISTING_BOOLEAN_FIELDS as readonly string[]).includes(name);
      const value = text(boolean&&typeof i.value==='boolean'?String(i.value):i.value, name === 'item_name' ? 75 : name === 'generic_keyword' ? 200 : 500);
      if(boolean&&!['true','false'].includes(value))fail('此属性必须为 true 或 false');
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}]/u.test(value)) fail('字段值必须使用美国站英文');
      if(name==='generic_keyword'&&Buffer.byteLength(value)>200)fail('搜索关键词的 UTF-8 字节长度超出上限');
      if (!['copy', 'translate', 'compose', 'enum_map','infer'].includes(String(i.transformation))) fail();
      const inferred=i.transformation==='infer';
      if(inferred&&!(INFERABLE_CATEGORY_FIELDS as readonly string[]).includes(name))fail('此字段不允许产品常识推断');
      if(inferred)text(i.inferenceReason,2000);else if(i.inferenceReason!==undefined)fail('仅推断候选可以携带推断理由');
      const evidenceIds = ids(i.evidenceIds); if (!evidenceIds.length) fail('候选缺少来源依据引用');
      return { value, evidenceIds, transformation: i.transformation as ListingFieldCandidate['items'][number]['transformation'],...(inferred?{inferenceReason:String(i.inferenceReason)}:{}) };
    });
    if(items.length!==(name==='bullet_point'?5:1))fail('字段条目数量不符合要求：要点需五条，其他字段需一条');
    if(new Set(items.map(i=>i.value.toLowerCase().trim())).size!==items.length)fail('字段包含重复条目');
    return { field: name, items };
  });
  const missing = array(o.missing, LISTING_CANDIDATE_FIELDS.length, raw => { const m = object(raw, ['field', 'reason']); return { field: field(m.field), reason: text(m.reason) }; });
  const fields = [...candidates.map(c => c.field), ...missing.map(m => m.field)];
  if (new Set(fields).size !== fields.length || fields.length === 0) fail();
  return { kind: 'amazon-fields', candidates, missing };
}
const TRANSLATIONS: Record<string, string[]> = {
  'Mixed colors': ['mixed colors','mixed colours','multicolor','multi-color','multicolored'],
  '硅胶': ['silicone'], '棉': ['cotton'], '棉质': ['cotton'], '聚酯纤维': ['polyester'], '塑料': ['plastic'], '不锈钢': ['stainless steel'],
  '蓝': ['blue'], '蓝色': ['blue'], '绿': ['green'], '绿色': ['green'], '灰': ['gray', 'grey'], '灰色': ['gray', 'grey'], '白色': ['white'], '黑色': ['black'], '红色': ['red'], '粉色': ['pink'], '米色': ['beige'], '棕色': ['brown'],
  '方形': ['square'], '正方形': ['square'], '圆形': ['round'], '长方形': ['rectangular', 'rectangle'],
  '灰绿': ['gray green', 'grey green', 'gray-green', 'grey-green'], '砖红': ['brick red', 'brick-red'], '鼠尾草绿': ['sage green'], '米白': ['off white', 'off-white'], '雾蓝': ['dusty blue'],
  '粉红色': ['pink'], '橘色': ['orange'], '橙色': ['orange'], '黄色': ['yellow'], '紫色': ['purple'],
};
type EvidenceContext = Pick<ListingAiContext, 'evidence'> & Partial<Pick<ListingAiContext, 'variantId'|'productType'|'categoryInferencePolicyVersion'>>;
interface EvidenceValidationOptions { historical?:boolean }
function legacyCategoryHistory(output:ListingFieldsOutput,context:Pick<ListingAiContext,'fields'>&EvidenceContext,options:EvidenceValidationOptions):boolean{
  return options.historical===true&&context.categoryInferencePolicyVersion===undefined
    &&context.fields.every(card=>!(CATEGORY_ATTRIBUTE_FIELDS as readonly string[]).includes(card.name))
    &&output.candidates.every(candidate=>!(CATEGORY_ATTRIBUTE_FIELDS as readonly string[]).includes(candidate.field)&&candidate.items.every(item=>item.transformation!=='infer'&&item.inferenceReason===undefined))
    &&!context.evidence.some(e=>e.source==='selected_sku'&&(CATEGORY_ATTRIBUTE_FIELDS as readonly string[]).some(field=>e.id.endsWith(`:${field}`)));
}
function evidenceFor(context: EvidenceContext, evidenceIds: string[]): ListingEvidence[] {
  return evidenceIds.map(id => {
    const evidence=context.evidence.find(e => e.id === id) ?? fail('引用的来源依据不存在于当前资料');
    if(context.variantId&&['selected_sku','source_image'].includes(evidence.source)&&!evidence.id.startsWith(`${context.variantId}:`))fail('引用属于其他 SKU，不能用于当前商品规格');
    return evidence;
  });
}
function categorySources(name:string,evidence:ListingEvidence[]):ListingEvidence[]{
  const direct=evidence.filter(e=>categoryAttributeField(e.name,e.value)===name);
  const selected=direct.filter(e=>e.source==='selected_sku');
  if(selected.length)return selected;
  const specs=['age_range_description','item_firmness_description','power_source_type'].includes(name)?evidence.filter(e=>e.source==='selected_sku'&&e.name==='Selected SKU specification'&&categoryAttributeValues(name,e.value).length):[];
  return specs.length?specs:direct;
}
function assertCategoryEvidence(name:CandidateField,value:string,evidence:ListingEvidence[],scope:ListingEvidence[],productType?:string,item?:ListingFieldCandidate['items'][number]):void{
  const sources=categorySources(name,scope),actual=categoryAttributeValues(name,value);
  if(sources.length){
    const normalize=(text:string)=>name==='ingredients'?text.toLowerCase().split(/\s*\+\s*/).sort().join('+'):text.toLowerCase();
    const expected=[...new Set(sources.flatMap(e=>categoryAttributeValues(name,e.value)).map(normalize))];
    const supported=expected.flatMap(value=>categoryAttributeSourceOptions(name,value)).map(normalize);
    if(expected.length>1||expected.length&&(!actual.length||actual.some(entry=>!supported.includes(normalize(entry)))))fail('分类属性与所选 SKU 或明确来源属性冲突');
    if(!evidence.some(e=>sources.some(source=>source.id===e.id)))fail('分类属性需要引用其明确的 SKU 或来源属性');
    return;
  }
  if(name==='ingredients')fail('成分需要明确来源成分依据，不能根据商品类别推断化学配方');
  if(item?.transformation!=='infer'||!item.inferenceReason?.trim())fail('分类属性缺少明确来源；产品判断须标明 infer 和理由');
  const relevant=evidence.some(e=>e.source!=='source_image'&&(e.source==='selected_sku'&&e.meaning==='general'||e.meaning==='material'
    ||/^(?:产品类别|产品类型|商品类型|类别|材质|材料|category|product[ _-]?type|material)$/iu.test(e.name)));
  if(!relevant||!productType&&!evidence.some(e=>/类别|类型|category|product[ _-]?type/iu.test(e.name)))fail('产品判断缺少实际商品类别、材质或所选 SKU 依据');
}
/** Exact SKU claims can also repair stale copy without a paid model review. */
export function selectedSkuCategoryConflicts(value:string,evidence:ListingEvidence[],candidateField?:CandidateField):{field:string;expected:string[];actual:string[]}[]{
  const conflicts:{field:string;expected:string[];actual:string[]}[]=[];
  for(const field of ['age_range_description','item_firmness_description','power_source_type']){
    if(field==='item_firmness_description'&&candidateField!==field&&!/\b(?:soft|medium|hard|firm)(?:[- ](?:bristles?|bristled|toothbrush))\b/iu.test(value))continue;
    const sources=categorySources(field,evidence).filter(e=>field==='power_source_type'||e.source==='selected_sku');
    const expected=[...new Set(sources.flatMap(e=>categoryAttributeValues(field,e.value)))],claims=categoryAttributeValues(field,value);
    if(expected.length&&claims.some(claim=>!expected.includes(claim)))conflicts.push({field,expected,actual:claims});
  }
  return conflicts;
}
function assertTypedEvidence(name: CandidateField, value: string, evidence: ListingEvidence[], scope:ListingEvidence[],variantId?:string,productType?:string,item?:ListingFieldCandidate['items'][number],enforceCategoryConsistency=true): void {
  const category=(CATEGORY_ATTRIBUTE_FIELDS as readonly string[]).includes(name);
  // A review may split a single typed value into substring claims. Its complete
  // value still has to match the source; each substring keeps its own real IDs.
  if(category)assertCategoryEvidence(name,item?.value??value,evidence,scope,productType,item);
  if(enforceCategoryConsistency&&selectedSkuCategoryConflicts(value,scope,name).length)fail('文案或属性与所选 SKU 的明确年龄、刷毛硬度或动力来源冲突');
  const semanticSupported=category||name==='target_audience'&&categorySources('age_range_description',evidence).some(e=>e.source==='selected_sku'&&categoryAttributeValues('age_range_description',e.value).some(v=>categoryAttributeValues('age_range_description',value).includes(v)))||hasSemanticEvidence(name,value,evidence,{scope,productType});
  if(name==='blade'&&!semanticSupported)fail('刀刃材质缺少匹配依据；金属指甲刀可凭材质和产品类别两项来源填 Metal，具体钢种仍需明确依据');
  if(name==='target_audience'&&!semanticSupported)fail('适用人群缺少明确来源依据；通用人群不能推定具体年龄');
  if (!semanticSupported) fail('主题、角色、面料、功能或配件描述缺少对应类型的来源依据');
  if (['material', 'item_shape', 'care_instructions'].includes(name)) {
    if (!evidence.length || evidence.some(e => e.meaning !== name)) fail('材质、形状或护理字段引用的依据类型不匹配');
    const known = evidence.flatMap(e => TRANSLATIONS[e.value.trim()] ?? (/^[A-Za-z -]+$/.test(e.value) ? [e.value.toLowerCase()] : []));
    if (known.length && !known.some(v => value.toLowerCase() === v)) fail('材质、形状或护理字段的翻译与来源不一致');
  }
  // Enforce common, objectively checkable claims even when they occur inside prose.
  const translated = (e: ListingEvidence): string[] => TRANSLATIONS[e.value.trim()] ?? [e.meaning==='material'?translatedFabricEvidence(e.value):e.value.toLowerCase()];
  const normalized = value.toLowerCase().replaceAll('-', ' ');
  if(!['flavor','scent','ingredients'].includes(name)&&!supportsColorClaims(value,evidence,name==='color',scope,variantId))fail('颜色或渐变、单色描述缺少当前 SKU 的匹配来源依据');
  for (const material of normalized.match(/\b(?:silicone|cotton|polyester|plastic|stainless steel)\b/g) ?? []) {
    if (!(name==='blade'&&semanticSupported)&&!evidence.some(e => e.meaning === 'material' && translated(e).some(v => v.includes(material)))) fail('文案中的材质缺少匹配来源依据');
  }
  const quantity = value.match(/\b(?:set|pack)\s+of\s+(\d+)|\b(\d+)\s*[- ]?(?:pieces?|pcs|pack|count)\b/i);
  if (quantity) {
    const count = quantity[1] ?? quantity[2];
    if (!evidence.some(e => e.meaning === 'general' && ((/^(?:商品数量|数量|件数|售卖件数|numberofitems|quantity|unitcount)$/i.test(e.name.replace(/[\s_-]/g,'')) && e.value.trim() === count) || new RegExp(`(?:\\b${count}\\s*(?:pieces?|pcs|pack|count|件|个)|(?:数量|件数)[：:]?\\s*${count}(?!\\d)|(?:set|pack)\\s+of\\s+${count}(?!\\d))`, 'i').test(e.name + ':' + e.value)))) fail();
  }
  // Certifications stay manual; each other special assertion needs its own positive source.
  if (/\b(?:fda|certifi\w*|bpa|antibacter\w*|non[ -]?toxic|food[ -]?safe|organic)\b/i.test(value)) fail();
  if (/\b(?:guaranteed|unbreakable|indestructible|risk[ -]?free|best in the world)\b/i.test(value)) fail();
  const measure = /(?<![\d.+-])([+-]?\d+(?:\.\d+)?)\s*((?:degrees?\s*|°\s*)[cf]|fahrenheit|celsius|inches|inch|pounds|pound|grams|gram|hours?|minutes?|cm|mm|kg|lbs?|oz|ml|liters?|mah|watts?|volts?|g|厘米|毫米|英寸|公斤|千克|克|磅|毫升|摄氏度|华氏度)(?![A-Za-z])/gi;
  const canonicalUnit = (unit: string) => {
    const normalized = unit.toLowerCase().replace(/\s/g,'');
    if (/^(?:degrees?|°)f$|^fahrenheit$|^华氏度$/.test(normalized)) return 'fahrenheit';
    if (/^(?:degrees?|°)c$|^celsius$|^摄氏度$/.test(normalized)) return 'celsius';
    return ({inch:'inches',英寸:'inches',pound:'pounds',lb:'pounds',lbs:'pounds',磅:'pounds',grams:'g',gram:'g',克:'g',厘米:'cm',毫米:'mm',公斤:'kg',千克:'kg',毫升:'ml',hour:'hours',minute:'minutes',liter:'liters',watt:'watts',volt:'volts'} as Record<string,string>)[normalized] ?? normalized;
  };
  const sources = evidence.flatMap(e => [...e.value.matchAll(measure)].map(match => `${Number(match[1])}:${canonicalUnit(match[2])}`));
  for (const claim of value.matchAll(measure)) if (!sources.includes(`${Number(claim[1])}:${canonicalUnit(claim[2])}`)) fail('尺寸、重量或其他数值缺少匹配的来源数值和单位');
  const normalizeModel = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
  for (const claim of value.matchAll(/(compatible with|for use with|fits model)\s+([^,;.\n]+)/gi)) {
    if (claim[1].toLowerCase() === 'for use with' && !/\d/.test(claim[2])) continue;
    const model = normalizeModel(claim[2]);
    if (!model || !evidence.some(e => !/不|禁止|\b(?:not|no|never|incompatible)\b/i.test(e.value) && e.value.split(/[,;，；、/|\n]+/).some(entry => normalizeModel(entry.trim().replace(/^(?:(?:compatible with|for use with|fits model|model)\s*:?\s*|(?:兼容|适用(?:于|型号)?)[：:]?\s*)/i,'')) === model))) fail();
  }
  const claims: [RegExp,RegExp][] = [
    [/dishwasher/i,/dishwasher|洗碗机/i], [/heat[ -]?resistan/i,/heat[ -]?resistan|耐热/i],
    [/waterproof/i,/waterproof|防水/i], [/100\s*%|pure cotton/i,/100\s*%|纯棉/i], [/individually wrapped/i,/individually wrapped|独立包装/i],
  ];
  for (const [claim,source] of claims) if (claim.test(value)) {
    const negative = (v: string) => /不|禁止|并非|非纯|^(?:否|0)$|\b(?:no|not|never|false|avoid|unsafe|unsuitable)\b/i.test(v.trim());
    const outputParts = value.split(/[，,;；。]/).filter(part=>claim.test(part));
    const sourceParts = evidence.flatMap(e=>e.value.split(/[，,;；。]/).filter(part=>source.test(part) || source.test(e.name)));
    if (!sourceParts.length || outputParts.some(part=>sourceParts.some(sourcePart=>negative(sourcePart)!==negative(part)))) fail();
  }
}
export function assertListingEvidence(output: ListingFieldsOutput, context: Pick<ListingAiContext, 'fields'> & EvidenceContext,options:EvidenceValidationOptions={}): void {
  const enforceCategoryConsistency=!legacyCategoryHistory(output,context,options);
  for (const c of output.candidates) {
    const card=context.fields.find(f=>f.name===c.field)??fail();
    if(card.closedEnum&&c.items.some(item=>!card.allowedValues.some(option=>option===item.value||typeof option==='boolean'&&(LISTING_BOOLEAN_FIELDS as readonly string[]).includes(c.field)&&String(option)===item.value)))fail('字段值不在当前类目允许的枚举选项中');
    const aggregate=context.evidence.find(e=>e.meaning==='color'&&e.id.endsWith(':sale-color')&&e.value==='Mixed colors');
    if(c.field==='color'&&aggregate&&c.items.some(i=>!i.evidenceIds.includes(aggregate.id)||!TRANSLATIONS['Mixed colors'].includes(i.value.toLowerCase())))fail();
    for (const i of c.items) assertTypedEvidence(c.field, i.value, evidenceFor(context, i.evidenceIds),context.evidence,context.variantId,context.productType,i,enforceCategoryConsistency);
  }
  if (output.missing.some(m => !context.fields.some(f => f.name === m.field))) fail();
}
export function validateListingReviewOutput(raw: unknown): ListingFieldsReviewOutput {
  const o = object(raw, ['kind', 'verdict', 'checks', 'issues']);
  if (o.kind !== 'amazon-fields-review' || !['PASS', 'NEEDS_CHANGES', 'BLOCKED'].includes(String(o.verdict))) fail();
  const checks = array(o.checks, LISTING_CANDIDATE_FIELDS.length + 4, raw => {
    const c = object(raw, ['field', 'index', 'verdict', 'evidenceIds', 'reason', 'claims']);
    if (!Number.isInteger(c.index) || Number(c.index) < 0 || Number(c.index) > 4) fail();
    const claims = array(c.claims, 12, raw => { const v = object(raw, ['text', 'verdict', 'evidenceIds', 'reason']); return { text: text(v.text, 500), verdict: supported(v.verdict), evidenceIds: ids(v.evidenceIds), reason: text(v.reason) }; });
    if (!claims.length) fail();
    return { field: field(c.field), index: c.index as number, verdict: supported(c.verdict), evidenceIds: ids(c.evidenceIds), reason: text(c.reason), claims };
  });
  if (new Set(checks.map(c => `${c.field}.${c.index}`)).size !== checks.length) fail();
  const issues = array(o.issues, 30, raw => { const i = object(raw, ['field', 'message']); return { field: field(i.field), message: text(i.message) }; });
  if (o.verdict === 'PASS' ? issues.length || checks.some(c => c.verdict !== 'SUPPORTED' || !c.evidenceIds.length || c.claims.some(v => v.verdict !== 'SUPPORTED' || !v.evidenceIds.length)) : !issues.length) fail();
  return { kind: 'amazon-fields-review', verdict: o.verdict as ListingFieldsReviewOutput['verdict'], checks, issues };
}
export function assertListingReview(review: ListingFieldsReviewOutput, candidate: ListingFieldsOutput, context: Pick<ListingAiContext, 'fields'> & EvidenceContext,options:EvidenceValidationOptions={}): void {
  assertListingEvidence(candidate, context,options);
  const enforceCategoryConsistency=!legacyCategoryHistory(candidate,context,options);
  if (review.checks.length !== candidate.candidates.reduce((n, c) => n + c.items.length, 0)) fail();
  for (const c of candidate.candidates) for (const [index, item] of c.items.entries()) {
    const check = review.checks.find(check => check.field === c.field && check.index === index) ?? fail();
    const evidence = evidenceFor(context, check.evidenceIds);
    if (check.verdict === 'SUPPORTED') assertTypedEvidence(c.field, item.value, evidence,context.evidence,context.variantId,context.productType,item,enforceCategoryConsistency);
    for (const claim of check.claims) {
      if (!item.value.includes(claim.text)) fail();
      const claimEvidence = evidenceFor(context, claim.evidenceIds);
      if (claim.verdict === 'SUPPORTED') assertTypedEvidence(c.field, claim.text, claimEvidence,context.evidence,context.variantId,context.productType,item,enforceCategoryConsistency);
    }
    // A reviewer may split an item into claims, but cannot silently skip its other assertions.
    const covered = new Array<boolean>(item.value.length).fill(false);
    for (const claim of check.claims) for (let at = item.value.indexOf(claim.text); at >= 0; at = item.value.indexOf(claim.text, at + 1)) covered.fill(true, at, at + claim.text.length);
    const uncovered = item.value.split('').map((char,index)=>covered[index]?' ':char).join('');
    if (/[\p{L}\p{N}]/u.test(uncovered.replace(/\b(?:a|an|the|and|or|of|for|in|with|to|on|at|is|are)\b/gi, ''))) fail();
  }
}

/** Strict bounded history validation; no provider input can set this metadata. */
export function validateListingContext(raw: unknown): ListingAiContext {
  const o = object(raw, ['draftId','draftRevision','productId','productRevision','variantId','sku','targetId','targetGeneration','listingProgram','productType','marketplaceId','locale','requirements','parentageLevel','schemaChecksum','schemaVersion','schemaSha256','policyVersion','fields','evidence','unverifiedSourceTitle'], ['repairRequest','categoryInferencePolicyVersion']);
  if(o.categoryInferencePolicyVersion!==undefined&&o.categoryInferencePolicyVersion!==CATEGORY_INFERENCE_POLICY_VERSION)fail('分类推断策略版本不支持');
  for (const k of ['draftId','productId','variantId','targetId']) if (!/^[0-9a-f-]{36}$/i.test(text(o[k], 36))) fail();
  for (const k of ['draftRevision','productRevision','targetGeneration']) if (!Number.isSafeInteger(o[k]) || Number(o[k]) < (k === 'targetGeneration' ? 0 : 1)) fail();
  for (const k of ['sku','productType','marketplaceId','locale','schemaChecksum','schemaVersion','policyVersion']) text(o[k], 200);
  if (!['haul','standard'].includes(String(o.listingProgram)) || !['NONE','PARENT','CHILD'].includes(String(o.parentageLevel)) || !['LISTING','LISTING_PRODUCT_ONLY','LISTING_OFFER_ONLY'].includes(String(o.requirements)) || !/^[a-f0-9]{64}$/.test(String(o.schemaSha256))) fail();
  if (typeof o.unverifiedSourceTitle !== 'string' || o.unverifiedSourceTitle.length > 500) fail();
  const fields = array(o.fields, LISTING_CANDIDATE_FIELDS.length, raw => {
    const c = object(raw, ['name','title','requirement','closedEnum','allowedValues','suggestedValues'], ['description','minLength','maxLength','minUtf8ByteLength','maxUtf8ByteLength','minItems','maxItems']);
    field(c.name); text(c.title, 500);
    if (c.description !== undefined) text(c.description, 2000);
    if (!['required','conditional','optional'].includes(String(c.requirement)) || typeof c.closedEnum !== 'boolean') fail();
    for (const k of ['allowedValues','suggestedValues']) array(c[k], 2000, v => { if (!['string','boolean','number'].includes(typeof v) || String(v).length > 2000) fail(); return v; });
    for (const k of ['minLength','maxLength','minUtf8ByteLength','maxUtf8ByteLength','minItems','maxItems']) if (c[k] !== undefined && (!Number.isSafeInteger(c[k]) || Number(c[k]) < 0)) fail();
    return c;
  });
  const evidence = array(o.evidence, 200, raw => {
    const e = object(raw, ['id','name','value','meaning','source'],['imageObservation']); text(e.id,150);text(e.name,100);text(e.value,4000);
    if(!['general','material','color','item_shape','care_instructions'].includes(String(e.meaning)) || !['source_confirmed','human_confirmed','selected_sku','source_image'].includes(String(e.source)))fail();
    if(e.source==='source_image'){
      const proof=object(e.imageObservation,['resultId','context','colors']);
      if(!/^[0-9a-f-]{36}$/i.test(text(proof.resultId,36)))fail();
      const context=validateSourceColorContext(proof.context);
      const output=validateSourceColorOutput({kind:'source-color',verdict:'DETERMINED',colors:proof.colors,reason:'Recorded source observation',referenceAssetIds:context.referenceAssets.map(ref=>ref.assetId)});
      if(e.meaning!=='color'||e.id!==`${o.variantId}:source-color:${proof.resultId}`||e.value!==output.colors.join(', ')||context.productId!==o.productId||context.productRevision!==o.productRevision)fail('来源图片颜色与当前商品或记录不匹配');
    }else if(e.imageObservation!==undefined||String(e.id).includes(':source-color:'))fail('图片观察不能冒充人工或文字来源');
    return e;
  });
  if (o.repairRequest !== undefined) {
    const repair = object(o.repairRequest, ['issues','currentValues']);
    array(repair.issues, 50, raw => { const issue = object(raw, ['field','code','message']); const name = field(issue.field); if (!fields.some(card => card.name === name)) fail(); text(issue.code,100); text(issue.message,2000); return issue; });
    if (!repair.currentValues || typeof repair.currentValues !== 'object' || Array.isArray(repair.currentValues)) fail();
    for (const name of Object.keys(repair.currentValues as object)) if (!fields.some(card => card.name === name)) fail();
  }
  if (new Set(fields.map(f=>f.name)).size !== fields.length || new Set(evidence.map(e=>e.id)).size !== evidence.length || Buffer.byteLength(JSON.stringify(o)) > 60000) fail();
  return structuredClone(o) as unknown as ListingAiContext;
}
