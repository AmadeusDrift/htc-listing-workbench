import type { IpcHandler } from './amazon-ipc.ts';
import type { SkuNamingService } from './sku-naming/service.ts';

export function installSkuNamingIpc(service: SkuNamingService, handle: IpcHandler, hooks?: { audit(action: string, summary: string): void }): void {
  handle('red:sku-naming:settings', 0, () => service.getSettings());
  handle('red:sku-naming:save', 1, raw => {
    const saved = service.saveSettings(raw);
    hooks?.audit('sku-naming.settings-saved', `已保存 SKU 命名规则版本 ${saved.revision}`);
    return saved;
  });
  handle('red:sku-naming:preview', 1, raw => service.preview(raw));
}
