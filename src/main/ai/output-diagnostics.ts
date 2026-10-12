import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AiCall } from '../../shared/ai-contracts.ts';

const SOURCE_MAX_BYTES=16*1024*1024;
const MAX_BYTES = 200000, MAX_FILES = 10000, MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const managedName = /^\d{17}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
export type AiOutputRejectionStage = 'provider-response-validation' | 'operation-output-validation' | 'source-freshness' | 'result-record-validation';

function safeDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical(realpathSync(path)) !== canonical(path)) throw Error('Unsafe diagnostic directory');
}
function diagnosticText(value: string): string {
  return value
    .replace(/("(?:authorization|api[_-]?key|password|access[_-]?token|secret|headers)"\s*:\s*")[^"\r\n]*("|$)/gi,'$1[omitted: sensitive field]$2')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,'Bearer [omitted: sensitive field]')
    .replace(/data:image\/[^\s;,]+(?:;[^,\s]*)?;?base64,[A-Za-z0-9+/=_-]+/gi,'[omitted: image bytes]')
    .replace(/(?:iVBORw0KGgo|\/9j\/|R0lGOD[lh]|UklGR)[A-Za-z0-9+/_=-]*/g,'[omitted: image bytes]')
    .replace(/[A-Za-z0-9+/_-]{256,}={0,2}/g,'[omitted: encoded bytes]');
}
function diagnosticOutput(value: unknown, depth = 0): unknown {
  if (depth > 40) return '[omitted: nesting limit]';
  if (typeof value === 'string') return diagnosticText(value);
  if (Array.isArray(value)) return value.map(item=>diagnosticOutput(item,depth+1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[
    diagnosticText(key),
    /^(?:credentials?|requestheaders?|headers?|authorization|proxyauthorization|apikey|accesskeyid|accesskeysecret|secretaccesskey|securitytoken|password|bearertoken|b64json|base64|imagebase64|imagedata)$/i.test(key.replace(/[^a-z0-9]/gi,''))
      ? '[omitted: sensitive field]' : diagnosticOutput(item,depth+1),
  ]));
  return value;
}

/** Failed-output evidence. Recovery must explicitly revalidate it; never adopt as a successful paid call. */
export function recordInvalidAiOutput(directory: string, input: { call: AiCall; operation: string; createdAt: string; rejectionStage: AiOutputRejectionStage; rejectionReason?: string; output: unknown }): void {
  let destination: string | undefined, file: number | undefined, complete = false;
  try {
    const { call } = input, name = `${input.createdAt.replace(/[-:.TZ]/g,'')}-${call.id}.json`;
    if (!managedName.test(name) || !/^[a-z][a-z0-9-]{0,63}$/.test(input.operation)) return;
    const output = diagnosticOutput(input.output), outputByteLength = Buffer.byteLength(JSON.stringify(output),'utf8');
    const metadata = { version:1, approved:false, errorCode:'OUTPUT_INVALID', callId:call.id, operation:input.operation,
      productId:call.productId, productRevision:call.productRevision, providerId:call.providerId, model:call.model,
      createdAt:input.createdAt, rejectionStage:input.rejectionStage,
      // Only a fixed code is kept; free text never enters the file through this field.
      ...(input.rejectionReason && /^[A-Z][A-Z_]{2,39}$/.test(input.rejectionReason) ? { rejectionReason:input.rejectionReason } : {}), outputByteLength };
    const maxBytes=input.operation==='source-image-consistency'?SOURCE_MAX_BYTES:MAX_BYTES;
    let json = JSON.stringify({ ...metadata, output });
    if (Buffer.byteLength(json,'utf8') > maxBytes) json = JSON.stringify({ ...metadata, output:null, outputOmitted:'size_limit' });
    if (Buffer.byteLength(json,'utf8') > maxBytes) return;
    const root = resolve(directory), folder = join(root,'ai-diagnostics');
    safeDirectory(root);
    try { mkdirSync(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    safeDirectory(folder);
    // Only delete this helper's regular files; never traverse a link or delete a directory.
    const existing = readdirSync(folder).filter(entry=>managedName.test(entry)).sort();
    let total=Buffer.byteLength(json,'utf8')+existing.reduce((sum,entry)=>sum+lstatSync(join(folder,entry)).size,0),remaining=existing.length+1;
    for (const entry of existing) {
      if(remaining<=MAX_FILES&&total<=MAX_TOTAL_BYTES)break;
      const path = join(folder,entry), info = lstatSync(path);
      safeDirectory(root); safeDirectory(folder);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || canonical(realpathSync(path)) !== canonical(path)) return;
      // Source failures are recovery evidence, not a disposable diagnostic cache.
      // Keep them even when ordinary diagnostics exceed retention quotas.
      try{if(info.size<=SOURCE_MAX_BYTES&&JSON.parse(readFileSync(path,'utf8')).operation==='source-image-consistency')continue;}catch{continue;}
      unlinkSync(path);
      remaining--;total-=info.size;
    }
    safeDirectory(root); safeDirectory(folder);
    const path = join(folder,name);
    file = openSync(path,'wx',0o600); destination = path;
    writeFileSync(file,json,'utf8'); complete = true;
  } catch { /* Diagnostic failures never alter the original error or settled usage. */ }
  finally {
    if (file !== undefined) try { closeSync(file); } catch { /* Best effort only. */ }
    if (destination && !complete) try { safeDirectory(resolve(directory)); safeDirectory(join(resolve(directory),'ai-diagnostics')); unlinkSync(destination); } catch { /* Remove only this incomplete file. */ }
  }
}

/** Only this call's bounded regular diagnostic files, with exact request identity. No network. */
function readInvalidAiRecords(directory:string,call:AiCall,operation:string):{rejectionStage:string;output?:unknown}[] {
  if(call.status!=='FAILED'||call.errorCode!=='OUTPUT_INVALID')return [];
  const values:{rejectionStage:string;output?:unknown}[]=[];
  try{
    const root=resolve(directory),folder=join(root,'ai-diagnostics');safeDirectory(root);safeDirectory(folder);
    for(const entry of readdirSync(folder).filter(name=>managedName.test(name)&&name.endsWith(`-${call.id}.json`)).sort().reverse()){
      try{
        const path=join(folder,entry),info=lstatSync(path);
        if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>(operation==='source-image-consistency'?SOURCE_MAX_BYTES:MAX_BYTES)||canonical(realpathSync(path))!==canonical(path))continue;
        const raw=JSON.parse(readFileSync(path,'utf8'));
        if(raw.version===1&&raw.approved===false&&raw.errorCode==='OUTPUT_INVALID'&&raw.operation===operation&&raw.callId===call.id&&raw.productId===call.productId&&raw.productRevision===call.productRevision&&raw.providerId===call.providerId&&raw.model===call.model&&['provider-response-validation','operation-output-validation','source-freshness','result-record-validation'].includes(raw.rejectionStage))values.push(raw);
      }catch{/* A damaged diagnostic does not hide another retained response. */}
    }
  }catch{/* Missing evidence remains an explicit unrecoverable output. */}
  return values;
}

export function hasInvalidAiResponse(directory:string,call:AiCall,operation:string):boolean {
  return readInvalidAiRecords(directory,call,operation).length>0;
}
export function readInvalidAiOutputs(directory:string,call:AiCall,operation:string):unknown[] {
  return readInvalidAiRecords(directory,call,operation).filter(record=>record.rejectionStage==='operation-output-validation'&&record.output!==null&&record.output!==undefined&&!JSON.stringify(record.output).includes('[omitted:')).map(record=>record.output);
}

/** Includes malformed/provider-incomplete text: its presence must never authorize a paid retry. */
export function hasRetainedInvalidAiOutput(directory:string,call:AiCall,operation:string):boolean {return readInvalidAiRecords(directory,call,operation).some(r=>r.output!==null&&r.output!==undefined);}
