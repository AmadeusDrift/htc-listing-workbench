const fs = require('node:fs');
const { resolve, relative, isAbsolute, dirname } = require('node:path');
const worktreeRoot = resolve(__dirname,'../../..');
const realRoot = fs.realpathSync.native(worktreeRoot);
const contained = (base,path) => {
  const value=relative(base,path);
  return !value.startsWith('..') && !isAbsolute(value);
};
// Dependencies may use a junction, but data/harness/output paths never may.
// Check every existing ancestor, including when the requested leaf is absent.
function trustedWithin(base,path) {
  if (!path || !isAbsolute(path) || !contained(base,resolve(path)) || !contained(worktreeRoot,resolve(path))) return false;
  let current=resolve(path);
  for(;;) {
    try {
      if(fs.lstatSync(current).isSymbolicLink() || !contained(realRoot,fs.realpathSync.native(current))) throw Error('STABILIZATION_PATH_UNTRUSTED');
    } catch(error) { if(error.code!=='ENOENT') throw error; }
    if(relative(worktreeRoot,current)==='') break;
    current=dirname(current);
  }
  return true;
}
function assertTrustedWithin(base,path) {
  if(!trustedWithin(base,path)) throw Error('STABILIZATION_PATH_UNTRUSTED');
}
module.exports={worktreeRoot,trustedWithin,assertTrustedWithin};
