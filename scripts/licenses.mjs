import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Production code bundled by Vite/esbuild. Electron's notices remain beside HTC.exe.
const packages = ['react', 'react-dom', 'scheduler', 'lucide-react', 'ajv', 'ajv-formats', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string', 'basic-ftp', 'pdf-lib', '@pdf-lib/standard-fonts', '@pdf-lib/upng', 'pako', 'tslib'];
const licenseFiles = { 'require-from-string': 'license', 'basic-ftp': 'LICENSE.txt', 'pdf-lib': 'LICENSE.md', '@pdf-lib/standard-fonts': 'LICENSE.md', 'tslib': 'LICENSE.txt' };
export async function noticesText(dependencyRoot = 'node_modules') {
  const sections = ['HTC Workbench — Third-party notices\n\nThe following components are bundled with the application. Electron and Chromium notices are distributed separately as LICENSE and LICENSES.chromium.html.'];
  for (const name of packages) {
    const directory = join(dependencyRoot, name), pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const license = await readFile(join(directory, licenseFiles[name] ?? 'LICENSE'), 'utf8');
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
    sections.push(`${name} ${pkg.version}\n${repository}\n${'='.repeat(64)}\n${license.trim()}`);
    if (name === 'pako') {
      const source = await readFile(join(directory, 'lib/zlib/inflate.js'), 'utf8');
      const notice = source.match(/\/\/ \(C\) 1995[\s\S]*?\/\/ 3\.[^\r\n]*/)?.[0];
      if (!notice) throw new Error('Missing bundled zlib notice');
      sections.push('pako bundled zlib license\n' + '='.repeat(64) + '\n' + notice.replace(/^\/\/ ?/gm, ''));
    }
  }
  return sections.join('\n\n') + '\n';
}
export async function writeNotices(target, dependencyRoot = 'node_modules') {
  if (!target) throw new Error('An explicit notices target is required');
  await writeFile(target, await noticesText(dependencyRoot), { encoding: 'utf8', flag: 'wx' });
}
