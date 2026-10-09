import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AmazonService } from '../amazon/service.ts';
import { AmazonTransportError } from '../amazon/transport.ts';
import type { ProcurementService } from '../procurement/service.ts';
import type { ProcurementBatch, ProcurementLine } from '../../shared/procurement-contracts.ts';
import type { ItemLabelFormat, ItemLabelRecord } from '../../shared/item-label-contracts.ts';
import { DEFAULT_ITEM_LABEL_FORMAT } from '../../shared/item-label-contracts.ts';
import { identifier } from '../../shared/validation.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { openDatabase } from '../database.ts';
import { itemLabelDownloads, itemLabelRequest, validateItemLabelFormat } from './adapter.ts';
import { itemLabelFingerprint, validateItemLabelRecord } from './records.ts';
import { readVerifiedLabelPdf, saveLabelPdf } from './files.ts';

type LabelsAmazon=Pick<AmazonService,'executionTargetScope'|'createMarketplaceItemLabels'|'downloadItemLabel'>;
type LabelsProcurement=Pick<ProcurementService,'get'|'list'|'candidates'|'setLabelStatus'>;
class LabelPausedBeforeSend extends UserFacingError {}
export class ItemLabelService {
  private db:DatabaseSync; private directory:string;private amazon:LabelsAmazon;private procurement:LabelsProcurement;private now:()=>number;private sleep:(ms:number)=>Promise<void>;
  private running:Promise<void>|null=null;private timer:ReturnType<typeof setTimeout>|null=null;private stopped=false;private started=false;
  constructor(directory:string,amazon:LabelsAmazon,procurement:LabelsProcurement,deps:{now?:()=>number;sleep?:(ms:number)=>Promise<void>}={}){
    this.directory=directory;this.db=openDatabase(directory);this.amazon=amazon;this.procurement=procurement;this.now=deps.now??Date.now;this.sleep=deps.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    for(const row of this.list())if(row.current&&['REQUESTING','DOWNLOADING'].includes(row.status)){row.status='FAILED';row.nextDueAt=null;row.errorCode='INTERRUPTED';row.message='上次标签请求被中断，未取得完整文件；请检查后重试';this.put(row);}
  }
  private at(){return new Date(this.now()).toISOString();}
  private put(row:ItemLabelRecord){row.updatedAt=this.at();const valid=validateItemLabelRecord(row);this.db.prepare('INSERT INTO item_labels(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(row.id,JSON.stringify(valid));if(row.current)this.procurement.setLabelStatus(row.batchId,row.lineId,row.status);}
  list(input:{batchId?:string;jobId?:string}={}):ItemLabelRecord[]{const batchId=input.batchId===undefined?null:identifier(input.batchId),jobId=input.jobId===undefined?null:identifier(input.jobId);return this.db.prepare('SELECT id,record_json FROM item_labels ORDER BY rowid').all().map(row=>{const parsed=validateItemLabelRecord(JSON.parse(String(row.record_json)));if(parsed.id!==row.id)throw new UserFacingError('标签记录身份不一致');return parsed;}).filter(row=>(!batchId||row.batchId===batchId)&&(!jobId||row.jobId===jobId));}
  get(rawId:string):ItemLabelRecord{const id=identifier(rawId),row=this.db.prepare('SELECT record_json FROM item_labels WHERE id=?').get(id);if(!row)throw new UserFacingError('商品标签记录不存在');const parsed=validateItemLabelRecord(JSON.parse(String(row.record_json)));if(parsed.id!==id)throw new UserFacingError('标签记录身份不一致');return parsed;}
  private base(batch:ProcurementBatch,line:ProcurementLine,jobId:string|null,format:ItemLabelFormat){let generation=0;try{generation=this.amazon.executionTargetScope(line.targetId).generation;}catch{/* Missing target is persisted as a context failure. */}return {jobId,batchId:batch.id,lineId:line.id,draftId:line.draftId,productId:line.productId,variantId:line.variantId,targetId:line.targetId,sellerId:line.sellerId,marketplaceId:line.marketplaceId,sku:line.sku,mode:batch.mode,targetGeneration:generation,quantity:line.stockQuantity,format};}
  private targetMatches(row:Pick<ItemLabelRecord,'targetId'|'sellerId'|'marketplaceId'|'mode'|'targetGeneration'>):boolean{try{const scope=this.amazon.executionTargetScope(row.targetId);return scope.target.sellerId===row.sellerId&&scope.target.marketplaceId===row.marketplaceId&&scope.target.mode===row.mode&&scope.generation===row.targetGeneration;}catch{return false;}}
  syncBatch(batchId:string,options:{jobId?:string;format?:ItemLabelFormat}={}):ItemLabelRecord[]{
    const batch=this.procurement.get(batchId),prior=this.list({batchId:batch.id}),eligible=new Map(this.procurement.candidates().map(row=>[row.draftId,row]));const result:ItemLabelRecord[]=[];
    for(const line of batch.lines){
      const previous=prior.findLast(row=>row.lineId===line.id&&row.current)??prior.findLast(row=>row.lineId===line.id),jobId=options.jobId?identifier(options.jobId):previous?.jobId??batch.automaticJobId??null,format=validateItemLabelFormat(options.format??previous?.format??DEFAULT_ITEM_LABEL_FORMAT);
      const base=this.base(batch,line,jobId,format),fingerprint=itemLabelFingerprint(base),contextMatches=this.targetMatches(base);
      if(previous?.current&&previous.fingerprint===fingerprint&&(contextMatches||previous.errorCode==='TARGET_CONTEXT_CHANGED')){if(previous.status==='WAITING_SKU'&&eligible.get(line.draftId)?.eligible){previous.status='QUEUED';previous.nextDueAt=this.at();previous.message='等待获取标签';this.put(previous);}result.push(previous);continue;}
      const sameRequestAfterRotation=!!previous&&previous.targetGeneration!==base.targetGeneration&&itemLabelFingerprint({...base,targetGeneration:previous.targetGeneration})===previous.fingerprint;
      const previousStatus=previous?.status;
      if(previous?.current){previous.current=false;previous.status='STALE';previous.nextDueAt=null;previous.message='数量、格式或绑定信息已变化，旧版本不再用于打印';this.put(previous);}
      const status=!contextMatches?'FAILED':batch.mode==='demo'?'FAILED':!base.quantity?'WAITING_QUANTITY':base.quantity>10000?'FAILED':eligible.get(line.draftId)?.eligible?'QUEUED':'WAITING_SKU';
      const row:ItemLabelRecord={...base,id:randomUUID(),fingerprint,version:Math.max(0,...prior.filter(row=>row.lineId===line.id).map(row=>row.version))+1,current:true,status,paused:previous?.paused??false,attempts:0,nextDueAt:status==='QUEUED'?this.at():null,createdAt:this.at(),updatedAt:this.at(),requestId:null,errorCode:!contextMatches?'TARGET_CONTEXT_CHANGED':batch.mode==='demo'?'DEMO_LABEL_UNAVAILABLE':base.quantity&&base.quantity>10000?'QUANTITY_LIMIT':null,message:!contextMatches?'标签店铺身份已变化或连接已删除，请核对目标':status==='WAITING_QUANTITY'?'请填写需要打印的销售单位数量':status==='WAITING_SKU'?'等待平台建档确认':status==='FAILED'?(batch.mode==='demo'?'演示记录不会请求真实平台标签':'商品标签单次数量上限为 10000'):'等待获取标签',files:[]};
      if(sameRequestAfterRotation){row.status=previousStatus==='CANCELLED'?'CANCELLED':'FAILED';row.attempts=previous!.attempts;row.requestId=previous!.requestId;row.nextDueAt=null;row.errorCode=previous!.errorCode??'TARGET_CONTEXT_CHANGED';row.message=previousStatus==='CANCELLED'?'已取消后续标签请求':'授权配置已变化，原请求次数和结果已保留；请检查后人工重试';}
      this.put(row);result.push(row);
    }
    this.arm();return result;
  }
  private matches(row:ItemLabelRecord):boolean{try{const current=this.get(row.id),batch=this.procurement.get(row.batchId),line=batch.lines.find(line=>line.id===row.lineId);return this.targetMatches(row)&&current.current&&current.status!=='CANCELLED'&&!!line&&itemLabelFingerprint(this.base(batch,line,row.jobId,row.format))===row.fingerprint;}catch{return false;}}
  private stale(row:ItemLabelRecord){const latest=this.get(row.id);if(!latest.current)return;latest.current=false;latest.status='STALE';latest.nextDueAt=null;latest.message='标签绑定已变化，请同步当前备货数量';this.put(latest);}
  private async run(row:ItemLabelRecord):Promise<void>{
    if(row.status!=='QUEUED'||row.paused)return; if(!this.matches(row)){this.stale(row);return;}
    const candidate=this.procurement.candidates().find(v=>v.draftId===row.draftId);if(!candidate?.eligible){row.status='WAITING_SKU';row.nextDueAt=null;row.message=candidate?.reason??'等待 SKU 建档确认';this.put(row);return;}
    const scope=this.amazon.executionTargetScope(row.targetId);if(!scope.target.configured||scope.target.paused){row.status='FAILED';row.errorCode='TARGET_UNAVAILABLE';row.message='标签连接当前不可用，请检查店铺授权';row.nextDueAt=null;this.put(row);return;}
    row.status='REQUESTING';row.attempts++;row.nextDueAt=null;row.message='正在请求 Amazon 商品标签';row.errorCode=null;this.put(row);
    try{
      const response=await this.amazon.createMarketplaceItemLabels(row.targetId,itemLabelRequest(row.marketplaceId,row.sku,row.quantity!,row.format),()=>{if(this.stopped||this.get(row.id).paused)throw new LabelPausedBeforeSend('标签任务已暂停，尚未发出请求');if(!this.matches(row))throw new UserFacingError('标签绑定发生变化');});
      row.requestId=response.requestId;
      if(!this.matches(row)){this.stale(row);return;}
      row.status='DOWNLOADING';row.message='正在下载和核验全部标签文件';row.paused=this.get(row.id).paused;this.put(row);
      const documents=itemLabelDownloads(response.data,this.now()),files:ItemLabelRecord['files']=[];let total=0;
      for(const [index,doc]of documents.entries()){
        let bytes:Buffer|undefined;for(let attempt=0;attempt<2;attempt++){try{bytes=await this.amazon.downloadItemLabel(doc.uri);break;}catch{if(attempt===1)throw new UserFacingError('标签文件下载失败，未取得完整 PDF 集合');await this.sleep(500);}}
        if(!bytes)throw new UserFacingError('标签文件下载失败');total+=bytes.length;if(total>128*1024*1024)throw new UserFacingError('标签文件集合超过允许大小');
        files.push(await saveLabelPdf(this.directory,row.id,index+1,bytes));
      }
      const newest=this.get(row.id);if(!this.matches(row)){if(newest.current)this.stale(row);else{newest.files=files;this.put(newest);}return;}
      row.files=files;row.status='READY';row.message='全部 PDF 标签已保存并校验';row.errorCode=null;row.paused=newest.paused;this.put(row);
    }catch(error){
      if(!this.matches(row)){this.stale(row);return;}const newest=this.get(row.id);row.paused=newest.paused;
      if(error instanceof LabelPausedBeforeSend){row.attempts=Math.max(0,row.attempts-1);row.status='QUEUED';row.nextDueAt=this.at();row.message='标签任务已暂停';this.put(row);return;}
      const transient=error instanceof AmazonTransportError&&!error.unknownWrite&&(error.status===429||error.status===408||error.status!==null&&error.status>=500);
      row.status=transient&&row.attempts<3?'QUEUED':'FAILED';row.nextDueAt=row.status==='QUEUED'?new Date(this.now()+Math.min(120000,10000*2**(row.attempts-1))).toISOString():null;
      row.requestId=error instanceof AmazonTransportError?error.requestId:row.requestId;row.errorCode=error instanceof AmazonTransportError?(error.unknownWrite?'REQUEST_UNKNOWN':`HTTP_${error.status??'NETWORK'}`):'LABEL_FILE_FAILED';
      row.message=error instanceof AmazonTransportError&&error.status===403?'商品标签接口权限不足，请核对 Amazon Fulfillment 角色':error instanceof AmazonTransportError&&error.unknownWrite?'标签请求结果未知，未获得可核验文件；请检查后重试':row.status==='QUEUED'?'标签接口暂时不可用，已安排有限重试':'标签获取或 PDF 校验失败，未获得完整可打印文件';row.files=[];this.put(row);
    }
  }
  runDue():Promise<void>{if(this.stopped)return Promise.resolve();if(this.running)return this.running;this.running=(async()=>{for(const row of this.list().filter(row=>row.current&&!row.paused&&row.status==='QUEUED'&&Date.parse(row.nextDueAt!)<=this.now())){if(this.stopped)break;await this.run(this.get(row.id));}})().finally(()=>{this.running=null;this.arm();});return this.running;}
  private arm(){if(!this.started||this.stopped||this.running)return;if(this.timer)clearTimeout(this.timer);const due=this.list().filter(row=>row.current&&!row.paused&&row.status==='QUEUED').map(row=>Date.parse(row.nextDueAt!));if(!due.length){this.timer=null;return;}this.timer=setTimeout(()=>{this.timer=null;void this.runDue().catch(()=>{});},Math.max(10,Math.min(2147483647,Math.min(...due)-this.now())));this.timer.unref?.();}
  resume():void{this.started=true;this.arm();}
  suspendScheduling():void{this.started=false;if(this.timer)clearTimeout(this.timer);this.timer=null;}
  hasActiveWork():boolean{return this.running!==null;}
  retry(id:string):ItemLabelRecord{const row=this.get(id);if(!row.current||row.status!=='FAILED')throw new UserFacingError('只能重试当前失败的标签版本');if(!this.matches(row))throw new UserFacingError('备货绑定已变化，请刷新');if(row.attempts>=1000)throw new UserFacingError('标签累计重试次数已达上限');row.status='QUEUED';row.paused=false;row.nextDueAt=this.at();row.message='已安排人工确认重试';row.errorCode=null;this.put(row);this.arm();return row;}
  pauseJob(jobId:string):void{for(const row of this.list({jobId}))if(row.current&&!['READY','CANCELLED'].includes(row.status)){row.paused=true;this.put(row);}this.arm();}
  resumeJob(jobId:string):void{for(const row of this.list({jobId}))if(row.current&&row.paused){row.paused=false;this.put(row);}this.arm();}
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
