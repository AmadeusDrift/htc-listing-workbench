import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (!existsSync('dist/index.html') || !existsSync('dist-electron/main.cjs')) {
  console.error('请先运行 npm run build，再启动 HTC。'); process.exit(1);
}
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.'], { stdio: 'inherit', env, windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
