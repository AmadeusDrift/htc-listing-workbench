import {candidateFixture} from './fixtures/controlled-candidate.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const module=await import('../src/main/application/controlled-candidate.ts').catch(()=>null);
const sha=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
test('candidate identity checks the actual running EXE, loaded main/preload/renderer and package manifest',async()=>{
 assert.ok(module?.verifyControlledCandidate);const f=candidateFixture(),candidate=await module.verifyControlledCandidate(f.app,f.exe);assert.equal(candidate.identity.sourceCommit,'a'.repeat(40));assert.equal(candidate.identity.sourceDigest,'b'.repeat(64));assert.equal(candidate.identity.executableSha256,sha(readFileSync(f.exe)));candidate.assertUnchanged();writeFileSync(join(f.app,'dist-electron/main.cjs'),'modified source');assert.throws(()=>candidate.assertUnchanged(),/候选/);await assert.rejects(module.verifyControlledCandidate(f.app,f.exe),/候选/);
});
test('candidate provenance cannot accept a mismatched main build, path traversal or incomplete runtime inventory',async()=>{
 assert.ok(module?.verifyControlledCandidate);for(const mutation of [(m:any)=>m.build.sourceCommit='c'.repeat(40),(m:any)=>m.files[0].path='../HTC.exe',(m:any)=>m.files=m.files.filter((f:any)=>!f.path.endsWith('preload.cjs')),(m:any)=>m.build.files[0].sha256='c'.repeat(64)]){const f=candidateFixture();mutation(f.manifest);writeFileSync(join(f.root,'版本与摘要.json'),JSON.stringify(f.manifest));await assert.rejects(module.verifyControlledCandidate(f.app,f.exe),/候选/);}
});
