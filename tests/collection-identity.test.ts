import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';

test('the fixed extension public key derives exactly the permitted Chromium identity', async () => {
  const identity = await import('../src/shared/collection-identity.ts').catch(() => null);
  assert.ok(identity, 'the collection identity module is required');
  const bytes = Buffer.from(identity.COLLECTION_EXTENSION_PUBLIC_KEY, 'base64');
  assert.equal(createPublicKey({ key: bytes, format: 'der', type: 'spki' }).asymmetricKeyType, 'rsa');
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  assert.equal(identity.COLLECTION_EXTENSION_ID, id);
  assert.equal(identity.COLLECTION_EXTENSION_ORIGIN, `chrome-extension://${id}/`);
});
