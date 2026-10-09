import { readFileSync } from 'node:fs';
import type { AmazonSchema } from '../../../src/shared/amazon-contracts.ts';

export function realAmazonSchema(): AmazonSchema {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`./drink-coaster-us/${name}.json`, import.meta.url), 'utf8'));
  const context = read('context');
  return { ...context, key: 'sanitized-drink-coaster-us', targetId: 'fixture-target', mode: 'demo', schema: read('schema'), metaSchema: read('meta-schema') };
}

export function realParentAmazonSchema(): AmazonSchema {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`./figurine-parent-us/${name}.json`, import.meta.url), 'utf8'));
  return { ...read('context'), key: 'sanitized-figurine-parent-us', targetId: 'fixture-target', mode: 'demo', schema: read('schema'), metaSchema: read('meta-schema') };
}
