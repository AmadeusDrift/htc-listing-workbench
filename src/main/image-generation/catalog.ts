import { TYAI_IMAGE_MODELS } from '../../shared/image-generation-contracts.ts';
import type { ImageModelCatalog, ImageModelOption } from '../../shared/image-generation-contracts.ts';
import { relayModelProtocol, validRelayModelId } from '../../shared/image-models.ts';
import { AiError } from '../ai/errors.ts';
import { relayJson } from './relay-request.ts';

const object = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw);
export function builtInModels(): ImageModelCatalog {
  return { source: 'builtin', fetchedAt: null, models: TYAI_IMAGE_MODELS.map(id => ({ id, protocol: relayModelProtocol(id), endpoints: [] })) };
}
export async function fetchRelayModels(fetcher: typeof fetch, apiKey: string, signal: AbortSignal): Promise<ImageModelCatalog> {
  const { data } = await relayJson(fetcher, '/v1/models', apiKey, signal, undefined, 2 * 1024 * 1024);
  if (!object(data) || !Array.isArray(data.data) || data.data.length > 5000 || data.has_more === true) throw new AiError('OUTPUT_INVALID');
  const models = new Map<string, ImageModelOption>();
  for (const row of data.data) {
    if (!object(row)) throw new AiError('OUTPUT_INVALID');
    if (!validRelayModelId(row.id) || row.id.includes(apiKey)) continue;
    const endpoints = Array.isArray(row.supported_endpoint_types) ? row.supported_endpoint_types.filter((value): value is string => typeof value === 'string' && ['openai', 'gemini', 'image-generation', 'image-edits'].includes(value)) : [];
    const combined = [...new Set([...(models.get(row.id)?.endpoints ?? []), ...endpoints])];
    models.set(row.id, { id: row.id, protocol: relayModelProtocol(row.id, combined), endpoints: combined });
  }
  return { source: 'remote', fetchedAt: new Date().toISOString(), models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
