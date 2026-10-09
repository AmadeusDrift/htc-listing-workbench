import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = resolve('.test-data'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'credential-safe-storage-')), bundle = join(directory, 'test.cjs');
const electron = createRequire(import.meta.url)('electron'), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
try {
  await build({ entryPoints: ['tests/fixtures/credential-lifecycle-electron.ts'], outfile: bundle, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'] });
  for (const phase of ['save', 'outage', 'restart']) {
    const result = await new Promise((resolveResult, reject) => {
      const process = spawn(electron, [bundle, phase, directory], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
      const timer = setTimeout(() => { process.kill(); reject(new Error(`Isolated credential phase ${phase} timed out`)); }, 30000);
      process.stdout.on('data', value => { output += value; }); process.stderr.on('data', () => {});
      process.on('error', error => { clearTimeout(timer); reject(error); });
      process.on('exit', code => { clearTimeout(timer); resolveResult({ code, output }); });
    });
    const report = result.output.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.phase === phase);
    if (report) console.log(JSON.stringify(report));
    assert.equal(result.code, 0, `Isolated credential phase ${phase} failed`);
    assert.equal(report?.passed, true, `Missing successful phase ${phase} report`);
  }
} finally {
  assert.ok(directory.startsWith(root + sep));
  await rm(directory, { recursive: true, force: true });
}
