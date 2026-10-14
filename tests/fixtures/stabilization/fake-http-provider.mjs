// Test-only external protocol boundary. No business services or result adoption.
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
const { worktreeRoot, assertTrustedWithin } = createRequire(import.meta.url)('./trusted-path.cjs');
const {validateProtocolRoute,verifyProtocol}=createRequire(import.meta.url)('./pipeline-protocol.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safePath = path => typeof path === 'string' && /^\/[a-zA-Z0-9/_.-]+$/.test(path) && !path.includes('..') && !path.includes('//');

function ledgerStore(directory) {
  const path=join(directory,'server-ledger.jsonl');assertTrustedWithin(worktreeRoot,path);
  const rows=existsSync(path)?readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  let previous='0'.repeat(64);
  for(const [index,row] of rows.entries()){const {sha256,...data}=row;assert.equal(data.sequence,index+1);assert.equal(data.previous,previous);assert.equal(sha256,digest(JSON.stringify(data)));previous=sha256;}
  return {path,rows,append(data){const record={sequence:rows.length+1,at:new Date().toISOString(),previous,...data};const row={...record,sha256:digest(JSON.stringify(record))};
    const fd=openSync(path,'a');try{appendFileSync(fd,JSON.stringify(row)+'\n');fsyncSync(fd);}finally{closeSync(fd);}rows.push(row);previous=row.sha256;return row;
  }};
}
function verifyRoutes(routes) {
  assert.ok(Array.isArray(routes)&&routes.length,'S10_ROUTES_REQUIRED');const keys=new Set(),ids=new Set();
  return routes.map(route=>{assert.ok(/^[a-z0-9-]+$/.test(route.id)&&!ids.has(route.id),'S10_ROUTE_ID_INVALID');ids.add(route.id);
    assert.ok(['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(route.method)&&safePath(route.path),'S10_ROUTE_INVALID');const key=route.method+' '+route.path;assert.ok(!keys.has(key),'S10_ROUTE_DUPLICATE');keys.add(key);
    if(route.credential){assert.ok(/^[a-z-]+$/.test(route.credential.header)&&/^Bearer s10-[a-z0-9-]+$/.test(route.credential.value),'S10_FIXTURE_CREDENTIAL_REQUIRED');}
    if(route.publicUrl){const url=new URL(route.publicUrl);assert.ok(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(!url.search||route.protocol),'S10_PUBLIC_ROUTE_INVALID');}
    if(route.protocol)validateProtocolRoute(route);
    return structuredClone(route);
  });
}
async function listen(server){await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});return server.address().port;}

export async function createFakeProvider({directory,routes,ftp=false,maxRequestBytes=8*1024*1024}) {
  directory=resolve(directory);assertTrustedWithin(join(worktreeRoot,'.test-data'),directory);assert.ok(Number.isSafeInteger(maxRequestBytes)&&maxRequestBytes>0);
  await mkdir(directory,{recursive:true});assertTrustedWithin(worktreeRoot,directory);const ledger=ledgerStore(directory),known=verifyRoutes(routes),sockets=new Set(),held=new Map();let closed=false;
  const connections=server=>server.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));});
  const server=httpServer(async(request,response)=>{
    const route=known.find(row=>row.method===request.method&&row.path===request.url);
    if(known.some(row=>row.protocol))ledger.append({event:'arrival',method:request.method??'GET',routeId:route?.id??null});
    const reject=(status,reason)=>{ledger.append({event:'rejected',method:request.method??'GET',reason});request.resume();response.writeHead(status);response.end();};
    if(!route)return reject(404,'route');if(route.credential&&request.headers[route.credential.header]!==route.credential.value)return reject(403,'credential');
    const parts=[];let size=0;
    try{for await(const chunk of request){size+=chunk.length;if(size>maxRequestBytes){reject(413,'size');return;}parts.push(Buffer.from(chunk));}
      const input=Buffer.concat(parts);if(route.protocol){try{verifyProtocol(route,request.headers,input);}catch{return reject(403,'protocol');}}
      const row=ledger.append({event:'request',routeId:route.id,method:route.method,path:route.path,bodySha256:digest(input),bodyBytes:size,...(route.protocol?{protocolVerified:true}:{})});
      const output=route.response??{};let json=output.json??{};
      if(output.issueTokenFor){const target=known.find(row=>row.id===output.issueTokenFor);assert.equal(target?.protocol?.kind,'oss4');assert.equal(route.protocol?.action,'DescribeUploadToken');const p=target.protocol;
        json={Code:200,Data:{AccessKeyId:p.accessKeyId,AccessKeySecret:p.accessKeySecret,SecurityToken:p.securityToken,BucketName:p.bucket,FileNamePrefix:'s10/',OssInternetEndPoint:'https://oss-'+p.region+'.aliyuncs.com',Expiration:Date.parse(p.now)/1000+1800}};
      }
      const bytes=output.bytes?Buffer.from(output.bytes):Buffer.from(JSON.stringify(json));
      response.writeHead(output.status??200,{'content-type':output.contentType??'application/json','x-s10-request-id':String(row.sequence),'content-length':String(bytes.length)});response.flushHeaders();ledger.append({event:'headers',routeId:route.id,requestSequence:row.sequence,status:output.status??200});
      const finish=()=>{if(!response.destroyed){response.end(bytes);ledger.append({event:'body',routeId:route.id,requestSequence:row.sequence,bodySha256:digest(bytes),bodyBytes:bytes.length});}};
      if(output.holdBody){const pending=held.get(route.id)??[];pending.push(finish);held.set(route.id,pending);}else finish();
    }catch(error){if(!response.destroyed){response.writeHead(500);response.end();}ledger.append({event:'transport-error',routeId:route.id,errorCode:error.code??'LOCAL_ERROR'});}
  });connections(server);const port=await listen(server),ftpSockets=new Set();let controlServer,dataServer,ftpPort,dataPort;
  const ftpRoot=join(directory,'ftp-files');
  const ftpPath=remote=>{assert.ok(safePath(remote)&&remote.startsWith('/s10/'),'S10_FTP_PATH_INVALID');const file=resolve(ftpRoot,remote.slice(1));assertTrustedWithin(ftpRoot,file);return file;};
  if(ftp){await mkdir(ftpRoot,{recursive:true});let activeData=null,transfer=null;
    dataServer=tcpServer(socket=>{if(activeData){socket.destroy();return;}activeData=socket;const parts=[];let size=0;ftpSockets.add(socket);socket.on('error',()=>{});
      socket.on('data',chunk=>{size+=chunk.length;if(size>maxRequestBytes)socket.destroy();else parts.push(Buffer.from(chunk));});
      socket.on('end',()=>{const current=transfer;transfer=null;activeData=null;if(!current){socket.destroy();return;}const bytes=Buffer.concat(parts);
        void (async()=>{const file=ftpPath(current.path);await mkdir(dirname(file),{recursive:true});assertTrustedWithin(ftpRoot,file);await writeFile(file,bytes);ledger.append({event:'ftp-upload',method:'STOR',path:current.path,bodySha256:digest(bytes),bodyBytes:bytes.length});socket.end();current.control.write('226 Transfer complete\r\n');})().catch(()=>{socket.destroy();current.control.write('550 Upload failed\r\n');});
      });socket.on('close',()=>{ftpSockets.delete(socket);if(activeData===socket)activeData=null;});
    });dataPort=await listen(dataServer);
    controlServer=tcpServer(control=>{ftpSockets.add(control);control.on('error',()=>{});control.on('close',()=>ftpSockets.delete(control));control.write('220 S10 loopback\r\n');let pending='',user=false,authenticated=false;
      control.on('data',chunk=>{pending+=chunk.toString();if(pending.length>8192){control.destroy();return;}for(;;){const end=pending.indexOf('\r\n');if(end<0)break;const line=pending.slice(0,end);pending=pending.slice(end+2);const split=line.indexOf(' '),command=split<0?line:line.slice(0,split),value=split<0?'':line.slice(split+1);
        if(command==='USER'){user=value==='s10-user';control.write('331 Password required\r\n');}
        else if(command==='PASS'){authenticated=user&&value==='s10-password';control.write(authenticated?'230 Logged in\r\n':'530 Login incorrect\r\n');}
        else if(command==='QUIT')control.end('221 Goodbye\r\n');
        else if(!authenticated)control.write('530 Login required\r\n');
        else if(command==='FEAT')control.write('211-Features\r\n SIZE\r\n UTF8\r\n211 End\r\n');
        else if(['TYPE','STRU','OPTS'].includes(command))control.write('200 OK\r\n');
        else if(command==='PWD')control.write('257 "/s10"\r\n');
        else if(command==='EPSV')control.write(`229 Entering Extended Passive Mode (|||${dataPort}|)\r\n`);
        else if(command==='SIZE'){try{const file=ftpPath(value);control.write(existsSync(file)?`213 ${readFileSync(file).length}\r\n`:'550 Not found\r\n');}catch{control.write('550 Invalid path\r\n');}}
        else if(['CWD','MKD'].includes(command)){try{ftpPath(value+'/probe');control.write(command==='CWD'?'250 Changed\r\n':'257 Created\r\n');}catch{control.write('550 Invalid path\r\n');}}
        else if(command==='STOR'){try{ftpPath(value);assert.ok(activeData&&!transfer);transfer={path:value,control};control.write('150 Transfer ready\r\n');}catch{activeData?.destroy();activeData=null;control.write('550 Invalid transfer\r\n');}}
        else control.write('502 Unsupported\r\n');
      }});
    });ftpPort=await listen(controlServer);
  }
  return {origin:`http://127.0.0.1:${port}`,port,routes:known.map(({response,...route})=>structuredClone(route)),directory,ledgerPath:ledger.path,
    ftp:ftp?{host:'127.0.0.1',port:ftpPort,dataPort,user:'s10-user',password:'s10-password'}:null,
    ledger:()=>structuredClone(ledger.rows),release(id){const releases=held.get(id)??[];held.delete(id);releases.forEach(fn=>fn());},readFtp:path=>readFile(ftpPath(path)),
    async close(){if(closed)return;closed=true;held.clear();for(const socket of [...sockets,...ftpSockets])socket.destroy();await Promise.all([server,controlServer,dataServer].filter(Boolean).map(value=>new Promise(done=>value.close(done))));}
  };
}
