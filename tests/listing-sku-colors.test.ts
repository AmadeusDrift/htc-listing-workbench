import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures/listing-ai.ts';
import { buildListingContext } from './helpers/legacy-listing-context.ts';
import { assertListingEvidence, assertListingReview, validateListingFieldsOutput, validateListingReviewOutput } from '../src/main/listing-ai/validation.ts';
import type { ListingEvidence } from '../src/shared/listing-ai-contracts.ts';

const variantId='3c90c700-9c17-44b3-a5eb-a9abdbd2fc1d';
const multi='尺寸: 定制款多色橙+绿+黄+蓝 / 颜色: 大号21厘米长青蛙（带磁铁） · 1 pc';
const spring='尺寸: 春茶色渐变 / 颜色: 小号12厘米长青蛙（带磁铁） · 1 pc';
const spec=(value:string,id=variantId):ListingEvidence=>({id:`${id}:spec`,name:'Selected SKU specification',value,meaning:'general',source:'selected_sku'});
const context=(value:string)=>({variantId,fields:[{name:'color'},{name:'product_description'},{name:'item_name'}],evidence:[spec(value)]} as any);
const output=(field:string,value:string,evidenceIds=[`${variantId}:spec`])=>validateListingFieldsOutput({kind:'amazon-fields',candidates:[{field,items:[{value,evidenceIds,transformation:'translate'}]}],missing:[]});

test('Pine Needle Green source shade supports the color field and factual prose without borrowing another SKU',()=>{
  const c=context('尺寸: 松针绿单色 / 颜色: 中号15.5厘米长青蛙（带磁铁） · 1 pc');
  for(const [field,value] of [['color','Pine Needle Green'],['color','Pine Green'],['item_name','Pine Needle Green Frog Figurine'],['product_description','A green frog in a solid pine needle green finish.']])
    assert.doesNotThrow(()=>assertListingEvidence(output(field,value),c));
  for(const value of ['Sage Green','Pine Needle Green Gradient','Blue'])assert.throws(()=>assertListingEvidence(output('color',value),c));
  const other=spec(c.evidence[0].value,randomUUID());c.evidence.push(other);
  assert.throws(()=>assertListingEvidence(output('color','Pine Needle Green',[other.id]),c));
});

test('Luminous Natural translates the selected source shade without inferring a white or green body',()=>{
  const c=context('尺寸: 夜光本色 / 颜色: 中号15.5厘米长青蛙（带磁铁） · 1 pc');
  for(const value of ['Luminous Natural','Natural Glow-in-the-Dark','Glow in the Dark Natural'])
    assert.doesNotThrow(()=>assertListingEvidence(output('color',value),c));
  for(const value of ['White','Green','Natural White','Luminous Natural Blue','Pine Needle Green'])
    assert.throws(()=>assertListingEvidence(output('color',value),c));
  assert.throws(()=>assertListingEvidence(output('color','Luminous Natural'),context('颜色: 蓝色')));
});

test('a valid color citation is not invalidated by an additional unrelated but genuine fact citation',()=>{
  const c=context('颜色: 松针绿单色');c.evidence.push({id:'shape',name:'造型',value:'青蛙',meaning:'item_shape',source:'source_confirmed'});
  assert.doesNotThrow(()=>assertListingEvidence(output('color','Pine Needle Green',[`${variantId}:spec`,'shape']),c));
  assert.throws(()=>assertListingEvidence(output('color','Blue',[`${variantId}:spec`,'shape']),c));
  assert.throws(()=>assertListingEvidence(output('color','Pine Needle Green',['shape']),c));
  assert.throws(()=>assertListingEvidence(output('color','Pine Needle Green',[`${variantId}:spec`,'unknown']),c));
});

test('captured multicolor caption can cite the current selected SKU specification without rewriting saved context',()=>{
  const c=context(multi),before=structuredClone(c);
  assert.doesNotThrow(()=>assertListingEvidence(output('product_description','Multicolor orange, green, yellow and blue'),c));
  assert.deepEqual(c,before);
});

test('generic multicolor prose uses explicit current SKU context without requiring its spec citation on every phrase',()=>{
  const c=context(multi);c.evidence.push({id:'process',name:'工艺',value:'3D打印',meaning:'general',source:'source_confirmed'});
  const before=structuredClone(c);
  assert.doesNotThrow(()=>assertListingEvidence(output('product_description','Multicolor 3D-printed finish',['process']),c));
  assert.deepEqual(c,before);
  // Exact hues and the color field still require their cited color evidence.
  assert.throws(()=>assertListingEvidence(output('product_description','Multicolor red and blue finish',['process']),c));
  assert.throws(()=>assertListingEvidence(output('color','Multicolor',['process']),c));
});

test('generic multicolor context support excludes other SKUs, options, random and single-color specifications',()=>{
  for(const value of ['颜色: 蓝色','颜色: 随机红蓝','颜色: 红色或蓝色','颜色: 未知']){
    const c=context(value);c.evidence.push(spec(multi,randomUUID()),{id:'process',name:'工艺',value:'3D打印',meaning:'general',source:'source_confirmed'});
    assert.throws(()=>assertListingEvidence(output('product_description','Multicolor 3D-printed finish',['process']),c),value);
  }
});

test('captured Spring Tea Gradient color and independent review accept the selected specification translation',()=>{
  const c=context(spring),candidate=output('color','Spring Tea Gradient');
  assert.doesNotThrow(()=>assertListingEvidence(candidate,c));
  const review=validateListingReviewOutput({kind:'amazon-fields-review',verdict:'PASS',checks:[{field:'color',index:0,verdict:'SUPPORTED',evidenceIds:[`${variantId}:spec`],reason:'Current SKU shade.',claims:[{text:'Spring Tea Gradient',verdict:'SUPPORTED',evidenceIds:[`${variantId}:spec`],reason:'Current SKU shade.'}]}],issues:[]});
  assert.doesNotThrow(()=>assertListingReview(review,candidate,c));
  for(const unsupported of ['Green Gradient','Spring Tea Solid Color','Spring Tea Blue Gradient','Unicorn Rainbow']) assert.throws(()=>assertListingEvidence(output('color',unsupported),c),unsupported);
});

test('new contexts retain the saved evidence shape while accepting explicit colors in swapped supplier axes',async t=>{
  const f=await fixture(t);
  for(const [selected,color] of [[multi,'Multicolor Orange + Green + Yellow + Blue'],[spring,'Spring Tea Gradient']]){
    const product={...f.product,variants:[{...f.product.variants[0],normalizedSpec:selected},{...f.product.variants[0],id:randomUUID(),sku:'OTHER',normalizedSpec:'颜色: 红色'}]};
    const c=buildListingContext(f.draft,product,1),selectedSpec=c.evidence.find(e=>e.id===`${f.product.variants[0].id}:spec`)!;
    assert.equal(c.evidence.some(e=>e.id===`${f.product.variants[0].id}:color`),false,'adding derived evidence would invalidate saved image-context fingerprints');
    assert.equal(selectedSpec.value,selected); assert.equal(selectedSpec.source,'selected_sku');
    assert.doesNotThrow(()=>assertListingEvidence(output('color',color,[selectedSpec.id]),c));
    assert.throws(()=>assertListingEvidence(output('product_description','Red',[selectedSpec.id]),c));
  }
  const legacy=buildListingContext(f.draft,{...f.product,variants:[{...f.product.variants[0],normalizedSpec:'颜色: 蓝色'}]},1);
  assert.equal(legacy.evidence.find(e=>e.id===`${f.product.variants[0].id}:color`)?.value,'蓝色','keep the original value as well as its ID for saved fingerprints');
});

test('legacy selected-SKU spec citations support ordinary colors and explicit gradient modifiers only',()=>{
  for(const [source,value] of [['颜色: 蓝色','Blue'],['尺寸: 樱花粉单色 / 颜色: 大号青蛙','Cherry Blossom Pink'],['颜色: 浅蓝色渐变','Light Blue Gradient'],['规格: 透明蓝黄【四格一体】','Clear Blue-Yellow']]){
    assert.doesNotThrow(()=>assertListingEvidence(output('color',value),context(source)),value);
  }
  assert.throws(()=>assertListingEvidence(output('color','Blue Gradient'),context('颜色: 蓝色')));
  assert.throws(()=>assertListingEvidence(output('color','Light Blue'),context('颜色: 蓝色')));
});

test('foreign SKU spec references and product-wide option lists cannot establish the selected color',()=>{
  const c=context(multi),foreign=spec('颜色: 红色',randomUUID());c.evidence.push(foreign);
  assert.throws(()=>assertListingEvidence(output('color','Red',[foreign.id]),c));
  assert.throws(()=>assertListingEvidence(output('product_description','Red',[`${variantId}:spec`]),c));
  for(const source of ['红色、蓝色可选','颜色: 红色或蓝色','Available in red, green and blue','颜色: 可任选红绿蓝']){
    assert.throws(()=>assertListingEvidence(output('color','Blue'),context(source)),source);
  }
  const global={...spec('红色、蓝色可选'),id:'all-options',name:'规格',source:'source_confirmed' as const};
  assert.throws(()=>assertListingEvidence(output('color','Blue',['all-options']),{...context(multi),evidence:[global]}));
});

test('random or unknown colors never become a specific known color or a simultaneous multicolor item',()=>{
  for(const source of ['颜色: 随机红蓝 / 尺寸: 21cm','随机颜色','多种款式 随机发货','Assorted colors, red or blue']){
    const c=context(source);
    for(const value of ['Red','Blue','Multicolor Red and Blue'])assert.throws(()=>assertListingEvidence(output('color',value),c),`${source} -> ${value}`);
    assert.doesNotThrow(()=>assertListingEvidence(output('color','Random Color'),c));
  }
  for(const source of ['颜色: 未知，蓝色仅作示意','颜色: 未指定（红色或蓝色）','Unknown color, red example']){
    for(const value of ['Red','Blue','Multicolor Red and Blue'])assert.throws(()=>assertListingEvidence(output('color',value),context(source)),`${source} -> ${value}`);
  }
});

test('color fields cannot reduce an explicit multicolor variant to one component color',()=>{
  for(const source of [multi,'颜色: 红色+蓝色','规格: 透明蓝黄'])assert.throws(()=>assertListingEvidence(output('color','Blue'),context(source)),source);
  assert.doesNotThrow(()=>assertListingEvidence(output('product_description','Blue and yellow'),context('规格: 透明蓝黄')));
});

test('incidental strings and negated colors remain unusable as color evidence',()=>{
  for(const [source,value] of [['功能: 蓝牙','Blue'],['用途: 绿植装饰','Green'],['材质: 黄铜','Yellow'],['功能: 红外传感器','Red'],['型号: OrangePi','Orange'],['型号: Blackberry','Black'],['颜色: 不是蓝色','Blue'],['颜色: 不是红+蓝','Red + Blue'],['Color: not red','Red'],['尺寸: 21 cm','Magic Universal']]){
    assert.throws(()=>assertListingEvidence(output('color',value),context(source)),source);
  }
});

test('context extraction never borrows colors from another SKU or the product-wide choices',async t=>{
  const f=await fixture(t),product=structuredClone(f.product);
  product.variants[0].normalizedSpec='尺寸: 青蛙大号';
  product.variants.push({...product.variants[0],id:randomUUID(),sku:'OTHER',normalizedSpec:'颜色: 蓝色'});
  product.facts.push({id:randomUUID(),name:'颜色',value:'红色、蓝色可选',source:'1688',sourceRef:'',state:'source_confirmed'});
  const c=buildListingContext(f.draft,product,1);assert.equal(c.evidence.some(e=>e.meaning==='color'),false);
  assert.throws(()=>assertListingEvidence(output('color','Blue',[`${product.variants[0].id}:spec`]),c));
});

test('legacy derived color evidence cannot bypass a random, unknown or contradictory selected specification',async t=>{
  const f=await fixture(t);
  for(const source of ['颜色: 随机蓝色','颜色: 未知，蓝色仅作示意','颜色: 不是蓝色','颜色: 蓝色或随机色','尺寸: 定制款多色橙+绿+黄+蓝色']){
    const c=buildListingContext(f.draft,{...f.product,variants:[{...f.product.variants[0],normalizedSpec:source}]},1);
    const typed=c.evidence.find(e=>e.id===`${f.product.variants[0].id}:color`);assert.ok(typed,'keep the legacy context fingerprint stable');
    assert.throws(()=>assertListingEvidence(output('color','Blue',[typed.id]),c),source);
  }
});

test('explicitly typed bare Chinese colors retain their prior English translations',()=>{
  for(const [source,value] of [['蓝','Blue'],['绿','Green'],['灰','Grey']]){
    const c=context('尺寸: 小号');c.evidence=[{id:'confirmed-color',name:'颜色',meaning:'color',source:'human_confirmed',value:source}];
    assert.doesNotThrow(()=>assertListingEvidence(output('color',value,['confirmed-color']),c));
    assert.throws(()=>assertListingEvidence(output('color','Red',['confirmed-color']),c));
  }
});

test('confirmed metallic, transparent and named colors retain finite translations without restoring arbitrary English',()=>{
  for(const [source,values] of [['金色',['Gold']],['银色',['Silver']],['透明',['Clear','Transparent']],['无色',['Colorless']],['原木色',['Natural Wood']],['香槟色',['Champagne']],['玫瑰金',['Rose Gold']]] as const){
    const c=context('尺寸: 小号');c.evidence=[{id:'confirmed-color',name:'颜色',meaning:'color',source:'human_confirmed',value:source}];
    for(const value of values)assert.doesNotThrow(()=>assertListingEvidence(output('color',value,['confirmed-color']),c),`${source} -> ${value}`);
    for(const value of ['Unicorn Rainbow','Blue','Random Color',source==='金色'?'Silver':'Gold'])assert.throws(()=>assertListingEvidence(output('color',value,['confirmed-color']),c),`${source} -> ${value}`);
  }
});

test('extended color names require explicit selected specification words and do not alter ordinary prose checks',()=>{
  for(const [source,value] of [['颜色: 金色','Gold'],['规格: 玫瑰金','Rose Gold'],['颜色: 无色','Colorless']])assert.doesNotThrow(()=>assertListingEvidence(output('color',value),context(source)));
  for(const [source,value] of [['型号: 金','Gold'],['型号: 银','Silver'],['功能: 金属加工','Gold'],['颜色: 随机金色','Gold'],['颜色: 金色或银色','Silver']])assert.throws(()=>assertListingEvidence(output('color',value),context(source)));
  const c=context('普通展示款');
  for(const value of ['Clear product information','Gold medal display idea','Silver anniversary display','Display on a natural wood table'])assert.doesNotThrow(()=>assertListingEvidence(output('product_description',value),c),value);
});

test('confirmed typed English shade names remain usable as exact copies without guessing unknown translations',()=>{
  for(const name of ['Royal Blue','Ocean Blue'])for(const source of ['source_confirmed','human_confirmed'] as const){
    const c=context('尺寸: 小号');c.evidence=[{id:'confirmed-color',name:'颜色',meaning:'color',source,value:name}];
    assert.doesNotThrow(()=>assertListingEvidence(output('color',name,['confirmed-color']),c));
    assert.throws(()=>assertListingEvidence(output('color',name==='Royal Blue'?'Ocean Blue':'Royal Blue',['confirmed-color']),c));
  }
});

test('exact English copies cannot bypass selected specification, aggregate package or cross-SKU restrictions',()=>{
  const c=context('颜色: 随机蓝色'),derived={id:`${variantId}:color`,name:'Selected SKU color',value:'Royal Blue',meaning:'color' as const,source:'selected_sku' as const};c.evidence.push(derived);
  assert.throws(()=>assertListingEvidence(output('color','Royal Blue',[derived.id]),c));
  const foreign={...derived,id:`${randomUUID()}:color`};c.evidence.push(foreign);
  assert.throws(()=>assertListingEvidence(output('color','Royal Blue',[foreign.id]),c));
  const confirmed={id:'confirmed-color',name:'颜色',value:'Royal Blue',meaning:'color' as const,source:'human_confirmed' as const};
  c.evidence=[confirmed,{...derived,id:`${variantId}:sale-color`,name:'Sales package color (use this aggregate for the color field)',value:'Mixed colors'}];
  assert.throws(()=>assertListingEvidence(output('color','Royal Blue',[confirmed.id]),c));
});
