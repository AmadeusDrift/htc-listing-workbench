import type { ImageGenerationService } from './image-generation/service.ts';

export function installImageGenerationIpc(service: ImageGenerationService, handle: (channel: string, count: number, callback: (...args: unknown[]) => unknown) => void): void {
  handle('red:image-generation:spend-status',0,()=>service.getSpendStatus());
  handle('red:image-generation:spend-limit-save',1,input=>service.setDailySpendLimit(input));
  handle('red:image-generation:models', 0, () => service.getModels());
  handle('red:image-generation:refresh-models', 0, () => service.refreshModels());
  handle('red:image-generation:connection', 0, () => service.getConnection());
  handle('red:image-generation:provider-connection', 1, provider => service.getConnection(provider));
  handle('red:image-generation:save', 1, input => service.saveConnection(input));
  handle('red:image-generation:disconnect', 0, () => service.disconnect());
  handle('red:image-generation:provider-disconnect', 1, provider => service.disconnect(provider));
  handle('red:image-generation:check', 0, () => service.checkConnection());
  handle('red:image-generation:provider-check', 1, provider => service.checkConnection(provider));
  handle('red:image-generation:generate', 1, input => service.generate(input));
  handle('red:image-generation:cancel', 0, () => service.cancel());
}
