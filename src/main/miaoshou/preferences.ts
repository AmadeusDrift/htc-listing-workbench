import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MiaoshouPreferences } from '../../shared/miaoshou-contracts.ts';
import { writeFileAtomically } from '../files.ts';
import { exact, fail } from './validation.ts';

function parse(raw: unknown): MiaoshouPreferences {
  const value = exact(raw, ['autoSyncOnInbox'], 'INPUT');
  if (typeof value.autoSyncOnInbox !== 'boolean') return fail('INPUT');
  return { autoSyncOnInbox: value.autoSyncOnInbox };
}
export class MiaoshouPreferenceStore {
  private pending: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(directory: string) { this.path = join(directory, 'miaoshou-preferences.json'); }
  private async check(): Promise<number | null> {
    try {
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return fail('STORAGE');
      return stat.size;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async get(): Promise<MiaoshouPreferences> {
    await this.pending;
    try { const size = await this.check(); return size && size <= 1024 ? parse(JSON.parse(await readFile(this.path, 'utf8'))) : { autoSyncOnInbox: false }; }
    catch { return { autoSyncOnInbox: false }; }
  }
  async save(raw: unknown): Promise<MiaoshouPreferences> {
    const value = parse(raw);
    const operation = this.pending.then(async () => {
      await this.check(); await writeFileAtomically(this.path, JSON.stringify(value) + '\n'); return { ...value };
    });
    this.pending = operation.then(() => {}, () => {});
    return operation;
  }
}
