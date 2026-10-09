import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function buildElectron() {
  await build({ absWorkingDir: resolve('.'), tsconfig: resolve('tsconfig.json'), entryPoints: { main: resolve('src/main/index.ts'), preload: resolve('src/main/preload.ts') }, outdir: 'dist-electron',
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['electron'], sourcemap: true });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildElectron();
