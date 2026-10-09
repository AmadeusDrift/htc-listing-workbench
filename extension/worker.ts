/// <reference path="./chrome.d.ts" />
import { COLLECTION_ERROR_CODES, COLLECTION_MAX_MESSAGE_BYTES } from '../src/shared/collection-contracts.ts';
import type { CollectionReceiveResult, CollectionRequest, CollectionResponse, CollectionSnapshot } from '../src/shared/collection-contracts.ts';
import { normalizePage } from './normalize.ts';
import { read1688Page } from './read-page.ts';

let pending: { captureId: string; snapshot: CollectionSnapshot } | null = null;
let receipt: CollectionReceiveResult | null = null;
let working = false;
function state() { return { ok: true, pending, receipt, working }; }
function native(request: CollectionRequest): Promise<CollectionResponse> {
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > COLLECTION_MAX_MESSAGE_BYTES) return Promise.reject(new Error('TOO_LARGE'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: string | null, response?: CollectionResponse) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(new Error(error)) : resolve(response!); };
    const timer = setTimeout(() => finish('TIMEOUT'), 15000);
    chrome.runtime.sendNativeMessage(__HTC_NATIVE_HOST__, request, reply => {
      if (chrome.runtime.lastError) { finish('APP_UNAVAILABLE'); return; }
      const response = reply as CollectionResponse;
      if (!response || response.version !== 1 || (response.requestId !== request.requestId && !(response.type === 'error' && response.requestId === null))) { finish('INVALID_MESSAGE'); return; }
      if (!response.ok) { finish(COLLECTION_ERROR_CODES.includes(response.code) ? response.code : 'INVALID_MESSAGE'); return; }
      if (request.type === 'status' && response.type === 'status' && ['ready', 'paused'].includes(response.state)) { finish(null, response); return; }
      if (request.type === 'capture' && response.type === 'receipt' && response.receipt?.captureId === request.captureId) { finish(null, response); return; }
      finish('INVALID_MESSAGE');
    });
  });
}
async function act(type: string, previewCaptureId?: string) {
  if (type === 'state') return state();
  if (type === 'status') {
    const response = await native({ version: 1, type: 'status', requestId: crypto.randomUUID() });
    return { ok: true, connection: response.type === 'status' ? response.state : 'paused' };
  }
  if (working) throw new Error('APP_BUSY');
  if (type === 'discard') { pending = null; receipt = null; return state(); }
  working = true;
  try {
    if (type === 'read') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id || !tab.url) throw new Error('PAGE_UNAVAILABLE');
      const source = new URL(tab.url);
      const fixture = __HTC_TEST_FIXTURES__ && source.protocol === 'http:' && source.hostname === '127.0.0.1';
      if (!fixture && (source.protocol !== 'https:' || source.hostname !== 'detail.1688.com' || !/^\/offer\/[1-9]\d{0,19}\.html$/.test(source.pathname))) throw new Error('INVALID_SOURCE');
      let results;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { results = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: read1688Page, args: [__HTC_TEST_FIXTURES__] }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('TIMEOUT')), 8000); }),
      ]); }
      catch (error) { throw new Error(error instanceof Error && error.message === 'TIMEOUT' ? 'TIMEOUT' : 'PAGE_UNAVAILABLE'); }
      finally { clearTimeout(timeout); }
      const snapshot = normalizePage(results[0]?.result);
      const next = { captureId: crypto.randomUUID(), snapshot };
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > COLLECTION_MAX_MESSAGE_BYTES - 256) throw new Error('TOO_LARGE');
      pending = next; receipt = null;
    } else if (type === 'send') {
      if (!pending) throw new Error('NOTHING_TO_SEND');
      if (pending.captureId !== previewCaptureId) throw new Error('CAPTURE_CONFLICT');
      const response = await native({ version: 1, type: 'capture', requestId: crypto.randomUUID(), ...pending });
      if (response.type !== 'receipt') throw new Error('INVALID_MESSAGE');
      receipt = response.receipt;
    }
  } finally { working = false; }
  return state();
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  if (!message || typeof message !== 'object' || !('type' in message) || !['state', 'status', 'read', 'send', 'discard'].includes(String(message.type))) { respond({ ok: false, code: 'INVALID_MESSAGE' }); return; }
  const isSend = message.type === 'send';
  if (Object.keys(message).length !== (isSend ? 2 : 1) || (isSend && (!('captureId' in message) || typeof message.captureId !== 'string' || !/^[0-9a-f-]{36}$/.test(message.captureId)))) { respond({ ok: false, code: 'INVALID_MESSAGE' }); return; }
  const previewCaptureId = 'captureId' in message && typeof message.captureId === 'string' ? message.captureId : undefined;
  void act(String(message.type), previewCaptureId).then(respond, error => respond({ ok: false, code: error instanceof Error ? error.message : 'INTERNAL_ERROR' }));
  return true;
});
