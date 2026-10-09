/// <reference path="./chrome.d.ts" />
import type { CollectionReceiveResult, CollectionSnapshot } from '../src/shared/collection-contracts.ts';
import { errorLabels, warningLabels } from '../src/shared/collection-labels.ts';
type State = { ok: boolean; code?: string; working?: boolean; connection?: string; pending?: { captureId: string; snapshot: CollectionSnapshot } | null; receipt?: CollectionReceiveResult | null };
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const buttons = ['read', 'connect', 'send'].map(id => element<HTMLButtonElement>(id));
let previewCaptureId: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function render(state: State) {
  previewCaptureId = state.pending?.captureId ?? null;
  if (!state.pending) { element('preview').hidden = true; return; }
  const snapshot = state.pending.snapshot;
  element('preview').hidden = false;
  element('title').textContent = snapshot.title || `1688 商品 ${snapshot.offerId}`;
  element('source').textContent = `商品 ${snapshot.offerId} · ${new Date(snapshot.capturedAt).toLocaleTimeString('zh-CN')}`;
  element('skus-count').textContent = String(snapshot.skus.length); element('images-count').textContent = String(snapshot.images.length);
  element('skus').replaceChildren(...snapshot.skus.map(sku => {
    const tr = document.createElement('tr'), name = document.createElement('td'), spec = document.createElement('span'), price = document.createElement('td');
    name.textContent = sku.providerSkuId; spec.textContent = sku.originalSpec || '规格待补'; name.append(spec);
    price.textContent = sku.purchasePrice === null ? '待补' : `¥ ${sku.purchasePrice}`; tr.append(name, price); return tr;
  }));
  element('warnings').replaceChildren(...snapshot.warnings.map(code => { const li = document.createElement('li'); li.textContent = warningLabels[code]; return li; }));
  element('receipt').hidden = !state.receipt;
  element('receipt').textContent = state.receipt ? `${state.receipt.duplicate ? '已在采集箱，未重复创建' : '已送入采集箱'} · ${state.receipt.variantCount} 个 SKU` : '';
  element('send').textContent = state.receipt ? '再次确认入箱' : '送入采集箱';
}
async function action(type: string) {
  clearTimeout(refreshTimer);
  let workerBusy = false;
  buttons.forEach(button => { button.disabled = true; }); element('error').hidden = true;
  element('notice').textContent = ({ read: '正在读取当前商品…', send: '正在等待工作台确认…', status: '正在检查连接…' } as Record<string, string>)[type] ?? '';
  try {
    const state = await chrome.runtime.sendMessage(type === 'send' ? { type, captureId: previewCaptureId } : { type }) as State;
    if (!state?.ok) throw new Error(state?.code ?? 'INTERNAL_ERROR');
    if (type === 'status') element('connection').textContent = state.connection === 'ready' ? '工作台已连接' : '工作台暂时忙碌';
    else render(state);
    workerBusy = state.working === true;
    element('notice').textContent = workerBusy ? '正在完成上一次读取或发送…' : '';
    if (workerBusy) refreshTimer = setTimeout(() => void action('state'), 250);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
    element('error').textContent = errorLabels[code] ?? errorLabels.INTERNAL_ERROR; element('error').hidden = false; element('notice').textContent = '';
    if (type === 'status') element('connection').textContent = '尚未连接';
  } finally { buttons.forEach(button => { button.disabled = workerBusy; }); }
}
element('connect').addEventListener('click', () => void action('status'));
element('read').addEventListener('click', () => void action('read'));
element('send').addEventListener('click', () => void action('send'));
void action('state');
