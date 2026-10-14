import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { AmazonPersistence } from '../src/main/amazon/persistence.ts';
import { AmazonService } from '../src/main/amazon/service.ts';
import { SALES_IDENTITY_INDEXES } from '../src/main/record-indexes.ts';
import type { SalesListingPlan } from '../src/shared/sales-plan-contracts.ts';

test('330 sales against 3000 on-disk historical drafts use indexed candidate reads',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'htc-sales-performance-')),db=new DatabaseSync(join(directory,'synthetic.sqlite'));
 try{
 db.exec('CREATE TABLE listing_drafts(id TEXT PRIMARY KEY,product_id TEXT,record_json TEXT,created_at TEXT);CREATE INDEX amazon_drafts_product ON listing_drafts(product_id,created_at)');
 const target={id:'store',sellerId:'seller',marketplaceId:'US',mode:'live'},now=new Date().toISOString();
 const put=db.prepare('INSERT INTO listing_drafts VALUES(?,?,?,?)');db.exec('BEGIN');
 for(let i=0;i<3000;i++)put.run('draft-'+i,'product-'+i,JSON.stringify({draft:{...target,id:'draft-'+i,productId:'product-'+i,sku:'SKU-'+i,targetId:target.id,state:i<330?'UNKNOWN':'DRAFT',submittedAt:null,updatedAt:now,schema:{parentageLevel:'NONE',schema:{description:'x'.repeat(8000)}},salesPlan:{sourceGroupKey:'source-'+i,recipe:{key:'recipe-'+i}}}}),now);
 db.exec('COMMIT');for(const index of SALES_IDENTITY_INDEXES)db.exec(index.sql);
 const persistence=Object.create(AmazonPersistence.prototype) as AmazonPersistence;persistence.db=db;
 const plans=Array.from({length:330},(_,i)=>({sku:'SKU-'+i,sourceGroupKey:'source-'+i,recipe:{key:'recipe-'+i,components:[{variantId:'variant-'+i}],totalPieces:1}} as SalesListingPlan));
 const find=(p:AmazonPersistence,i:number)=>AmazonService.prototype.findSalesDraft.call({getTarget:()=>target,persistence:p} as never,'product-'+i,plans[i],'store');
 const baseline=Object.create(persistence) as AmazonPersistence;baseline.salesCandidates=()=>persistence.records();
 const measure=async(p:AmazonPersistence,chunked:boolean)=>{let ticks=0,maxGap=0,last=performance.now(),active=true;const beat=()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;if(active)setImmediate(beat).unref();};setImmediate(beat).unref();const start=performance.now();
 try{for(let i=0;i<330;i++){const draft=find(p,i);assert.equal(draft?.state,'UNKNOWN');assert.equal(draft?.id,'draft-'+i);if(chunked&&(i%3===2))await yieldLoop();}await yieldLoop();return {elapsed:performance.now()-start,maxGap,ticks};}finally{active=false;}};
 const old=await measure(baseline,false),fresh=await measure(persistence,true);
 assert.equal(persistence.salesCandidates('product-0','SKU-0','recipe-0').length,1);
 const explain=db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM listing_drafts WHERE json_extract(record_json,'$.draft.sku')=?").all('SKU-0');assert.match(JSON.stringify(explain),/record_drafts_sku/);
 t.diagnostic(`same disk fixture 3000 x 8KB history / 330 lookups: old ${JSON.stringify(old)}; indexed/chunked ${JSON.stringify(fresh)}`);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

