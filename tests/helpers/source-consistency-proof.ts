import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import type { WorkspaceStore } from '../../src/main/store.ts';
import { openDatabase } from '../../src/main/database.ts';
import { resolveConsistencyContext } from '../../src/main/source-image-consistency/scope.ts';
import { readConsistencyView,saveConsistencyDecision } from '../../src/main/source-image-consistency/proof.ts';

/** Explicit test fixture authority, through the real main-process decision path. No network. */
export async function confirmSourceConsistencyFixture(directory:string,store:WorkspaceStore,productId:string,variantIds?:string[]):Promise<void>{
  const db=openDatabase(directory);try{
    const product=store.getProduct(productId);
    for(const variantId of variantIds??product.variants.map(v=>v.id)){
      const input={productId,productRevision:product.revision,variantId},context=resolveConsistencyContext(db,store,directory,input),view=readConsistencyView(db,context);
      await saveConsistencyDecision(db,store,directory,{...input,fingerprint:view.fingerprint,decision:'CONFIRMED',reason:'Synthetic test fixture: checked this exact original image against the selected source specification; no dimensions or material verified'});
    }
  }finally{db.close();}
}

/** Real managed bytes for pre-existing service fixtures; never a production bypass. */
export function addSourceOriginalFixture(directory:string,store:WorkspaceStore,productId:string,variantIds:string[],role:'main'|'gallery'='main',marker=0){
  const product=store.getProduct(productId),id=randomUUID(),bytes=Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(1000,16);bytes.writeUInt32BE(1000,20);bytes[32]=marker;
  mkdirSync(join(directory,'assets'),{recursive:true});writeFileSync(join(directory,`assets/${id}.png`),bytes);
  const imported=store.addAssets({productId,revision:product.revision},[{id,fileName:'synthetic-original.png',mimeType:'image/png',width:1000,height:1000,byteSize:bytes.length,originalPath:`assets/${id}.png`,previewPath:`assets/${id}.png`,sha256:createHash('sha256').update(bytes).digest('hex')}]);
  return store.updateAsset({productId,revision:imported.revision,assetId:id,role,variantIds});
}

/** Persist a bounded legacy state-machine fixture at its explicit source-delivery boundary. */
export function materializeSourceSnapshot(directory:string,product:import('../../src/shared/contracts.ts').ProductDetail,variantIds:string[]):void{
  const db=openDatabase(directory);try{
    db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,title=excluded.title,description=excluded.description').run(product.id,product.title,product.sourceUrl,product.description,product.status,product.origin,product.revision,product.createdAt,product.updatedAt);
    product.variants.forEach((v,i)=>db.prepare('INSERT INTO variants VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET original_spec=excluded.original_spec,normalized_spec=excluded.normalized_spec,source_spec=excluded.source_spec').run(v.id,product.id,v.sku,v.originalSpec,v.normalizedSpec,v.purchasePrice,v.inventory,v.sourceSpec,v.sourcePurchasePrice,i));
    for(const variantId of variantIds){
      if(db.prepare('SELECT 1 FROM variant_assets WHERE variant_id=?').get(variantId))continue;
      const id=randomUUID(),bytes=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(1000,16);bytes.writeUInt32BE(1000,20);bytes[32]=product.variants.findIndex(v=>v.id===variantId);
      mkdirSync(join(directory,'assets'),{recursive:true});writeFileSync(join(directory,`assets/${id}.png`),bytes);
      const role=db.prepare('SELECT 1 FROM assets WHERE product_id=?').get(product.id)?'gallery':'main',path=`assets/${id}.png`;
      db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,product.id,'synthetic-original.png',role,'image/png',1000,1000,bytes.length,path,path,createHash('sha256').update(bytes).digest('hex'),product.createdAt);
      db.prepare('INSERT INTO variant_assets VALUES(?,?,1,?)').run(id,variantId,product.createdAt);
      product.assets.push({id,fileName:'synthetic-original.png',role,mimeType:'image/png',width:1000,height:1000,byteSize:bytes.length,previewUrl:'',variantIds:[variantId],createdAt:product.createdAt} as any);
    }
  }finally{db.close();}
}
