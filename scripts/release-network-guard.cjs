// Test-host injection only. This file is never copied into a candidate package.
function installNetworkGuard(electron = require('electron')) {
  if (globalThis.__releaseGuard) throw Error('Release guard already installed');
  const state = { installedBeforeMain: true, attempts: [], sessions: 0, shownWindows: [] };
  Object.defineProperty(state, 'require', { value: require });
  Object.defineProperty(globalThis, '__releaseGuard', { value: state });
  const block = transport => function () {
    state.attempts.push(transport);
    throw Error(`RELEASE_NETWORK_BLOCKED: ${transport}`);
  };
  for (const name of ['node:http', 'node:https']) for (const method of ['get', 'request']) require(name)[method] = block(`${name}.${method}`);
  require('node:net').Socket.prototype.connect = block('node:net.connect');
  require('node:tls').connect = block('node:tls.connect');
  require('node:http2').connect = block('node:http2.connect');
  require('node:dgram').createSocket = block('node:dgram.createSocket');
  const dns = require('node:dns');
  for (const target of [dns, dns.promises]) for (const name of Object.keys(target)) if (/^(lookup|resolve|reverse)/.test(name) && typeof target[name] === 'function') target[name] = block(`node:dns.${name}`);
  globalThis.fetch = block('global.fetch'); globalThis.WebSocket = block('global.WebSocket');
  for (const method of ['fetch', 'request', 'resolveHost']) electron.net[method] = block(`electron.net.${method}`);
  electron.shell.openExternal = block('electron.shell.openExternal');
  require('node:module').syncBuiltinESMExports();
  const installed = new WeakSet();
  const protect = session => {
    if (installed.has(session)) return; installed.add(session); state.sessions++;
    session.fetch = block('electron.session.fetch');
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (/^(red|red-asset|file|data|devtools):/.test(details.url)) return callback({});
      state.attempts.push('electron.session.webRequest'); callback({ cancel: true });
    });
  };
  electron.app.on('session-created', protect);
  electron.app.on('browser-window-created', (_event, window) => {
    protect(window.webContents.session); window.webContents.backgroundThrottling = false;
    if (window.isVisible()) state.shownWindows.push(window.id);
    window.on('show', () => state.shownWindows.push(window.id));
  });
  void electron.app.whenReady().then(() => protect(electron.session.defaultSession));
  return state;
}
module.exports = { installNetworkGuard };
