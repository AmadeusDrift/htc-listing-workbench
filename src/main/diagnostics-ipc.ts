import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IpcHandler } from './amazon-ipc.ts';
import { UserFacingError } from '../shared/errors.ts';
import { writeFileAtomically } from './files.ts';
import { createLocalDiagnosticReport } from './diagnostics/service.ts';
import type { DiagnosticContext } from './diagnostics/service.ts';
import type { RunDiagnosticReport } from '../shared/run-report-contracts.ts';

interface DiagnosticHooks {
  runReport?: { query(input: unknown): RunDiagnosticReport; export(input: unknown): RunDiagnosticReport };
  context(): DiagnosticContext;
  /** Implemented only by the main process's native save dialog. Never accepts a renderer path. */
  selectDestination(): Promise<{ canceled: boolean; filePath?: string }>;
}
type OperationCode = 'DIAGNOSTIC_FAILED' | 'DIAGNOSTIC_EXPORT_DESTINATION' | 'DIAGNOSTIC_EXPORT_FAILED' | 'DIAGNOSTIC_EXPORT_NO_SPACE';
class DiagnosticOperationError extends UserFacingError {
  constructor(code: OperationCode) { super(code); }
}
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const inside = (root: string, path: string) => { const child = relative(canonical(root), canonical(path)); return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
async function exportDestination(directory: string, selected: string): Promise<string> {
  const reject = () => { throw new DiagnosticOperationError('DIAGNOSTIC_EXPORT_DESTINATION'); };
  if (typeof selected !== 'string' || !isAbsolute(selected) || extname(selected).toLowerCase() !== '.json') reject();
  const destination = resolve(selected), root = resolve(directory), parent = dirname(destination);
  if (inside(root, destination)) reject();
  const actualRoot = await realpath(root), actualParent = await realpath(parent), parentStat = await lstat(parent);
  // Resolve aliases before checking the entire data root, including future credential/bridge folders.
  if (inside(actualRoot, join(actualParent, basename(destination))) || !parentStat.isDirectory() || parentStat.isSymbolicLink() || canonical(parent) !== canonical(actualParent)) reject();
  try {
    const file = await lstat(destination);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || canonical(await realpath(destination)) !== canonical(destination)) reject();
  } catch (error) { if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw error; }
  return join(actualParent, basename(destination));
}
export function installDiagnosticsIpc(directory: string, handle: IpcHandler, hooks: DiagnosticHooks): void {
  if (hooks.runReport) {
    handle('red:diagnostics:run-query', 1, input => hooks.runReport!.query(input));
    handle('red:diagnostics:run-export', 1, async input => {
      try {
        const selected = await hooks.selectDestination();
        if (selected.canceled || !selected.filePath) return { cancelled: true };
        await exportDestination(directory, selected.filePath);
        const report = hooks.runReport!.export(input);
        const destination = await exportDestination(directory, selected.filePath);
        await writeFileAtomically(destination, JSON.stringify(report, null, 2)+'\n');
        return { cancelled: false };
      } catch (error) {
        if (error instanceof DiagnosticOperationError || error instanceof UserFacingError) throw error;
        throw new DiagnosticOperationError((error as { code?: unknown } | null)?.code === 'ENOSPC' ? 'DIAGNOSTIC_EXPORT_NO_SPACE' : 'DIAGNOSTIC_EXPORT_FAILED');
      }
    });
  }
  handle('red:diagnostics:get', 0, async () => {
    try { return await createLocalDiagnosticReport(directory, hooks.context()); }
    catch { throw new DiagnosticOperationError('DIAGNOSTIC_FAILED'); }
  });
  handle('red:diagnostics:export', 0, async () => {
    try {
      const selected = await hooks.selectDestination();
      if (selected.canceled || !selected.filePath) return { cancelled: true };
      await exportDestination(directory, selected.filePath);
      const report = await createLocalDiagnosticReport(directory, hooks.context());
      // File inspection yields to the event loop. Revalidate after it, immediately before writing.
      const destination = await exportDestination(directory, selected.filePath);
      await writeFileAtomically(destination, JSON.stringify(report, null, 2) + '\n');
      return { cancelled: false };
    } catch (error) {
      if (error instanceof DiagnosticOperationError) throw error;
      throw new DiagnosticOperationError((error as { code?: unknown } | null)?.code === 'ENOSPC' ? 'DIAGNOSTIC_EXPORT_NO_SPACE' : 'DIAGNOSTIC_EXPORT_FAILED');
    }
  });
}
