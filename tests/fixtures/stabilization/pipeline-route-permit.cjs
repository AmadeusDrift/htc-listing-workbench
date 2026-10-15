// Controller-signed, one-use test route. No production credential or domain write.
const assert=require('node:assert/strict'),{createHash,createHmac,timingSafeEqual}=require('node:crypto');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const headerHash=headers=>sha(JSON.stringify([...new Headers(headers)].sort(([a],[b])=>a.localeCompare(b))));
const signature=(value,key)=>createHmac('sha256',key).update(JSON.stringify(value)).digest('hex');
function issue(authority,sequence,route,headers,bytes){const value={version:1,runId:authority.runId,sequence,route,headersSha256:headerHash(headers),bodySha256:sha(bytes)};return {...value,signature:signature(value,authority.key)};}
function verify(authority,envelope){const {signature:actual,...value}=JSON.parse(JSON.stringify(envelope));assert.deepEqual(Object.keys(value).sort(),['bodySha256','headersSha256','route','runId','sequence','version']);assert.equal(value.version,1);assert.equal(value.runId,authority.runId);assert.ok(Number.isSafeInteger(value.sequence)&&value.sequence>0);assert.match(value.bodySha256,/^[a-f0-9]{64}$/);assert.match(value.headersSha256,/^[a-f0-9]{64}$/);const expected=signature(value,authority.key);assert.ok(typeof actual==='string'&&actual.length===expected.length&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected)),'S10_PERMIT_SIGNATURE');return value;}
module.exports={issue,verify,sha,headerHash};
