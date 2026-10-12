import { AiError } from './ai/errors.ts';
import { presentRejection } from '../shared/rejection-presentation.ts';
import { UserFacingError } from '../shared/errors.ts';
import { resolve, sep } from 'node:path';
import { identifier } from '../shared/validation.ts';

export function authorizeSender(sender: { senderId: number; windowId: number; isMainFrame: boolean; url: string }, expected: string): void {
  let actual: URL, allowed: URL;
  try { actual = new URL(sender.url); allowed = new URL(expected); } catch { throw new UserFacingError('调用来源不受信任'); }
  actual.hash = ''; allowed.hash = '';
  if (sender.senderId !== sender.windowId || !sender.isMainFrame || actual.href !== allowed.href) throw new UserFacingError('调用来源不受信任');
}
export function assetIdFromUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'red-asset:' || url.hostname !== 'image' || url.port || url.username || url.password || url.search || url.hash) throw new UserFacingError('图片来源无效');
  return identifier(url.pathname.slice(1));
}
export function managedAssetPath(root: string, relative: string): string {
  if (!/^assets\/[0-9a-f-]{36}(?:\.preview)?\.(png|jpg)$/.test(relative)) throw new UserFacingError('素材路径无效');
  const base = resolve(root), destination = resolve(base, relative);
  if (!destination.startsWith(base + sep)) throw new UserFacingError('素材路径越界');
  return destination;
}
export function publicRejection(error:unknown){return error instanceof AiError?(error.rejection??(error.reason?{version:'rejection-presentation/v1' as const,code:error.reason}:undefined)):undefined;}
export function publicError(error: unknown): string {
  if (error instanceof AiError && (error.rejection||error.reason)) return presentRejection(error.rejection?.code??error.reason);
  if (error instanceof UserFacingError) return error.message.slice(0, 300);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (['EACCES', 'EPERM'].includes(code)) return '没有访问所选文件或数据目录的权限，请选择可访问的位置';
  if (code === 'ENOENT') return '所选文件已移动或不存在，请重新选择';
  if (code === 'ENOSPC') return '磁盘空间不足，本次操作未完成';
  return '本地操作未完成，具体原因尚未确定，请核对失败阶段与诊断记录';
}
