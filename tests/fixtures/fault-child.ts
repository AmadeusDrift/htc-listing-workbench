import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { commitWorkspaceRestore } from '../../src/main/backup.ts';
import type { PreparedRestore } from '../../src/main/backup.ts';

const root = resolve(process.argv[2]), within = relative(resolve('.test-data'), root);
if (within.startsWith('..') || within.includes(sep) || !within.startsWith('fault-recovery-')) throw new Error('Isolated fault fixture required');
const mode = process.argv[3], directory = join(root, 'target');
if (mode === 'restore') {
  const prepared = JSON.parse(await readFile(join(root, 'prepared.json'), 'utf8')) as PreparedRestore;
  await commitWorkspaceRestore(directory, prepared, point => { if (point === process.argv[4]) process.exit(73); });
} else if (mode === 'lock') {
  const db = new DatabaseSync(join(directory, 'red.sqlite'));
  db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
  process.send?.({ locked: true });
  const timer = setTimeout(() => { db.close(); process.exit(74); }, 15000);
  process.once('message', () => { clearTimeout(timer); db.exec('ROLLBACK'); db.close(); process.exit(0); });
} else throw new Error('Unknown fault fixture');
