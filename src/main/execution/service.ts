import { cleanHaulAttributes } from '../amazon/listing-program.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AmazonService } from '../amazon/service.ts';
import type { WorkspaceStore } from '../store.ts';
import type { AmazonDraft } from '../../shared/amazon-contracts.ts';
import type { ExecutionItem, ExecutionStep, ExecutionTask } from '../../shared/execution-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { identifier, record, text } from '../../shared/validation.ts';
import { openDatabase } from '../database.ts';
import { publicError } from '../security.ts';
import { fingerprint, stepNames, validateExecutionTask } from './records.ts';
import { hostedAttributes, imageFields } from './images.ts';
import { TaskWriteNotSentError } from '../amazon/task-errors.ts';
import { approvedWorkflowAsset, approvedWorkflowAssets, workflowRuns } from '../image-workflow/records.ts';
import { hasSevenApprovedImages } from '../../shared/image-workflow-contracts.ts';
import type { ProductDetail } from '../../shared/contracts.ts';
import { validateAttributes } from '../amazon/schema.ts';
import { isDeferredImageIssue } from '../image-workflow/deferred-fields.ts';
import { isSameSalesFamily } from '../sales-plans/family-binding.ts';

interface ProfileScope { id: string; generation: number; enabled: boolean; configured: boolean; host: string; port: number; secure: boolean; remoteRoot: string; publicBaseUrl: string }
interface HostedImage { id: string; assetId: string; profileId: string; generation: number; sha256: string; publicUrl: string; status: string }
export interface ExecutionHosting {
  getProfile(id: string): ProfileScope;
  upload(input: { assetId: string; profileId: string; generation: number; batchId: string }, signal?: AbortSignal): Promise<HostedImage>;
  verify(uploadId: string, signal?: AbortSignal): Promise<HostedImage>;
}
export interface ExecutionDependencies {
  /** Registers durable work only; it must not wait for the delayed remote request. */
  scheduleFollowup?: (draftId: string) => unknown;
}
const terminal = (task: ExecutionTask) => ['COMPLETED', 'CANCELLED'].includes(task.status);
const submitted = (draft: AmazonDraft) => !!draft.submittedAt || ['SUBMITTING','SUBMITTED','PROCESSING','BUYABLE','DISCOVERABLE','UNKNOWN'].includes(draft.state);
const ref = (draft: AmazonDraft) => ({ id: draft.id, revision: draft.revision });

/** One active batch with bounded SKU workers. Credentials and authorization never enter task records. */
export class ExecutionService {
  private db: DatabaseSync;
  private store: WorkspaceStore;
  private amazon: AmazonService;
  private hosting: ExecutionHosting;
  private dependencies: ExecutionDependencies;
  private tasks = new Map<string, ExecutionTask>();
  private grants = new Set<string>();
  private worker: Promise<void> | null = null;
  private liveStepTail: Promise<void> = Promise.resolve();
  private controller: AbortController | null = null;
  private activeId: string | null = null;
  private closing = false;
  private closed = false;
  constructor(directory: string, store: WorkspaceStore, amazon: AmazonService, hosting: ExecutionHosting, dependencies: ExecutionDependencies = {}) {
    this.db = openDatabase(directory); this.store = store; this.amazon = amazon; this.hosting = hosting; this.dependencies = dependencies;
    try {
      for (const row of this.db.prepare('SELECT id,record_json FROM execution_tasks ORDER BY rowid').all()) {
        const task = validateExecutionTask(JSON.parse(String(row.record_json)));
        if (row.id !== task.id) throw new UserFacingError('任务身份不一致');
        this.tasks.set(task.id, task);
        if (['RUNNING','QUEUED'].includes(task.status)) { task.status = 'PAUSED'; task.error = '工作台曾中断；请核对任务后重新启动'; this.save(task); }
      }
    } catch (error) { this.db.close(); throw error; }
  }
  private ensureOpen(): void { if (this.closing || this.closed) throw new UserFacingError('任务服务正在停止'); }
  private task(rawId: unknown): ExecutionTask { this.ensureOpen(); const task = this.tasks.get(identifier(rawId)); if (!task) throw new UserFacingError('任务不存在'); return task; }
  private save(task: ExecutionTask): void {
    task.revision++; task.updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO execution_tasks(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(task.id, JSON.stringify(task));
  }
  list(): ExecutionTask[] { this.ensureOpen(); return [...this.tasks.values()].reverse().map(task => structuredClone(task)); }
  get(id: string): ExecutionTask { return structuredClone(this.task(id)); }
  get busy(): boolean { return this.worker !== null; }
  private confirmed(assetId: string, variantId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM variant_assets WHERE asset_id=? AND variant_id=? AND confirmed=1').get(assetId, variantId);
  }
  private selectedAssets(draft: AmazonDraft, product: ProductDetail): ExecutionItem['assets'] {
    if(draft.schema.parentageLevel==='PARENT'&&draft.parentImageSourceDraftId){
      const child=this.amazon.getDraft(draft.parentImageSourceDraftId);
      if(!draft.salesPlan||child.salesPlan?.parentage!=='CHILD'||!isSameSalesFamily(child.salesPlan,draft.salesPlan)||child.salesPlan.parentSku!==draft.sku
        ||child.targetId!==draft.targetId||child.productId!==draft.productId||child.productRevision!==draft.productRevision)throw new UserFacingError('父体引用的子体图片范围变化');
      const approved=approvedWorkflowAsset(this.db,child,product);
      if(!approved)throw new UserFacingError('父体等待子体主图通过检测');
      return [{...approved,role:'main'}];
    }
    this.store.assertSourceConsistency(product.id,draft.salesPlan?.recipe.components.map(c=>c.variantId)??[draft.variantId]);
    const workflow=workflowRuns(this.db,draft.id)[0];
    if(workflow&&draft.schema.parentageLevel!=='PARENT'&&!submitted(draft)&&!hasSevenApprovedImages(workflow))throw new UserFacingError('每个销售 SKU 必须完成 7 张图片审核，请继续自动准备');
    const approved = approvedWorkflowAssets(this.db, draft, product);
    if (approved) return approved.map((asset,index)=>({...asset,role:index===0?'main':'gallery'}));
    const derived = new Set(workflowRuns(this.db).flatMap(run => run.slots?run.slots.flatMap(slot=>slot.approvedAssetId?[slot.approvedAssetId]:[]):run.approvedAssetId ? [run.approvedAssetId] : []));
    return product.assets.filter(a => !derived.has(a.id) && a.role !== 'detail' && a.variantIds.includes(draft.variantId) && this.confirmed(a.id, draft.variantId))
      .sort((a,b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)))
      .map(a => ({id:a.id,role:a.role as 'main'|'gallery',sha256:this.store.getAssetRecord(a.id)!.sha256}));
  }
  private profile(task: Pick<ExecutionTask, 'profileId'|'profileGeneration'|'profileStamp'>): void {
    const profile = this.hosting.getProfile(task.profileId);
    if (!profile.enabled || !profile.configured || profile.generation !== task.profileGeneration || fingerprint(profile) !== task.profileStamp) throw new UserFacingError('FTP 配置已停用或发生变化；原任务不能改投其他配置，请重新建任务');
  }
  private current(item: ExecutionItem, forWrite = true): AmazonDraft {
    const draft = this.amazon.getDraft(item.draftId);
    if (draft.productId !== item.productId || draft.variantId !== item.variantId || draft.sku !== item.sku || draft.targetId !== item.targetId
      || draft.sellerId !== item.sellerId || draft.marketplaceId !== item.marketplaceId || draft.mode !== item.mode || fingerprint(draft.schema) !== item.schemaHash) throw new UserFacingError('任务的 SKU、目标或 Schema 已变化，请重新建任务');
    if (!forWrite) return draft;
    const product = this.store.getProduct(item.productId);
    if (product.revision !== item.productRevision || draft.productRevision !== item.productRevision) throw new UserFacingError('来源商品已变化，请建立新草稿和任务');
    if (fingerprint(this.amazon.executionTargetScope(item.targetId)) !== item.targetStamp) throw new UserFacingError('店铺授权或配置已变化，请重新建任务');
    const currentHash = fingerprint(draft.attributes);
    if (currentHash !== item.attributesHash) {
      // A crash can occur between saveDraft and checkpointing the returned revision.
      if (currentHash !== item.intendedAttributesHash || draft.revision !== item.draftRevision + 1) throw new UserFacingError('草稿内容已变化，请重新建任务');
      item.attributesHash = currentHash; item.draftRevision = draft.revision; item.intendedAttributesHash = null;
    }
    if (draft.revision !== item.draftRevision) throw new UserFacingError('草稿版本已变化，请重新建任务');
    if (fingerprint(this.selectedAssets(draft, product)) !== fingerprint(item.assets)) throw new UserFacingError('图片或 SKU 关联已变化，请重新建任务');
    return draft;
  }
  create(raw: unknown): ExecutionTask {
    this.ensureOpen(); const input = record(raw, '新建任务参数', ['draftIds','profileId','concurrency']);
    const concurrency = Object.hasOwn(input, 'concurrency') ? input.concurrency : 1;
    if (concurrency !== 1 && concurrency !== 3 && concurrency !== 5) throw new UserFacingError('任务并发数必须为 1、3 或 5');
    if (!Array.isArray(input.draftIds) || input.draftIds.length < 1 || input.draftIds.length > 50) throw new UserFacingError('每个任务请选择 1–50 个 SKU 草稿');
    const ids = input.draftIds.map(identifier); if (new Set(ids).size !== ids.length) throw new UserFacingError('任务草稿不能重复');
    if ([...this.tasks.values()].some(task => !terminal(task) && task.items.some(item => ids.includes(item.draftId)))) throw new UserFacingError('所选草稿已在未结束任务中，请先处理原任务');
    const profileId = text(input.profileId, 'FTP 配置', 30, true), profile = this.hosting.getProfile(profileId);
    if (!profile.enabled || !profile.configured) throw new UserFacingError('请先配置并启用 FTP');
    const items: ExecutionItem[] = ids.map(id => {
      const draft = this.amazon.getDraft(id), product = this.store.getProduct(draft.productId);
      if (submitted(draft)) throw new UserFacingError('所选草稿已经提交或结果未知，请先回读处理');
      if (draft.productRevision !== product.revision) throw new UserFacingError('来源商品已变化，请重新建立草稿');
      const target = this.amazon.executionTargetScope(draft.targetId); if (!target.target.configured || target.target.paused) throw new UserFacingError('店铺未配置或已暂停');
      const assets = this.selectedAssets(draft, product);
      if (assets.filter(a => a.role === 'main').length !== 1) throw new UserFacingError('每个 SKU 必须有一张已确认关联的主图');
      imageFields(draft, assets.length);
      return { draftId: id, productId: draft.productId, productRevision: product.revision, variantId: draft.variantId, sku: draft.sku,
        targetId: draft.targetId, targetName: draft.targetName, sellerId: draft.sellerId, marketplaceId: draft.marketplaceId, mode: draft.mode, targetStamp: fingerprint(target),
        schemaHash: fingerprint(draft.schema), attributesHash: fingerprint(draft.attributes), intendedAttributesHash: null, draftRevision: draft.revision,
        assets, uploads: [],
        steps: stepNames.map(name => ({ name, status: 'PENDING', attempts: 0, error: null })), status: 'PENDING', listingState: null, submitStarted: false };
    });
    const listings = items.map(i => `${i.sellerId}:${i.marketplaceId}:${i.sku}`);
    if (new Set(listings).size !== listings.length || [...this.tasks.values()].some(t => !terminal(t) && t.items.some(i => listings.includes(`${i.sellerId}:${i.marketplaceId}:${i.sku}`)))) throw new UserFacingError('同一店铺 SKU 已在任务中，不能重复排队');
    const now = new Date().toISOString();
    const task: ExecutionTask = { id: randomUUID(), revision: 0, status: 'CREATED', concurrency, profileId, profileGeneration: profile.generation, profileStamp: fingerprint(profile), items, createdAt: now, updatedAt: now, error: null };
    this.save(task); this.tasks.set(task.id, task); return structuredClone(task);
  }
  /** Used to build the native task-start dialog. The renderer cannot supply approval. */
  prepareStart(id: string): ExecutionTask {
    const task = this.task(id);
    if (!['CREATED','PAUSED','NEEDS_ATTENTION'].includes(task.status) || this.activeId === task.id) throw new UserFacingError('任务正在运行、已经完成或取消，不能启动');
    if (task.items.some(i => i.status !== 'DONE' && !submitted(this.amazon.getDraft(i.draftId)))) this.profile(task);
    for (const item of task.items) if (item.status !== 'DONE') this.current(item, !submitted(this.amazon.getDraft(item.draftId)));
    return structuredClone(task);
  }
  startAuthorized(approved: ExecutionTask): ExecutionTask {
    const task = this.task(approved.id);
    if (fingerprint(task) !== fingerprint(approved)) throw new UserFacingError('确认期间任务已变化，请重新启动');
    this.prepareStart(task.id); task.status = 'QUEUED'; task.error = null; this.grants.add(task.id); this.save(task);
    if (!this.worker) this.worker = this.runQueue().finally(() => { this.worker = null; });
    return structuredClone(task);
  }
  pause(id: string): ExecutionTask {
    const task = this.task(id); if (terminal(task)) throw new UserFacingError('已结束任务不能暂停');
    task.status = 'PAUSED'; this.grants.delete(id); this.save(task); return structuredClone(task);
  }
  cancel(id: string): ExecutionTask {
    const task = this.task(id); if (task.status === 'COMPLETED') throw new UserFacingError('已经完成的任务不能取消');
    task.status = 'CANCELLED'; this.grants.delete(id); if (this.activeId === id) this.controller?.abort(); this.save(task); return structuredClone(task);
  }
  private running(task: ExecutionTask): boolean { return !this.closing && task.status === 'RUNNING' && this.grants.has(task.id); }
  private async runQueue(): Promise<void> {
    for (;;) {
      const task = [...this.tasks.values()].find(t => t.status === 'QUEUED' && this.grants.has(t.id)); if (!task || this.closing) return;
      this.activeId = task.id; this.controller = new AbortController(); task.status = 'RUNNING'; this.save(task);
      try {
        let next = 0;
        const work = async () => {
          while (this.running(task)) {
            // Claim synchronously before yielding so each worker owns a distinct SKU.
            const item = task.items[next++]; if (!item) return;
            if (item.status !== 'DONE') await this.runItem(task, item);
          }
        };
        // Even an unexpected worker failure must not release the active batch or
        // let close() dispose the database while another worker is still saving.
        const outcomes = await Promise.allSettled(Array.from({ length: Math.min(task.concurrency, task.items.length) }, () => work()));
        const failed = outcomes.find(result => result.status === 'rejected');
        if (failed) task.error = publicError(failed.reason);
        if (this.running(task)) {
          task.status = !failed && task.items.every(i => i.status === 'DONE') ? 'COMPLETED' : 'NEEDS_ATTENTION'; this.save(task);
        }
      } finally { this.grants.delete(task.id); this.activeId = null; this.controller = null; }
    }
  }
  private async runItem(task: ExecutionTask, item: ExecutionItem): Promise<void> {
    let step: ExecutionStep | undefined;
    try {
      item.status = 'RUNNING'; this.save(task);
      if(!submitted(this.amazon.getDraft(item.draftId))){
        const current=this.current(item),cleanup=cleanHaulAttributes(current.listingProgram,current.attributes);
        if(cleanup.removed.length){
          item.intendedAttributesHash=fingerprint(cleanup.attributes);this.save(task);
          const saved=this.amazon.saveDraft({...ref(current),attributes:current.attributes});
          item.draftRevision=saved.revision;item.attributesHash=fingerprint(saved.attributes);item.intendedAttributesHash=null;this.save(task);
        }
      }
      const beforeUpload = this.amazon.getDraft(item.draftId);
      if (!submitted(beforeUpload) && item.steps.find(value => value.name === 'upload')?.status !== 'DONE') {
        const draft = this.current(item);
        if (validateAttributes(draft.schema.schema, draft.attributes, draft.schema.metaSchema).some(issue => issue.severity === 'ERROR' && !isDeferredImageIssue(draft,issue,item.assets.length))) {
          step = item.steps.find(value => value.name === 'validate')!;
          step.attempts++;
          const checked = await this.amazon.validateDraft(ref(draft)); item.listingState = checked.state;
          throw new UserFacingError('本地校验未通过，尚未上传图片；请在草稿中查看问题，修正后建立新任务');
        }
      }
      for (step of item.steps) {
        if (!this.running(task)) break;
        if (step.status === 'DONE' || step.status === 'SKIPPED') continue;
        if (item.mode === 'live' && ['preview', 'submit', 'readback'].includes(step.name)) {
          // Preserve the existing transport's sequential rate checks while SKU
          // preparation/uploads run concurrently. Preview and submit share a rate bucket.
          const previous = this.liveStepTail; let release = () => {};
          this.liveStepTail = new Promise<void>(resolve => { release = resolve; });
          await previous;
          try { await this.runStep(task, item, step); } finally { release(); }
        } else {
          await this.runStep(task, item, step);
        }
      }
      if (item.steps.every(s => s.status === 'DONE' || s.status === 'SKIPPED')) { item.status = 'DONE'; this.save(task); }
    } catch (error) {
      if (step) { step.status = 'FAILED'; step.error = publicError(error); }
      item.status = 'FAILED'; task.error = publicError(error); this.save(task);
    }
  }
  private async runStep(task: ExecutionTask, item: ExecutionItem, step: ExecutionStep): Promise<void> {
    // A live step may have waited behind another SKU. Check scope only after its
    // turn is acquired, so stopped tasks and changed drafts cannot send stale work.
    if (!this.running(task)) return;
    if (step.name !== 'readback' && !submitted(this.amazon.getDraft(item.draftId))) this.profile(task);
    const draft = this.current(item, step.name !== 'readback' && !submitted(this.amazon.getDraft(item.draftId)));
    // An accepted or uncertain write must only be read back, never repeated.
    if (step.name !== 'readback' && submitted(draft)) {
      step.status = step.name === 'submit' && item.submitStarted ? 'DONE' : 'SKIPPED';
      step.error = step.status === 'SKIPPED' ? '草稿已提交，本任务仅回读；此步骤未执行' : null;
      item.listingState = draft.state; this.save(task); return;
    }
    if (step.name === 'submit' && item.submitStarted) {
      if(this.amazon.wasSubmissionRejected(item.draftId)){item.submitStarted=false;this.save(task);throw new UserFacingError('Amazon 已明确拒绝提交，需按返回字段修复后重新预览');}
      throw new UserFacingError('此提交步骤曾中断或失败，禁止自动重放；请人工核对后建立新任务');
    }
    step.status = 'RUNNING'; step.attempts++; step.error = null; this.save(task);
    await this.execute(task, item, step, draft);
    step.status = 'DONE'; this.save(task);
  }
  private async verifyImages(task: ExecutionTask, item: ExecutionItem): Promise<void> {
    if (item.uploads.length !== item.assets.length) throw new UserFacingError('图片托管记录不完整');
    for (const upload of item.uploads) {
      const verified = await this.hosting.verify(upload.uploadId, this.controller?.signal);
      if (verified.status !== 'AVAILABLE' || verified.profileId !== task.profileId || verified.generation !== task.profileGeneration
        || verified.assetId !== upload.assetId || verified.sha256 !== upload.sha256 || verified.publicUrl !== upload.publicUrl) throw new UserFacingError('图片外链验证失败，任务已转人工处理');
    }
  }
  private async execute(task: ExecutionTask, item: ExecutionItem, step: ExecutionStep, draft: AmazonDraft): Promise<void> {
    if (step.name === 'upload') {
      for (const asset of item.assets) {
        if (!this.running(task)) throw new UserFacingError('任务已暂停或取消');
        this.current(item);
        const hosted = await this.hosting.upload({ assetId: asset.id, profileId: task.profileId, generation: task.profileGeneration, batchId: task.id }, this.controller?.signal);
        if (hosted.status !== 'AVAILABLE' || hosted.assetId !== asset.id || hosted.sha256 !== asset.sha256 || hosted.profileId !== task.profileId || hosted.generation !== task.profileGeneration) throw new UserFacingError('图片尚未完成托管验证');
        item.uploads = item.uploads.filter(u => u.assetId !== asset.id);
        item.uploads.push({ assetId: asset.id, uploadId: hosted.id, sha256: hosted.sha256, publicUrl: hosted.publicUrl }); this.save(task);
      }
      return;
    }
    if (step.name === 'images') {
      const attributes = cleanHaulAttributes(draft.listingProgram,hostedAttributes(draft, item)).attributes, nextHash = fingerprint(attributes);
      if (nextHash !== item.attributesHash) {
        item.intendedAttributesHash = nextHash; this.save(task);
        const saved = this.amazon.saveDraft({ ...ref(draft), attributes }); item.draftRevision = saved.revision; item.attributesHash = fingerprint(saved.attributes); item.intendedAttributesHash = null; this.save(task);
      }
      return;
    }
    if (step.name === 'validate') {
      const result = await this.amazon.validateDraft(ref(draft)); item.listingState = result.state;
      if (result.state !== 'LOCAL_VALIDATED') throw new UserFacingError('本地校验未通过，请在草稿中查看问题；修正后建立新任务'); return;
    }
    if (step.name === 'preview') {
      await this.verifyImages(task, item); if (!this.running(task)) throw new UserFacingError('任务已暂停或取消');
      this.current(item); const result = await this.amazon.previewDraft(ref(draft)); item.listingState = result.state;
      if (result.state !== 'AMAZON_VALIDATED') throw new UserFacingError('Amazon 预览未通过，请在草稿中查看问题'); return;
    }
    if (step.name === 'submit') {
      await this.verifyImages(task, item); if (!this.running(task)) throw new UserFacingError('任务已暂停或取消');
      this.profile(task); this.current(item);
      if (!draft.previewedAt || Date.now() - Date.parse(draft.previewedAt) > 14 * 60_000) {
        draft = await this.amazon.previewDraft(ref(draft));
        if (!this.running(task) || draft.state !== 'AMAZON_VALIDATED') throw new UserFacingError('任务已暂停或预览未通过');
      }
      // Native confirmation approved this frozen whole-task scope, not a renderer boolean.
      item.submitStarted = true; this.save(task);
      let result: AmazonDraft;
      try {
        result = await this.amazon.submitDraft(ref(draft), true, () => {
          if (!this.running(task)) throw new UserFacingError('任务已暂停或取消');
          this.profile(task); this.current(item);
        });
      } catch (error) {
        // The write intent is persisted as SUBMITTING before any network write.
        // Still-validated means the preflight guard stopped it before that intent.
        if (this.amazon.getDraft(item.draftId).state === 'AMAZON_VALIDATED' || error instanceof TaskWriteNotSentError) {
          item.submitStarted = false;
          item.steps.find(s => s.name === 'preview')!.status = 'PENDING';
        }
        throw error;
      }
      item.listingState = result.state;
      if(!submitted(result)&&this.amazon.wasSubmissionRejected(item.draftId)){item.submitStarted=false;this.save(task);}
      if (!submitted(result)) throw new UserFacingError('Amazon 未接受提交，请人工处理'); return;
    }
    if (item.mode === 'live' && this.dependencies.scheduleFollowup) {
      await this.dependencies.scheduleFollowup(draft.id); item.listingState = draft.state;
      if (!draft.submittedAt || ['UNKNOWN','SUBMITTING'].includes(draft.state)) throw new UserFacingError('提交结果未知；已保留待核对记录，禁止自动重放');
      return;
    }
    const result = await this.amazon.readListing(ref(draft)); item.listingState = result.state;
    if (!['BUYABLE','DISCOVERABLE'].includes(result.state)) throw new UserFacingError(result.state === 'UNKNOWN' ? '提交结果未知；已回读但仍不能证明写入结果，禁止自动重放' : 'Amazon 尚未确认可售或可见，请稍后重试回读或处理返回问题');
  }
  async waitForIdle(): Promise<void> { await this.worker; }
  async close(): Promise<void> {
    if (this.closed) return; this.closing = true;
    for (const task of this.tasks.values()) if (['RUNNING','QUEUED'].includes(task.status)) { task.status = 'PAUSED'; this.save(task); }
    this.grants.clear(); this.controller?.abort(); await this.worker; this.db.close(); this.closed = true;
  }
}
