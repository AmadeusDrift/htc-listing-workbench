import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService } from '../src/main/catalog/service.ts';
import type { AmazonTarget } from '../src/shared/amazon-contracts.ts';

test('a full catalog persists, local search makes no requests, failed refresh preserves the previous index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'htc-catalog-'));
  let calls = 0, fail = false;
  const target = { id: 'store-1', sellerId: 'seller-1', marketplaceId: 'ATVPDKIKX0DER', mode: 'live', locale: 'en_US' } as AmazonTarget;
  const amazon = { getTarget: () => target, fetchProductTypeLibrary: async () => { calls++; if (fail) throw Error('network'); return [{ name: 'COASTER', displayName: 'Coasters' }, { name: 'TOOTHBRUSH', displayName: 'Toothbrushes' }]; } };
  let service = new CatalogService(dir, amazon);
  assert.equal(service.get('store-1'), null);
  const saved = await service.sync('store-1');
  assert.equal(saved.productTypes.length, 2);
  assert.equal(service.search({ targetId: 'store-1', query: 'coaster' })[0].name, 'COASTER');
  assert.equal(calls, 1);
  fail = true; await assert.rejects(service.sync('store-1'), /network/);
  assert.equal(service.get('store-1')?.fetchedAt, saved.fetchedAt);
  service.close(); service = new CatalogService(dir, amazon);
  assert.equal(service.get('store-1')?.productTypes.length, 2);
  target.sellerId = 'changed-seller'; assert.equal(service.get('store-1'), null);
  service.close();
});
test('duplicate product types and cross-scope refreshes never replace a valid index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'htc-catalog-'));
  const target = { id: 'store-2', sellerId: 'seller-1', marketplaceId: 'ATVPDKIKX0DER', mode: 'live', locale: 'en_US' } as AmazonTarget;
  const service = new CatalogService(dir, { getTarget: () => target, fetchProductTypeLibrary: async () => [{ name: 'COASTER', displayName: 'A' }, { name: 'COASTER', displayName: 'B' }] });
  await assert.rejects(service.sync('store-2')); assert.equal(service.get('store-2'), null); service.close();
});

test('real Amazon digit-leading product types survive local caching and reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'htc-catalog-'));
  const target = { id: 'store-3d', sellerId: 'seller-1', marketplaceId: 'ATVPDKIKX0DER', mode: 'live', locale: 'en_US' } as AmazonTarget;
  const types = ['3D_PRINTABLE_DESIGNS', '3D_PRINTED_PRODUCT', '3D_PRINTER'].map(name => ({ name, displayName: name }));
  const amazon = { getTarget: () => target, fetchProductTypeLibrary: async () => types };
  let service = new CatalogService(dir, amazon);
  try {
    assert.deepEqual((await service.sync(target.id)).productTypes, types);
    await service.close(); service = new CatalogService(dir, amazon);
    assert.equal(service.search({ targetId: target.id, query: '3D_PRINTER' })[0].name, '3D_PRINTER');
  } finally { await service.close(); }
});
