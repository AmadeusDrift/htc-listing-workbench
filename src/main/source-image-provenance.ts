import { readManagedImageSync } from './ai/source.ts';
import type { DatabaseSync } from 'node:sqlite';
import { keys, uuid, integer, sha256, date, boundedText } from './ai/validation.ts';
import { readSourceImageReceipt, sourceImageMappings } from './source-images.ts';
import { listingFingerprint } from './listing-ai/validation.ts';
import { assertUnambiguousRecordJson } from './record-json.ts';
import { UserFacingError } from '../shared/errors.ts';

export interface SourceImageProvenance {
  version:'source-image-provenance/v1';id:string;productId:string;receiptKind:'native1688'|'miaoshou';receiptId:string;receiptFingerprint:string;
  imageId:string;url:string;mappings:{localVariantId:string;sourceSku:string;basis:'provider-sku-id'|'spec-value'|'miaoshou-mapping';specName:string|null;specValue:string|null}[];
  assetId:string;sha256:string;byteSize:number;mimeType:'image/png'|'image/jpeg';width:number;height:number;observedAt:string;
}
const reject=():never=>{throw new UserFacingError('来源图片身份记录不完整或已变化');};
export function validateSourceImageProvenance(raw:unknown):SourceImageProvenance {
  const o=keys(raw,['version','id','productId','receiptKind','receiptId','receiptFingerprint','imageId','url','mappings','assetId','sha256','byteSize','mimeType','width','height','observedAt']);
  if(o.version!=='source-image-provenance/v1'||!['native1688','miaoshou'].includes(String(o.receiptKind))||!['image/png','image/jpeg'].includes(String(o.mimeType))||!Array.isArray(o.mappings)||o.mappings.length>200)return reject();
  const seen=new Set<string>();
  const mappings=o.mappings.map(raw=>{const m=keys(raw,['localVariantId','sourceSku','basis','specName','specValue']);
    if(!['provider-sku-id','spec-value','miaoshou-mapping'].includes(String(m.basis))||(o.receiptKind==='miaoshou')!==(m.basis==='miaoshou-mapping'))return reject();
    const id=uuid(m.localVariantId);if(seen.has(id))return reject();seen.add(id);
    if(m.basis!=='spec-value'&&(m.specName!==null||m.specValue!==null))return reject();
    if(m.basis==='spec-value'&&(m.specName===null||m.specValue===null))return reject();
    return {localVariantId:id,sourceSku:boundedText(m.sourceSku,256),basis:m.basis as SourceImageProvenance['mappings'][number]['basis'],specName:m.specName===null?null:boundedText(m.specName,100),specValue:m.specValue===null?null:boundedText(m.specValue,500)};
  });
  const url=boundedText(o.url,2048);if(!url.startsWith('https://'))return reject();
  return {version:'source-image-provenance/v1',id:uuid(o.id),productId:uuid(o.productId),receiptKind:o.receiptKind as SourceImageProvenance['receiptKind'],receiptId:uuid(o.receiptId),receiptFingerprint:sha256(o.receiptFingerprint),imageId:boundedText(o.imageId,100),url,mappings,assetId:uuid(o.assetId),sha256:sha256(o.sha256),byteSize:integer(o.byteSize,1,20*1024*1024),mimeType:o.mimeType as SourceImageProvenance['mimeType'],width:integer(o.width,1,100000),height:integer(o.height,1,100000),observedAt:date(o.observedAt)};
}
export function assertSourceImageProvenance(db:DatabaseSync,value:SourceImageProvenance,directory?:string):{relativePath:string;sha256:string;byteSize:number} {
  const source=readSourceImageReceipt(db,value.productId);
  if(!source||source.kind!==value.receiptKind||source.receipt.id!==value.receiptId||source.receipt.fingerprint!==value.receiptFingerprint)return reject();
  const image=source.receipt.snapshot.images.find(i=>i.id===value.imageId);
  const mappings=sourceImageMappings(source).flatMap(m=>m.images.filter(i=>i.imageId===value.imageId).map(({imageId,...i})=>({localVariantId:m.localVariantId,sourceSku:m.sourceSku,...i})));
  if(!image||image.url!==value.url||listingFingerprint(mappings)!==listingFingerprint(value.mappings))return reject();
  for(const mapping of value.mappings){const owner=db.prepare('SELECT product_id FROM variants WHERE id=?').get(mapping.localVariantId);if(owner&&owner.product_id!==value.productId)return reject();}
  const a=db.prepare('SELECT * FROM assets WHERE id=?').get(value.assetId);
  if(!a||a.product_id!==value.productId||a.sha256!==value.sha256||a.byte_size!==value.byteSize||a.mime_type!==value.mimeType||a.width!==value.width||a.height!==value.height)return reject();
  const relativePath=String(a.original_path);
  if(relativePath!==`assets/${value.assetId}.${value.mimeType==='image/png'?'png':'jpg'}`)return reject();
  if(directory)readManagedImageSync(directory,{id:value.assetId,productId:value.productId,fileName:String(a.file_name),originalPath:relativePath,previewPath:String(a.preview_path),sha256:value.sha256,byteSize:value.byteSize,mimeType:value.mimeType,width:value.width,height:value.height});
  return {relativePath,sha256:value.sha256,byteSize:value.byteSize};
}
export function assertSourceImageHistory(db:DatabaseSync,directory?:string) {
  const columns=db.prepare('PRAGMA table_xinfo(source_image_provenance)').all(),indexes=db.prepare('PRAGMA index_list(source_image_provenance)').all();
  if(columns.length!==2||columns.some(c=>!['id','record_json'].includes(String(c.name))||c.type!=='TEXT'||c.notnull!==1||c.pk!==(c.name==='id'?1:0)||c.hidden!==0||c.dflt_value!==null)
    ||indexes.length!==1||indexes[0].origin!=='pk'||indexes[0].unique!==1||db.prepare('PRAGMA foreign_key_list(source_image_provenance)').all().length)return reject();
  assertUnambiguousRecordJson(db,'source_image_provenance');const seen=new Set<string>();
  return db.prepare('SELECT id,record_json FROM source_image_provenance').all().map(row=>{
    const value=validateSourceImageProvenance(JSON.parse(String(row.record_json))),identity=`${value.receiptKind}:${value.receiptId}:${value.imageId}:${value.assetId}`;
    if(row.id!==value.id||seen.has(identity))return reject();seen.add(identity);
    return assertSourceImageProvenance(db,value,directory);
  });
}
