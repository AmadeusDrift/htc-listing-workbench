import test from 'node:test';
import assert from 'node:assert/strict';
import { listingFingerprint } from '../src/main/json-fingerprint.ts';
import { listingFingerprint as v0 } from '../src/main/listing-ai/evidence-validation-v0.ts';
import { listingFingerprint as v1 } from '../src/main/listing-ai/evidence-validation-v1.ts';
import { listingFingerprint as v2 } from '../src/main/listing-ai/evidence-validation-v2.ts';
import { listingFingerprint as v3 } from '../src/main/listing-ai/evidence-validation-v3.ts';
test('neutral fingerprint preserves every historical serializer including object insertion order',()=>{
  for(const value of [null,{},[],{b:1,a:2},{a:2,b:1},{nested:[{中文:'资料',unit:'cm'}],missing:undefined}])for(const legacy of [v0,v1,v2,v3])assert.equal(listingFingerprint(value),legacy(value));
  assert.notEqual(listingFingerprint({a:1,b:2}),listingFingerprint({b:2,a:1}));
});
