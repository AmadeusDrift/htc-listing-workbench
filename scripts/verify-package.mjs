import { cli } from './release-verification.mjs';
import { verifyCandidate } from './release-package.mjs';

const args = cli(['--source-repo', '--snapshot', '--package-root']);
const { manifest, ...receipt } = await verifyCandidate(args['--source-repo'], args['--snapshot'], args['--package-root']);
console.log(JSON.stringify({ package: args['--package-root'], sourceCommit: manifest.source.commit, activated: false, ...receipt }, null, 2));
