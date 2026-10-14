// Test-only wire authentication. Pure bytes/URI verification; never opens sockets.
const assert=require('node:assert/strict'),{createHash,createHmac,timingSafeEqual}=require('node:crypto');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(actual,expected)=>typeof actual==='string'&&Buffer.byteLength(actual)===Buffer.byteLength(expected)&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected));
const secret=value=>assert.ok(typeof value==='string'&&/^s10-[a-z0-9-]{4,100}$/.test(value),'S10_SYNTHETIC_PROTOCOL_CREDENTIAL');
const paths=['/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list','/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail'];
function validateProtocolRoute(route){
  const p=route.protocol;assert.ok(p&&typeof p==='object'&&!route.credential,'S10_PROTOCOL_POLICY');
  const url=new URL(route.publicUrl);assert.ok(url.href===route.publicUrl&&url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&!url.port,'S10_PROTOCOL_URI');
  assert.equal(route.method,p.kind==='oss4'?'PUT':'POST','S10_PROTOCOL_METHOD');
  if(p.kind==='miaoshou'){
    assert.ok(url.origin==='https://openapi-erp.91miaoshou.com'&&paths.includes(url.pathname)&&!url.search,'S10_PROTOCOL_URI');secret(p.appKey);secret(p.appSecret);assert.match(p.timestamp,/^[0-9]{10}$/);
  }else if(p.kind==='acs3'){
    if(p.action==='RecognizeAllText'){assert.equal(route.publicUrl,'https://ocr-api.cn-hangzhou.aliyuncs.com/?Type=Commerce','S10_PROTOCOL_URI');assert.equal(p.version,'2021-07-07');assert.equal(p.contentType,'application/octet-stream');}
    else{assert.ok(['DescribeUploadToken','ImageModeration'].includes(p.action));assert.equal(route.publicUrl,'https://green-cip.cn-shanghai.aliyuncs.com/');assert.equal(p.version,'2022-03-02');assert.equal(p.contentType,'application/x-www-form-urlencoded');assert.match(p.bodySha256,/^[a-f0-9]{64}$/);}
    secret(p.accessKeyId);secret(p.accessKeySecret);secret(p.nonce);assert.ok(new Date(p.now).toISOString()===p.now,'S10_PROTOCOL_CLOCK');
  }else if(p.kind==='oss4'){
    assert.match(p.bucket,/^s10-[a-z0-9-]+$/);assert.equal(p.region,'cn-shanghai');assert.match(p.candidateId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.equal(p.objectName,'s10/'+p.candidateId+'.png');
    assert.equal(route.publicUrl,`https://${p.bucket}.oss-${p.region}.aliyuncs.com/${p.objectName}`);assert.equal(p.contentType,'image/png');assert.match(p.bodySha256,/^[a-f0-9]{64}$/);secret(p.accessKeyId);secret(p.accessKeySecret);secret(p.securityToken);assert.equal(new Date(p.now).toISOString(),p.now);
  }else throw Error('S10_PROTOCOL_UNIMPLEMENTED');
}
function verifyProtocol(route,headers,bytes){
  validateProtocolRoute(route);const p=route.protocol,url=new URL(route.publicUrl),h=new Headers(headers);let permitted;
  if(p.bodySha256)assert.equal(sha(bytes),p.bodySha256,'S10_PROTOCOL_BODY');
  if(h.has('content-length'))assert.equal(h.get('content-length'),String(bytes.length),'S10_PROTOCOL_LENGTH');
  assert.ok(!h.has('transfer-encoding'),'S10_PROTOCOL_TRANSFER');
  if(h.has('host'))assert.equal(h.get('host'),url.host,'S10_PROTOCOL_HOST');
  if(p.kind==='miaoshou'){
    permitted=new Set(['x-app-key','x-timestamp','x-sign']);
    assert.equal(h.get('content-type'),'application/json','S10_PROTOCOL_CONTENT_TYPE');assert.equal(h.get('x-app-key'),p.appKey,'S10_PROTOCOL_KEY');assert.equal(h.get('x-timestamp'),p.timestamp,'S10_PROTOCOL_CLOCK');
    const signature=createHmac('sha256',p.appSecret).update(p.appSecret+url.pathname+p.timestamp+p.appKey).update(bytes).update(p.appSecret).digest('hex');assert.ok(same(h.get('x-sign'),signature),'S10_PROTOCOL_SIGNATURE');
  }else if(p.kind==='oss4'){
    const timestamp=p.now.replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'),day=timestamp.slice(0,8),scope=`${day}/${p.region}/oss/aliyun_v4_request`;
    const signed={'content-type':p.contentType,'content-md5':createHash('md5').update(bytes).digest('base64'),'x-oss-security-token':p.securityToken,'x-oss-content-sha256':'UNSIGNED-PAYLOAD','x-oss-date':timestamp};
    for(const [name,value]of Object.entries(signed))assert.equal(h.get(name),value,'S10_PROTOCOL_HEADER');
    const canonical=['PUT',`/${p.bucket}/${p.objectName}`,'',Object.keys(signed).sort().map(name=>`${name}:${signed[name]}\n`).join(''),'','UNSIGNED-PAYLOAD'].join('\n');
    const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
    const key=hmac(hmac(hmac(hmac('aliyun_v4'+p.accessKeySecret,day),p.region),'oss'),'aliyun_v4_request');
    const signature=hmac(key,`OSS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha(canonical)}`).toString('hex');
    assert.ok(same(h.get('authorization'),`OSS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope},Signature=${signature}`),'S10_PROTOCOL_SIGNATURE');permitted=new Set([...Object.keys(signed),'authorization']);
  }else{
    const signed={host:url.hostname,'x-acs-action':p.action,'x-acs-version':p.version,'x-acs-content-sha256':sha(bytes),'x-acs-date':new Date(p.now).toISOString().replace(/\.\d{3}Z$/,'Z'),'x-acs-signature-nonce':p.nonce,'content-type':p.contentType};
    for(const [name,value]of Object.entries(signed))assert.equal(h.get(name),value,'S10_PROTOCOL_HEADER');
    const names=Object.keys(signed).sort(),signedNames=names.join(';');
    const canonical=['POST','/',url.search.slice(1),names.map(name=>`${name}:${signed[name].trim()}\n`).join(''),signedNames,sha(bytes)].join('\n');
    const signature=createHmac('sha256',p.accessKeySecret).update('ACS3-HMAC-SHA256\n'+sha(canonical)).digest('hex');
    assert.ok(same(h.get('authorization'),`ACS3-HMAC-SHA256 Credential=${p.accessKeyId},SignedHeaders=${signedNames},Signature=${signature}`),'S10_PROTOCOL_SIGNATURE');
    permitted=new Set([...names,'authorization']);
  }
  for(const [name]of h)if(/authorization|api.?key|token|cookie|secret|password|signature|x-sign|x-app-key|^x-oss-|^x-acs-/i.test(name))assert.ok(permitted.has(name),'S10_PROTOCOL_EXTRA_CREDENTIAL');
  return true;
}
module.exports={validateProtocolRoute,verifyProtocol};
