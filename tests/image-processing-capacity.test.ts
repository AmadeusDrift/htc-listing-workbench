import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageProcessingCapacity } from '../src/main/image-processing/capacity.ts';

test('image capacity includes active and queued bytes, rejects beyond 64 MiB and releases once',()=>{
  const capacity=new ImageProcessingCapacity();
  const releases=[capacity.reserve(20*1024*1024),capacity.reserve(20*1024*1024),capacity.reserve(20*1024*1024)];
  const fourth=capacity.reserve(4*1024*1024);
  assert.throws(()=>capacity.reserve(1),/本地处理繁忙/);
  fourth();fourth();
  const replacement=capacity.reserve(4*1024*1024);assert.throws(()=>capacity.reserve(1),/本地处理繁忙/);
  replacement();for(const release of releases)release();
  capacity.reserve(20*1024*1024)();
});
test('image capacity rejects a ninth request and finally frees successful and failed reservations',async()=>{
  const capacity=new ImageProcessingCapacity();
  const releases=Array.from({length:8},()=>capacity.reserve(1));
  assert.throws(()=>capacity.reserve(1),/本地处理繁忙/);
  await Promise.all(releases.map((release,i)=>Promise.resolve().then(()=>{if(i%2)throw Error('shutdown');}).finally(release).catch(()=>{})));
  const next=Array.from({length:8},()=>capacity.reserve(1));
  assert.throws(()=>capacity.reserve(1),/本地处理繁忙/);for(const release of next)release();
});
