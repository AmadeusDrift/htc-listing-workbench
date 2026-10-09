import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { app, safeStorage } from 'electron';
import { WorkspaceStore } from '../../src/main/store.ts';
import { AiService } from '../../src/main/ai/service.ts';
import { AmazonService } from '../../src/main/amazon/service.ts';
import { HostingService } from '../../src/main/hosting/service.ts';

const phase = process.argv[2], directory = resolve(process.argv[3] ?? '');
assert.ok(['save', 'outage', 'restart'].includes(phase));
assert.ok(directory.startsWith(resolve('.test-data') + sep) && /credential-safe-storage-[^\\/]+$/.test(directory));
app.setName('HTC Credential Lifecycle Test');
app.setPath('userData', directory); app.setPath('sessionData', join(directory, 'browser'));
app.commandLine.appendSwitch('disable-gpu');
async function main() {
await app.whenReady();
let store: WorkspaceStore | undefined, ai: AiService | undefined, amazon: AmazonService | undefined, hosting: HostingService | undefined;
try {
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  const storage = phase === 'outage' ? { isEncryptionAvailable: () => true, encryptString: (value: string) => safeStorage.encryptString(value), decryptString: () => { throw new Error('simulated outage'); } } : safeStorage;
  store = new WorkspaceStore(directory); hosting = new HostingService(directory, store, storage); ai = new AiService(directory, store, hosting, storage); amazon = new AmazonService(directory, id => store!.getProduct(id), storage);
  if (phase === 'save') {
    ai.saveConnection({ id: 'deepseek', apiKey: 'synthetic-safe-storage-credential' }); ai.setEnabled({ id: 'deepseek', enabled: true });
    const target = await amazon.importCredentials({ name: 'Isolated smoke test', sellerId: 'ISOLATED_TEST', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en_US', clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-secret', refreshToken: 'synthetic-refresh-token' });
    writeFileSync(join(directory, 'expected.json'), JSON.stringify({ profiles: ai.listProfiles(), target }));
  } else {
    const expected = JSON.parse(readFileSync(join(directory, 'expected.json'), 'utf8'));
    if (phase === 'outage') {
      assert.equal(ai.getProfile('deepseek').configured, false);
      assert.equal(ai.listConnections()[0].credentials[0].state, 'unreadable');
      assert.equal(amazon.getTarget(expected.target.id).configured, false);
      assert.equal(amazon.credentialDiagnostics().targets[0].state, 'unreadable');
    } else {
      assert.deepEqual(ai.listProfiles(), expected.profiles);
      assert.deepEqual(amazon.getTarget(expected.target.id), expected.target);
    }
  }
  process.stdout.write(JSON.stringify({ phase, passed: true, gui: false }) + '\n');
} catch { process.stdout.write(JSON.stringify({ phase, passed: false, gui: false }) + '\n'); process.exitCode = 1; }
finally { await ai?.close(); amazon?.close(); await hosting?.close(); store?.close(); if (process.exitCode) app.exit(Number(process.exitCode)); else app.quit(); }
}
void main().catch(() => { process.stdout.write(JSON.stringify({ phase, passed: false, gui: false }) + '\n'); app.exit(1); });
