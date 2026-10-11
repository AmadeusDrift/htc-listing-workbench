import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import { LISTING_CANDIDATE_FIELDS, CATEGORY_ATTRIBUTE_FIELDS, CATEGORY_INFERENCE_POLICY_VERSION } from '../../shared/listing-ai-contracts.ts';
import type { CandidateField, ListingAiContext, ListingEvidence, ListingFieldCard } from '../../shared/listing-ai-contracts.ts';
import { buildFieldCatalog } from '../amazon/field-catalog.ts';
import { AMAZON_COPY_POLICY_VERSION } from '../amazon/field-mapping.ts';
import { skuDependentSourceFact, categoryAttributeField, selectedSkuCategoryAttributes, selectedSkuCategoryEvidence } from '../amazon/demo.ts';
import { protectedAttribute } from '../ai/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { listingFingerprint, validateListingContext } from './validation.ts';
import { projectSalesProduct } from '../sales-plans/records.ts';
import { evidenceRole } from './evidence-contract-v2.ts';
import { FULL_SCHEMA_CONTRACT } from '../../shared/listing-ai-contracts.ts';
import { isFullSchema } from './full-schema.ts';

function meaning(name: string): ListingEvidence['meaning'] {
  const n = name.toLowerCase().replace(/[\s_-]/g, '');
  if (/^(材质|材料|面料|面料成分|材料成分|material|fabrictype|fabriccomposition)$/.test(n)) return 'material';
  if (/^(颜色|色系|color|colour)$/.test(n)) return 'color';
  if (/^(形状|外形|造型|外观造型|shape|itemshape)$/.test(n)) return 'item_shape';
  if (/^(护理说明|清洗说明|清洁方式|洗涤说明|careinstructions|care)$/.test(n)) return 'care_instructions';
  return 'general';
}
export function buildListingContext(draft: AmazonDraft, product: ProductDetail, targetGeneration: number, legacy=false): ListingAiContext {
  const originalProduct=product;
  product=projectSalesProduct(product,draft.salesPlan,draft.variantId);
  const variant = product.variants.find(v => v.id === draft.variantId);
  if (!variant || product.revision !== draft.productRevision || variant.sku !== draft.sku) throw new UserFacingError('来源商品或 SKU 已变化，请建立新草稿');
  if (draft.schema.locale !== 'en_US' || draft.marketplaceId !== 'ATVPDKIKX0DER') throw new UserFacingError('AI 字段辅助当前支持美国站英文，请选择 en_US');
  if(!legacy){
    const fields=Object.entries(draft.schema.schema.properties??{}).map(([name,node])=>({name,title:node&&typeof node==='object'&&!Array.isArray(node)&&typeof node.title==='string'?node.title:name,requirement:Array.isArray(draft.schema.schema.required)&&draft.schema.schema.required.includes(name)?'required' as const:'optional' as const,closedEnum:false,allowedValues:[],suggestedValues:[]}));
    const evidence:ListingEvidence[]=product.facts.filter(f=>f.value.trim()).map(f=>({id:f.id,name:f.name,value:f.value,meaning:meaning(f.name),source:f.state==='human_confirmed'?'human_confirmed':f.state==='source_confirmed'?'source_confirmed':'raw_source'}));
    evidence.push({id:`${variant.id}:spec`,name:'Selected SKU specification',value:variant.normalizedSpec||variant.originalSpec||variant.sku,meaning:'general',source:'selected_sku'});
    evidence.push({id:`${variant.id}:title`,name:'Original product title',value:product.title||draft.schema.productType,meaning:'general',source:'selected_sku'});
    return validateListingContext({contract:FULL_SCHEMA_CONTRACT,draftId:draft.id,draftRevision:draft.revision,productId:product.id,productRevision:product.revision,variantId:variant.id,sku:variant.sku,targetId:draft.targetId,targetGeneration,listingProgram:draft.listingProgram??'standard',productType:draft.schema.productType,marketplaceId:draft.marketplaceId,locale:draft.schema.locale,requirements:draft.schema.requirements,parentageLevel:draft.schema.parentageLevel,schemaChecksum:draft.schema.checksum,schemaVersion:draft.schema.version,schemaSha256:listingFingerprint({schema:draft.schema.schema,metaSchema:draft.schema.metaSchema}),policyVersion:AMAZON_COPY_POLICY_VERSION,fields,evidence,unverifiedSourceTitle:product.title,fullSchema:{schema:draft.schema.schema,metaSchema:draft.schema.metaSchema},currentAttributes:structuredClone(draft.attributes),businessValues:Object.fromEntries(Object.entries(draft.businessRules?.fields??{}).map(([field,entry])=>[field,entry.value])),sourceProduct:{variants:originalProduct.variants,...(draft.salesPlan?{salesRecipe:draft.salesPlan}:{}),title:originalProduct.title,description:originalProduct.description,facts:originalProduct.facts,selectedSku:variant,assets:originalProduct.assets}});
  }
  const requested=new Set([...draft.localIssues,...draft.previewIssues,...draft.listingIssues].filter(issue=>issue.severity==='ERROR').flatMap(issue=>issue.attributeNames));
  // Newly supported optional attributes must not invalidate already-paid image
  // contexts. Activate them only when required, present, or requested by validation.
  const fields: ListingFieldCard[] = buildFieldCatalog(draft.schema).filter(f => LISTING_CANDIDATE_FIELDS.includes(f.name as CandidateField)
    && (!(CATEGORY_ATTRIBUTE_FIELDS as readonly string[]).includes(f.name)||f.requirement==='required'||Object.hasOwn(draft.attributes,f.name)||requested.has(f.name))).map(f => {
    const card: ListingFieldCard = { name: f.name as CandidateField, title: f.title, ...(f.description ? {description:f.description.slice(0,2000)} : {}), requirement: f.requirement, closedEnum: f.closedEnum, allowedValues: f.allowedValues, suggestedValues: f.suggestedValues };
    for (const key of ['minLength','maxLength','minUtf8ByteLength','maxUtf8ByteLength','minItems','maxItems'] as const) if (f[key] !== undefined) card[key] = f[key];
    return card;
  });
  const evidence: ListingEvidence[] = product.facts.filter(f => ['source_confirmed','human_confirmed'].includes(f.state) && f.value.trim() && !protectedAttribute(f.name)).map(f => ({ id: f.id, name: f.name, value: f.value, meaning: meaning(f.name), source: f.state as 'source_confirmed' | 'human_confirmed' }));
  const selectedAttributes=Object.fromEntries(Object.entries(selectedSkuCategoryAttributes(variant)).filter(([field])=>fields.some(card=>card.name===field)));
  for(let i=evidence.length-1;i>=0;i--){const field=categoryAttributeField(evidence[i].name,evidence[i].value);if(field&&Object.hasOwn(selectedAttributes,field))evidence.splice(i,1);}
  for(const [field,value] of Object.entries(selectedAttributes))evidence.push({id:`${variant.id}:${field}`,name:field==='age_range_description'?'适用人群':field,value,meaning:'general',source:'selected_sku'});
  // Raw exclusions/unparsed roles must survive even when their category card is
  // hidden. Keep ordinary affirmative contexts byte-for-byte stable.
  for(const [field,{raw,parsed}] of Object.entries(selectedSkuCategoryEvidence(variant))){
    if(!parsed.excluded.length&&!parsed.unparsed&&parsed.values.length===1)continue;
    for(let i=evidence.length-1;i>=0;i--)if(evidenceRole(evidence[i].name,evidence[i].value)===field)evidence.splice(i,1);
    evidence.push({id:`${variant.id}:${field}`,name:field==='age_range_description'?'适用人群':field,value:raw,meaning:'general',source:'selected_sku'});
  }
  // Product-level color, measurements and counts cannot disambiguate multiple SKUs.
  if (product.variants.length > 1) for (let i = evidence.length - 1; i >= 0; i--) if (evidence[i].meaning === 'color' || /^(?:规格|商品规格|产品规格|规格型号)$/u.test(evidence[i].name.trim()) || skuDependentSourceFact(evidence[i].name)) evidence.splice(i, 1);
  const selectedRoles=selectedSkuCategoryAttributes(variant),evidenceBlockers:NonNullable<ListingAiContext['evidenceBlockers']>=[];
  for(const fact of product.facts){
    if(fact.state!=='conflicting'||!fact.value.trim()||protectedAttribute(fact.name))continue;
    if(product.variants.length>1&&(meaning(fact.name)==='color'||/^(?:规格|商品规格|产品规格|规格型号)$/u.test(fact.name.trim())||skuDependentSourceFact(fact.name)))continue;
    const field=evidenceRole(fact.name,fact.value);if(!field)continue;
    if(Object.hasOwn(selectedRoles,field)){
      if(!evidence.some(e=>e.source==='selected_sku'&&evidenceRole(e.name,e.value)===field)){
        for(let i=evidence.length-1;i>=0;i--)if(evidenceRole(evidence[i].name,evidence[i].value)===field)evidence.splice(i,1);
        evidence.push({id:`${variant.id}:${field}`,name:field==='age_range_description'?'适用人群':field,value:selectedRoles[field],meaning:'general',source:'selected_sku'});
      }
      continue;
    }
    let blocker=evidenceBlockers.find(b=>b.field===field);
    if(!blocker){blocker={field,reason:'source_conflict',facts:[]};evidenceBlockers.push(blocker);}
    blocker.facts.push({id:fact.id,name:fact.name,value:fact.value});
  }
  if(evidenceBlockers.length)for(let i=evidence.length-1;i>=0;i--)if(evidenceBlockers.some(b=>b.field===evidenceRole(evidence[i].name,evidence[i].value)))evidence.splice(i,1);
  const spec = variant.normalizedSpec.trim() || variant.originalSpec.trim();
  if (spec) evidence.push({ id: `${variant.id}:spec`, name: 'Selected SKU specification', value: spec, meaning: 'general', source: 'selected_sku' });
  // Keep this persisted evidence representation stable for resumable image-context
  // fingerprints. Validation also recognizes explicit colors in the selected :spec.
  const compoundColors: Record<string,string> = { '透明蓝黄': 'Clear Blue-Yellow', '透明青绿': 'Clear Teal-Green' };
  const colors = (spec.match(/透明蓝黄|透明青绿|鼠尾草绿|粉红色|灰绿|砖红|米白|雾蓝|蓝色|绿色|灰色|白色|黑色|红色|粉色|米色|棕色|橘色|橙色|黄色|紫色|\b(?:gray green|grey green|sage green|brick red|off white|dusty blue|blue|green|gr[ae]y|white|black|red|pink|beige|brown|orange|yellow|purple)\b/gi) ?? []).map(color => compoundColors[color] ?? color);
  if (colors[0] && new Set(colors.map(c=>c.toLowerCase())).size === 1) evidence.push({ id: `${variant.id}:color`, name: 'Selected SKU color', value: colors[0], meaning: 'color', source: 'selected_sku' });
  if(draft.salesPlan && draft.salesPlan.parentage!=='PARENT') {
    for(const [i,component] of draft.salesPlan.recipe.components.entries()) if(component.color) evidence.push({id:`${variant.id}:sale-color-${i}`,name:'Sales component color',value:component.color,meaning:'color',source:'selected_sku'});
    if(draft.salesPlan.recipe.components.length>1) evidence.push({id:`${variant.id}:sale-color`,name:'Sales package color (use this aggregate for the color field)',value:'Mixed colors',meaning:'color',source:'selected_sku'});
    evidence.push({id:`${variant.id}:sale-count`,name:'Sales package quantity',value:`${draft.salesPlan.recipe.totalPieces} pieces`,meaning:'general',source:'selected_sku'});
  }
  const c = { draftId: draft.id, draftRevision: draft.revision, productId: product.id, productRevision: product.revision, variantId: variant.id, sku: variant.sku, targetId: draft.targetId, targetGeneration,
    listingProgram: draft.listingProgram ?? 'standard', productType: draft.schema.productType, marketplaceId: draft.marketplaceId, locale: draft.schema.locale, requirements: draft.schema.requirements, parentageLevel: draft.schema.parentageLevel,
    schemaChecksum: draft.schema.checksum, schemaVersion: draft.schema.version, schemaSha256: listingFingerprint({ schema: draft.schema.schema, metaSchema: draft.schema.metaSchema }), policyVersion: AMAZON_COPY_POLICY_VERSION,
    fields, evidence, unverifiedSourceTitle: product.title,...(evidenceBlockers.length?{evidenceBlockers}:{}),
    ...(fields.some(card=>(CATEGORY_ATTRIBUTE_FIELDS as readonly string[]).includes(card.name))?{categoryInferencePolicyVersion:CATEGORY_INFERENCE_POLICY_VERSION}:{}) };
  if (Buffer.byteLength(JSON.stringify(c)) > 60000) throw new UserFacingError('当前字段和事实超出一次 AI 请求预算，请减少无关事实后重试');
  return validateListingContext(c);
}
/** Shop identifiers, schema and connection generation stay in the main process. */
export function listingModelPayload(context: ListingAiContext) {
  if(isFullSchema(context))return {contract:FULL_SCHEMA_CONTRACT,operation:'amazon-fields',targetLanguage:'US English',productType:context.productType,marketplaceId:context.marketplaceId,locale:context.locale,fullSchema:context.fullSchema,currentAttributes:context.currentAttributes,businessValues:context.businessValues,sourceProduct:context.sourceProduct,fields:context.fields.map(field=>({name:field.name,title:field.title,valueMode:undefined,options:undefined,suggestedOptions:undefined})),evidence:context.evidence,policy:{titleMaxCharacters:75,bulletCount:5,bulletMaxCharacters:500,descriptionMaxCharacters:500,keywordMaxUtf8Bytes:200},...(context.repairRequest?{repairRequest:context.repairRequest}:{})};
  return { targetLanguage: 'US English', productType: context.productType, policyVersion: context.policyVersion,
    policy: { titleMaxCharacters: 75, preferredTitleMaxCharacters: 70, bulletCount: 5, bulletMaxCharacters: 500, descriptionMaxCharacters: 500, keywordMaxUtf8Bytes: 200 },
    fields: context.fields.map(field=>({...field,valueMode:field.closedEnum?(field.allowedValues.length===1?'fixed' as const:'single_choice' as const):'free_text' as const,
      options:field.closedEnum?field.allowedValues:[],suggestedOptions:field.closedEnum?[]:field.suggestedValues})),
    evidence: context.evidence, ...(context.evidenceBlockers?{evidenceBlockers:context.evidenceBlockers}:{}), ...(context.repairRequest ? { repairRequest: context.repairRequest } : {}) };
}
