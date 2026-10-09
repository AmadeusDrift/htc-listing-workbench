import type { IpcHandler } from './amazon-ipc.ts';
import type { CollectionBridge } from './collection/service.ts';
import type { CollectionStatus } from '../shared/collection-contracts.ts';
import { COLLECTION_EXTENSION_ID, COLLECTION_NATIVE_HOST } from '../shared/collection-identity.ts';
import { identifier } from '../shared/validation.ts';
import { CollectionError } from './collection/validation.ts';
import { safeConnectionDirectory } from './collection/connection.ts';

export function installCollectionIpc(dataRoot: string, handle: IpcHandler, bridge: CollectionBridge | undefined, openPath: (path: string) => Promise<string>): void {
  const unavailable: CollectionStatus = { state: 'unavailable', protocolVersion: 1, nativeHostName: COLLECTION_NATIVE_HOST, extensionId: COLLECTION_EXTENSION_ID, connectionPrepared: false, activeConnections: 0 };
  handle('red:collection:status', 0, () => bridge?.getStatus() ?? unavailable);
  handle('red:collection:prepare', 0, () => { if (!bridge) throw new CollectionError('APP_UNAVAILABLE'); return bridge.prepareConnection(); });
  handle('red:collection:open-directory', 0, async () => {
    if (!bridge?.getStatus().connectionPrepared) throw new CollectionError('APP_UNAVAILABLE');
    try { const result = await openPath(await safeConnectionDirectory(dataRoot)); if (result) throw new CollectionError('APP_UNAVAILABLE'); }
    catch { throw new CollectionError('APP_UNAVAILABLE'); }
  });
  handle('red:collection:receipt', 1, value => { const id = identifier(value); return bridge?.getReceipt(id) ?? null; });
}
