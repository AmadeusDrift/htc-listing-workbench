import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseProfileImport } from '../src/main/hosting/validation.ts';
import { createPublicImageProbe } from '../src/main/hosting/public-probe.ts';

const profile = { id:'alpha', host:'ftp.example.test', port:2121, secure:false, username:'Alpha', password:'fixture-password-secret', remoteRoot:'/', publicBaseUrl:'https://htc.185858.xyz/AAA/' };
const bytes=Buffer.from('fixture image bytes'), expected={url:'https://htc.185858.xyz/AAA/20261009/probe.png',sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length,mimeType:'image/png'};
const signal=()=>new AbortController().signal;
const fakeDns=async()=>[{address:'198.18.0.55',family:4}];
function response(body:Uint8Array=bytes,headers:Record<string,string>={},status=200){return new Response(Uint8Array.from(body),{status,headers:{'content-type':'image/png','content-length':String(body.byteLength),...headers}});}

test('legacy usernames may equal the fixed profile label while secrets cannot enter editable public fields',()=>{
  assert.equal(parseProfileImport(profile).username,'Alpha');
  for(const change of [{host:'Alpha.example.test'},{remoteRoot:'/Alpha/'},{publicBaseUrl:'https://example.com/Alpha/'},{password:'Alpha'}]) assert.throws(()=>parseProfileImport({...profile,...change}));
});

test('trusted company image prefixes support Fake-IP with exact content verification and no credentials or redirects',async()=>{
  let called=0;
  const probe=createPublicImageProbe({lookup:fakeDns,nativeFetch:async(url,init)=>{called++;assert.equal(url,expected.url);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');return response();}});
  await probe(expected,signal());assert.equal(called,1);
});

test('the hosting proxy exception cannot authorize other hosts, prefixes or private/mixed DNS answers',async()=>{
  let calls=0;
  for(const [url,addresses] of [
    ['https://other.example.com/AAA/a.png',await fakeDns()],
    ['https://htc.185858.xyz.evil.test/AAA/a.png',await fakeDns()],
    ['https://htc.185858.xyz/other/a.png',await fakeDns()],
    [expected.url,[{address:'127.0.0.1',family:4}]],
    [expected.url,[{address:'198.18.0.55',family:4},{address:'10.0.0.1',family:4}]],
    [expected.url,[{address:'198.18.0.55',family:4},{address:'8.8.8.8',family:4}]],
  ] as const){const probe=createPublicImageProbe({lookup:async()=>[...addresses],nativeFetch:async()=>{calls++;return response();}});await assert.rejects(probe({...expected,url},signal()),{code:'PUBLIC_URL_UNSAFE'});}
  assert.equal(calls,0);
});

test('proxy image verification rejects redirects, MIME/size/hash differences and stops stalled response bodies',async()=>{
  for(const make of [()=>response(bytes,{},302),()=>response(bytes,{'content-type':'text/html'}),()=>response(bytes,{'content-length':'999'}),()=>response(Buffer.alloc(bytes.length)),()=>response(Buffer.alloc(bytes.length+1)),()=>response(bytes,{'content-encoding':'gzip'})]){
    await assert.rejects(createPublicImageProbe({lookup:fakeDns,nativeFetch:async()=>make()})(expected,signal()));
  }
  let cancelled=false;
  const slow=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'image/png'}});
  await assert.rejects(createPublicImageProbe({lookup:fakeDns,nativeFetch:async()=>slow,timeoutMs:15})(expected,signal()),{code:'PUBLIC_URL_TIMEOUT'});
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(cancelled,true);
});
