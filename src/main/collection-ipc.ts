import type { IpcHandler } from './amazon-ipc.ts';
import type { CollectionHistoryPort } from './collection/history.ts';
import type { CollectionStatus } from '../shared/collection-contracts.ts';
import { COLLECTION_EXTENSION_ID, COLLECTION_NATIVE_HOST } from '../shared/collection-identity.ts';
import { identifier } from '../shared/validation.ts';
import { CollectionError } from './collection/validation.ts';

export function installCollectionIpc(_dataRoot: string, handle: IpcHandler, bridge: Pick<CollectionHistoryPort,'getReceipt'> | undefined, _openPath: (path: string) => Promise<string>): void {
  const unavailable: CollectionStatus = { state: 'unavailable', protocolVersion: 1, nativeHostName: COLLECTION_NATIVE_HOST, extensionId: COLLECTION_EXTENSION_ID, connectionPrepared: false, activeConnections: 0 };
  handle('red:collection:status', 0, () => unavailable);
  handle('red:collection:prepare', 0, () => { throw new CollectionError('APP_UNAVAILABLE'); });
  handle('red:collection:open-directory', 0, async () => {
    throw new CollectionError('APP_UNAVAILABLE');
  });
  handle('red:collection:receipt', 1, value => { const id = identifier(value); return bridge?.getReceipt(id) ?? null; });
}
