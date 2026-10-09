import { AiError, abortable, throwIfAborted } from '../ai/errors.ts';
import { providerError, readJson } from './adapter.ts';
import { imageRequestNotSent } from './errors.ts';

/** One request to the fixed relay origin; credentials never reach redirects or error messages. */
export async function relayJson(fetcher: typeof fetch, path: string, apiKey: string, signal: AbortSignal, body?: string, maxBytes = 32 * 1024 * 1024): Promise<{ data: unknown; response: Response }> {
  let received: Response | undefined;
  const cancel = () => { void received?.body?.cancel().catch(() => {}); };
  try{throwIfAborted(signal);}catch(error){throw imageRequestNotSent(error);}
  try {
    received = await abortable(fetcher(`https://tyaiapi.com${path}`, {
      method: body === undefined ? 'GET' : 'POST', body, signal, redirect: 'error', credentials: 'omit',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    }).then(value => { received = value; if (signal.aborted) cancel(); return value; }), signal, cancel);
  } catch { throwIfAborted(signal); throw new AiError('NETWORK_ERROR'); }
  if (signal.aborted) { cancel(); throwIfAborted(signal); }
  if (!received) throw new AiError('NETWORK_ERROR');
  let data: unknown;
  try { data = await readJson(received, maxBytes, signal); }
  catch (error) { throwIfAborted(signal); if (received.ok) throw error; }
  if (!received.ok) throw providerError(received.status, data);
  return { data, response: received };
}
