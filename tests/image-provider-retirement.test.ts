import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync } from 'node:fs';
import { resolve,join,dirname } from 'node:path';
import { WorkspaceStore } from '../src/main/store.ts';
import { ImageGenerationService } from '../src/main/image-generation/service.ts';
import { mockStorage } from './fixtures/listing-ai.ts';

test('official and relay image connections cannot be saved, checked or selected',async t=>{
  const root=resolve('.test-data');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'retired-image-')),store=new WorkspaceStore(directory);let requests=0;
  const service=new ImageGenerationService(directory,store,mockStorage,{decodePreview:b=>b,fetch:async()=>{requests++;throw Error('No real request');}});
  t.after(async()=>{await service.close();store.close();assert.equal(dirname(directory),root);rmSync(directory,{recursive:true,force:true});});
  for(const provider of ['openai','tyai'] as const){
    assert.throws(()=>service.saveConnection({provider,model:'gpt-image-2.5-sunburst',enabled:true,apiKey:'sk-retired-key-fixture'}));
    assert.throws(()=>service.getConnection(provider));await assert.rejects(service.checkConnection(provider));
  }
  assert.equal(requests,0);assert.equal(service.getConnection().provider,'openrouter');assert.equal(service.getConnection().configured,false);
});
