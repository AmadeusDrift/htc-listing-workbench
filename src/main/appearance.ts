import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultAppearancePreferences } from '../shared/appearance-contracts.ts';
import type { AppearanceApi, AppearancePreferences } from '../shared/appearance-contracts.ts';
import { UserFacingError } from '../shared/errors.ts';
import { record } from '../shared/validation.ts';
import { writeFileAtomically } from './files.ts';

function parseAppearancePreferences(raw: unknown): AppearancePreferences {
  const value = record(raw, '外观设置', ['theme', 'density', 'motion']);
  if (Reflect.ownKeys(value).length !== 3 || !['theme', 'density', 'motion'].every(key => Object.hasOwn(value, key))
    || !['light', 'dark', 'system'].includes(value.theme as string)
    || !['comfortable', 'compact'].includes(value.density as string)
    || !['full', 'reduced'].includes(value.motion as string)) throw new UserFacingError('外观设置格式不正确');
  return { theme: value.theme as AppearancePreferences['theme'], density: value.density as AppearancePreferences['density'], motion: value.motion as AppearancePreferences['motion'] };
}

/** A separate local preference file keeps branding changes out of the workspace database and credentials. */
export class AppearanceStore implements AppearanceApi {
  private readonly directory: string;
  private pendingSave: Promise<void> = Promise.resolve();
  constructor(directory: string) { this.directory = resolve(directory); }

  private async checkedFile(): Promise<{ path: string; size: number | null }> {
    const root = await lstat(this.directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new UserFacingError('外观设置目录不可安全访问');
    const path = join(this.directory, 'appearance.json');
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new UserFacingError('外观设置文件不可安全访问');
      return { path, size: stat.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, size: null };
      throw error;
    }
  }

  async getAppearance(): Promise<AppearancePreferences> {
    await this.pendingSave;
    try {
      const file = await this.checkedFile();
      if (file.size === null || file.size < 1 || file.size > 4096) return defaultAppearancePreferences();
      return parseAppearancePreferences(JSON.parse(await readFile(file.path, 'utf8')));
    } catch { return defaultAppearancePreferences(); }
  }

  async saveAppearance(raw: unknown): Promise<AppearancePreferences> {
    const value = parseAppearancePreferences(raw);
    const saved = this.pendingSave.then(async () => {
      const file = await this.checkedFile();
      await writeFileAtomically(file.path, JSON.stringify(value, null, 2) + '\n');
      return { ...value };
    });
    this.pendingSave = saved.then(() => {}, () => {});
    return saved;
  }
}

export function appearanceTitleBarOverlay(theme: AppearancePreferences['theme'], systemDark: boolean) {
  const dark = theme === 'dark' || theme === 'system' && systemDark;
  return { color: dark ? '#20303b' : '#eef3f6', symbolColor: dark ? '#e7eef3' : '#253f4e', height: 44 };
}
