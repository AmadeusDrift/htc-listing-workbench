// Test-only preload. No production imports, credentials or real workspace paths.
const { resolve, relative, isAbsolute } = require('node:path');
const { worktreeRoot, trustedWithin, assertTrustedWithin } = require('./trusted-path.cjs');
const root = process.env.HTC_STABILIZATION_DATA_DIR;
// Anchor to this versioned preload, never to a child's changed cwd.
const cwdRelative = relative(worktreeRoot,process.cwd());
if (cwdRelative.startsWith('..') || isAbsolute(cwdRelative)) throw Error('STABILIZATION_WORKTREE_REQUIRED');
assertTrustedWithin(worktreeRoot,process.cwd());
const allowedRoot = resolve(worktreeRoot, '.test-data');
const rootRelative = root ? relative(allowedRoot, resolve(root)) : '..';
if (!root || !isAbsolute(root) || rootRelative.startsWith('..') || isAbsolute(rootRelative)) {
  throw Error('STABILIZATION_DATA_ROOT_REQUIRED');
}
assertTrustedWithin(allowedRoot,root);
// Existing Electron fixtures create a distinct child root and compiled preload.
// Preserve these ONLY after verifying they remain inside this test worktree.
const dataRoot = trustedWithin(allowedRoot,process.env.RED_DATA_DIR) ? process.env.RED_DATA_DIR : root;
const harness = {};
for (const name of ['RED_E2E_PRELOAD','RED_E2E_HTML']) if (trustedWithin(worktreeRoot,process.env[name])) harness[name] = process.env[name];
for (const key of Object.keys(process.env)) {
  if (/^(OPENAI|OPENROUTER|DEEPSEEK|ALIYUN|AMAZON|AWS|FTP|MIAOSHOU|FIRMNESS_SOURCE|SOURCE_.*(?:DB|ASSETS)|RED_)/i.test(key)
      || /(?:SOURCE_DB|SOURCE_ASSETS|API_KEY|ACCESS_KEY|TOKEN|PASSWORD|SECRET|PROXY)$/i.test(key)) delete process.env[key];
}
process.env.RED_DATA_DIR = dataRoot;
process.env.RED_E2E = '1';
Object.assign(process.env,harness);
const state = { blocked: [], loopback: 0 };
globalThis.__stabilizationNetwork = state;
const local = host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(String(host).toLowerCase());
const resolvedLoopback = address => ['127.0.0.1','::1','0:0:0:0:0:0:0:1'].includes(String(address).toLowerCase());
function deny(transport) { state.blocked.push(transport); throw Error('STABILIZATION_NETWORK_BLOCKED: ' + transport); }
function protectLookup(original,transport) {
  return function(host,options,callback) {
    if(typeof options==='function'){callback=options;options=undefined;}
    let completed=false;
    const checked=(error,address,family)=>{
      if(completed)return;completed=true;
      if(error)return callback(error);
      const addresses=Array.isArray(address)?address:[{address,family}];
      if(!addresses.length||addresses.some(row=>![4,6].includes(row.family)||!resolvedLoopback(row.address))){
        state.blocked.push(transport);return callback(Error('STABILIZATION_NETWORK_BLOCKED: '+transport));
      }
      return callback(null,address,family);
    };
    return options===undefined?original.call(this,host,checked):original.call(this,host,options,checked);
  };
}
function checkUrl(input, transport) {
  let url; try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch { return deny(transport); }
  if (!local(url.hostname)) deny(transport);
  state.loopback++;
}
const fetch = globalThis.fetch;
globalThis.fetch = function(input, ...args) { checkUrl(input, 'fetch'); return fetch.call(this, input, ...args); };
const connect = require('node:net').Socket.prototype.connect;
require('node:net').Socket.prototype.connect = function(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const host = typeof first === 'object' ? first.host ?? 'localhost' : typeof first === 'number' ? (typeof normalized[1] === 'string' ? normalized[1] : 'localhost') : '';
  if (typeof first === 'string' && first.startsWith('\\\\.\\pipe\\')) return connect.apply(this, args);
  if (!local(host)) deny('net.connect');
  if(typeof first==='object'&&typeof first.lookup==='function') normalized[0]={...first,lookup:protectLookup(first.lookup,'net.lookup-result')};
  return connect.apply(this, args);
};
const dns = require('node:dns');
for (const target of [dns, dns.promises]) for (const name of Object.keys(target)) {
  if (!/^(lookup|resolve|reverse)/.test(name) || typeof target[name] !== 'function') continue;
  const original = target[name];
  target[name] = function(host, ...args) {
    if (!local(host)) deny('dns.' + name);
    if(name!=='lookup')return deny('dns.'+name);
    // Never ask a configured DNS server to resolve localhost. Preserve the
    // requested IPv6 family, otherwise choose the IPv4 loopback explicitly.
    const numeric=String(host).toLowerCase()==='localhost'?(args[0]?.family===6?'::1':'127.0.0.1'):host;
    if(target===dns)return protectLookup(original,'dns.lookup-result').call(this,numeric,...args);
    return original.call(this,numeric,...args);
  };
}
for (const [module, name] of [['node:http2','connect'], ['node:dgram','createSocket']]) require(module)[name] = () => deny(module);
require('node:module').syncBuiltinESMExports();
process.once('exit', () => {
  const fs = require('node:fs');
  const output = resolve(allowedRoot,'stabilization/network-counts');
  assertTrustedWithin(allowedRoot,output);
  fs.mkdirSync(output,{recursive:true});
  const report=resolve(output,process.pid+'.json');assertTrustedWithin(allowedRoot,report);
  fs.writeFileSync(report,JSON.stringify({pid:process.pid,blocked:state.blocked,loopbackFetches:state.loopback,policy:'External destinations rejected before patched transports; no OS-wide packet measurement',scope:'Node patched transports; Electron only when preload is honored'}));
});
// Electron test hosts that honor NODE_OPTIONS get the same destination rule.
if (process.versions.electron && process.type === 'browser') {
  const electron = require('electron');
  for (const name of ['fetch','request']) {
    const original = electron.net[name];
    electron.net[name] = function(input, ...args) {
      checkUrl(typeof input === 'object' && !input.url ? `${input.protocol ?? 'https:'}//${input.hostname ?? input.host ?? ''}${input.path ?? '/'}` : input, 'electron.net.' + name);
      return original.call(this, input, ...args);
    };
  }
  electron.app.on('session-created', session => session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
    if (/^(file|data|devtools|red|red-asset):/.test(details.url)) return done({});
    try { checkUrl(details.url, 'electron.session'); done({}); } catch { done({ cancel: true }); }
  }));
}
