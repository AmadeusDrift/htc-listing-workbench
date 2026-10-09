import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AiService } from '../src/main/ai/service.ts';
import { AiVault } from '../src/main/ai/vault.ts';
import { AiError } from '../src/main/ai/errors.ts';
import { openDatabase } from '../src/main/database.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { createWorkspaceBackup, prepareWorkspaceRestore, commitWorkspaceRestore } from '../src/main/backup.ts';
import { fixture, holdFetch, isCode, storage } from './fixtures/ai-control.ts';
import type { AiProviderId } from '../src/shared/ai-contracts.ts';

const secret = 'shared-api-key-never-public';
const aliyun = { accessKeyId: 'shared-aliyun-key-id', accessKeySecret: 'shared-aliyun-secret', securityToken: 'shared-session-token' };
const cipher = (directory: string, id: AiProviderId) => readFile(join(directory, 'ai-vault', `${id}.bin`));
const connection = (service: AiService, id = 'deepseek') => service.listConnections().find(row => row.id === id)!;

test('two vendor connections begin unconfigured with public role metadata only', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.service.listConnections, 'function', 'grouped connection API must exist');
  const rows = f.service.listConnections();
  assert.deepEqual(rows.map(row => row.id), ['deepseek', 'aliyun']);
  assert.ok(rows.every(row => row.state === 'unconfigured'));
  assert.deepEqual(rows.map(row=>row.profiles.length),[2,3]);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['credentials', 'id', 'profiles', 'state']);
  assert.ok(rows.flatMap(row => row.profiles).every(profile => !profile.configured && !profile.enabled));
  assert.deepEqual(f.service.connectionTemplate('deepseek'), { id: 'deepseek', apiKey: '' });
  assert.deepEqual(f.service.connectionTemplate('aliyun'), { id: 'aliyun', accessKeyId: '', accessKeySecret: '', securityToken: '' });
});

test('upgrade adds IP detection with the existing encrypted OCR key and enabled state without a provider call',async t=>{
  const f=await fixture(t);
  f.service.importProfile({id:'aliyun-ocr',...aliyun}); f.service.setEnabled({id:'aliyun-ocr',enabled:true});
  const ocr=f.service.getProfile('aliyun-ocr'),cipherBefore=await cipher(f.directory,'aliyun-ocr');
  await f.service.close(); const db=openDatabase(f.directory);
  try{db.prepare('DELETE FROM ai_profiles WHERE id=?').run('aliyun-image-risk');}finally{db.close();}
  const upgraded=new AiService(f.directory,f.store,f.hosting,storage,{fetch:async()=>{throw Error('Upgrade must not call providers');}});
  try{
    const profile=upgraded.getProfile('aliyun-image-risk'); assert.equal(profile.configured,true); assert.equal(profile.enabled,true);
    assert.deepEqual(new AiVault(f.directory,storage).read(profile.id,profile.generation),aliyun);
    assert.deepEqual(upgraded.getProfile('aliyun-ocr'),ocr); assert.deepEqual(await cipher(f.directory,'aliyun-ocr'),cipherBefore);
    upgraded.setEnabled({id:'aliyun-image-risk',enabled:false});
  }finally{await upgraded.close();}
  const restarted=new AiService(f.directory,f.store,f.hosting,storage);
  try{assert.equal(restarted.getProfile('aliyun-image-risk').enabled,false);}finally{await restarted.close();}
  assert.equal(f.requests.length,0);
});

test('a single vendor save configures both roles without enabling or invoking them', async t => {
  const f = await fixture(t), vault = new AiVault(f.directory, storage);
  for (const input of [{ id: 'deepseek', apiKey: secret }, { id: 'aliyun', ...aliyun }]) {
    const saved = f.service.saveConnection(input);
    assert.equal(saved.state, 'shared');
    for (const profile of saved.profiles) {
      assert.equal(profile.configured, true); assert.equal(profile.enabled, false);
      assert.deepEqual(vault.read(profile.id, profile.generation), input.id === 'deepseek' ? { apiKey: secret } : aliyun);
    }
  }
  assert.equal(f.requests.length, 0); assert.equal(f.service.listCalls().length, 0);
  const db = openDatabase(f.directory);
  try {
    const publicData = JSON.stringify([f.service.listConnections(), f.service.listProfiles(), f.service.connectionTemplate('deepseek'), f.service.connectionTemplate('aliyun'), db.prepare('SELECT * FROM ai_profiles').all()]);
    for (const value of [secret, ...Object.values(aliyun)]) assert.equal(publicData.includes(value), false);
  } finally { db.close(); }
  for (const file of await readdir(join(f.directory, 'ai-vault'))) {
    const bytes = await readFile(join(f.directory, 'ai-vault', file));
    for (const value of [secret, ...Object.values(aliyun)]) assert.equal(bytes.includes(Buffer.from(value)), false);
  }
});

test('legacy roles are partial or separate without silently migrating their credentials', async t => {
  const f = await fixture(t);
  f.service.importProfile({ id: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'legacy-generation-key' });
  f.service.setEnabled({ id: 'deepseek', enabled: true });
  assert.equal(connection(f.service).state, 'partial');
  f.service.importProfile({ id: 'deepseek-review', model: 'deepseek-flash', apiKey: 'legacy-review-key' });
  const before = f.service.listProfiles(), original = await Promise.all(['deepseek', 'deepseek-review'].map(id => cipher(f.directory, id as AiProviderId)));
  assert.equal(connection(f.service).state, 'separate');
  await f.service.close();
  const restarted = new AiService(f.directory, f.store, f.hosting, storage);
  try {
    assert.equal(connection(restarted).state, 'separate'); assert.deepEqual(restarted.listProfiles(), before);
    assert.deepEqual(await Promise.all(['deepseek', 'deepseek-review'].map(id => cipher(f.directory, id as AiProviderId))), original);
  } finally { await restarted.close(); }
});

test('explicit reuse copies the selected legacy role and retains role models and enable flags', async t => {
  const f = await fixture(t), vault = new AiVault(f.directory, storage);
  f.service.importProfile({ id: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'legacy-generation-key' });
  f.service.setEnabled({ id: 'deepseek', enabled: true });
  f.service.importProfile({ id: 'deepseek-review', model: 'deepseek-flash', apiKey: 'legacy-review-key' });
  const before = connection(f.service).profiles;
  const saved = f.service.reuseConnection({ id: 'deepseek', sourceId: 'deepseek-review' });
  assert.equal(saved.state, 'shared');
  saved.profiles.forEach((profile, i) => {
    assert.equal(profile.model, before[i].model); assert.equal(profile.enabled, before[i].enabled);
    assert.equal(profile.generation, before[i].generation + 1);
    assert.deepEqual(vault.read(profile.id, profile.generation), { apiKey: 'legacy-review-key' });
  });
  assert.throws(() => f.service.reuseConnection({ id: 'aliyun', sourceId: 'deepseek' }), AiError);
  assert.throws(() => f.service.reuseConnection({ id: 'aliyun', sourceId: 'aliyun-ocr' }), isCode('NOT_CONFIGURED'));
});

test('Aliyun comparison includes the optional security token and reuse handles a partial pair', async t => {
  const f = await fixture(t);
  f.service.importProfile({ id: 'aliyun-ocr', ...aliyun });
  f.service.importProfile({ id: 'aliyun-image-risk', ...aliyun });
  f.service.importProfile({ id: 'aidge-segmentation', ...aliyun, securityToken: 'different-session-token' });
  assert.equal(connection(f.service, 'aliyun').state, 'separate');
  f.service.disconnect('aidge-segmentation');
  assert.equal(connection(f.service, 'aliyun').state, 'partial');
  const saved = f.service.reuseConnection({ id: 'aliyun', sourceId: 'aliyun-ocr' });
  assert.equal(saved.state, 'shared'); assert.ok(saved.profiles.every(profile => !profile.enabled));
});

test('grouped import accepts vendor and legacy formats, changing only the imported function model', async t => {
  const f = await fixture(t);
  f.service.saveConnection({ id: 'deepseek', apiKey: secret });
  f.service.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-v4-pro', enabled: true });
  f.service.saveFunctionSettings({ id: 'deepseek-review', model: 'deepseek-v4-pro', enabled: false });
  const imported = f.service.importConnectionConfig({ id: 'deepseek-review', model: 'deepseek-flash', apiKey: 'imported-vendor-key' });
  assert.equal(imported.state, 'shared');
  assert.deepEqual(imported.profiles.map(profile => [profile.model, profile.enabled]), [['deepseek-v4-pro', true], ['deepseek-flash', false]]);
  const vendor = f.service.importConnectionConfig({ id: 'deepseek', apiKey: secret });
  assert.deepEqual(vendor.profiles.map(profile => [profile.model, profile.enabled]), [['deepseek-v4-pro', true], ['deepseek-flash', false]]);
  const cloud = f.service.importConnectionConfig({ id: 'aliyun-ocr', ...aliyun });
  assert.equal(cloud.state, 'shared'); assert.ok(cloud.profiles.every(profile => !profile.enabled));
  assert.equal(f.service.importConnectionConfig({ id: 'aliyun', ...aliyun }).state, 'shared');
});

test('grouped inputs reject unknown fields, IDs, missing credentials, models and enable flags', async t => {
  const f = await fixture(t);
  for (const input of [null, [], { id: 'deepseek-review', apiKey: secret }, { id: 'other', apiKey: secret }, { id: 'deepseek', apiKey: secret, model: 'deepseek-flash' }, { id: 'deepseek', apiKey: '' }, { id: 'aliyun', accessKeyId: aliyun.accessKeyId }, { id: 'aliyun', ...aliyun, endpoint: 'https://example.test' }]) assert.throws(() => f.service.saveConnection(input), AiError);
  for (const input of [{ id: 'deepseek', sourceId: 'deepseek', apiKey: secret }, { id: 'deepseek', sourceId: 'other' }, { id: 'aliyun-ocr', sourceId: 'aliyun-ocr' }]) assert.throws(() => f.service.reuseConnection(input), AiError);
  for (const input of [{ id: 'deepseek', model: 'deepseek-flash', enabled: 'yes' }, { id: 'deepseek', model: 'invalid', enabled: false }, { id: 'aliyun-ocr', model: 'deepseek-flash', enabled: false }, { id: 'deepseek', model: 'deepseek-flash', enabled: false, apiKey: secret }]) assert.throws(() => f.service.saveFunctionSettings(input), AiError);
  for (const input of [{ id: 'deepseek', model: 'deepseek-flash', apiKey: secret, enabled: true }, { id: 'aliyun', ...aliyun, model: 'ImageMatting' }]) assert.throws(() => f.service.importConnectionConfig(input), AiError);
  for (const id of ['aliyun-ocr', 'other']) {
    assert.throws(() => f.service.disconnectConnection(id), AiError); assert.throws(() => f.service.connectionTemplate(id), AiError);
  }
  assert.throws(() => f.service.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-flash', enabled: true }), isCode('NOT_CONFIGURED'));
  assert.ok(f.service.listConnections().every(row => row.state === 'unconfigured')); assert.equal(f.requests.length, 0);
});

test('function model and enable changes remain independent and never require credentials again', async t => {
  const f = await fixture(t), vault = new AiVault(f.directory, storage);
  const unconfigured = f.service.saveFunctionSettings({ id: 'deepseek-review', model: 'deepseek-flash', enabled: false });
  assert.equal(unconfigured.state, 'unconfigured');
  f.service.saveConnection({ id: 'deepseek', apiKey: secret });
  const before = connection(f.service).profiles;
  f.service.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-v4-pro', enabled: true });
  const changed = f.service.getProfile('deepseek');
  assert.equal(changed.generation, before[0].generation + 1); assert.equal(changed.enabled, true);
  assert.deepEqual(vault.read(changed.id, changed.generation), { apiKey: secret });
  assert.deepEqual(f.service.getProfile('deepseek-review'), before[1]); assert.equal(connection(f.service).state, 'shared');
  const encrypted = await cipher(f.directory, 'deepseek');
  f.service.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-v4-pro', enabled: false });
  assert.equal(f.service.getProfile('deepseek').generation, changed.generation);
  assert.deepEqual(await cipher(f.directory, 'deepseek'), encrypted);
});

test('failure encrypting the second role rolls back the first ciphertext and both profiles', async t => {
  const f = await fixture(t);
  f.service.saveConnection({ id: 'deepseek', apiKey: secret });
  const before = f.service.listProfiles(), previous = await Promise.all(['deepseek', 'deepseek-review'].map(id => cipher(f.directory, id as AiProviderId)));
  const original = storage.encryptString; let count = 0;
  const failure = t.mock.method(storage, 'encryptString', (value: string) => { if (++count === 2) throw Error(secret); return original(value); });
  assert.throws(() => f.service.saveConnection({ id: 'deepseek', apiKey: 'replacement-api-key' }), isCode('ENCRYPTION_UNAVAILABLE'));
  failure.mock.restore();
  assert.equal(count, 2); assert.deepEqual(f.service.listProfiles(), before);
  assert.deepEqual(await Promise.all(['deepseek', 'deepseek-review'].map(id => cipher(f.directory, id as AiProviderId))), previous);
});

for (const operation of ['save', 'reuse', 'disconnect'] as const) test(`${operation}: failure persisting the second role rolls back both profiles and vaults`, async t => {
  const f = await fixture(t); f.enable('deepseek'); f.enable('deepseek-review');
  const before = f.service.listProfiles(), previous = await Promise.all(['deepseek', 'deepseek-review'].map(id => cipher(f.directory, id as AiProviderId)));
  const db = openDatabase(f.directory);
  try {
    db.exec("CREATE TRIGGER ai_pair_failure BEFORE UPDATE ON ai_profiles WHEN NEW.id='deepseek-review' BEGIN SELECT RAISE(ABORT,'secret-error-must-not-escape'); END;");
    assert.throws(() => operation === 'save' ? f.service.saveConnection({ id: 'deepseek', apiKey: secret }) : operation === 'reuse' ? f.service.reuseConnection({ id: 'deepseek', sourceId: 'deepseek' }) : f.service.disconnectConnection('deepseek'), error => error instanceof AiError && !error.message.includes('secret-error'));
    assert.deepEqual(f.service.listProfiles(), before);
    assert.deepEqual(await Promise.all(['deepseek', 'deepseek-review'].map(id => cipher(f.directory, id as AiProviderId))), previous);
  } finally { db.close(); }
});

test('failed pair rotation leaves running requests alive; successful rotation cancels both roles', async t => {
  const f = await fixture(t); f.enable('deepseek'); f.enable('deepseek-review');
  const suggestion = await f.service.suggest(f.textInput), held = holdFetch(); f.respond(held.fetch);
  const pending = f.service.suggest(f.textInput); await held.started;
  const db = openDatabase(f.directory);
  try {
    db.exec("CREATE TRIGGER ai_pair_failure BEFORE UPDATE ON ai_profiles WHEN NEW.id='deepseek-review' BEGIN SELECT RAISE(ABORT,'failed'); END;");
    assert.throws(() => f.service.saveConnection({ id: 'deepseek', apiKey: secret }), AiError);
    assert.equal(f.requests[1].options?.signal?.aborted, false);
    db.exec('DROP TRIGGER ai_pair_failure');
    const review = f.service.review({ productId: f.product.id, productRevision: f.product.revision, suggestionResultId: suggestion.id });
    const rejected = Promise.allSettled([pending, review]);
    await new Promise(resolve => setImmediate(resolve));
    f.service.saveConnection({ id: 'deepseek', apiKey: secret });
    assert.ok((await rejected).every(result => result.status === 'rejected' && isCode('CONFIG_CHANGED')(result.reason)));
    held.release(); assert.equal(f.service.listResults(f.product.id).length, 1);
  } finally { db.close(); }
});

test('model changes cancel only that role while the other role completes normally', async t => {
  const f = await fixture(t); f.enable('deepseek'); f.enable('deepseek-review');
  const suggestion = await f.service.suggest(f.textInput), held = holdFetch(); f.respond(held.fetch);
  const generation = f.service.suggest(f.textInput), rejected = assert.rejects(generation, isCode('CONFIG_CHANGED'));
  const review = f.service.review({ productId: f.product.id, productRevision: f.product.revision, suggestionResultId: suggestion.id });
  await held.started; await new Promise(resolve => setImmediate(resolve));
  const previousReview = f.service.getProfile('deepseek-review');
  f.service.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-v4-pro', enabled: true });
  await rejected; assert.deepEqual(f.service.getProfile('deepseek-review'), previousReview);
  held.release(); assert.equal((await review).providerId, 'deepseek-review');
});

test('disabling one function cancels it and retains both credentials', async t => {
  const held = holdFetch(), f = await fixture(t, { fetch: held.fetch });
  f.service.saveConnection({ id: 'deepseek', apiKey: secret });
  f.service.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-flash', enabled: true });
  f.service.saveFunctionSettings({ id: 'deepseek-review', model: 'deepseek-v4-pro', enabled: true });
  const pending = f.service.suggest(f.textInput), rejected = assert.rejects(pending, isCode('DISABLED')); await held.started;
  const saved = f.service.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-flash', enabled: false });
  await rejected; held.release();
  assert.equal(saved.state, 'shared'); assert.deepEqual(saved.profiles.map(profile => profile.enabled), [false, true]);
});

test('shared credential changes and disconnect preserve budgets and history across restart', async t => {
  const f = await fixture(t); f.enable('deepseek'); f.enable('deepseek-review'); f.enable('aliyun-ocr');
  const policies = [{ providerId: 'deepseek', dailyCallLimit: 3, dailyTokenLimit: 50000 }, { providerId: 'deepseek-review', dailyCallLimit: 7, dailyTokenLimit: 100000 }];
  policies.forEach(policy => f.service.setUsagePolicy(policy));
  const suggestion = await f.service.suggest(f.textInput); await f.service.review({ productId: f.product.id, productRevision: f.product.revision, suggestionResultId: suggestion.id });
  const history = [f.service.listCalls(), f.service.listResults(f.product.id)], cloud = f.service.getProfile('aliyun-ocr');
  const saved = f.service.saveConnection({ id: 'deepseek', apiKey: secret }); assert.ok(saved.profiles.every(profile => profile.enabled));
  const disconnected = f.service.disconnectConnection('deepseek');
  assert.equal(disconnected.state, 'unconfigured'); assert.ok(disconnected.profiles.every(profile => !profile.enabled && !profile.configured));
  assert.deepEqual(disconnected.profiles.map(profile => profile.model), saved.profiles.map(profile => profile.model));
  for (const id of ['deepseek', 'deepseek-review'] as const) await assert.rejects(cipher(f.directory, id), { code: 'ENOENT' });
  assert.deepEqual(f.service.getProfile('aliyun-ocr'), cloud);
  assert.deepEqual([f.service.listCalls(), f.service.listResults(f.product.id)], history);
  await f.service.close(); const restarted = new AiService(f.directory, f.store, f.hosting, storage);
  try {
    assert.equal(connection(restarted).state, 'unconfigured');
    assert.deepEqual([restarted.listCalls(), restarted.listResults(f.product.id)], history);
    policies.forEach(policy => { assert.deepEqual(restarted.getUsagePolicy(policy.providerId), policy); assert.equal(restarted.getUsageSummary(policy.providerId).attempts, 1); });
  } finally { await restarted.close(); }
});

test('restored configured=false metadata blocks legacy reuse even with surviving ciphertext', async t => {
  const f = await fixture(t); f.enable('deepseek');
  const profile = f.service.getProfile('deepseek'), db = openDatabase(f.directory);
  try { db.prepare('UPDATE ai_profiles SET record_json=? WHERE id=?').run(JSON.stringify({ ...profile, configured: false, enabled: false }), profile.id); } finally { db.close(); }
  assert.equal(connection(f.service).state, 'unconfigured');
  assert.throws(() => f.service.reuseConnection({ id: 'deepseek', sourceId: 'deepseek' }), isCode('NOT_CONFIGURED'));
  f.service.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-v4-pro', enabled: false });
  assert.equal(connection(f.service).state, 'unconfigured');
  assert.throws(() => f.service.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-v4-pro', enabled: true }), isCode('NOT_CONFIGURED'));
});

test('vendor connections remain compatible with backup restore and never regain saved keys', async t => {
  const f = await fixture(t); f.service.saveConnection({ id: 'deepseek', apiKey: secret });
  f.service.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-v4-pro', enabled: true });
  f.service.setUsagePolicy({ providerId: 'deepseek-review', dailyCallLimit: 9, dailyTokenLimit: 90000 });
  const target = join(f.directory, 'restored'), file = join(f.directory, 'shared.htcbackup');
  await createWorkspaceBackup(f.directory, file, 'shared connection backup passphrase');
  const prepared = await prepareWorkspaceRestore(target, file, 'shared connection backup passphrase'); await commitWorkspaceRestore(target, prepared);
  const store = new WorkspaceStore(target), hosting = new HostingService(target, store, storage), restored = new AiService(target, store, hosting, storage);
  try {
    assert.ok(restored.listConnections().every(row => row.state === 'unconfigured'));
    assert.equal(restored.getProfile('deepseek').model, 'deepseek-v4-pro');
    assert.deepEqual(restored.getUsagePolicy('deepseek-review'), { providerId: 'deepseek-review', dailyCallLimit: 9, dailyTokenLimit: 90000 });
    assert.throws(() => restored.reuseConnection({ id: 'deepseek', sourceId: 'deepseek' }), isCode('NOT_CONFIGURED'));
  } finally { await restored.close(); await hosting.close(); store.close(); }
});
