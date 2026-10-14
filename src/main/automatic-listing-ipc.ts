import type { IpcHandler } from './amazon-ipc.ts';
import type { AutomaticListingTask } from '../shared/automatic-listing-contracts.ts';
import type { AutomaticListingService } from './automatic-listing/service.ts';
import { identifier } from '../shared/validation.ts';

interface Hooks { confirm(task: AutomaticListingTask): Promise<boolean>; audit(action: string, summary: string): void }
export function installAutomaticListingIpc(service: AutomaticListingService, handle: IpcHandler, hooks: Hooks): void {
  const start = async (id: string) => {
    const task = await service.confirmStart(id,hooks.confirm);
    if (!task) return null;
    hooks.audit('automatic-listing.started', `启动 ${task.items.length} 个 SKU 的自动流程（${task.targetName}）`);
    return task;
  };
  handle('red:automatic-listing:start', 1, async raw => {
    const task = await service.create(raw);
    try { const started = await start(task.id); if (!started) service.cancel(task.id); return started; }
    catch (error) { service.cancel(task.id); throw error; }
  });
  handle('red:automatic-listing:adaptation-preview',1,id=>service.previewAdaptationForUi(identifier(id)));
  handle('red:automatic-listing:adaptation-apply',1,input=>service.applyAdaptation(input));
  handle('red:automatic-listing:batch-summary',1,id=>service.batchSummary(identifier(id)));
  handle('red:automatic-listing:execution-mode',1,input=>service.setExecutionMode(input));
  handle('red:automatic-listing:batch-plan',0,()=>service.getBatchPlan());
  handle('red:automatic-listing:work-batches',0,()=>service.listWorkBatches());
  handle('red:automatic-listing:work-batch-add',1,input=>service.addWorkBatchProducts(input));
  handle('red:automatic-listing:work-batch-archive',1,async id=>{const batch=await service.archiveWorkBatch(identifier(id));hooks.audit('automatic-listing.archived','归档当前工作批次并新建空批次');return batch;});
  handle('red:automatic-listing:list', 0, () => service.list());
  handle('red:automatic-listing:queue',1,raw=>service.queue(raw));
  handle('red:automatic-listing:get', 1, id => service.get(identifier(id)));
  handle('red:automatic-listing:resume', 1, id => start(identifier(id)));
  handle('red:automatic-listing:pause', 1, id => service.pause(identifier(id)));
  handle('red:automatic-listing:cancel', 1, id => service.cancel(identifier(id)));
}
