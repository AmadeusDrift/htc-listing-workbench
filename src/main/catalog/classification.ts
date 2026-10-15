import type { ProductTypeOption } from '../../shared/amazon-contracts.ts';
import type { CategoryDecision, ProductClassification } from '../../shared/category-ai-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { categoryCandidateSnapshot } from '../ai/category-context.ts';
import { candidateRelevance, rankCategoryCandidates } from './candidate-ranking.ts';
import type { CandidateHit } from './candidate-ranking.ts';
import { validateCategoryDecision } from '../ai/category-adapter.ts';

export interface ClassificationInput { productId: string; productRevision: number; targetId: string }
interface DecisionResult { id: string; callId?:string; output: CategoryDecision }
/** Valid domain result, with no adopted platform type. Not permission for another request. */
export class CategoryNoSuitableError extends UserFacingError {
  readonly code='CATEGORY_NO_SUITABLE';
  readonly stage='CLASSIFY';
  readonly certainty='RECEIVED_VALID';
  readonly decisionId:string;readonly callId:string;readonly candidateSnapshotSha256:string;
  constructor(decisionId:string,callId:string,candidateSnapshotSha256:string){
    super('本次候选无适用商品类型，需要人工确认类目；未获取类型 Schema 或创建草稿');
    this.decisionId=decisionId;this.callId=callId;this.candidateSnapshotSha256=candidateSnapshotSha256;
  }
}
export interface ClassificationDependencies {
  keywords(input: ClassificationInput): Promise<DecisionResult>;
  /** Main-only full local library. UI search retains its separate fifty-result cap. */
  localCandidates?(targetId:string): ProductTypeOption[];
  search(targetId: string, query: string): ProductTypeOption[];
  fallback(targetId: string, query: string): Promise<ProductTypeOption[]>;
  choose(input: ClassificationInput & { candidates: ProductTypeOption[]; keywords: string[] }, phase: 'select' | 'judge'): Promise<DecisionResult>;
}
/** Classification runs for one product, before reading that product's Schema. */
export async function classifyProduct(input: ClassificationInput, deps: ClassificationDependencies): Promise<ProductClassification> {
  const first = await deps.keywords(input), keywords = first.output.keywords;
  if (!keywords.length) throw new UserFacingError('模型未返回可用的商品分类关键词');
  const hits:CandidateHit[]=[];
  const library=deps.localCandidates?.(input.targetId);
  for (const keyword of keywords) for (const candidate of library??deps.search(input.targetId, keyword)) {
    if(!library||candidateRelevance(candidate,keyword).score>0)hits.push({candidate,keyword,source:'local'});
  }
  if (!hits.length) for (const candidate of await deps.fallback(input.targetId, keywords.slice(0, 3).join(' '))) hits.push({candidate,keyword:keywords.slice(0,3).join(' '),source:'platform'});
  if (!hits.length) throw new UserFacingError('类目库和平台检索均未返回可用商品类型');
  const shortlist = rankCategoryCandidates(hits);
  const assertSelection=(result:DecisionResult,phase:'select'|'judge')=>{
    const decision=validateCategoryDecision(result.output);
    if(decision.phase!==phase)throw new UserFacingError('分类阶段与本次候选请求不匹配');
    if(decision.selection&&decision.selection.candidateSnapshotSha256!==categoryCandidateSnapshot(shortlist))throw new UserFacingError('分类结果与本次候选快照不匹配，请查看商品分类异常');
    if(decision.selection?.outcome==='NO_SUITABLE'){
      const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      if(!uuid.test(result.id)||!result.callId||!uuid.test(result.callId))throw new UserFacingError('分类无适用结果缺少原调用和结果身份，请核对本次候选请求');
      throw new CategoryNoSuitableError(result.id,result.callId,decision.selection.candidateSnapshotSha256);
    }
  };
  let choice = await deps.choose({ ...input, keywords, candidates: shortlist }, 'select');
  assertSelection(choice,'select');
  const decisionIds = [first.id, choice.id], judged = choice.output.ambiguous;
  if (judged) {
    // Judge sees original evidence and the candidates, not a score to rubber-stamp.
    choice = await deps.choose({ ...input, keywords, candidates: shortlist }, 'judge');
    decisionIds.push(choice.id);
    assertSelection(choice,'judge');
  }
  const productType = choice.output.productType;
  if (!productType || !shortlist.some(candidate => candidate.name === productType)) throw new UserFacingError('分类结果不属于实际候选商品类型，请查看商品分类异常');
  return { productType, reason: choice.output.reason, keywords, candidateTypes: shortlist.map(candidate => candidate.name), decisionIds, judged, classifiedAt: new Date().toISOString() };
}
