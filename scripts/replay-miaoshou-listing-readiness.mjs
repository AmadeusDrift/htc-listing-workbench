import { readFile, writeFile } from 'node:fs/promises';
import { analyzeMiaoshouMeasurements } from '../src/shared/miaoshou-measurements.ts';
import { defaultListingRules, quoteListing } from '../src/shared/listing-rules.ts';
import { convertMeasurement } from '../src/main/amazon/field-mapping.ts';

// Replay only: do not assign a guessed Amazon category or call any provider.
const folder = new URL('../artifacts/miaoshou-api-field-audit-2026-10-07/', import.meta.url);
const products = JSON.parse(await readFile(new URL('sync-live-snapshots.json',folder),'utf8'));
const rules = defaultListingRules();
const fallbackDimensions = rules.product.dimensions.map(value => convertMeasurement(value,rules.product.dimensionUnit,'length').value);
const fallbackWeight = convertMeasurement(rules.product.packageWeight,rules.product.weightUnit,'weight').value;
const rows = products.map(product => {
  const measurement = analyzeMiaoshouMeasurements(product);
  const skus = product.skus.map((sku,index) => {
    const source = measurement.skus.find(row=>row.sourceKey===sku.key), fallbackFields=[];
    const take = (field,fallback) => {
      if(source.values[field]) return source.values[field].value;
      if(source.evidence.some(e=>e.field===field&&e.status==='conflict')) return null;
      fallbackFields.push(field);return fallback;
    };
    const dimensionsInches=['length','width','height'].map((axis,i)=>take(`package.${axis}`,fallbackDimensions[i]));
    const weightPounds=take('package.weight',fallbackWeight);
    let quote=null, reason=null;
    try {
      if(dimensionsInches.includes(null)||weightPounds===null)throw Error('包装参数冲突，需要人工核对');
      if(!sku.price||!Number.isFinite(Number(sku.price))||Number(sku.price)<=0)throw Error('采购成本缺失');
      // A scenario, not a selected user mapping: one source sales unit, price assumed CNY.
      quote=quoteListing({costCny:Number(sku.price),dimensionsInches,weightPounds},rules.pricing);
    } catch(error) { reason=error.message; }
    return {sourceKey:sku.key,specification:source.specification,selectedByDefaultVariantLimit:index<rules.product.variantLimit,
      sourcePrice:sku.price,originalSourceWeight:sku.weight,confirmedValues:source.values,
      scenario:{purchaseCurrency:'CNY (replay assumption; confirm before import)',salesUnits:1,dimensionsInches,weightPounds,fallbackFields,quote,reason},
      unresolved:['目标类目尚未确认，未下载或套用该商品的真实 Amazon Schema','尚未执行 Amazon VALIDATION_PREVIEW',...(fallbackFields.length?['包装尺寸或重量含业务默认，尚不能判定真实物流合格']:[])]};
  });
  return {remoteId:product.remoteId,title:product.title,skuCount:skus.length,selectedSkuCount:skus.filter(s=>s.selectedByDefaultVariantLimit).length,plannedStockSetsPerSelectedSku:rules.product.stockSets,skus};
});
const all=rows.flatMap(row=>row.skus);
const summary={products:rows.length,skus:all.length,selectedByDefaultVariantLimit:all.filter(row=>row.selectedByDefaultVariantLimit).length,
  withAnyConfirmedItemDimension:all.filter(row=>['length','width','height'].some(axis=>row.confirmedValues[`item.${axis}`])).length,
  withFullConfirmedPackageDimensions:all.filter(row=>['length','width','height'].every(axis=>row.confirmedValues[`package.${axis}`])).length,
  withConfirmedPackageWeight:all.filter(row=>row.confirmedValues['package.weight']).length,
  scenarioQuotesWithinPriceCap:all.filter(row=>row.scenario.quote).length,scenarioQuoteExceptions:all.filter(row=>!row.scenario.quote).length,
  realAmazonPreviews:0,deepSeekCalls:0};
await writeFile(new URL('listing-readiness-replay.json',folder),JSON.stringify({generatedAt:new Date().toISOString(),method:'Offline source/measurement/pricing replay; not Amazon validation or category assignment',rules,summary,products:rows},null,2)+'\n');
const lines=['# 12 件妙手商品离线准备检查','','使用已成功读取的真实妙手快照；仅运行本地整理与定价算法。未调用 Amazon、DeepSeek，未把其他类目的字段套到这些商品。','',
  `合计 ${summary.products} 件商品 / ${summary.skus} 个 SKU；默认每商品最多 ${rules.product.variantLimit} 个，自动准备会选 ${summary.selectedByDefaultVariantLimit} 个，原始 ${summary.skus} 个全部保留。`,
  `有商品尺寸文字依据 ${summary.withAnyConfirmedItemDimension} 个 SKU；有完整包装尺寸依据 ${summary.withFullConfirmedPackageDimensions} 个；有明确包装毛重依据 ${summary.withConfirmedPackageWeight} 个。`,'',
  '以下价格仅为“price 是人民币、按来源销售单元单独售卖”的情景计算；没有自动组套，没有确认采购单位，也不表示物流或上架通过。使用业务默认包装参数的结果仍须核实。','',
  '| 商品 | 来源 SKU | 默认选取 | 情景价格可算 / 异常 |','| --- | ---: | ---: | ---: |',
  ...rows.map(row=>`| ${row.title.replaceAll('|','／')} | ${row.skuCount} | ${row.selectedSkuCount} | ${row.skus.filter(s=>s.scenario.quote).length} / ${row.skus.filter(s=>!s.scenario.quote).length} |`),'',
  '实际预览前仍需确认每件商品的 Amazon 类目、采购币种和销售单位，并读取对应 Schema。证书、负责人、注册号等真实资料只列缺项，不由 AI 编造。当前不能把页面启用标签与磁盘凭据读数的不一致解释为密钥失效。'];
await writeFile(new URL('../../docs/12件妙手商品离线准备检查_2026-10-07.md',folder),lines.join('\n')+'\n');
console.log(JSON.stringify(summary,null,2));
