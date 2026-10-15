import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';

test('actual task and SKU components render separate packaging/invalid counts and honest history times',async t=>{
 await mkdir(resolve('.test-data'),{recursive:true});const root=await mkdtemp(resolve('.test-data/s09-status-ui-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await build({stdin:{resolveDir:resolve('.'),loader:'tsx',contents:String.raw`
 import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
 import {AutomaticProductGroups,SalesItem} from './src/renderer/AutomaticProductGroups';
 import {AutomaticTaskGroups} from './src/renderer/AutomaticTaskGroups';
 import {buildAutomaticProductGroups,automaticItemOutcome,automaticItemReason,summarizeAutomaticItems} from './src/renderer/automatic-product-groups';
 import {NavigationMemoryContext} from './src/renderer/navigation-context';
 export function render(){const base={key:'row',productId:'product',productTitle:'合成商品',variantId:'variant',sku:'FIXED-SKU',stockSets:5,draftId:null,imageStarted:false,imageAttempts:0,batchId:null,stage:'SOURCES',status:'FAILED',error:null};
 const rows=[{...base,key:'package',status:'SCREENED',outcome:{kind:'RULE_FILTERED',code:'DIMENSIONAL_WEIGHT_LIMIT',pricingReport:{}}},{...base,key:'invalid',outcome:{kind:'SYSTEM_REPAIR',code:'SOURCE_CONSISTENCY_INVALID_OUTPUT'}},{...base,key:'unknown',outcome:{kind:'UNKNOWN',code:'SOURCE_CONSISTENCY_SENT_UNKNOWN'}}],actions={busy:false,pending:false,onManual:()=>{throw Error('render invoked command')},onUpdated:()=>{throw Error('render invoked command')}},counts=summarizeAutomaticItems(rows),light=rows.map(row=>({...row,specification:'',color:'',sourceVariantIds:['variant'],parentSku:null,familyKey:'unresolved',familyResolved:false,independent:false,outcome:automaticItemOutcome(row),hasError:false,reason:automaticItemReason(row)}));
 const wrap=children=>renderToStaticMarkup(<NavigationMemoryContext.Provider value={new Map()}>{children}</NavigationMemoryContext.Provider>);
 const old=wrap(<AutomaticProductGroups memoryKey="status" groups={buildAutomaticProductGroups(rows,[])} sourceErrors={{}} loadingSources={false} revision="original" {...actions}/>),fresh=wrap(<AutomaticTaskGroups view={{kind:'page',task:{id:'status',revision:1,updatedAt:'original'},groups:[{productId:'product',title:'合成商品',items:light,counts}],total:1,page:1,pageSize:20}} products={[]} sources={[]} sourceErrors={{}} loadingSources={false} search="" onClearSearch={()=>{}} {...actions}/>);
 const history=wrap(<SalesItem item={{...base,lastContinuedAt:'2026-10-15T00:00:00.000Z',failureHistory:[{version:1,stage:'SOURCES',reason:'旧请求失败',occurredAt:'2026-10-15T01:00:00.000Z',source:'request-proof'},{version:1,stage:'SOURCES',reason:'本地核对失败',occurredAt:'2026-10-15T02:00:00.000Z',source:'local-check'},{version:1,stage:'SOURCES',reason:'旧失败',occurredAt:null}]}} memoryKey="history" expanded revision="refresh-is-not-time" {...actions}/>);
 return {old,fresh,history};}
 `},outfile:join(root,'status.cjs'),bundle:true,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent'});
 const rendered=createRequire(import.meta.url)(join(root,'status.cjs')).render();
 for(const html of [rendered.old,rendered.fresh]){assert.match(html,/包装抛重限制 1/);assert.match(html,/已收无效输出 1/);assert.match(html,/利润淘汰 0/);assert.match(html,/结果待核对 1/);}
 assert.match(rendered.history,/原请求明确失败凭据时间/);assert.match(rendered.history,/本次本地检查时间/);assert.match(rendered.history,/原失败时间未保存/);assert.match(rendered.history,/本次继续命令时间/);assert.match(rendered.history,/此失败历史未保存请求开始时间/);assert.match(rendered.history,/当前页面读取未发送新请求/);assert.doesNotMatch(rendered.history,/refresh-is-not-time|本次检查失败记录时间/);
});
