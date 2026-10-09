import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AiService } from '../src/main/ai/service.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { WorkspaceStore } from '../src/main/store.ts';
import { HostingService } from '../src/main/hosting/service.ts';
import { storage, isCode } from './fixtures/ai-control.ts';
import type { TestContext } from 'node:test';
import type { AiProfile } from '../src/shared/ai-contracts.ts';

async function workspace(t: TestContext) {
  await mkdir(resolve('.test-data'), { recursive: true });
  const directory = await mkdtemp(resolve('.test-data/credential-lifecycle-'));
  let available = true, decryptable = true;
  const crypto = { ...storage, isEncryptionAvailable: () => available, decryptString: (value: Buffer) => { if (!decryptable) throw new Error('synthetic decryption failure'); return storage.decryptString(value); } };
  let store: WorkspaceStore, hosting: HostingService, ai: AiService;
  const open = () => { store = new WorkspaceStore(directory); hosting = new HostingService(directory, store, crypto); ai = new AiService(directory, store, hosting, crypto); return ai; };
  const close = async () => { await ai?.close(); await hosting?.close(); store?.close(); };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  const persisted = () => { const db = new DatabaseSync(join(directory, 'red.sqlite'), { readOnly: true }); try { return db.prepare('SELECT record_json FROM ai_profiles ORDER BY id').all().map(row => JSON.parse(String(row.record_json)) as AiProfile); } finally { db.close(); } };
  return { directory, crypto, open, close, persisted, hosting: () => hosting, unavailable: () => { available = false; }, unreadable: () => { decryptable = false; }, recover: () => { available = true; decryptable = true; } };
}

for (const failure of ['unavailable', 'unreadable'] as const) test(`AI startup during ${failure} encryption preserves stored intent and recovers after restart`, async t => {
  const f = await workspace(t), original = f.open();
  original.saveConnection({ id: 'deepseek', apiKey: 'isolated-lifecycle-test-secret' });
  original.setEnabled({ id: 'deepseek', enabled: true });
  const before = f.persisted(), bytes = await readFile(join(f.directory, 'ai-vault/deepseek.bin'));
  await f.close(); f[failure](); const outage = f.open();
  assert.equal(outage.getProfile('deepseek').configured, false);
  assert.equal(outage.listConnections()[0].credentials[0].state, failure === 'unavailable' ? 'encryption-unavailable' : 'unreadable');
  assert.deepEqual(f.persisted(), before, 'a transient decrypt failure must never change persisted configuration or enable flags');
  assert.deepEqual(await readFile(join(f.directory, 'ai-vault/deepseek.bin')), bytes);
  await f.close(); f.recover(); const recovered = f.open();
  assert.equal(recovered.getProfile('deepseek').configured, true);
  assert.equal(recovered.getProfile('deepseek').enabled, true);
  assert.equal(recovered.getProfile('deepseek-review').enabled, false);
  await f.close(); assert.deepEqual(f.open().listProfiles().sort((a, b) => a.id.localeCompare(b.id)), before);
});

const amazonCredentials = { name: 'Isolated credential fixture', sellerId: 'FIXTURE_SELLER', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en_US', clientId: 'isolated-client-id', clientSecret: 'isolated-client-secret', refreshToken: 'isolated-refresh-token' };
const amazonMetadata = (directory: string) => { const db = new DatabaseSync(join(directory, 'red.sqlite'), { readOnly: true }); try { return db.prepare('SELECT id,target_json,credential_generation FROM amazon_targets ORDER BY id').all(); } finally { db.close(); } };

for (const paused of [false, true]) test(`Amazon decrypt outage preserves configuration, generation and paused=${paused} intent across restart`, async t => {
  const f = await workspace(t); f.open();
  let amazon = new AmazonService(f.directory, () => { throw new Error('unused'); }, f.crypto);
  try {
    const target = await amazon.importCredentials(amazonCredentials); if (paused) amazon.pauseTarget({ targetId: target.id, paused: true });
    const before = amazonMetadata(f.directory), path = join(f.directory, 'amazon-vault', `${target.id}.bin`), bytes = await readFile(path);
    amazon.close(); await f.close(); f.unreadable(); f.open(); amazon = new AmazonService(f.directory, () => { throw new Error('unused'); }, f.crypto);
    assert.equal(amazon.getTarget(target.id).configured, false);
    assert.deepEqual(amazonMetadata(f.directory), before, 'startup must not persist temporary decryption failures or rotate generation');
    assert.deepEqual(await readFile(path), bytes);
    amazon.close(); await f.close(); f.recover(); f.open(); amazon = new AmazonService(f.directory, () => { throw new Error('unused'); }, f.crypto);
    assert.equal(amazon.getTarget(target.id).configured, true); assert.equal(amazon.getTarget(target.id).paused, paused);
  } finally { amazon.close(); }
});

test('Amazon pause during decrypt outage persists only the user pause intent', async t => {
  const f = await workspace(t); f.open(); const amazon = new AmazonService(f.directory, () => { throw new Error('unused'); }, f.crypto);
  try {
    const target = await amazon.importCredentials(amazonCredentials); f.unreadable(); amazon.pauseTarget({ targetId: target.id, paused: true });
    f.recover(); assert.equal(amazon.getTarget(target.id).configured, true); assert.equal(amazon.getTarget(target.id).paused, true);
  } finally { amazon.close(); }
});

test('Amazon restart still registers readable saved secrets before accepting new public metadata', async t => {
  const f = await workspace(t); f.open(); let amazon = new AmazonService(f.directory, () => { throw new Error('unused'); }, f.crypto);
  try {
    await amazon.importCredentials(amazonCredentials); amazon.close();
    amazon = new AmazonService(f.directory, () => { throw new Error('unused'); }, f.crypto);
    await assert.rejects(amazon.importCredentials({ ...amazonCredentials, name: amazonCredentials.clientSecret, sellerId: 'OTHER_SELLER', clientId: 'other-client-id', clientSecret: 'other-client-secret', refreshToken: 'other-refresh-token' }), /敏感/);
  } finally { amazon.close(); }
});

test('Amazon diagnostics report orphaned ciphertext and metadata mismatch without activating or exposing saved credentials', async t => {
  const f = await workspace(t); f.open(); const amazon = new AmazonService(f.directory, () => { throw new Error('unused'); }, f.crypto);
  try {
    assert.equal(typeof amazon.credentialDiagnostics, 'function', 'read-only connection diagnostics must be available');
    assert.deepEqual(amazon.credentialDiagnostics(), { targets: [], orphanedCredentialCount: 0 });
    const target = await amazon.importCredentials(amazonCredentials);
    assert.equal(amazon.credentialDiagnostics().targets[0].state, 'ready');
    f.unavailable(); assert.equal(amazon.credentialDiagnostics().targets[0].state, 'encryption-unavailable'); f.recover();
    const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
    try { db.prepare("UPDATE amazon_targets SET target_json=json_set(target_json,'$.configured',json('false'),'$.paused',json('true')) WHERE id=?").run(target.id); } finally { db.close(); }
    assert.equal(amazon.credentialDiagnostics().targets[0].state, 'metadata-mismatch');
    assert.equal(amazon.getTarget(target.id).configured, false);
    assert.throws(() => amazon.pauseTarget({ targetId: target.id, paused: false }));
    const deleteDb = new DatabaseSync(join(f.directory, 'red.sqlite'));
    try { deleteDb.prepare('DELETE FROM amazon_targets WHERE id=?').run(target.id); } finally { deleteDb.close(); }
    assert.deepEqual(amazon.credentialDiagnostics(), { targets: [], orphanedCredentialCount: 1 });
    assert.equal(amazon.listTargets().length, 0);
    for (const secret of [amazonCredentials.clientId, amazonCredentials.clientSecret, amazonCredentials.refreshToken]) assert.equal(JSON.stringify(amazon.credentialDiagnostics()).includes(secret), false);
  } finally { amazon.close(); }
});

test('disabling during a decrypt outage preserves the saved credential configuration', async t => {
  const f = await workspace(t), ai = f.open();
  ai.saveConnection({ id: 'deepseek', apiKey: 'isolated-lifecycle-test-secret' }); ai.setEnabled({ id: 'deepseek', enabled: true });
  f.unreadable(); ai.setEnabled({ id: 'deepseek', enabled: false });
  f.recover(); assert.equal(ai.getProfile('deepseek').configured, true); assert.equal(ai.getProfile('deepseek').enabled, false);
});

test('model edits fail without rotating metadata when saved credentials cannot be read', async t => {
  const f = await workspace(t), ai = f.open();
  ai.saveConnection({ id: 'deepseek', apiKey: 'isolated-lifecycle-test-secret' }); const before = f.persisted();
  f.unreadable();
  assert.throws(() => ai.saveFunctionSettings({ id: 'deepseek', model: 'deepseek-v4-pro', enabled: false }), isCode('NOT_CONFIGURED'));
  assert.deepEqual(f.persisted(), before);
});

test('a model edit from a cached outage view preserves stored enable intent after recovery', async t => {
  const { aiFunctionSettingsInput } = await import('../src/renderer/credential-status.ts');
  assert.equal(typeof aiFunctionSettingsInput, 'function');
  const f = await workspace(t), ai = f.open();
  ai.saveConnection({ id: 'deepseek', apiKey: 'isolated-lifecycle-test-secret' }); ai.setEnabled({ id: 'deepseek', enabled: true });
  f.unavailable(); const cached = ai.listConnections()[0];
  assert.equal(cached.profiles[0].enabled, false); assert.equal(cached.credentials[0].storedEnabled, true);
  cached.credentials.reverse(); // Match intent by provider ID, never by array position.
  f.recover();
  ai.saveFunctionSettings(aiFunctionSettingsInput(cached, 'deepseek', { model: 'deepseek-v4-pro' }));
  assert.equal(ai.getProfile('deepseek').model, 'deepseek-v4-pro');
  assert.equal(ai.getProfile('deepseek').enabled, true, 'model-only changes must not replace saved intent with temporary runtime unavailability');
  ai.saveFunctionSettings(aiFunctionSettingsInput(cached, 'deepseek', { model: 'deepseek-v4-pro', enabled: false }));
  assert.equal(ai.getProfile('deepseek').enabled, false, 'an explicit user pause still takes effect');
});

test('restored or disconnected AI metadata cannot activate surviving ciphertext', async t => {
  const f = await workspace(t), ai = f.open();
  ai.saveConnection({ id: 'deepseek', apiKey: 'isolated-lifecycle-test-secret' });
  const path = join(f.directory, 'ai-vault/deepseek.bin'), old = await readFile(path);
  ai.disconnectConnection('deepseek'); await writeFile(path, old); await f.close();
  const restarted = f.open(); assert.equal(restarted.getProfile('deepseek').configured, false);
  assert.throws(() => restarted.setEnabled({ id: 'deepseek', enabled: true }), isCode('NOT_CONFIGURED'));
});

test('AI connection diagnostics distinguish absent, disabled, ready, unreadable and mismatched metadata without secrets', async t => {
  const f = await workspace(t), ai = f.open(), diagnostic = () => ai.listConnections()[0].credentials;
  assert.ok(diagnostic(), 'connections expose credential diagnostics separately from persisted profiles');
  assert.ok(diagnostic().every(row => row.state === 'absent' && !row.storedConfigured));
  ai.saveConnection({ id: 'deepseek', apiKey: 'isolated-lifecycle-test-secret' });
  assert.ok(diagnostic().every(row => row.state === 'configured-disabled'));
  ai.setEnabled({ id: 'deepseek', enabled: true }); assert.equal(diagnostic()[0].state, 'ready');
  f.unreadable(); assert.equal(diagnostic()[0].state, 'unreadable'); assert.equal(diagnostic()[0].storedEnabled, true);
  f.recover();
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try { db.exec("UPDATE ai_profiles SET record_json=json_set(record_json,'$.generation',10) WHERE id='deepseek'"); } finally { db.close(); }
  assert.equal(diagnostic()[0].state, 'metadata-mismatch');
  const publicData = JSON.stringify(ai.listConnections());
  assert.equal(publicData.includes('isolated-lifecycle-test-secret'), false);
  assert.equal(publicData.includes('ciphertext'), false);
});

const hostingCredentials = { id: 'alpha', host: 'isolated.example.test', port: 2121, secure: false, username: 'isolated-user', password: 'isolated-password', remoteRoot: '/', publicBaseUrl: 'https://htc.185858.xyz/AAA/' };
test('hosting disable during an outage preserves saved configuration after decryption recovers', async t => {
  const f = await workspace(t); f.open(); const hosting = f.hosting();
  hosting.importProfile(hostingCredentials); hosting.setEnabled({ id: 'alpha', enabled: true });
  f.unreadable(); hosting.setEnabled({ id: 'alpha', enabled: false });
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'), { readOnly: true });
  try { assert.equal(JSON.parse(String(db.prepare("SELECT record_json FROM hosting_profiles WHERE id='alpha'").get()!.record_json)).configured, true); } finally { db.close(); }
  f.recover();
  assert.equal(hosting.getProfile('alpha').configured, true); assert.equal(hosting.getProfile('alpha').enabled, false);
});

test('hosting restored configured=false metadata never activates surviving ciphertext', async t => {
  const f = await workspace(t); f.open(); const hosting = f.hosting(); hosting.importProfile(hostingCredentials);
  const db = new DatabaseSync(join(f.directory, 'red.sqlite'));
  try { db.exec("UPDATE hosting_profiles SET record_json=json_set(record_json,'$.configured',json('false'),'$.enabled',json('false')) WHERE id='alpha'"); } finally { db.close(); }
  assert.equal(hosting.getProfile('alpha').configured, false);
  assert.throws(() => hosting.setEnabled({ id: 'alpha', enabled: true }));
});
