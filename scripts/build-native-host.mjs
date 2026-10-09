import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { COLLECTION_EXTENSION_ID } from '../src/shared/collection-identity.ts';

export async function buildNativeHost(outputDirectory = resolve('dist-native')) {
  if (process.platform !== 'win32') throw new Error('The collection native host build requires Windows .NET Framework 4.');
  const output = resolve(outputDirectory); await mkdir(output, { recursive: true });
  const source = (await readFile(resolve('native-host/Program.cs'), 'utf8')).replaceAll('__EXTENSION_ID__', COLLECTION_EXTENSION_ID);
  const generated = join(output, 'Program.g.cs'), executable = join(output, 'HTC.CollectionHost.exe'); await writeFile(generated, source, 'utf8');
  const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await promisify(execFile)(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${executable}`, generated], { windowsHide: true, maxBuffer: 1024 * 1024 });
  return executable;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: build-native-host.mjs [--output directory]');
  await buildNativeHost(args[1] ? resolve(args[1]) : undefined);
}
