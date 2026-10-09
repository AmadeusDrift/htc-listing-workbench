import { basename, resolve, sep } from 'node:path';
import { AiService } from '../../src/main/ai/service.ts';
import { WorkspaceStore } from '../../src/main/store.ts';
import { HostingService } from '../../src/main/hosting/service.ts';
import type { SecretStorage } from '../../src/main/amazon/vault.ts';

const directory = resolve(process.argv[2]), allowed = resolve('.test-data') + sep;
if (!directory.startsWith(allowed) || !basename(directory).startsWith('ai-usage-crash-')) throw new Error('Isolated crash fixture required');
const storage: SecretStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
const store = new WorkspaceStore(directory), product = store.createProduct(), hosting = new HostingService(directory, store, storage);
const service = new AiService(directory, store, hosting, storage, { now: () => new Date('2026-09-30T12:00:00.000Z'), fetch: async () => {
  // Abrupt real process exit only after the transaction and at actual fetch entry.
  process.exit(73);
} });
service.importProfile({ id: 'deepseek', model: 'deepseek-flash', apiKey: 'isolated-child-fixture-key' }); service.setEnabled({ id: 'deepseek', enabled: true });
await service.suggest({ productId: product.id, productRevision: product.revision, variantId: product.variants[0].id, ocrResultIds: [] });
