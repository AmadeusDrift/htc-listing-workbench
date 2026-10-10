import type test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { WorkspaceStore } from '../../src/main/store.ts';
import { openDatabase } from '../../src/main/database.ts';
import { saveInput } from '../fixtures/listing-ai.ts';
import { resolveConsistencyContext } from '../../src/main/source-image-consistency/scope.ts';
function png(){const b=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(256,16);b.writeUInt32BE(256,20);return b;}
export function consistencyFixture(t:test.TestContext){
  mkdirSync(resolve('.test-data'),{recursive:true});const directory=mkdtempSync(resolve('.test-data/source-consistency-'));
  const store=new WorkspaceStore(directory),db=openDatabase(directory);let p=store.createProduct();
  p=store.saveProduct({...saveInput(p),variants:saveInput(p).variants.map(v=>({...v,originalSpec:'Blue round',normalizedSpec:'Blue round'}))});
  const id=randomUUID(),bytes=png();mkdirSync(resolve(directory,'assets'));writeFileSync(resolve(directory,`assets/${id}.png`),bytes);
  p=store.addAssets({productId:p.id,revision:p.revision},[{id,fileName:'synthetic.png',mimeType:'image/png',width:256,height:256,byteSize:bytes.length,originalPath:`assets/${id}.png`,previewPath:`assets/${id}.png`,sha256:createHash('sha256').update(bytes).digest('hex')}]);
  p=store.updateAsset({productId:p.id,revision:p.revision,assetId:id,role:'main',variantIds:[p.variants[0].id]});
  let storageClosed=false;const closeStorage=()=>{if(!storageClosed){storageClosed=true;db.close();store.close();}};
  const cleanup:(()=>void|Promise<void>)[]=[];
  t.after(async()=>{for(const fn of cleanup.reverse())await fn();closeStorage();assert.ok(resolve(directory).startsWith(resolve('.test-data')+'\\'));rmSync(directory,{recursive:true,force:true});});
  const context=()=>resolveConsistencyContext(db,store,directory,{productId:p.id,productRevision:store.getProduct(p.id).revision,variantId:p.variants[0].id});
  return{directory,store,db,p,context,cleanup,closeStorage};
}
