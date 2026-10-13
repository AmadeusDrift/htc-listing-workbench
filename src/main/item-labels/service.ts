import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AmazonService } from '../amazon/service.ts';
import { AmazonTransportError } from '../amazon/transport.ts';
import type { ProcurementService } from '../procurement/service.ts';
import type { ProcurementBatch, ProcurementLine } from '../../shared/procurement-contracts.ts';
import type { ItemLabelFormat, ItemLabelRecord } from '../../shared/item-label-contracts.ts';
import { DEFAULT_ITEM_LABEL_FORMAT } from '../../shared/item-label-contracts.ts';
import { identifier, record } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { openDatabase } from '../database.ts';
import { itemLabelDownloads, itemLabelRequest, validateItemLabelFormat } from './adapter.ts';
import { itemLabelFingerprint, validateItemLabelRecord } from './records.ts';
import { readVerifiedLabelPdf, saveLabelPdf } from './files.ts';

type LabelsAmazon=Pick<AmazonService,'executionTargetScope'|'createMarketplaceItemLabels'|'downloadItemLabel'|'restoreItemLabelDownloads'>;
type LabelsProcurement=Pick<ProcurementService,'get'|'list'|'candidates'|'setLabelStatus'>;
class LabelPausedBeforeSend extends UserFacingError {}
export class ItemLabelService {
  private db:DatabaseSync; private directory:string;private amazon:LabelsAmazon;private procurement:LabelsProcurement;private now:()=>number;private sleep:(ms:number)=>Promise<void>;
  private running:Promise<void>|null=null;private timer:ReturnType<typeof setTimeout>|null=null;private stopped=false;private started=false;
  constructor(directory:string,amazon:LabelsAmazon,procurement:LabelsProcurement,deps:{now?:()=>number;sleep?:(ms:number)=>Promise<void>}={}){
    this.directory=directory;this.db=openDatabase(directory);this.amazon=amazon;this.procurement=procurement;this.now=deps.now??Date.now;this.sleep=deps.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    for(const row of this.list()){
      if(row.current&&!row.requestedAt&&['QUEUED','WAITING_SKU','WAITING_QUANTITY'].includes(row.status)){row.paused=true;this.put(row);}
      else if(row.requestPending||row.status==='REQUESTING'||row.current&&row.status==='DOWNLOADING'){
        if(!row.requestedAt)this.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?)').run(randomUUID(),null,'item-labels.legacy-interrupted','保留旧标签中断状态与原请求证据',JSON.stringify(row),this.at());
        const unknown=row.requestPending||row.status==='REQUESTING';
        if(row.status==='DOWNLOADING')row.responseReceived=true;
        row.status=row.current?'FAILED':'STALE';row.paused=true;row.nextDueAt=null;row.requestPending=false;
        row.errorCode=unknown?'REQUEST_UNKNOWN':'INTERRUPTED';
        row.message=unknown?'标签发送后结果未知，请核对原请求；普通重试不会重新发送':'标签响应已收到，但本地下载被中断；请检查后重试';this.put(row);
      }
    }
  }
  private at(){return new Date(this.now()).toISOString();}
  /** Signed download capabilities stay in main-only storage, never ItemLabelRecord/IPC. */
  private saveDownloads(row:ItemLabelRecord,downloads:{uri:string;expiration:number}[]):void{
    this.db.prepare('INSERT INTO amazon_settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run('item_label_download_v1:'+row.id,JSON.stringify({version:1,labelId:row.id,fingerprint:row.fingerprint,requestId:row.requestId,receivedAt:this.at(),downloads}));
  }
  private downloads(row:ItemLabelRecord):{uri:string;expiration:number}[]{
    try{
      const entry=this.db.prepare('SELECT value_json FROM amazon_settings WHERE key=?').get('item_label_download_v1:'+row.id);
      if(!entry||String(entry.value_json).length>2*1024*1024)throw Error();
      const value=record(JSON.parse(String(entry.value_json)),'标签恢复',['version','labelId','fingerprint','requestId','receivedAt','downloads']);
      if(value.version!==1||value.labelId!==row.id||value.fingerprint!==row.fingerprint||value.requestId!==row.requestId||typeof value.receivedAt!=='string'||!Number.isFinite(Date.parse(value.receivedAt))||!Array.isArray(value.downloads))throw Error();
      return itemLabelDownloads({documentDownloads:value.downloads.map(raw=>{const d=record(raw,'标签恢复文件',['uri','expiration']);if(typeof d.expiration!=='number'||!Number.isFinite(d.expiration)||d.expiration>Date.parse(value.receivedAt as string)+86400000)throw Error();return {downloadType:'URL',uri:d.uri,expiration:new Date(d.expiration).toISOString()};})},this.now());
    }catch{throw new UserFacingError('原标签下载资料已过期、缺失或不匹配；保留原请求，不能重新生成');}
  }
  private put(row:ItemLabelRecord){row.updatedAt=this.at();const valid=validateItemLabelRecord(row);this.db.prepare('INSERT INTO item_labels(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(row.id,JSON.stringify(valid));if(row.current)this.procurement.setLabelStatus(row.batchId,row.lineId,row.status);}
  list(input:{batchId?:string;jobId?:string}={}):ItemLabelRecord[]{const batchId=input.batchId===undefined?null:identifier(input.batchId),jobId=input.jobId===undefined?null:identifier(input.jobId);return this.db.prepare('SELECT id,record_json FROM item_labels ORDER BY rowid').all().map(row=>{const parsed=validateItemLabelRecord(JSON.parse(String(row.record_json)));if(parsed.id!==row.id)throw new UserFacingError('标签记录身份不一致');return parsed;}).filter(row=>(!batchId||row.batchId===batchId)&&(!jobId||row.jobId===jobId));}
  get(rawId:string):ItemLabelRecord{const id=identifier(rawId),row=this.db.prepare('SELECT record_json FROM item_labels WHERE id=?').get(id);if(!row)throw new UserFacingError('商品标签记录不存在');const parsed=validateItemLabelRecord(JSON.parse(String(row.record_json)));if(parsed.id!==id)throw new UserFacingError('标签记录身份不一致');return parsed;}
  private base(batch:ProcurementBatch,line:ProcurementLine,jobId:string|null,format:ItemLabelFormat){let generation=0;try{generation=this.amazon.executionTargetScope(line.targetId).generation;}catch{/* Missing target is persisted as a context failure. */}return {jobId,batchRevision:batch.revision,batchId:batch.id,lineId:line.id,draftId:line.draftId,productId:line.productId,variantId:line.variantId,targetId:line.targetId,sellerId:line.sellerId,marketplaceId:line.marketplaceId,sku:line.sku,mode:batch.mode,targetGeneration:generation,quantity:line.stockQuantity,format};}
  private targetMatches(row:Pick<ItemLabelRecord,'targetId'|'sellerId'|'marketplaceId'|'mode'|'targetGeneration'>):boolean{try{const scope=this.amazon.executionTargetScope(row.targetId);return scope.target.sellerId===row.sellerId&&scope.target.marketplaceId===row.marketplaceId&&scope.target.mode===row.mode&&scope.generation===row.targetGeneration;}catch{return false;}}
  syncBatch(batchId:string,options:{jobId?:string;format?:ItemLabelFormat}={}):ItemLabelRecord[]{
    const batch=this.procurement.get(batchId),prior=this.list({batchId:batch.id}),eligible=new Map(this.procurement.candidates().map(row=>[row.draftId,row]));const result:ItemLabelRecord[]=[];
    for(const line of batch.lines){
      const unknown=prior.findLast(row=>row.lineId===line.id&&row.errorCode==='REQUEST_UNKNOWN');
      // A procurement revision is not evidence that the prior request was not sent.
      if(unknown){result.push(unknown);continue;}
      const previous=prior.findLast(row=>row.lineId===line.id&&row.current)??prior.findLast(row=>row.lineId===line.id),jobId=options.jobId?identifier(options.jobId):previous?.jobId??batch.automaticJobId??null,format=validateItemLabelFormat(options.format??previous?.format??DEFAULT_ITEM_LABEL_FORMAT);
      const base=this.base(batch,line,jobId,format),fingerprint=itemLabelFingerprint(base),contextMatches=this.targetMatches(base);
      if(previous?.current&&previous.fingerprint===fingerprint&&(contextMatches||previous.errorCode==='TARGET_CONTEXT_CHANGED')){result.push(previous);continue;}
      const sameRequestAfterRotation=!!previous&&(previous.targetGeneration!==base.targetGeneration||previous.batchRevision===undefined)&&itemLabelFingerprint({...base,targetGeneration:previous.targetGeneration,...(previous.batchRevision===undefined?{batchRevision:undefined}:{})})===previous.fingerprint;
      const previousStatus=previous?.status;
      if(previous?.current){if(previous.status==='REQUESTING')previous.requestPending=true;previous.current=false;previous.status='STALE';previous.nextDueAt=null;previous.message='数量、格式或绑定信息已变化，旧版本不再用于打印';this.put(previous);}
      const status=!contextMatches?'FAILED':batch.mode==='demo'?'FAILED':!base.quantity?'WAITING_QUANTITY':base.quantity>10000?'FAILED':eligible.get(line.draftId)?.eligible?'NOT_REQUESTED':'WAITING_SKU';
      const row:ItemLabelRecord={...base,id:randomUUID(),fingerprint,version:Math.max(0,...prior.filter(row=>row.lineId===line.id).map(row=>row.version))+1,current:true,status,paused:previous?.paused??false,attempts:0,nextDueAt:null,createdAt:this.at(),updatedAt:this.at(),requestId:null,errorCode:!contextMatches?'TARGET_CONTEXT_CHANGED':batch.mode==='demo'?'DEMO_LABEL_UNAVAILABLE':base.quantity&&base.quantity>10000?'QUANTITY_LIMIT':null,message:!contextMatches?'标签店铺身份已变化或连接已删除，请核对目标':status==='WAITING_QUANTITY'?'请填写需要打印的销售单位数量':status==='WAITING_SKU'?'等待平台建档确认':status==='FAILED'?(batch.mode==='demo'?'演示记录不会请求真实平台标签':'商品标签单次数量上限为 10000'):'需要备货或打印时，请准备本批次标签',files:[]};
      if(sameRequestAfterRotation){if(previous!.responseReceived||previous!.files.length||previousStatus==='DOWNLOADING'||previous!.errorCode==='INTERRUPTED')row.responseReceived=true;row.status=previousStatus==='CANCELLED'?'CANCELLED':'FAILED';row.attempts=previous!.attempts;row.requestId=previous!.requestId;row.nextDueAt=null;row.errorCode=previous!.errorCode??'TARGET_CONTEXT_CHANGED';row.message=previousStatus==='CANCELLED'?'已取消后续标签请求':'授权配置或标签版本绑定已变化，原请求次数和结果已保留；请检查后人工重试';}
      this.put(row);result.push(row);
    }
    return result;
  }
  /** Public preparation boundary: READY is reusable only after local PDF verification. */
  async prepareVerifiedBatch(batchId:string,options:{format?:ItemLabelFormat}={}):Promise<ItemLabelRecord[]>{
    const rows=this.prepareBatch(batchId,options),result:ItemLabelRecord[]=[];
    for(const row of rows){
      if(row.status==='READY'){
        try {await this.verifyFiles(row.id);} catch(error) {if(this.get(row.id).errorCode!=='FILE_INTEGRITY')throw error;}
      }
      result.push(this.get(row.id));
    }
    return result;
  }
  /** Queue-only primitive. Production entrypoints use prepareVerifiedBatch. */
  prepareBatch(batchId:string,options:{format?:ItemLabelFormat}={}):ItemLabelRecord[]{
    const rows=this.syncBatch(batchId,options);
    for(const row of rows){
      if(!['NOT_REQUESTED','WAITING_SKU','WAITING_QUANTITY','QUEUED'].includes(row.status)||row.attempts>=3)continue;
      row.requestedAt??=this.at();row.paused=false;
      if(row.quantity&&row.quantity<=10000&&this.procurement.candidates().find(value=>value.draftId===row.draftId)?.eligible){row.status='QUEUED';row.nextDueAt??=this.at();row.message='已请求准备标签';}
      this.put(row);
    }
    this.arm();return rows;
  }
  private matches(row:ItemLabelRecord):boolean{try{const current=this.get(row.id),batch=this.procurement.get(row.batchId),line=batch.lines.find(line=>line.id===row.lineId);return !this.list({batchId:row.batchId}).some(value=>value.lineId===row.lineId&&value.errorCode==='REQUEST_UNKNOWN')&&this.targetMatches(row)&&current.current&&current.status!=='CANCELLED'&&!!line&&itemLabelFingerprint(this.base(batch,line,row.jobId,row.format))===row.fingerprint;}catch{return false;}}
  private stale(row:ItemLabelRecord){const latest=this.get(row.id);if(!latest.current)return;if(latest.status==='REQUESTING')latest.requestPending=true;latest.current=false;latest.status='STALE';latest.nextDueAt=null;latest.message='标签绑定已变化，请同步当前备货数量';this.put(latest);}
  private async run(row:ItemLabelRecord):Promise<void>{
    if(row.status!=='QUEUED'||row.paused||!row.requestedAt)return; if(!this.matches(row)){this.stale(row);return;}
    const candidate=this.procurement.candidates().find(v=>v.draftId===row.draftId);if(!candidate?.eligible){row.status='WAITING_SKU';row.nextDueAt=null;row.message=candidate?.reason??'等待 SKU 建档确认';this.put(row);return;}
    const scope=this.amazon.executionTargetScope(row.targetId);if(!scope.target.configured||scope.target.paused){row.status='FAILED';row.errorCode='TARGET_UNAVAILABLE';row.message='标签连接当前不可用，请检查店铺授权';row.nextDueAt=null;this.put(row);return;}
    if(!row.responseReceived){row.status='REQUESTING';row.requestPending=true;row.attempts++;row.nextDueAt=null;row.message='正在请求 Amazon 商品标签';row.errorCode=null;this.put(row);}
    try{
      let documents:{uri:string;expiration:number}[];
      if(row.responseReceived){documents=this.downloads(row);this.amazon.restoreItemLabelDownloads(row,documents);}
      else{
        const response=await this.amazon.createMarketplaceItemLabels(row.targetId,itemLabelRequest(row.marketplaceId,row.sku,row.quantity!,row.format),()=>{if(this.stopped||this.get(row.id).paused||!this.get(row.id).requestedAt)throw new LabelPausedBeforeSend('标签任务已暂停，尚未发出请求');if(!this.matches(row))throw new UserFacingError('标签绑定发生变化');});
        const received=this.get(row.id);received.requestPending=false;received.responseReceived=true;received.requestId=response.requestId;if(received.current)received.status='DOWNLOADING';
        row.requestPending=false;row.responseReceived=true;row.requestId=response.requestId;
        // Keep a malformed known response blocked; valid recovery metadata commits with its identity.
        try{documents=itemLabelDownloads(response.data,this.now());}catch(error){this.put(received);throw error;}
        this.db.exec('BEGIN IMMEDIATE');
        try{this.saveDownloads(received,documents);this.put(received);this.db.exec('COMMIT');}
        catch(error){this.db.exec('ROLLBACK');throw error;}
      }
      if(!this.matches(row)){this.stale(row);return;}
      row.status='DOWNLOADING';row.nextDueAt=null;row.downloadAttempts=(row.downloadAttempts??0)+1;row.message='正在下载和核验原请求的全部标签文件';row.paused=this.get(row.id).paused;this.put(row);
      const files:ItemLabelRecord['files']=[];let total=0;
      for(const [index,doc]of documents.entries()){
        if(doc.expiration<=this.now())throw new UserFacingError('原标签下载地址已过期；保留原请求，不能重新生成');
        let bytes:Buffer|undefined;for(let attempt=0;attempt<2;attempt++){try{bytes=await this.amazon.downloadItemLabel(doc.uri);break;}catch(error){if(attempt===1)throw error instanceof UserFacingError?error:new UserFacingError('标签文件下载失败，未取得完整 PDF 集合');await this.sleep(500);}}
        if(!bytes)throw new UserFacingError('标签文件下载失败');total+=bytes.length;if(total>128*1024*1024)throw new UserFacingError('标签文件集合超过允许大小');
        files.push(await saveLabelPdf(this.directory,row.id,index+1,bytes));
      }
      const newest=this.get(row.id);if(!this.matches(row)){if(newest.current)this.stale(row);else{newest.files=files;this.put(newest);}return;}
      row.files=files;row.status='READY';row.message='全部 PDF 标签已保存并校验';row.errorCode=null;row.paused=newest.paused;this.put(row);
    }catch(error){
      if(!row.responseReceived&&error instanceof AmazonTransportError&&error.unknownWrite){
        // Even a superseded in-flight request remains unresolved: preserve its evidence.
        const latest=this.get(row.id);latest.status=latest.current?'FAILED':'STALE';latest.attempts=row.attempts;latest.nextDueAt=null;latest.requestPending=false;
        latest.requestId=error.requestId;latest.errorCode='REQUEST_UNKNOWN';latest.message='标签请求结果未知，请核对原请求；普通重试不会重新发送';this.put(latest);return;
      }
      row.requestPending=false;const settled=this.get(row.id);settled.requestPending=false;if(settled.status==='REQUESTING')settled.status='FAILED';this.put(settled);
      if(!this.matches(row)){this.stale(row);return;}const newest=this.get(row.id);row.paused=newest.paused;
      if(error instanceof LabelPausedBeforeSend){if(!newest.requestedAt)delete row.requestedAt;row.attempts=Math.max(0,row.attempts-1);row.status='QUEUED';row.nextDueAt=this.at();row.message='标签任务已暂停';this.put(row);return;}
      const transient=error instanceof AmazonTransportError&&!error.unknownWrite&&(error.status===429||error.status===408||error.status!==null&&error.status>=500);
      const retryCount=row.responseReceived?(row.downloadAttempts??0):row.attempts;
      row.status=transient&&retryCount<3?'QUEUED':'FAILED';row.nextDueAt=row.status==='QUEUED'?new Date(this.now()+Math.min(120000,10000*2**(retryCount-1))).toISOString():null;
      row.requestId=!row.responseReceived&&error instanceof AmazonTransportError?error.requestId:row.requestId;row.errorCode=error instanceof AmazonTransportError?(error.unknownWrite?(row.responseReceived?'DOWNLOAD_FAILED':'REQUEST_UNKNOWN'):`HTTP_${error.status??'NETWORK'}`):'LABEL_FILE_FAILED';
      row.message=error instanceof AmazonTransportError&&error.status===403?'商品标签接口权限不足，请核对 Amazon Fulfillment 角色':!row.responseReceived&&error instanceof AmazonTransportError&&error.unknownWrite?'标签请求结果未知，未获得可核验文件；请检查后重试':row.status==='QUEUED'?'标签接口暂时不可用，已安排有限重试':error instanceof UserFacingError?error.message.slice(0,1200):'标签获取或 PDF 校验失败，未获得完整可打印文件';row.files=[];this.put(row);
    }
  }
  runDue():Promise<void>{if(this.stopped)return Promise.resolve();if(this.running)return this.running;this.running=(async()=>{for(const waiting of this.list().filter(row=>row.current&&row.requestedAt&&!row.paused&&row.status==='WAITING_SKU')){if(!this.matches(waiting)){this.stale(waiting);continue;}if(this.procurement.candidates().find(value=>value.draftId===waiting.draftId)?.eligible&&waiting.quantity&&waiting.quantity<=10000){waiting.status='QUEUED';waiting.nextDueAt=this.at();this.put(waiting);}}for(const row of this.list().filter(row=>row.current&&!!row.requestedAt&&!row.paused&&row.status==='QUEUED'&&Date.parse(row.nextDueAt!)<=this.now())){if(this.stopped)break;await this.run(this.get(row.id));}})().finally(()=>{this.running=null;this.arm();});return this.running;}
  private arm(){if(!this.started||this.stopped||this.running)return;if(this.timer)clearTimeout(this.timer);const due=this.list().filter(row=>row.current&&!!row.requestedAt&&!row.paused&&['QUEUED','WAITING_SKU'].includes(row.status)).map(row=>row.status==='WAITING_SKU'?this.now()+5000:Date.parse(row.nextDueAt!));if(!due.length){this.timer=null;return;}this.timer=setTimeout(()=>{this.timer=null;void this.runDue().catch(()=>{});},Math.max(10,Math.min(2147483647,Math.min(...due)-this.now())));this.timer.unref?.();}
  resume():void{this.started=true;this.arm();}
  suspendScheduling():void{this.started=false;if(this.timer)clearTimeout(this.timer);this.timer=null;}
  hasActiveWork():boolean{return this.running!==null;}
  retry(id:string):ItemLabelRecord{
    let row=this.get(id);
    if(this.list({batchId:row.batchId}).some(value=>value.lineId===row.lineId&&value.errorCode==='REQUEST_UNKNOWN'))throw new UserFacingError('标签请求结果未知，请先核对原请求；普通重试不能重新发送');
    if(!row.current||row.status!=='FAILED')throw new UserFacingError('只能重试当前失败的标签版本');
    if(!this.matches(row))throw new UserFacingError('备货绑定已变化，请刷新');
    if(row.attempts>=1000||(row.downloadAttempts??0)>=1000)throw new UserFacingError('标签累计重试次数已达上限');
    if(row.files.length||row.errorCode==='INTERRUPTED')row.responseReceived=true;
    const downloads=row.responseReceived?this.downloads(row):null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(row.files.length){
        row.current=false;row.status='STALE';row.nextDueAt=null;this.put(row);
        row={...row,id:randomUUID(),version:row.version+1,current:true,createdAt:this.at(),files:[]};
        if(downloads)this.saveDownloads(row,downloads);
      }
      row.requestedAt=this.at();row.status='QUEUED';row.paused=false;row.nextDueAt=this.at();row.message='已安排人工确认重试';row.errorCode=null;
      this.put(row);this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
    this.arm();return row;
  }
  pauseJob(jobId:string):void{for(const row of this.list({jobId}))if(row.current&&!['READY','CANCELLED'].includes(row.status)){row.paused=true;this.put(row);}this.arm();}
  resumeJob(jobId:string):void{for(const row of this.list({jobId}))if(row.current&&row.paused&&row.requestedAt){row.paused=false;this.put(row);}this.arm();}
  cancelJob(jobId:string):void{for(const row of this.list({jobId}))if(row.current&&!['READY','REQUESTING','DOWNLOADING'].includes(row.status)){row.status='CANCELLED';row.paused=true;row.nextDueAt=null;row.message='已取消后续标签请求';this.put(row);}else if(row.current&&['REQUESTING','DOWNLOADING'].includes(row.status)){row.paused=true;this.put(row);}this.arm();}
  private checkedSnapshot(row:ItemLabelRecord):ItemLabelRecord{
    const latest=this.get(row.id);
    if(latest.status!=='READY'||!this.matches(latest)||latest.fingerprint!==row.fingerprint||JSON.stringify(latest.files)!==JSON.stringify(row.files))throw new UserFacingError('标签绑定已变化或已过期，请刷新后重试');
    return latest;
  }
  async verifyFiles(id:string){
    const row=this.get(id);if(row.status!=='READY'||!this.matches(row))throw new UserFacingError('当前标签文件未就绪或已过期');
    const files=[];
    try{for(const descriptor of row.files)files.push({descriptor,...await readVerifiedLabelPdf(this.directory,descriptor)});}
    catch{
      // A read failure may finish after syncBatch has superseded this version.
      // Never write the captured READY row back over a newer lifecycle state.
      const latest=this.checkedSnapshot(row);latest.status='FAILED';latest.errorCode='FILE_INTEGRITY';latest.message='本地标签文件丢失或校验失败，请重新获取';this.put(latest);throw new UserFacingError(latest.message);
    }
    return {record:this.checkedSnapshot(row),files};
  }
  private readyBatchSnapshot(batchId:string):ItemLabelRecord[]{
    const batch=this.procurement.get(batchId),rows=this.list({batchId}).filter(row=>row.current);
    if(rows.length!==batch.lines.length||batch.lines.some(line=>rows.filter(row=>row.lineId===line.id).length!==1)||rows.some(row=>row.status!=='READY'||!this.matches(row)))throw new UserFacingError('本批次仍有商品标签未就绪或绑定已变化');
    return rows;
  }
  assertBatchSnapshot(batchId:string,records:ItemLabelRecord[]):void{
    const rows=[...new Map(records.map(row=>[row.id,row])).values()],latest=this.readyBatchSnapshot(batchId);
    if(latest.length!==rows.length||latest.some(row=>!rows.some(previous=>previous.id===row.id&&previous.batchId===batchId)))throw new UserFacingError('本批次标签绑定已变化，请刷新后重试');
    for(const row of rows)this.checkedSnapshot(row);
  }
  async filesForBatch(batchId:string){
    const rows=this.readyBatchSnapshot(batchId),results=[];
    for(const row of rows){const verified=await this.verifyFiles(row.id);for(const file of verified.files)results.push({record:verified.record,...file});}
    this.assertBatchSnapshot(batchId,rows);
    return results;
  }
  async close():Promise<void>{if(this.stopped)return;this.stopped=true;if(this.timer)clearTimeout(this.timer);await this.running;this.db.close();}
}
