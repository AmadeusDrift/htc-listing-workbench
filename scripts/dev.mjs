import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { buildElectron } from './build-electron.mjs';

await buildElectron();
const server = await createServer(); await server.listen();
process.env.electron_config_cache = resolve('.cache/electron');
const require = createRequire(import.meta.url);
const env = { ...process.env, RED_DEV_SERVER_URL: 'http://127.0.0.1:5173/' }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.'], { stdio: 'inherit', env, windowsHide: true });
child.on('exit', async code => { await server.close(); process.exitCode = code ?? 1; });
child.on('error', async error => { console.error(error.message); await server.close(); process.exitCode = 1; });
process.on('SIGINT', () => child.kill());
