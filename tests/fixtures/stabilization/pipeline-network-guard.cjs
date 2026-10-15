// Test-only exact destination policy, installed before worker/application imports.
const fs=require('node:fs'),path=require('node:path'),{AsyncLocalStorage}=require('node:async_hooks');
const protocolRequest=require('node:http').request,{Readable}=require('node:stream');
const httpScope=new AsyncLocalStorage(),electronScope=new AsyncLocalStorage();
const permitScope=new AsyncLocalStorage(),usedPermits=new Set(),permitApi=require('./pipeline-route-permit.cjs');
const {worktreeRoot,trustedWithin}=require('./trusted-path.cjs');
const {validateProtocolRoute,verifyProtocol}=require('./pipeline-protocol.cjs');
const trusted=(base,target)=>{try{if(!trustedWithin(base,target))throw Error();}catch{throw Error('S10_PATH_UNTRUSTED');}};
const policyFile=process.env.S10_POLICY_FILE;trusted(path.join(worktreeRoot,'.test-data'),policyFile);
const policy=JSON.parse(fs.readFileSync(policyFile,'utf8'));
if(policy.version!==1||!Array.isArray(policy.routes)||!policy.routes.length)throw Error('S10_POLICY_INVALID');
trusted(path.dirname(policyFile),policy.dataRoot);trusted(path.dirname(policyFile),policy.reportPath);
const origin=new URL(policy.origin);if(policy.origin!==origin.origin||origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||origin.pathname!=='/'||origin.search||origin.hash)throw Error('S10_POLICY_INVALID');
for(const route of policy.routes){if(!/^[a-z0-9-]+$/.test(route.id)||!/^\/[a-zA-Z0-9/_.-]+$/.test(route.path)||route.path.includes('..')||route.path.includes('//')||!['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(route.method))throw Error('S10_POLICY_INVALID');
  if(route.credential&&!/^Bearer s10-[a-z0-9-]+$/.test(route.credential.value))throw Error('S10_POLICY_INVALID');
  if(route.native!==undefined&&route.native!==true)throw Error('S10_POLICY_INVALID');
  if(route.protocol)validateProtocolRoute(route);
}
function freezePolicy(value){if(value&&typeof value==='object'){for(const part of Object.values(value))freezePolicy(part);Object.freeze(value);}}freezePolicy(policy);
for(const key of Object.keys(process.env))if(/^(OPENAI|OPENROUTER|DEEPSEEK|ALIYUN|AMAZON|AWS|FTP|MIAOSHOU|RED_|FIRMNESS_SOURCE|SOURCE_)/i.test(key)||/(?:PROXY|API_KEY|ACCESS_KEY|TOKEN|PASSWORD|SECRET)$/i.test(key))delete process.env[key];
process.env.RED_DATA_DIR=policy.dataRoot;process.env.RED_E2E='1';
const state={installedBeforeMain:true,blocked:[],allowed:0,nodeProtocolSent:0,nativeProtocolSent:0,dataRoot:policy.dataRoot};Object.defineProperty(state,'require',{value:require});Object.defineProperty(globalThis,'__s10Guard',{value:state});
if(policy.permitAuthority){if(!/^s10-[a-f0-9-]{36}$/.test(policy.permitAuthority.runId)||!/^s10-[a-f0-9]{64}$/.test(policy.permitAuthority.key))throw Error('S10_POLICY_PERMIT_INVALID');Object.defineProperty(state,'withRoutePermit',{value:(envelope,work)=>{const permit=permitApi.verify(policy.permitAuthority,envelope);if(usedPermits.has(permit.sequence))throw Error('S10_PERMIT_REPLAY');validateProtocolRoute(permit.route);freezePolicy(permit);usedPermits.add(permit.sequence);return permitScope.run(permit,work);}});}
const deny=transport=>{state.blocked.push(transport);throw Error('S10_NETWORK_BLOCKED: '+transport);};
function rawPathSafe(value){if(/\\|%2e|%2f|%5c|\/\.\.?(?:\/|$)/i.test(value))deny('path');}
function mapped(input,init={},transport='fetch'){
  const raw=typeof input==='string'||input instanceof URL?String(input):input?.url; if(typeof raw!=='string')return deny(transport);rawPathSafe(raw);
  const url=new URL(raw),method=String(init.method??input?.method??'GET').toUpperCase();
  if(url.username||url.password||url.hash)return deny(transport);
  const headers=new Headers(init.headers??input?.headers);
  if([...headers.keys()].some(name=>name.startsWith('x-s10-native-')))return deny('native-capability:'+transport);
  const permit=permitScope.getStore(),dynamic=permit?.route,route=(dynamic&&dynamic.method===method&&dynamic.publicUrl===raw?dynamic:null)??policy.routes.find(row=>row.method===method&&(row.publicUrl===raw||raw===origin.origin+row.path)&&(!row.protocol||row.protocol.kind!=='acs3'||headers.get('x-acs-action')===row.protocol.action));if(!route)return deny(transport);
  if(route===dynamic&&(permitApi.headerHash(headers)!==permit.headersSha256||permitApi.sha(wireBody(init.body))!==permit.bodySha256))return deny('permit-input');
  if(url.search&&!route.protocol)return deny(transport);
  if(route.protocol){
    const nativeSupported=route.protocol.kind==='miaoshou'||route.protocol.kind==='acs3'&&route.protocol.action==='RecognizeAllText'||route.native===true&&['public-source','public-bytes','public-image','lwa','amazon','acs3','oss4'].includes(route.protocol.kind);
    if(!['fetch','electron.net.fetch'].includes(transport)||transport==='electron.net.fetch'&&!nativeSupported||raw!==route.publicUrl||init.redirect!==undefined&&!['error','manual'].includes(init.redirect))return deny('protocol-transport');
    if(['connection','transfer-encoding','content-length','expect','upgrade','trailer'].some(name=>headers.has(name))||headers.has('host')&&headers.get('host')!==url.host)return deny('protocol-headers');
    try{verifyProtocol(route,headers,wireBody(init.body));}catch{return deny('protocol-auth');}
    state.allowed++;return {url:origin.origin+route.path,method,headers,route};
  }
  if(route.credential&&headers.get(route.credential.header)!==route.credential.value)return deny('credential');
  for(const [key,value] of headers)if(/authorization|api.?key|token|cookie/i.test(key)&&(!route.credential||key!==route.credential.header||value!==route.credential.value))return deny('credential');
  state.allowed++;return {url:origin.origin+route.path,method,headers,route};
}
function wireBody(body){if(body===undefined)return Buffer.alloc(0);if(typeof body==='string')return Buffer.from(body);if(ArrayBuffer.isView(body))return Buffer.from(new Uint8Array(body.buffer,body.byteOffset,body.byteLength));if(body instanceof ArrayBuffer)return Buffer.from(new Uint8Array(body));throw Error('S10_BODY_NOT_FROZEN');}
function snapshotInit(init){const frozen={...init};if(frozen.body!==undefined&&typeof frozen.body!=='string')frozen.body=new Uint8Array(wireBody(frozen.body));return frozen;}
function sendProtocol(request,init){
  const bytes=wireBody(init.body),headers=Object.freeze({...Object.fromEntries(request.headers),host:new URL(request.route.publicUrl).host,'content-length':String(bytes.length)});
  state.nodeProtocolSent++;
  return httpScope.run(true,()=>new Promise((done,reject)=>{
    const req=protocolRequest({hostname:'127.0.0.1',port:Number(origin.port),path:request.route.path,method:request.method,headers,agent:false},response=>{
      if(response.statusCode>=300&&response.statusCode<400&&init.redirect!=='manual'){response.destroy();reject(Error('S10_PROTOCOL_REDIRECT'));return;}
      const output=new Response(Readable.toWeb(response),{status:response.statusCode,headers:response.headers});Object.defineProperty(output,'url',{value:request.route.publicUrl});done(output);
    });
    const abort=()=>req.destroy(init.signal?.reason instanceof Error?init.signal.reason:Error('S10_PROTOCOL_ABORTED'));
    req.once('error',reject);req.once('close',()=>init.signal?.removeEventListener('abort',abort));
    if(init.signal?.aborted){abort();return;}init.signal?.addEventListener('abort',abort,{once:true});req.end(bytes);
  }));
}
const fetch=globalThis.fetch;globalThis.fetch=function(input,init={}){const frozen=snapshotInit(init),request=mapped(input,frozen);if(request.route.protocol)return sendProtocol(request,frozen);return httpScope.run(true,()=>fetch(request.url,{...frozen,method:request.method,headers:Object.freeze(Object.fromEntries(request.headers)),redirect:'error'}));};
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
    const urlInput=typeof input==='string'||input instanceof URL;
    const opts={...(urlInput?{}:input),...(options&&typeof options==='object'?options:{})};
    const scheme=name==='node:https'?'https:':'http:',raw=urlInput?String(input):`${opts.protocol??scheme}//${opts.hostname??opts.host??''}${opts.port?':'+opts.port:''}${opts.path??'/'}`;
    let url;try{url=new URL(raw);}catch{return deny(name+'.target');}
    const expected={protocol:url.protocol,hostname:url.hostname,host:url.hostname,port:url.port,path:url.pathname};
    for(const [key,value] of Object.entries(expected))if(Object.hasOwn(opts,key)&&(key==='port'?String(opts[key]):opts[key])!==value)return deny(name+'.target-override');
    if(url.protocol!==scheme||opts.auth!==undefined||opts.socketPath!==undefined||opts.createConnection!==undefined||opts.agent!==undefined&&opts.agent!==false)return deny(name+'.target-override');
    let headerInput=opts.headers;
    if(Array.isArray(headerInput)&&headerInput.every(value=>typeof value==='string')){
      if(headerInput.length%2)return deny(name+'.headers');headerInput=Array.from({length:headerInput.length/2},(_,index)=>[headerInput[index*2],headerInput[index*2+1]]);
    }
    const headers=new Headers(headerInput);
    if(headers.has('host')&&headers.get('host')!==url.host)return deny(name+'.host-header');
    const request=mapped(raw,{method:String(opts.method??'GET').toUpperCase(),headers},name+'.'+method);if(url.origin!==origin.origin||request.url!==raw)return deny(name+'.direct-route');
    headers.set('host',url.host);
    const frozen=Object.freeze({...opts,protocol:url.protocol,hostname:url.hostname,host:url.hostname,port:Number(url.port),path:url.pathname,method:request.method,headers:Object.freeze(Object.fromEntries(headers)),agent:false});
    const result=httpScope.run(true,()=>original.call(module,frozen,typeof options==='function'?options:callback));
    const mutation=()=>{result.destroy();return deny(name+'.request-mutation');};
    for(const key of ['path','method','host','protocol']){const value=result[key];Object.defineProperty(result,key,{get:()=>value,set:mutation,configurable:false});}
    for(const key of ['setHeader','removeHeader','appendHeader','addTrailers'])Object.defineProperty(result,key,{value:mutation,writable:false,configurable:false});
    return result;
  };
}
require('node:module').syncBuiltinESMExports();
function installElectron(electron){
  const nativePending=new Map();
  for(const method of ['fetch']){const original=electron.net[method].bind(electron.net);electron.net[method]=(input,init={})=>{
    const frozen=snapshotInit(init),request=mapped(input,frozen,'electron.net.fetch');
    if(!request.route.protocol&&!request.route.native)return electronScope.run(request,()=>original(request.url,{...frozen,method:request.method,headers:request.headers,redirect:'error'}));
    const capability=require('node:crypto').randomUUID();nativePending.set(capability,{request,bytes:wireBody(frozen.body),sent:false});
    const nativeHeaders={...Object.fromEntries(request.headers),'x-s10-native-capability':capability};delete nativeHeaders.host;
    return electronScope.run(request,()=>original(request.url,{...frozen,method:request.method,headers:nativeHeaders,redirect:frozen.redirect??'error'})).then(response=>{Object.defineProperty(response,'url',{value:request.route.publicUrl});return response;}).catch(error=>{state.nativeProtocolFailure={name:error.name??null,code:error.code??null,causeCode:error.cause?.code??null,headerRejected:/host|unsafe.?header|forbidden.?header/i.test(String(error.message))};throw error;}).finally(()=>nativePending.delete(capability));
  };}
  const nativeRequest=electron.net.request.bind(electron.net);electron.net.request=input=>{const expected=electronScope.getStore(),url=typeof input==='string'?input:input?.url;
    if(!expected||url!==expected.url||String(input?.method??'GET').toUpperCase()!==expected.method)return deny('electron.net.request');return nativeRequest(input);
  };
  electron.net.resolveHost=()=>deny('electron.net.resolveHost');
  electron.shell.openExternal=()=>deny('shell.openExternal');const installed=new WeakSet();
  const protect=session=>{if(installed.has(session))return;installed.add(session);const original=session.fetch.bind(session);session.fetch=(input,init={})=>{
    const expected=electronScope.getStore(),headers=new Headers(init.headers??input?.headers),capability=headers.get('x-s10-native-capability'),pending=capability&&nativePending.get(capability),raw=typeof input==='string'?input:input?.url;
    if((expected?.route.protocol||expected?.route.native)&&pending&&pending.request===expected&&!pending.delegated&&raw===expected.url&&String(init.method??input?.method??'GET').toUpperCase()===expected.method){pending.delegated=true;return original(input,init);}
    const request=mapped(input,init,'session.fetch');return electronScope.run(request,()=>original(request.url,{...init,method:request.method,headers:request.headers,redirect:'error'}));
  };
    session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,done)=>{if(/^(file|data|red|red-asset|devtools):/.test(details.url))return done({});
      try{rawPathSafe(details.url);const url=new URL(details.url);if(url.origin!==origin.origin||url.search||url.hash||!policy.routes.some(row=>row.method===details.method&&row.path===url.pathname)&&![...nativePending.values()].some(p=>p.request.url===details.url&&p.request.method===details.method))throw Error();done({});}catch{state.blocked.push('Chromium');done({cancel:true});}});
    session.webRequest.onBeforeSendHeaders({urls:[origin.origin+'/*']},(details,done)=>{try{
      const headers=new Headers(details.requestHeaders),capability=headers.get('x-s10-native-capability');
      if(capability){const pending=nativePending.get(capability);if(!pending||pending.sent||pending.request.url!==details.url||pending.request.method!==details.method)throw Error('S10_NATIVE_IDENTITY');
        headers.delete('x-s10-native-capability');headers.set('host',new URL(pending.request.route.publicUrl).host);if(pending.request.route.protocol)verifyProtocol(pending.request.route,headers,pending.bytes);else mapped(pending.request.route.publicUrl,{method:pending.request.method,headers},'electron.net.fetch');pending.sent=true;state.nativeProtocolSent++;done({requestHeaders:Object.fromEntries(headers)});return;
      }
      mapped(details.url,{method:details.method,headers:details.requestHeaders},'Chromium.headers');done({requestHeaders:details.requestHeaders});
    }catch{state.blocked.push('Chromium.protocol-headers');done({cancel:true});}});
  };
  electron.app.on('session-created',protect);electron.app.on('browser-window-created',(_event,window)=>protect(window.webContents.session));void electron.app.whenReady().then(()=>protect(electron.session.defaultSession));
}
if(process.versions.electron&&process.type==='browser')installElectron(require('electron'));
process.once('exit',()=>{const report=policy.reportPath+'-'+process.pid+'.json';trusted(path.dirname(policyFile),report);fs.writeFileSync(report,JSON.stringify(state,null,2),{flag:'wx'});});
module.exports={mapped,installElectron};
