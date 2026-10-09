import { randomUUID } from 'node:crypto';
import { link, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Replace an export only after its complete contents have reached disk. */
export async function writeFileAtomically(destination: string, contents: string | Uint8Array, replace = true): Promise<void> {
  const temporary = join(dirname(destination), `.red-export-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, 'wx'); created = true;
    try { await file.writeFile(contents, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    if (replace) await rename(temporary, destination);
    else { await link(temporary, destination); await unlink(temporary); }
    created = false;
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}
