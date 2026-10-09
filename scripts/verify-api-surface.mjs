import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { publicApi } from './api-surface.mjs';

// Static verification without starting Electron or interacting with the UI.
const source = await readFile(new URL('../src/main/preload.ts', import.meta.url), 'utf8');
const body = source.split('const api: RedApi = {')[1]?.split('contextBridge.exposeInMainWorld')[0];
assert.ok(body, 'Explicit reviewed preload object is required');
const exposed = [...body.matchAll(/^  (\w+):/gm)].map(match => match[1]);
assert.equal(new Set(publicApi).size, publicApi.length, 'Duplicate public API entries');
assert.deepEqual(exposed.sort(), [...publicApi].sort());
console.log(`Reviewed desktop API surface matches ${exposed.length} capabilities; no UI launched.`);
