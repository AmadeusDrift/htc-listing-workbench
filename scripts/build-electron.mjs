import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function buildElectron() {
  // The packaged executable enters main.cjs for every launch. Route the private
  // image child before evaluating any business startup or single-instance lock.
  await build({ absWorkingDir: resolve('.'), tsconfig: resolve('tsconfig.json'), entryPoints: { main: resolve('src/main/index.ts') }, outdir: 'dist-electron',
    banner:{js:"if (process.argv.includes('--htc-image-worker')) { require('./image-worker.cjs'); } else {"},footer:{js:'}'},
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['electron'], sourcemap: true });
  await build({ absWorkingDir: resolve('.'), tsconfig: resolve('tsconfig.json'), entryPoints: { preload: resolve('src/main/preload.ts'), 'image-worker':resolve('src/main/image-processing/worker.ts') }, outdir:'dist-electron',
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['electron'], sourcemap: true });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildElectron();
