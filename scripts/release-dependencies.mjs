import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {basename,dirname,join} from 'node:path';
/** A worktree may share its ancestor's installed npm tree. Read/copy only; the lock is verified in the snapshot. */
export function installedDependencyRoot(repo){
 const require=createRequire(join(repo,'package.json'));
 const root=dirname(dirname(require.resolve('electron/package.json')));
 assert.equal(basename(root).toLowerCase(),'node_modules','A flat installed npm dependency tree is required');return root;
}
