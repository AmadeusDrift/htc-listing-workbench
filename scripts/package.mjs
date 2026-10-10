import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { cli } from './release-verification.mjs';
import { assertArtifactLocation } from './release-source.mjs';
import { assembleCandidate, verifyBuild } from './release-package.mjs';
import { noticesText } from './licenses.mjs';

assert.equal(process.platform, 'win32', 'Windows candidate required');
const args = cli(['--source-repo', '--snapshot', '--output']);
const repo = args['--source-repo'], snapshot = args['--snapshot'], output = args['--output'];
assertArtifactLocation(repo, output);
const { source, build } = await verifyBuild(repo, snapshot);
const pkg = JSON.parse(await readFile(join(snapshot, 'package.json'), 'utf8'));
const receipt = await assembleCandidate({ snapshot, runtime: join(snapshot, 'node_modules/electron/dist'), output, pkg,
  notices: await noticesText(join(snapshot, 'node_modules')), source, build, protectedRoots: [join(repo, 'release'), join(repo, '.git')] });
await verifyBuild(repo, snapshot);
await writeFile(join(dirname(output), `${basename(output)}-receipt.json`), JSON.stringify({ sourceCommit: source.commit, ...receipt }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ candidate: output, activated: false, sourceCommit: source.commit, ...receipt }, null, 2));
