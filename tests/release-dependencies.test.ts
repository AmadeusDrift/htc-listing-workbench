import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
const {installedDependencyRoot}=await import(new URL('../scripts/release-dependencies.mjs',import.meta.url).href);
test('candidate snapshot resolves an ancestor installed dependency tree without installing into the worktree',t=>{
 mkdirSync(resolve('.test-data'),{recursive:true});const root=mkdtempSync(resolve('.test-data/release-dependencies-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repo=join(root,'artifacts','worktrees','feature'),modules=join(root,'node_modules');mkdirSync(repo,{recursive:true});writeFileSync(join(repo,'package.json'),'{}');mkdirSync(join(modules,'electron'),{recursive:true});writeFileSync(join(modules,'electron','package.json'),JSON.stringify({name:'electron',version:'44.4.5'}));
 assert.equal(installedDependencyRoot(repo),modules);
});
