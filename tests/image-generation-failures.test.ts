import test from 'node:test';
import assert from 'node:assert/strict';
import { AiError } from '../src/main/ai/errors.ts';
import { OpenRouterImageAdapter } from '../src/main/ai/adapters/openrouter-images.ts';

test('OpenRouter classify server errors as unknown, preserving definitive request rejections',async()=>{
  for(const provider of ['openrouter'])for(const [status,definitive] of [[400,true],[401,true],[403,true],[408,false],[409,false],[429,true],[500,false],[502,false],[503,false],[504,false]] as const){
    let posts=0;
    const fetcher:typeof fetch=async(_url,init)=>{assert.equal(init?.method,'POST');posts++;return Response.json({error:{message:'mock failure'}},{status});};
    const input={apiKey:'local-fixture-key',prompt:'Source product image',size:'1024x1024' as const,quality:'high' as const,background:'opaque' as const,references:[]};
    const pending=new OpenRouterImageAdapter({fetch:fetcher}).generate({...input,model:'openai/gpt-image-2.5-sunburst'},new AbortController().signal);
    await assert.rejects(pending,error=>{assert.ok(error instanceof AiError);assert.equal((error as AiError&{definitive:boolean}).definitive,definitive,`${provider} ${status}`);return true;});
    assert.equal(posts,1,`${provider} ${status}`);
  }
});

test('the active image adapter prove local validation and reference-budget errors were not sent',async()=>{
  const bytes=Buffer.alloc(8*1024*1024);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(256,16);bytes.writeUInt32BE(256,20);
  for(const provider of ['openrouter'])for(const failure of ['input','budget']){
    let posts=0;const fetcher:typeof fetch=async()=>{posts++;throw new Error('Unexpected POST');};
    const input={apiKey:'local-fixture-key',prompt:failure==='input'?'':'Source product image',size:'1024x1024' as const,quality:'high' as const,background:'opaque' as const,
      references:failure==='budget'?Array.from({length:3},()=>({mimeType:'image/png' as const,bytes})):[]};
    const pending=new OpenRouterImageAdapter({fetch:fetcher}).generate({...input,model:'openai/gpt-image-2.5-sunburst'},new AbortController().signal);
    await assert.rejects(pending,error=>{assert.ok(error instanceof AiError);assert.equal((error as AiError&{notSent:boolean}).notSent,true,`${provider} ${failure}`);return true;});
    assert.equal(posts,0);
  }
});

test('malformed image responses expose a safe stage and never retry paid POSTs',async()=>{
  for(const malformed of ['json','shape','base64','raster']){
    let posts=0;
    const encoded=malformed==='base64'?'invalid-encoding!':Buffer.from('invalid raster').toString('base64');
    const body=malformed==='shape'?{}:{data:[{b64_json:encoded}]};
    const fetcher:typeof fetch=async()=>{posts++;return malformed==='json'?new Response('private-secret is not JSON'):Response.json(body);};
    const input={apiKey:'private-secret',prompt:'private prompt',size:'1024x1024' as const,quality:'high' as const,background:'opaque' as const,references:[]};
    const signal=new AbortController().signal;
    const pending=new OpenRouterImageAdapter({fetch:fetcher}).generate({...input,model:'openai/gpt-image-2.5-sunburst'},signal);
    await assert.rejects(pending,error=>{assert.ok(error instanceof AiError);assert.equal(error.code,'OUTPUT_INVALID');assert.match(error.message,new RegExp({json:'响应读取',shape:'响应结构',base64:'图片编码',raster:'图片格式'}[malformed]!));assert.equal(error.message.includes('private'),false);assert.notEqual((error as AiError&{definitive?:boolean}).definitive,true);return true;});
    assert.equal(posts,1);
  }
});
