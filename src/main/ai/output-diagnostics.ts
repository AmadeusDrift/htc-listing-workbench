import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AiCall } from '../../shared/ai-contracts.ts';

const MAX_BYTES = 200000, MAX_FILES = 50;
const managedName = /^\d{17}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
export type AiOutputRejectionStage = 'operation-output-validation' | 'source-freshness' | 'result-record-validation';

function safeDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical(realpathSync(path)) !== canonical(path)) throw Error('Unsafe diagnostic directory');
}
function diagnosticText(value: string): string {
  return value
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

/** Local failed-output evidence only. Never read by result/adoption APIs or included in requests. */
export function recordInvalidAiOutput(directory: string, input: { call: AiCall; operation: string; createdAt: string; rejectionStage: AiOutputRejectionStage; output: unknown }): void {
  let destination: string | undefined, file: number | undefined, complete = false;
  try {
    const { call } = input, name = `${input.createdAt.replace(/[-:.TZ]/g,'')}-${call.id}.json`;
    if (!managedName.test(name) || !/^[a-z][a-z0-9-]{0,63}$/.test(input.operation)) return;
    const output = diagnosticOutput(input.output), outputByteLength = Buffer.byteLength(JSON.stringify(output),'utf8');
    const metadata = { version:1, approved:false, errorCode:'OUTPUT_INVALID', callId:call.id, operation:input.operation,
      productId:call.productId, productRevision:call.productRevision, providerId:call.providerId, model:call.model,
      createdAt:input.createdAt, rejectionStage:input.rejectionStage, outputByteLength };
    let json = JSON.stringify({ ...metadata, output });
    if (Buffer.byteLength(json,'utf8') > MAX_BYTES) json = JSON.stringify({ ...metadata, output:null, outputOmitted:'size_limit' });
    if (Buffer.byteLength(json,'utf8') > MAX_BYTES) return;
    const root = resolve(directory), folder = join(root,'ai-diagnostics');
    safeDirectory(root);
    try { mkdirSync(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    safeDirectory(folder);
    // Only delete this helper's regular files; never traverse a link or delete a directory.
    const existing = readdirSync(folder).filter(entry=>managedName.test(entry)).sort();
    for (const entry of existing.slice(0,Math.max(0,existing.length-MAX_FILES+1))) {
      const path = join(folder,entry), info = lstatSync(path);
      safeDirectory(root); safeDirectory(folder);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || canonical(realpathSync(path)) !== canonical(path)) return;
      unlinkSync(path);
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
