import { plainColorName } from './plain-colors.ts';
import type { ListingEvidence } from '../../shared/listing-ai-contracts.ts';

type ColorName = { name: string; aliases: string[]; includes?: string[] };
// Finite translations, not a guess from the product title or other variants. Named
// shades only imply a basic color when the source actually names that basic color.
const NAMES: ColorName[] = [
  { name:'Clear Blue-Yellow', aliases:['透明蓝黄','clear blue-yellow','clear blue yellow'], includes:['Blue','Yellow'] },
  { name:'Clear Teal-Green', aliases:['透明青绿','clear teal-green','clear teal green'], includes:['Teal','Green'] },
  { name:'Spring Tea', aliases:['春茶色','春茶','spring tea'] },
  { name:'Pine Needle Green', aliases:['松针绿色','松针绿','pine needle green','pine green'], includes:['Green'] },
  { name:'Luminous Natural', aliases:['夜光本色','luminous natural','natural glow-in-the-dark','natural glow in the dark','glow-in-the-dark natural','glow in the dark natural'] },
  { name:'Cherry Blossom Pink', aliases:['樱花粉色','樱花粉','cherry blossom pink'], includes:['Pink'] },
  { name:'Gray Green', aliases:['灰绿色','灰绿','gray green','grey green','gray-green','grey-green'], includes:['Gray','Green'] },
  { name:'Brick Red', aliases:['砖红色','砖红','brick red','brick-red'], includes:['Red'] },
  { name:'Sage Green', aliases:['鼠尾草绿色','鼠尾草绿','sage green'], includes:['Green'] },
  { name:'Off White', aliases:['米白色','米白','off white','off-white'], includes:['White'] },
  { name:'Dusty Blue', aliases:['雾蓝色','雾蓝','dusty blue'], includes:['Blue'] },
  ...Object.entries({Blue:['蓝色'],Green:['绿色'],Gray:['灰色','grey'],White:['白色'],Black:['黑色'],Red:['红色'],Pink:['粉红色','粉色'],Beige:['米色'],Brown:['棕色'],Orange:['橘色','橙色'],Yellow:['黄色'],Purple:['紫色'],Teal:['青色']}).flatMap(([name,aliases])=>[
    ...(['Light','Dark'] as const).map(shade=>({name:`${shade} ${name}`,aliases:[`${shade.toLowerCase()} ${name.toLowerCase()}`,...aliases.filter(a=>a.endsWith('色')).flatMap(a=>[`${shade==='Light'?'浅':'深'}${a}`,`${shade==='Light'?'浅':'深'}${a.slice(0,-1)}`])],includes:[name]})),
    {name,aliases:[name.toLowerCase(),...aliases]},
  ]),
];
const escape = (s:string) => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function vocabulary(names:ColorName[]){
  const aliases=names.flatMap(color=>color.aliases.map(alias=>({alias,color}))).sort((a,b)=>b.alias.length-a.alias.length);
  return {aliases,words:new RegExp(aliases.map(({alias})=>/[A-Za-z]/.test(alias)?`(?<![A-Za-z])${escape(alias)}(?![A-Za-z])`:escape(alias)).join('|'),'gi')};
}
const BASIC=vocabulary(NAMES);
// These words also describe materials or ordinary prose (e.g. "clear details").
// Only interpret them as colors in a color field or its color evidence.
const EXTENDED=vocabulary([...NAMES,
  {name:'Gold',aliases:['金色','gold']},{name:'Silver',aliases:['银色','silver']},
  {name:'Copper',aliases:['铜色','copper']},
  {name:'Clear',aliases:['透明','clear','transparent']},{name:'Colorless',aliases:['无色','colorless']},
  {name:'Natural Wood',aliases:['原木色','natural wood']},{name:'Champagne',aliases:['香槟色','champagne']},
  {name:'Rose Gold',aliases:['玫瑰金色','玫瑰金','rose gold']},
]);
const bare: Record<string,string> = {蓝:'Blue',绿:'Green',灰:'Gray',白:'White',黑:'Black',红:'Red',粉:'Pink',棕:'Brown',橘:'Orange',橙:'Orange',黄:'Yellow',紫:'Purple'};
const RANDOM = /随机|\b(?:random(?:ly)?(?:\s+(?:colors?|colours?))?|assorted\s+colou?rs?)\b/gi;
const MULTI = /多色|混色|彩色|\b(?:multi[ -]?colou?re?d?|mixed\s+colou?rs?)\b/gi;
const GRADIENT = /渐变|\b(?:gradient|ombre)\b/gi;
const SOLID = /单色|纯色|\bsolid(?:\s+colou?r)?\b/gi;
const OPTIONS = /可选|任选|可挑|或|\b(?:available|choose|choice|options?|or)\b/i;
const UNKNOWN = /未知|未指定|未确定|不确定|以实物为准|\b(?:unknown|unspecified)\b/i;
const negated = (value:string,index:number) => /(?:不是|并非|非|不含|无|\b(?:not|no|without))\s*$/i.test(value.slice(Math.max(0,index-12),index));
type Colors = { names:ColorName[]; random:boolean; multi:boolean; gradient:boolean; solid:boolean; remainder:string };
const has = (pattern:RegExp,value:string) => { pattern.lastIndex=0;return pattern.test(value); };
function readColors(value:string, specification:boolean,extended=false):Colors|undefined {
  const {aliases,words}=extended?EXTENDED:BASIC;
  const random=has(RANDOM,value);
  // A random selection does not establish any of its possible colors.
  if(specification&&random)return {names:[],random:true,multi:false,gradient:false,solid:false,remainder:''};
  if(specification&&(OPTIONS.test(value)||UNKNOWN.test(value)))return;
  const names:ColorName[]=[],chars=value.split('');
  for(const match of value.matchAll(words)){
    if(negated(value,match.index!))return;
    const color=aliases.find(a=>a.alias.toLowerCase()===match[0].toLowerCase())!.color;
    names.push(color);chars.fill(' ',match.index!,match.index!+match[0].length);
  }
  // Single Chinese characters count only in an explicit color list or a whole
  // color-axis value, never inside 青蛙 / 蓝牙 / 黄铜 / 绿植 / 红外.
  if(specification){
    const remaining=chars.join('');
    const runs=/(?:[蓝绿灰白黑红粉棕橘橙黄紫]\s*[+＋、,&和与]\s*)+[蓝绿灰白黑红粉棕橘橙黄紫]|(?:颜色|色系)\s*[:：]\s*[蓝绿灰白黑红粉棕橘橙黄紫](?=\s*(?:$|[/|·;；]))/g;
    for(const match of remaining.matchAll(runs)){
      if(negated(value,match.index!))return;
      for(const char of match[0].replace(/^(?:颜色|色系)\s*[:：]\s*/,''))if(bare[char])names.push(NAMES.find(n=>n.name===bare[char])!);
      chars.fill(' ',match.index!,match.index!+match[0].length);
    }
  }
  const multi=has(MULTI,value),gradient=has(GRADIENT,value),solid=has(SOLID,value);
  const remainder=chars.join('').replace(RANDOM,' ').replace(MULTI,' ').replace(GRADIENT,' ').replace(SOLID,' ').replace(/\b(?:and|colou?rs?)\b/gi,' ').replace(/[\s+,/&()-]/g,'');
  const unique=[...new Map(names.map(n=>[n.name,n])).values()];
  if(!unique.length&&!random&&!multi)return;
  // Several separated named colors in a supplier spec may be choices. Require
  // an explicit multicolor descriptor or an uninterrupted joined color phrase.
  if(specification&&unique.length>1&&!multi){
    const first=[...value.matchAll(words)][0],last=[...value.matchAll(words)].at(-1);
    if(first&&last){
      const between=value.slice(first.index!,last.index!+last[0].length).replace(words,'').replace(/\b(?:and|colou?rs?)\b/gi,'').replace(/[\s+,/&()-]/g,'');
      if(between)return;
    }
  }
  return {names:unique,random,multi,gradient,solid,remainder};
}

function colorEvidence(evidence:ListingEvidence,scope:ListingEvidence[]):Colors|undefined {
  if(evidence.meaning==='color'){
    // Old contexts may contain an over-simplified derived color. Preserve their
    // bytes, but let the originating specification constrain its interpretation.
    const original=evidence.source==='selected_sku'&&evidence.name==='Selected SKU color'&&evidence.id.endsWith(':color')
      ?scope.find(e=>e.id===evidence.id.slice(0,-6)+':spec'&&e.source==='selected_sku'&&e.name==='Selected SKU specification'):undefined;
    if(original)return readColors(original.value,true,true);
    return readColors(bare[evidence.value.trim()]??evidence.value,true,true);
  }
  if(evidence.source==='selected_sku'&&evidence.meaning==='general'&&evidence.name==='Selected SKU specification'&&evidence.id.endsWith(':spec'))return readColors(evidence.value,true,true);
}

/** Whether existing text establishes the SKU color, including named shades and explicit random colors. */
export function hasSkuColorEvidence(evidence:ListingEvidence[]):boolean {
  return evidence.some(item=>!!colorEvidence(item,evidence));
}

/** Stable identity for an entire explicit color value; never interpret prose as a hue. */
export function exactSkuColorIdentity(value:string):string|null {
  const color=readColors(bare[value.trim()]??value.trim(),true,true);
  if(!color||color.random||color.remainder||!color.names.length)return null;
  return color.names.map(name=>name.name).sort().join(' / ')+(color.gradient?' Gradient':'');
}

/** Only cited color evidence and the current selected specification can justify
 * color claims. This also works with already-saved contexts containing only :spec. */
export function supportsColorClaims(value:string,evidence:ListingEvidence[],colorField:boolean,scope:ListingEvidence[]=evidence,variantId?:string):boolean {
  // A confirmed English shade name can be copied even if the finite vocabulary
  // recognizes only part of it. Derived SKU colors must still obey their :spec.
  if(colorField&&/^[A-Za-z -]+$/.test(value)&&evidence.length>0&&evidence.every(e=>e.meaning==='color'
    &&['source_confirmed','human_confirmed'].includes(e.source)&&e.name!=='Selected SKU color'
    &&e.value.trim().toLowerCase()===value.trim().toLowerCase()))return true;
  const claim=readColors(colorField?plainColorName(value).replace(/([a-z])([A-Z])/g,'$1 $2'):value,false,colorField),sources=evidence.map(e=>colorEvidence(e,scope)).filter((c):c is Colors=>!!c);
  if(colorField){
    if(!sources.length){
      // Preserve exact copies of explicitly confirmed color names outside the
      // finite translation vocabulary, without using general specifications.
      return evidence.length>0&&evidence.every(e=>e.meaning==='color'&&e.name!=='Selected SKU color'&&e.value.trim().toLowerCase()===value.trim().toLowerCase());
    }
    if(!claim||claim.remainder)return false;
    // The color field names the whole variant, not one color in a multicolor item.
    if(claim.names.length&&!sources.some(s=>s.names.length===claim.names.length&&claim.names.every(n=>s.names.some(other=>other.name===n.name||plainColorName(other.name)===plainColorName(n.name)))))return false;
  }
  if(!claim)return true;
  if(claim.random&&!sources.some(s=>s.random))return false;
  const isMulti=(s:Colors)=>!s.random&&(s.multi||s.names.length>1||s.names.some(n=>(n.includes?.length??0)>1));
  // A generic "multicolor" caption may rely on the explicit current SKU context.
  // Older saved plans cited the process/material for the rest of such a caption.
  // Exact hues and color fields still require their own cited evidence.
  const contextualMulti=!colorField&&claim.multi&&!claim.names.length&&variantId
    ?scope.filter(e=>e.id===`${variantId}:spec`&&e.source==='selected_sku'&&e.name==='Selected SKU specification')
      .some(e=>{const parsed=colorEvidence(e,scope);return !!parsed&&isMulti(parsed);}):false;
  if(claim.multi&&!sources.some(isMulti)&&!contextualMulti)return false;
  if(claim.gradient&&!sources.some(s=>s.gradient))return false;
  if(claim.solid&&!sources.some(s=>s.solid))return false;
  return claim.names.every(name=>sources.some(s=>!s.random&&s.names.some(n=>n.name===name.name||n.includes?.includes(name.name))));
}
