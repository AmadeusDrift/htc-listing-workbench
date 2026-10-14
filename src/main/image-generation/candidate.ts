import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import {lstatSync,openSync,fstatSync,readSync,closeSync,realpathSync} from 'node:fs';
import { join } from 'node:path';
import type { GeneratedImageCandidate } from '../../shared/image-generation-contracts.ts';
import { AiError } from '../ai/errors.ts';
import { keys, uuid } from "../ai/primitives.ts";
import { inspectRaster } from '../image-format.ts';
import { imageModel, imageProvider, privateDirectory } from './vault.ts';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function readPrivateFile(directory: string, name: string, limit: number): Promise<Buffer> {
  const path = join(directory, name), before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > limit || await realpath(path) !== path) throw new Error();
  const file = await open(path, 'r');
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.ino !== before.ino || initial.dev !== before.dev || initial.size !== before.size || initial.nlink !== 1) throw new Error();
    const bytes = Buffer.alloc(initial.size); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw new Error(); offset += bytesRead; }
    const [after, current, actual] = await Promise.all([file.stat(), lstat(path), realpath(path)]);
    if (actual !== path || current.isSymbolicLink() || current.ino !== initial.ino || current.dev !== initial.dev || current.nlink !== 1
      || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs) throw new Error();
    return bytes;
  } finally { await file.close(); }
}

/** Reopens only immutable managed candidate files and verifies their manifest, PNG bytes and native decode. */
export async function readCandidateFiles(directory: string, rawId: string, decodePreview?: (bytes: Buffer) => Buffer): Promise<{ candidate: GeneratedImageCandidate; bytes: Buffer; preview: Buffer }> {
  const id = uuid(rawId);
  try {
    const root = await realpath(directory), candidateDirectory = privateDirectory(privateDirectory(privateDirectory(root, 'image-generation'), 'candidates'), id);
    if (await realpath(candidateDirectory) !== candidateDirectory) throw new Error();
    const [manifest, bytes, preview] = await Promise.all([
      readPrivateFile(candidateDirectory, 'candidate.json', 32768), readPrivateFile(candidateDirectory, 'image.png', 20 * 1024 * 1024), readPrivateFile(candidateDirectory, 'preview.png', 4 * 1024 * 1024),
    ]);
    const result=parseCandidateData(id,manifest,bytes,preview,decodePreview);
    // Check the complete directory chain again after reads so substituted links cannot escape the candidate root.
    const current = privateDirectory(privateDirectory(privateDirectory(root, 'image-generation'), 'candidates'), id);
    if (await realpath(current) !== candidateDirectory) throw new Error();
    return result;
  } catch { throw new AiError('OUTPUT_INVALID'); }
}

function parseCandidateData(id:string,manifest:Buffer,bytes:Buffer,preview:Buffer,decodePreview?: (bytes: Buffer) => Buffer):{candidate:GeneratedImageCandidate;bytes:Buffer;preview:Buffer}{
    const raw = keys(JSON.parse(manifest.toString('utf8')), ['id', 'provider', 'model', 'mode', 'productId', 'productRevision', 'createdAt', 'requestId', 'sourceAssets', 'reviewState', 'mimeType', 'width', 'height', 'byteSize', 'sha256'], ['previewSha256','editSource']);
    const provider = imageProvider(raw.provider), model = imageModel(raw.model, provider);
    if (raw.id !== id || !['generate', 'edit'].includes(String(raw.mode)) || raw.reviewState !== 'unreviewed' || raw.mimeType !== 'image/png'
      || !Number.isSafeInteger(raw.productRevision) || Number(raw.productRevision) < 1 || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))
      || (raw.requestId !== null && (typeof raw.requestId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(raw.requestId)))
      || !Array.isArray(raw.sourceAssets) || raw.sourceAssets.length > 16 || raw.byteSize !== bytes.length || raw.sha256 !== digest(bytes)
      || (raw.previewSha256 !== undefined && raw.previewSha256 !== digest(preview))) throw new Error();
    const sourceAssets = raw.sourceAssets.map(value => {
      const asset = keys(value, ['id', 'sha256']);
      if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error();
      return { id: uuid(asset.id), sha256: asset.sha256 };
    });
    if (new Set(sourceAssets.map(asset => asset.id)).size !== sourceAssets.length || (raw.mode === 'edit') !== (sourceAssets.length > 0||raw.editSource!==undefined)) throw new Error();
    const shape = inspectRaster(bytes), previewShape = inspectRaster(preview), decoded = decodePreview ? decodePreview(bytes) : preview, decodedPreview = decodePreview ? decodePreview(preview) : preview;
    if (shape.mimeType !== 'image/png' || shape.width !== raw.width || shape.height !== raw.height || previewShape.mimeType !== 'image/png'
      || inspectRaster(decoded).mimeType !== 'image/png' || inspectRaster(decodedPreview).mimeType !== 'image/png' || decoded.length > 4 * 1024 * 1024 || decodedPreview.length > 4 * 1024 * 1024) throw new Error();
    let editSource:GeneratedImageCandidate['editSource'];if(raw.editSource!==undefined){const value=keys(raw.editSource,['id','sha256']);if(typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))throw new Error();editSource={id:uuid(value.id),sha256:value.sha256};if(editSource.id===id||raw.mode!=='edit')throw new Error();}
    const candidate: GeneratedImageCandidate = { id, provider, model, mode: raw.mode as GeneratedImageCandidate['mode'], productId: uuid(raw.productId), productRevision: Number(raw.productRevision),
      createdAt: raw.createdAt, requestId: raw.requestId as string | null, sourceAssets, reviewState: 'unreviewed', mimeType: 'image/png', width: shape.width, height: shape.height,
      byteSize: bytes.length, sha256: digest(bytes), previewUrl: `data:image/png;base64,${preview.toString('base64')}`,...(editSource?{editSource}:{}) };
    return { candidate, bytes, preview };
}

function readPrivateFileSync(directory:string,name:string,limit:number):Buffer {
  const path=join(directory,name),before=lstatSync(path);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>limit||realpathSync(path)!==path)throw new Error();
  const fd=openSync(path,'r');
  try{
    const initial=fstatSync(fd);if(!initial.isFile()||initial.ino!==before.ino||initial.dev!==before.dev||initial.size!==before.size||initial.nlink!==1)throw new Error();
    const bytes=Buffer.alloc(initial.size);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw new Error();offset+=n;}
    const after=fstatSync(fd),current=lstatSync(path);if(realpathSync(path)!==path||current.isSymbolicLink()||current.ino!==initial.ino||current.dev!==initial.dev||current.nlink!==1||after.size!==initial.size||after.mtimeMs!==initial.mtimeMs||after.ctimeMs!==initial.ctimeMs)throw new Error();return bytes;
  }finally{closeSync(fd);}
}
/** Identical strict artifact reader at the synchronous intent reservation boundary. */
export function readCandidateFilesSync(directory:string,rawId:string,decodePreview?:(bytes:Buffer)=>Buffer){
  const id=uuid(rawId);
  try{
    const root=realpathSync(directory),folder=privateDirectory(privateDirectory(privateDirectory(root,'image-generation'),'candidates'),id);if(realpathSync(folder)!==folder)throw new Error();
    const result=parseCandidateData(id,readPrivateFileSync(folder,'candidate.json',32768),readPrivateFileSync(folder,'image.png',20*1024*1024),readPrivateFileSync(folder,'preview.png',4*1024*1024),decodePreview);
    if(realpathSync(privateDirectory(privateDirectory(privateDirectory(root,'image-generation'),'candidates'),id))!==folder)throw new Error();return result;
  }catch{throw new AiError('OUTPUT_INVALID');}
}
