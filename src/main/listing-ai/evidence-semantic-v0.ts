// Frozen semantics shared by recorded v0 and v1 evidence contracts.
import type { CandidateField, ListingEvidence } from '../../shared/listing-ai-contracts.ts';

const normalizedName = (name:string) => name.toLowerCase().replace(/[\s_-]/g,'');
const statements = (value:string) => value.split(/[，,;；。\u002f|]/);
const positive = (value:string) => !/不|无|禁止|^(?:否|0)$|\b(?:not|no|without|never|false)\b/i.test(value.replace(/无线|不锈钢|无色/g,''));
export const BLADE_EVIDENCE_RULES = 'The blade field means blade material. An explicit 刀刃材质/刀片材质/刀头材质 or Blade Material fact supports its faithful translation. For productType NAIL_CLIPPER only, source-confirmed or human-confirmed whole-product 材质/材料/Material=金属/Metal together with 产品类别/产品类型/商品类型/类别/Category/Product Type=指甲刀/指甲钳/指甲剪/Nail Clipper supports the broad blade value Metal; cite BOTH facts for the item and claim. This is a narrow contextual mapping, not a claim about the steel grade. Do not apply it if a specific blade material is supplied: use that fact instead. Handle or housing material and metallic appearance do not qualify. Metal never implies Stainless Steel, Carbon Steel or an alloy. Return a plain English candidate value; the application adds the nested Amazon wrapper.';
const fabricNames: Record<string,string> = {'聚酯纤维':'polyester','涤纶':'polyester','棉质':'cotton','棉':'cotton','尼龙':'nylon','锦纶':'nylon','polyamide':'nylon','羊毛':'wool','亚麻':'linen','腈纶':'acrylic','氨纶':'spandex','elastane':'spandex','蚕丝':'silk','人造丝':'rayon','粘胶纤维':'viscose'};
export function translatedFabricEvidence(value:string):string {
  let text=value.toLowerCase();for(const [from,to] of Object.entries(fabricNames)) text=text.replaceAll(from,` ${to} `);return text;
}
function fabricParts(value:string): { fiber:string; percentage:number|null }[] {
  const parts:{fiber:string;percentage:number|null}[]=[];
  for(const text of translatedFabricEvidence(value).split(/[,/;，；、]+/)){
    const fibers=[...text.matchAll(/\b(cotton|polyester|nylon|wool|linen|acrylic|spandex|silk|rayon|viscose)\b/g)];
    const amounts=[...text.matchAll(/([+-]?\d+(?:\.\d+)?)\s*%/g)];
    if(!fibers.length){if(amounts.length)return [];continue;}
    // A clause is either "60% cotton 40% polyester" or "cotton 60% polyester 40%".
    // Each percentage belongs to one adjacent fiber; never reuse a suffix as the next prefix.
    const prefix=!!amounts.length&&amounts[0].index!<fibers[0].index!;let used=0;
    for(const [index,fiber] of fibers.entries()){
      const start=prefix?(index?fibers[index-1].index!+fibers[index-1][0].length:0):fiber.index!+fiber[0].length;
      const end=prefix?fiber.index!:fibers[index+1]?.index??text.length;
      const owned=amounts.filter(amount=>amount.index!>=start&&amount.index!+amount[0].length<=end);
      if(owned.length>1||amounts.length&&owned.length!==1)return [];
      used+=owned.length;parts.push({fiber:fiber[1],percentage:owned.length?Number(owned[0][1]):null});
    }
    if(used!==amounts.length)return [];
  }
  return parts;
}
/** These fields still use contextual translation, but cannot cite unrelated material/color facts. */
export function hasSemanticEvidence(field:CandidateField,value:string,evidence:ListingEvidence[],context:{productType?:string;scope?:ListingEvidence[]}={}):boolean {
  if(field==='blade'){
    const bladeFact=(e:ListingEvidence)=>/^(?:刀刃材质|刀片材质|刀头材质|bladematerial)$/.test(normalizedName(e.name));
    const sources=evidence.filter(e=>bladeFact(e)&&positive(e.value));
    const translations:Record<string,string[]>={'金属':['metal'],'不锈钢':['stainless steel'],'碳钢':['carbon steel'],'高碳钢':['high carbon steel'],'合金钢':['alloy steel'],'陶瓷':['ceramic']};
    if(sources.some(e=>(translations[e.value.trim()]??[e.value.toLowerCase().trim()]).includes(value.toLowerCase().trim())))return true;
    // A confirmed metal nail clipper supports the broad Metal category. Keep this
    // narrower than inferring any alloy or transferring a handle/housing material.
    if(context.productType!=='NAIL_CLIPPER'||value.trim().toLowerCase()!=='metal'||(context.scope??evidence).some(bladeFact))return false;
    const confirmed=evidence.filter(e=>['source_confirmed','human_confirmed'].includes(e.source));
    return confirmed.some(e=>e.meaning==='material'&&/^(?:材质|材料|material)$/.test(normalizedName(e.name))&&/^(?:金属|metal)$/i.test(e.value.trim()))&&
      confirmed.some(e=>/^(?:产品类别|产品类型|商品类型|类别|category|producttype)$/.test(normalizedName(e.name))&&/^(?:指甲刀|指甲钳|指甲剪|nail clippers?)$/i.test(e.value.trim()));
  }
  if(field==='target_audience'){
    const sources=evidence.filter(e=>/^(?:适用人群|适用对象|目标人群|使用人群|targetaudience|intendedusers)$/.test(normalizedName(e.name))&&positive(e.value));
    const translations:Record<string,string[]>={'通用':['general','all','general use','unisex'],'男女通用':['unisex','men and women'],'成人':['adult','adults'],'成年人':['adult','adults'],'男士':['men'],'女士':['women'],'儿童':['children','kids'],'婴儿':['baby','babies'],'老年人':['elderly','seniors']};
    return sources.some(e=>(translations[e.value.trim()]??[e.value.toLowerCase().trim()]).includes(value.toLowerCase().trim()));
  }
  if (field==='theme' || field==='subject_character') {
    // Schema options and generic material/color facts do not establish a depicted subject.
    // Contextual translations still require the independent claim review before auto-adoption.
    return evidence.some(e=>['general','item_shape'].includes(e.meaning) && positive(e.value) &&
      (e.source==='selected_sku' && e.name==='Selected SKU specification' ||
        /^(?:主题|角色|主体|图案|造型|形状|产品类型|商品类型|theme|subjectcharacter|character|pattern|shape|itemshape|producttype)$/.test(normalizedName(e.name))));
  }
  if(field==='fabric_type'){
    const material=evidence.filter(e=>e.meaning==='material'||/^(?:面料|面料成分|材料成分|fabrictype|fabriccomposition)$/.test(normalizedName(e.name)));
    if(!material.length)return false;
    if(/^(?:not[ _]applicable|n\/?a|none)$/i.test(value.trim())) return material.every(e=>/^(?:PLA|ABS|PVC|PP|PE|PET|plastic|silicone|metal|glass|ceramic|wood|bamboo|(?:synthetic )?resin|合成树脂|树脂|塑料|硅胶|金属|玻璃|陶瓷|木|竹)$/i.test(e.value.trim()));
    const parts=fabricParts(value), source=material.flatMap(e=>fabricParts(e.value));
    const rest=translatedFabricEvidence(value).replace(/\b(?:cotton|polyester|nylon|wool|linen|acrylic|spandex|silk|rayon|viscose|and|blend|fabric)\b/g,'').replace(/[\d\s%.,/;()+-]/g,'');
    return !rest&&parts.length>0&&parts.every(part=>source.some(s=>s.fiber===part.fiber&&(part.percentage===null||part.percentage>=0&&part.percentage<=100&&s.percentage===part.percentage)));
  }
  if(!['operation_mode','included_components','special_feature'].includes(field))return true;
  const relevant=evidence.filter(e=>{
    if(e.meaning!=='general')return false;
    const name=normalizedName(e.name);
    if(field==='operation_mode')return /^(?:工作方式|操作方式|运行方式|驱动方式|operationmode|类别|产品类型|商品类型|category|producttype)$/.test(name)||e.source==='selected_sku';
    if(field==='included_components')return /^(?:包含配件|配件|部件|包装清单|装箱清单|includedcomponents|components|类别|产品类型|商品类型|category|producttype)$/.test(name)||e.source==='selected_sku'&&/带|配|含|装|with|include|component/i.test(e.value);
    return /^(?:功能|特点|特性|特征|特色|特殊功能|功能特性|specialfeature|feature|features|function)$/.test(name)||e.source==='selected_sku';
  });
  if(!relevant.length)return false;
  if(field==='operation_mode'){
    const modes:Record<string,RegExp>={manual:/手动|手摇|粘毛滚|\bmanual\b/i,automatic:/自动|\bautomatic\b/i,adhesive:/粘毛|黏胶|粘胶|adhesive/i,brushing:/刷|brushing/i};
    const rule=modes[value.toLowerCase().trim()];
    if(rule?!relevant.some(e=>positive(e.value)&&rule.test(e.value)):!relevant.some(e=>e.value.trim().toLowerCase()===value.trim().toLowerCase()))return false;
  }
  const claims:[RegExp,RegExp][]=[
    [/bluetooth/i,/蓝牙|bluetooth/i],[/wi[ -]?fi/i,/无线网络|wi[ -]?fi/i],[/remote[ -]?control/i,/遥控|remote[ -]?control/i],
    [/\bautomatic\b/i,/自动|\bautomatic\b/i],[/\belectric\b/i,/电动|\belectric\b/i],[/rechargeable/i,/充电|rechargeable/i],
    [/batter(?:y|ies)/i,/电池|batter(?:y|ies)/i],[/charger/i,/充电器|charger/i],
  ];
  for(const [claim,source] of claims)if(claim.test(value)&&!relevant.some(e=>statements(e.value).some(part=>source.test(part)&&positive(part))))return false;
  if(field==='included_components'){
    const units:Record<string,string>={spoon:'(?:勺|spoons?)',roll:'(?:卷|rolls?)',magnet:'(?:磁铁|magnets?)'};
    for(const component of value.matchAll(/\b(spoon|roll|magnet)s?\b/gi)){
      const source=new RegExp(units[component[1].toLowerCase()],'i');
      const mentions=relevant.flatMap(e=>statements(e.value)).filter(part=>source.test(part));
      if(!mentions.length||mentions.some(part=>!positive(part)))return false;
    }
    for(const match of value.matchAll(/\b(\d+)\s+(spoon|roll|magnet)s?\b/gi)){
      const pattern=new RegExp(`(?<![\\d.])${Number(match[1])}\\s*${units[match[2].toLowerCase()]}(?![a-z])`,'i');
      if(!relevant.some(e=>statements(e.value).some(part=>pattern.test(part)&&positive(part))))return false;
    }
  }
  return true;
}
