// Network-free harness around the actual built production entry and UI.
const { resolve } = require('node:path');
globalThis.__listingAiTest = { mode:'normal', calls:0 };
globalThis.fetch = async (url, options) => {
  if (String(url)!=='https://api.deepseek.com/chat/completions') throw Error('Unexpected test network request');
  globalThis.__listingAiTest.calls++;
  if(globalThis.__listingAiTest.mode==='hold')return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
  const body=JSON.parse(options.body),p=JSON.parse(body.messages[1].content);
  let result;
  if(p.candidate){result={kind:'amazon-fields-review',verdict:'PASS',checks:p.candidate.candidates.flatMap(c=>c.items.map((item,index)=>({field:c.field,index,verdict:'SUPPORTED',evidenceIds:item.evidenceIds,reason:'Matches fixture facts.',claims:[{text:item.value,verdict:'SUPPORTED',evidenceIds:item.evidenceIds,reason:'Matches fixture facts.'}]}))),issues:[]};}
  else {const m=p.evidence.find(e=>e.meaning==='material'),c=p.evidence.find(e=>e.meaning==='color')??p.evidence.find(e=>e.id.endsWith(':spec'));
    const values={material:['Silicone',[m.id]],color:['Blue',[c.id]],item_name:['Blue Silicone Coaster',[m.id,c.id]],product_description:['A blue silicone coaster.',[m.id,c.id]]};
    result={kind:'amazon-fields',candidates:p.fields.filter(f=>values[f.name]).map(f=>({field:f.name,items:[{value:values[f.name][0],evidenceIds:values[f.name][1],transformation:'translate'}]})),missing:p.fields.filter(f=>!values[f.name]).map(f=>({field:f.name,reason:'Need more facts.'}))};
    if(p.contract==='listing-full-schema/v1'){
      result.contract=p.contract;
      result.candidates=result.candidates.map(({field,items})=>{
        const schema=p.fullSchema.schema.properties[field],props=schema.items?.properties;
        const value=items[0].value,nativeValue=schema.type==='array'?[props?{value,...(props.marketplace_id?{marketplace_id:p.marketplaceId}:{}),...(props.language_tag?{language_tag:p.locale}: {})}:value]:value;
        return {field,nativeValue,evidenceIds:items[0].evidenceIds,transformation:'translate'};
      });
    }
  }
  return new Response(JSON.stringify({id:'listing-ui-fixture',choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}}));
};
require(resolve('dist-electron/main.cjs'));
