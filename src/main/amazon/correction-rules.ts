import type {AmazonSchema,JsonObject,JsonValue} from '../../shared/amazon-contracts.ts';
import {UserFacingError} from '../../shared/errors.ts';
import {isObject} from './context.ts';
import {resolveSchemaNode} from './field-catalog.ts';
import {semanticJson} from './preparation.ts';
function manual(field:string,reason:string):never{throw new UserFacingError(`需人工处理 ${field}：${reason}`);}
/** Only changes spelling representation of a submitted fact or an explicitly confirmed business rule. */
export function deterministicFieldCorrections(before:JsonObject,submitted:JsonObject,schema:AmazonSchema,issues:JsonValue){
 if(!Array.isArray(issues)||issues.some(i=>!isObject(i)||typeof i.code!=='string'||!i.code.trim()||typeof i.message!=='string'||!i.message.trim()||!['ERROR','WARNING','INFO'].includes(String(i.severity))))manual('平台回读','错误结构不完整，不能作为可靠修正依据');
 const fields=[...new Set((Array.isArray(issues)?issues:[]).filter(i=>isObject(i)&&i.severity==='ERROR').flatMap(i=>isObject(i)&&Array.isArray(i.attributeNames)?i.attributeNames.filter((f):f is string=>typeof f==='string'):[]))];
 if(!fields.length)manual('平台回读','没有带明确字段的 ERROR，无法确定修正范围');
 const after=structuredClone(before),patches:JsonObject[]=[],evidence:string[]=[];
 for(const field of fields){
  if(!/^[a-z][a-z0-9_]*$/.test(field)||/brand|manufacturer|product_type|identifier|gtin|upc|ean|parent|relationship|package|variation/.test(field))manual(field,'涉及品牌/类目审批、商品身份或复杂关系，不能自动改写');
  if(semanticJson(before[field])!==semanticJson(submitted[field]))manual(field,'当前平台值与原可信提交不一致，缺少可靠来源');
  const values=before[field],props=schema.schema.properties;
  if(!Array.isArray(values)||!values.length||!isObject(props)||!isObject(props[field]))manual(field,'缺少原事实或当前字段规则');
  const node=resolveSchemaNode(schema.schema,props[field]),items=isObject(node.items)?resolveSchemaNode(schema.schema,node.items):null;
  const valueNode=items&&isObject(items.properties)&&isObject(items.properties.value)?resolveSchemaNode(schema.schema,items.properties.value):null;
  if(!valueNode||!Array.isArray(valueNode.enum)||!valueNode.enum.every(v=>typeof v==='string'))manual(field,'当前规则没有确定字符串枚举，不能推测事实');
  const enums=valueNode.enum as string[];let changed=false;
  const next=values.map(item=>{
   if(!isObject(item)||typeof item.value!=='string')return manual(field,'原值结构不完整，不能推测事实');
   const matches=field==='supplier_declared_dg_hz_regulation'?enums.filter(v=>v==='not_applicable'):enums.filter(v=>v.trim().toLowerCase()===String(item.value).trim().toLowerCase());
   if(matches.length!==1)return manual(field,'没有唯一且不改变事实含义的规范值');
   if(item.value!==matches[0])changed=true;return {...item,value:matches[0]};
  });
  if(!changed)manual(field,'载荷无实质变化；请核对平台具体错误，不重复发送');
  after[field]=next;patches.push({op:'replace',path:`/attributes/${field}`,value:next});evidence.push(`${field}：${field==='supplier_declared_dg_hz_regulation'?'用户确认 dangerous-goods-fixed/v1 固定 not_applicable':'原可信提交事实 + 当前 Schema 唯一枚举大小写/空白规范化'}`);
 }
 return {after,patches,evidence,fields};
}
