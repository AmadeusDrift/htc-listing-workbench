// Test-only exact destination policy, installed before worker/application imports.
const fs=require('node:fs'),path=require('node:path'),{AsyncLocalStorage}=require('node:async_hooks');
const httpScope=new AsyncLocalStorage(),electronScope=new AsyncLocalStorage();
const {worktreeRoot,trustedWithin}=require('./trusted-path.cjs');
const trusted=(base,target)=>{try{if(!trustedWithin(base,target))throw Error();}catch{throw Error('S10_PATH_UNTRUSTED');}};
const policyFile=process.env.S10_POLICY_FILE;trusted(path.join(worktreeRoot,'.test-data'),policyFile);
const policy=JSON.parse(fs.readFileSync(policyFile,'utf8'));
if(policy.version!==1||!Array.isArray(policy.routes)||!policy.routes.length)throw Error('S10_POLICY_INVALID');
trusted(path.dirname(policyFile),policy.dataRoot);trusted(path.dirname(policyFile),policy.reportPath);
const origin=new URL(policy.origin);if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||origin.pathname!=='/'||origin.search||origin.hash)throw Error('S10_POLICY_INVALID');
for(const route of policy.routes){if(!/^[a-z0-9-]+$/.test(route.id)||!/^\/[a-zA-Z0-9/_.-]+$/.test(route.path)||route.path.includes('..')||route.path.includes('//')||!['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(route.method))throw Error('S10_POLICY_INVALID');
  if(route.credential&&!/^Bearer s10-[a-z0-9-]+$/.test(route.credential.value))throw Error('S10_POLICY_INVALID');
}
for(const key of Object.keys(process.env))if(/^(OPENAI|OPENROUTER|DEEPSEEK|ALIYUN|AMAZON|AWS|FTP|MIAOSHOU|RED_|FIRMNESS_SOURCE|SOURCE_)/i.test(key)||/(?:PROXY|API_KEY|ACCESS_KEY|TOKEN|PASSWORD|SECRET)$/i.test(key))delete process.env[key];
process.env.RED_DATA_DIR=policy.dataRoot;process.env.RED_E2E='1';
const state={installedBeforeMain:true,blocked:[],allowed:0,dataRoot:policy.dataRoot};Object.defineProperty(state,'require',{value:require});Object.defineProperty(globalThis,'__s10Guard',{value:state});
const deny=transport=>{state.blocked.push(transport);throw Error('S10_NETWORK_BLOCKED: '+transport);};
function rawPathSafe(value){if(/\\|%2e|%2f|%5c|\/\.\.?(?:\/|$)/i.test(value))deny('path');}
function mapped(input,init={},transport='fetch'){
  const raw=typeof input==='string'||input instanceof URL?String(input):input?.url; if(typeof raw!=='string')return deny(transport);rawPathSafe(raw);
  const url=new URL(raw),method=String(init.method??input?.method??'GET').toUpperCase();
  if(url.username||url.password||url.hash||url.search)return deny(transport);
  const route=policy.routes.find(row=>row.method===method&&(row.publicUrl===raw||url.origin===origin.origin&&url.pathname===row.path));if(!route)return deny(transport);
  const headers=new Headers(init.headers??input?.headers);
  if(route.credential&&headers.get(route.credential.header)!==route.credential.value)return deny('credential');
  for(const [key,value] of headers)if(/authorization|api.?key|token|cookie/i.test(key)&&(!route.credential||key!==route.credential.header||value!==route.credential.value))return deny('credential');
  state.allowed++;return {url:origin.origin+route.path,method,headers,route};
}
const fetch=globalThis.fetch;globalThis.fetch=function(input,init={}){const request=mapped(input,init);return httpScope.run(true,()=>fetch(request.url,{...init,method:request.method,headers:request.headers,redirect:'error'}));};
globalThis.WebSocket=function(){deny('WebSocket');};
const ports=new Set([Number(origin.port),...(policy.ftp?[policy.ftp.port,policy.ftp.dataPort]:[])]);
if([...ports].some(port=>!Number.isSafeInteger(port)||port<1||port>65535))throw Error('S10_POLICY_INVALID');
const net=require('node:net'),connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let normalized=Array.isArray(args[0])?args[0]:args;const first=normalized[0],host=typeof first==='object'?first.host??'localhost':typeof first==='number'?normalized[1]:null,port=typeof first==='object'?first.port:first;
  if(host!=='127.0.0.1'||!ports.has(Number(port))||Number(port)===Number(origin.port)&&!httpScope.getStore()||typeof first==='object'&&(first.path||first.lookup))return deny('net.connect');return connect.apply(this,args);};
const dns=require('node:dns');for(const target of [dns,dns.promises])for(const name of Object.keys(target))if(/^(lookup|resolve|reverse)/.test(name)&&typeof target[name]==='function')target[name]=()=>deny('dns.'+name);
require('node:tls').connect=()=>deny('tls.connect');require('node:http2').connect=()=>deny('http2.connect');require('node:dgram').createSocket=()=>deny('dgram');
for(const name of ['node:http','node:https'])for(const method of ['request','get']){
  const module=require(name),original=module[method];module[method]=function(input,options,callback){
    const opts=typeof options==='object'?options:typeof input==='object'&&!(input instanceof URL)?input:{};
    const url=typeof input==='string'||input instanceof URL?String(input):`${opts.protocol??(name==='node:https'?'https:':'http:')}//${opts.hostname??opts.host??''}${opts.port?':'+opts.port:''}${opts.path??'/'}`;
    const request=mapped(url,opts,name+'.'+method);if(new URL(url).origin!==origin.origin||request.url!==url)return deny(name+'.direct-route');
    return httpScope.run(true,()=>original.call(module,input,options,callback));
  };
}
require('node:module').syncBuiltinESMExports();
function installElectron(electron){
  for(const method of ['fetch']){const original=electron.net[method].bind(electron.net);electron.net[method]=(input,init={})=>{const request=mapped(input,init,'electron.net.fetch');return electronScope.run(request,()=>original(request.url,{...init,method:request.method,headers:request.headers,redirect:'error'}));};}
  const nativeRequest=electron.net.request.bind(electron.net);electron.net.request=input=>{const expected=electronScope.getStore(),url=typeof input==='string'?input:input?.url;
    if(!expected||url!==expected.url||String(input?.method??'GET').toUpperCase()!==expected.method)return deny('electron.net.request');return nativeRequest(input);
  };
  electron.net.resolveHost=()=>deny('electron.net.resolveHost');
  electron.shell.openExternal=()=>deny('shell.openExternal');const installed=new WeakSet();
  const protect=session=>{if(installed.has(session))return;installed.add(session);const original=session.fetch.bind(session);session.fetch=(input,init={})=>{const request=mapped(input,init,'session.fetch');return electronScope.run(request,()=>original(request.url,{...init,method:request.method,headers:request.headers,redirect:'error'}));};
    session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,done)=>{if(/^(file|data|red|red-asset|devtools):/.test(details.url))return done({});
      try{rawPathSafe(details.url);const url=new URL(details.url);if(url.origin!==origin.origin||url.search||url.hash||!policy.routes.some(row=>row.method===details.method&&row.path===url.pathname))throw Error();done({});}catch{state.blocked.push('Chromium');done({cancel:true});}});
    session.webRequest.onBeforeSendHeaders({urls:[origin.origin+'/*']},(details,done)=>{try{mapped(details.url,{method:details.method,headers:details.requestHeaders},'Chromium.headers');done({requestHeaders:details.requestHeaders});}catch{done({cancel:true});}});
  };
  electron.app.on('session-created',protect);electron.app.on('browser-window-created',(_event,window)=>protect(window.webContents.session));void electron.app.whenReady().then(()=>protect(electron.session.defaultSession));
}
if(process.versions.electron&&process.type==='browser')installElectron(require('electron'));
process.once('exit',()=>{const report=policy.reportPath+'-'+process.pid+'.json';trusted(path.dirname(policyFile),report);fs.writeFileSync(report,JSON.stringify(state,null,2),{flag:'wx'});});
module.exports={mapped,installElectron};
