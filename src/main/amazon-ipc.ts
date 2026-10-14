import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import type { AmazonService } from './amazon/service.ts';
import { UserFacingError } from '../shared/errors.ts';
import { identifier, record } from '../shared/validation.ts';
import { writeFileAtomically } from './files.ts';

export type IpcHandler = (channel: string, argumentCount: number, callback: (...args: unknown[]) => unknown) => void;
export function installAmazonIpc(window: BrowserWindow, service: AmazonService, handle: IpcHandler, cleanupBackups: () => Promise<number>, scheduleFollowup?: (id: string) => void): void {
  handle('red:amazon:targets', 0, () => service.listTargets());
  handle('red:amazon:credential-diagnostics', 0, () => service.credentialDiagnostics());
  handle('red:amazon:demo', 0, () => service.enableDemo());
  handle('red:amazon:credentials-save', 1, raw => service.importCredentials(raw));
  handle('red:amazon:credentials-import', 0, async () => {
    const choice = await dialog.showOpenDialog(window, { title: '导入目标店铺的 SP-API 授权配置', properties: ['openFile'], filters: [{ name: '授权配置 JSON', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    if ((await stat(choice.filePaths[0])).size > 32 * 1024) throw new UserFacingError('授权配置文件不能超过 32 KB');
    let raw: unknown;
    try { raw = JSON.parse(await readFile(choice.filePaths[0], 'utf8')); } catch { throw new UserFacingError('授权配置不是有效 JSON，请按模板检查字段'); }
    return service.importCredentials(raw);
  });
  handle('red:amazon:credentials-template', 0, async () => {
    const choice = await dialog.showSaveDialog(window, { title: '保存 SP-API 授权配置模板', defaultPath: 'HTC-SPAPI-配置模板.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    await writeFileAtomically(choice.filePath, JSON.stringify({ name: '我的 Amazon 店铺', sellerId: '', marketplaceId: 'ATVPDKIKX0DER', region: 'na', locale: 'en_US', clientId: '', clientSecret: '', refreshToken: '' }, null, 2));
    return { cancelled: false };
  });
  handle('red:amazon:pause', 1, raw => service.pauseTarget(raw));
  handle('red:amazon:disconnect', 1, async raw => {
    const id = identifier(raw), target = service.getTarget(id);
    const answer = await dialog.showMessageBox(window, { type: 'question', title: '解除本机店铺授权', message: `解除「${target.name}」的本机连接？`, detail: '本机保存的加密凭据会被移除。商品与上架处理记录保留；Amazon 端的应用授权需要在 Seller Central 管理。', buttons: ['保留连接', '解除本机连接'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return { cancelled: true };
    await service.disconnectTarget(id); return { cancelled: false };
  });
  handle('red:amazon:types', 1, raw => service.searchProductTypes(raw));
  handle('red:amazon:schema', 1, raw => service.getSchema(raw));
  handle('red:amazon:actual-quote',1,raw=>service.getActualQuoteDetails(identifier(raw)));
  handle('red:amazon:drafts', 1, raw => service.listDrafts(identifier(raw)));
  handle('red:amazon:draft-create', 1, raw => service.createDraft(raw));
  handle('red:amazon:drafts-prepare', 1, raw => service.prepareDrafts(raw));
  handle('red:amazon:draft-save', 1, raw => service.saveDraft(raw));
  handle('red:amazon:validate', 1, raw => service.validateDraft(raw));
  handle('red:amazon:preview', 1, raw => service.previewDraft(raw));
  handle('red:amazon:submit', 1, async raw => {
    const input = record(raw, '提交参数', ['id', 'revision']);
    const draft = service.getDraft(identifier(input.id));
    if (draft.revision !== input.revision || draft.state !== 'AMAZON_VALIDATED') throw new UserFacingError('请先保存当前草稿并完成验证预览');
    const target = service.getTarget(draft.targetId);
    const demo = draft.mode === 'demo';
    const answer = await dialog.showMessageBox(window, { type: 'question', title: demo ? '确认演示提交' : '确认正式提交到 Amazon',
      message: `${demo ? '演示提交' : '正式提交'} SKU：${draft.sku}`,
      detail: `店铺：${target.name}\n卖家：${draft.sellerId}\n站点：${target.marketplaceName} (${draft.marketplaceId})\n商品类型：${draft.schema.productType}\n\n${demo ? '本次仅生成本地模拟结果，不会访问 Amazon。' : '本次会创建或更新该店铺的同名 SKU。请确认页面展示的商品属性、报价及图片地址。'}`,
      buttons: ['取消', demo ? '确认演示提交' : '确认正式提交'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return null;
    const submitted = await service.submitDraft({ id: draft.id, revision: draft.revision }, true);
    if (!demo) scheduleFollowup?.(submitted.id);
    return submitted;
  });
  handle('red:amazon:readback', 1, raw => service.readListing(raw));
  handle('red:amazon:corrections',1,raw=>service.listCorrections(identifier(raw)));
  handle('red:amazon:correction-prepare',1,raw=>service.prepareCorrection(raw));
  handle('red:amazon:correction-preview',1,raw=>service.previewCorrection(raw));
  handle('red:amazon:correction-read',1,raw=>service.readCorrection(raw));
  handle('red:amazon:correction-cancel',1,raw=>service.cancelCorrection(raw));
  handle('red:amazon:self-relation-correct',1,raw=>service.correctUnsubmittedSelfRelation(raw));
  handle('red:amazon:correction-send',1,async raw=>{
    const input=record(raw,'修正参数',['id','revision','patchHash']),c=service.getCorrection(identifier(input.id));
    if(!['PREPARED','READY'].includes(c.state)||c.revision!==input.revision||c.patchHash!==input.patchHash)throw new UserFacingError('请重新加载已准备的修正范围');
    const answer=await dialog.showMessageBox(window,{type:'question',title:'确认原 SKU 修正范围',message:`继续修正原 SKU ${c.sku}？`,detail:`卖家：${c.sellerId}\n站点：${c.marketplaceId}\n商品类型：${c.productType}\n第 ${c.round??1}/2 轮；本次确认允许以下范围内最多两轮不同载荷的自动修正，保留原 SKU、图片与提交历史。无变化不重发，UNKNOWN 必须核对。\n依据：${(c.evidence??[]).join('；')}\n差异：${JSON.stringify((c.scope??["package_contains_sku"]).map(field=>({field,before:c.before[field]??null,after:c.after[field]??null})))}\n补丁：${JSON.stringify(c.request.patches)}\n指纹：${c.patchHash}\n接受后核对结果，不代表已可售。`,buttons:['取消','确认范围并继续'],defaultId:0,cancelId:0,noLink:true});
    if(answer.response!==1)return null;
    return service.continueCorrection({id:c.id,revision:c.revision,patchHash:c.patchHash},true);
  });
  handle('red:amazon:calls', 0, () => service.listCalls());
  handle('red:amazon:policy', 0, () => service.getDataPolicy());
  handle('red:amazon:policy-save', 1, raw => service.saveDataPolicy(raw));
  handle('red:amazon:cleanup', 0, async () => ({ ...service.cleanupData(), removedBackups: await cleanupBackups() }));
}
