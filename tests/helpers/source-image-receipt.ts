import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { MiaoshouReceipt } from '../../src/shared/miaoshou-contracts.ts';
import { fingerprint, validateMiaoshouReceipt } from '../../src/main/miaoshou/validation.ts';
import { collectionSnapshot } from './collection-fixture.ts';
import { collectionFingerprint, validateCollectionReceipt, validateCollectionSnapshot } from '../../src/main/collection/validation.ts';
import type { ProductDetail } from '../../src/shared/contracts.ts';

export const sourceImageId=(url:string)=>`ms_${createHash('sha256').update(url).digest('hex').slice(0,32)}`;
/** Upgrade deliberately minimal legacy download fixtures to authentic persisted receipt identities. */
export function persistSourceImageFixture(directory:string,raw:MiaoshouReceipt):MiaoshouReceipt {
  const images=raw.snapshot.images.map(i=>({...i,id:sourceImageId(i.url)}));
  const skuMappings=(raw.skuMappings??[]).map(m=>({...m,imageIds:m.imageIds.map(id=>images[raw.snapshot.images.findIndex(i=>i.id===id)]?.id??id)}));
  const snapshot={remoteId:'123456',title:'Synthetic source',description:'',capturedAt:'2026-10-01T00:00:00.000Z',sources:[],attributes:[],warnings:[],images,
    skus:skuMappings.map(m=>({key:m.sourceKey,itemNum:'',price:null,oriPrice:null,stock:null,oriStock:null,weight:null,packageLength:null,packageWidth:null,packageHeight:null})),
    dimensions:[{id:'color' as const,name:'Color',values:skuMappings.map(m=>({id:m.sourceKey,name:m.sourceKey,imageUrls:m.imageIds.map(id=>images.find(i=>i.id===id)!.url)}))}]};
  const mapping={priceField:'none' as const,currency:'unknown' as const,skus:skuMappings.map(m=>({sourceKey:m.sourceKey,dimensions:{color:m.sourceKey}})).sort((a,b)=>a.sourceKey<b.sourceKey?-1:1)},accountScope='a'.repeat(64);
  const receipt=validateMiaoshouReceipt({id:randomUUID(),productId:raw.productId,mode:'live',receivedAt:snapshot.capturedAt,accountScope,snapshot,mapping,skuMappings,fingerprint:fingerprint(snapshot,mapping,accountScope,'live')});
  const db=new DatabaseSync(join(directory,'red.sqlite'));try{db.prepare('INSERT INTO miaoshou_receipts VALUES(?,?)').run(receipt.id,JSON.stringify(receipt));}finally{db.close();}
  Object.assign(raw,receipt);return raw;
}
export function attachNativeHistory(directory:string,product:ProductDetail) {
  let snapshot=collectionSnapshot();snapshot.skus=Array.from({length:20},(_,i)=>({...snapshot.skus[0],providerSkuId:`native-${i}`}));snapshot.skuImages=[];snapshot=validateCollectionSnapshot(snapshot);
  const firstCaptureId=randomUUID(),receipt=validateCollectionReceipt({id:randomUUID(),firstCaptureId,productId:product.id,fingerprint:collectionFingerprint(snapshot),receivedAt:snapshot.capturedAt,snapshot,skuMappings:snapshot.skus.map((s,i)=>({providerSkuId:s.providerSkuId,localVariantId:i===0?product.variants[0].id:randomUUID()}))});
  const db=new DatabaseSync(join(directory,'red.sqlite'));try{
    db.prepare('INSERT INTO collection_receipts VALUES(?,?)').run(receipt.id,JSON.stringify(receipt));
    db.prepare('INSERT INTO collection_captures VALUES(?,?)').run(firstCaptureId,JSON.stringify({id:firstCaptureId,receiptId:receipt.id,fingerprint:receipt.fingerprint,capturedAt:snapshot.capturedAt,receivedAt:receipt.receivedAt,duplicate:false}));
  }finally{db.close();}
  return receipt;
}
