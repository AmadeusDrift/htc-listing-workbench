import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObjectParser, PDFRawStream, PDFRef, type PDFContext, type PDFObject } from 'pdf-lib';
import type { ItemLabelFile } from '../../shared/item-label-contracts.ts';
import { identifier } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';

function usedObjectNumbers(context:PDFContext):Set<number>{
  const numbers=new Set<number>(),seen=new Set<PDFObject>(),pending:PDFObject[]=[];
  for(const [reference,value] of context.enumerateIndirectObjects()){numbers.add(reference.objectNumber);pending.push(value);}
  for(const value of Object.values(context.trailerInfo))if(value)pending.push(value);
  while(pending.length){
    const value=pending.pop()!;if(seen.has(value))continue;seen.add(value);
    if(seen.size>200000)throw Error('object graph limit');
    if(value instanceof PDFRef)numbers.add(value.objectNumber);
    else if(value instanceof PDFDict)pending.push(...value.values());
    else if(value instanceof PDFArray)pending.push(...value.asArray());
    else if(value instanceof PDFRawStream)pending.push(value.dict);
  }
  return numbers;
}
function declaredRoot(bytes:Buffer,offset:number,context:PDFContext):PDFRef{
  const seen=new Set<number>();let used:Set<number>|undefined;
  while(!seen.has(offset)&&seen.size<64){
    seen.add(offset);const source=bytes.subarray(offset).toString('latin1');let trailer:PDFDict;
    if(/^xref\s/.test(source)){
      let remaining=source.replace(/^xref\s+/,'');let entries=0;
      while(!/^trailer\b/.test(remaining)){
        const section=/^(\d+)\s+(\d+)\s+/.exec(remaining);if(!section)throw Error('xref subsection');
        const first=Number(section[1]),count=Number(section[2]);if(!Number.isSafeInteger(first)||!Number.isSafeInteger(count)||count<1||first+count>1000000||(entries+=count)>1000000)throw Error('xref size');
        remaining=remaining.slice(section[0].length);
        for(let i=0;i<count;i++){
          const entry=/^(\d{10})\s+(\d{5})\s+([nf])\s+/.exec(remaining);if(!entry)throw Error('xref entry');
          if(entry[3]==='n'){
            const address=Number(entry[1]),generation=Number(entry[2]);
            // Amazon's label exporter emits unused placeholders with this exact tuple.
            // Accept only absent, unreferenced objects; real object offsets stay strict.
            const unusedPlaceholder=address===0&&generation===65536&&first+i>0&&!(used??=usedObjectNumbers(context)).has(first+i);
            const object=new RegExp('^'+(first+i)+'\\s+'+generation+'\\s+obj\\b');
            if(!unusedPlaceholder&&(address<8||address>=bytes.length||!object.test(bytes.subarray(address,address+64).toString('latin1'))))throw Error('xref offset');
          }
          remaining=remaining.slice(entry[0].length);
        }
      }
      const parsed=PDFObjectParser.forBytes(Buffer.from(remaining.replace(/^trailer\s*/,''),'latin1'),context).parseObject();if(!(parsed instanceof PDFDict))throw Error('trailer');trailer=parsed;
    }else{
      const header=/^\d+\s+\d+\s+obj\b\s*/.exec(source);if(!header)throw Error('xref stream header');
      const stream=PDFObjectParser.forBytes(bytes.subarray(offset+header[0].length),context).parseObject();
      if(!(stream instanceof PDFRawStream)||stream.dict.lookup(PDFName.of('Type'))!==PDFName.of('XRef'))throw Error('xref stream');trailer=stream.dict;
    }
    const size=trailer.lookup(PDFName.of('Size'));if(!(size instanceof PDFNumber)||!Number.isSafeInteger(size.asNumber())||size.asNumber()<2)throw Error('trailer size');
    const root=trailer.get(PDFName.of('Root'));if(root!==undefined){if(!(root instanceof PDFRef))throw Error('catalog reference');return root;}
    const previous=trailer.lookup(PDFName.of('Prev'));if(!(previous instanceof PDFNumber)||!Number.isSafeInteger(previous.asNumber())||previous.asNumber()<8||previous.asNumber()>=offset)throw Error('missing catalog');offset=previous.asNumber();
  }
  throw Error('xref chain');
}
function validatePages(context:PDFContext,catalog:PDFDict):void{
  const visited=new Set<PDFObject>();let leaves=0;
  const visit=(reference:PDFObject|undefined,parent:PDFObject|undefined,mediaBox:PDFObject|undefined,depth:number):number=>{
    if(!(reference instanceof PDFRef)||depth>64)throw Error('page reference');const node=context.lookup(reference);
    if(!(node instanceof PDFDict)||visited.has(node)||visited.size>=20000)throw Error('page tree');visited.add(node);
    if(parent&&node.get(PDFName.of('Parent'))!==parent)throw Error('page parent');
    const media=node.lookup(PDFName.of('MediaBox'))??mediaBox,type=node.lookup(PDFName.of('Type'));
    if(type===PDFName.of('Page')){
      if(!parent||++leaves>10000||!(media instanceof PDFArray)||media.size()!==4)throw Error('page');
      const bounds=media.asArray().map(value=>{const number=context.lookup(value);if(!(number instanceof PDFNumber)||!Number.isFinite(number.asNumber()))throw Error('page bounds');return number.asNumber();});
      if(bounds[2]<=bounds[0]||bounds[3]<=bounds[1])throw Error('page bounds');
      const content=context.lookup(node.get(PDFName.of('Contents')));
      if(node.has(PDFName.of('Contents'))){if(content instanceof PDFArray){for(const entry of content.asArray())if(!(context.lookup(entry) instanceof PDFRawStream))throw Error('page content');}else if(!(content instanceof PDFRawStream))throw Error('page content');}
      return 1;
    }
    if(type!==PDFName.of('Pages'))throw Error('page tree type');const kids=node.lookup(PDFName.of('Kids')),count=node.lookup(PDFName.of('Count'));
    if(!(kids instanceof PDFArray)||!kids.size()||!(count instanceof PDFNumber)||!Number.isSafeInteger(count.asNumber())||count.asNumber()<1||count.asNumber()>10000)throw Error('page count');
    let actual=0;for(const child of kids.asArray())actual+=visit(child,reference,media,depth+1);if(actual!==count.asNumber())throw Error('page count');return actual;
  };
  visit(catalog.get(PDFName.of('Pages')),undefined,undefined,0);if(!leaves)throw Error('empty document');
}
export async function validateLabelPdf(bytes: Buffer): Promise<void> {
  if(bytes.length<64||bytes.length>32*1024*1024||!/^%PDF-[12]\.\d/.test(bytes.subarray(0,8).toString('latin1')))throw new UserFacingError('下载内容不是有效 PDF 标签');
  const tail=bytes.subarray(-2048).toString('latin1'),matches=[...tail.matchAll(/startxref\s+(\d+)\s+%%EOF/g)],last=matches.at(-1);
  if(!last||!/^\s*$/.test(tail.slice(last.index!+last[0].length)))throw new UserFacingError('PDF 标签文件不完整');
  const offset=Number(last[1]); if(!Number.isSafeInteger(offset)||offset<8||offset>=bytes.length)throw new UserFacingError('PDF 标签索引无效');
  const section=bytes.subarray(offset,Math.min(bytes.length,offset+4096)).toString('latin1');
  if(!/^xref\s/.test(section)&&!/^\d+\s+\d+\s+obj\b[\s\S]*\/Type\s*\/XRef\b/.test(section))throw new UserFacingError('PDF 标签索引无效');
  try{
    const document=await PDFDocument.load(bytes,{throwOnInvalidObject:true,updateMetadata:false});
    const root=declaredRoot(bytes,offset,document.context),catalog=document.context.lookup(root);
    if(!(catalog instanceof PDFDict)||catalog!==document.catalog||catalog.lookup(PDFName.of('Type'))!==PDFName.of('Catalog'))throw Error('catalog');
    validatePages(document.context,catalog);
  }catch{throw new UserFacingError('PDF 标签文档结构或页面无效');}
}
async function managedPath(directory:string,rel:string):Promise<string>{
  const root=await realpath(directory),path=resolve(root,rel),inside=relative(root,path);
  if(!inside||inside.startsWith('..')||isAbsolute(inside))throw new UserFacingError('标签文件路径无效');
  let cursor=root;
  for(const segment of inside.split(/[\\/]/).slice(0,-1)){cursor=join(cursor,segment);try{const stat=await lstat(cursor);if(stat.isSymbolicLink()||!stat.isDirectory())throw new UserFacingError('标签目录不能使用链接');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(cursor);}}
  try{if((await lstat(path)).isSymbolicLink())throw new UserFacingError('标签文件不能使用链接');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return path;
}
export async function saveLabelPdf(directory:string,id:string,index:number,bytes:Buffer):Promise<ItemLabelFile>{
  identifier(id);if(!Number.isSafeInteger(index)||index<1||index>100)throw new UserFacingError('标签文件序号无效');await validateLabelPdf(bytes);
  const relativePath=`documents/item-labels/${id}/${index}.pdf`,path=await managedPath(directory,relativePath),temp=join(dirname(path),randomUUID()+'.tmp');
  try{const handle=await open(temp,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await rename(temp,path);}finally{await rm(temp,{force:true});}
  const descriptor={relativePath,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length,index};await verifyLabelPdf(directory,descriptor);return descriptor;
}
export async function readVerifiedLabelPdf(directory:string,file:ItemLabelFile):Promise<{path:string;bytes:Buffer}>{
  if(!/^documents\/item-labels\/[a-f0-9-]{36}\/[1-9]\d?\d?\.pdf$/.test(file.relativePath))throw new UserFacingError('标签文件引用无效');
  const path=await managedPath(directory,file.relativePath),stat=await lstat(path);if(!stat.isFile()||stat.size!==file.byteSize||stat.size>32*1024*1024)throw new UserFacingError('标签文件大小校验失败');
  const bytes=await readFile(path);await validateLabelPdf(bytes);if(bytes.length!==file.byteSize||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new UserFacingError('标签文件校验值不匹配');return {path,bytes};
}
export async function verifyLabelPdf(directory:string,file:ItemLabelFile):Promise<string>{return (await readVerifiedLabelPdf(directory,file)).path;}
