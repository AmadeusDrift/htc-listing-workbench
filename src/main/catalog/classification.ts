import type { ProductTypeOption } from '../../shared/amazon-contracts.ts';
import type { CategoryDecision, ProductClassification } from '../../shared/category-ai-contracts.ts';
import { UserFacingError } from '../../shared/errors.ts';

export interface ClassificationInput { productId: string; productRevision: number; targetId: string }
interface DecisionResult { id: string; output: CategoryDecision }
export interface ClassificationDependencies {
  keywords(input: ClassificationInput): Promise<DecisionResult>;
  search(targetId: string, query: string): ProductTypeOption[];
  fallback(targetId: string, query: string): Promise<ProductTypeOption[]>;
  choose(input: ClassificationInput & { candidates: ProductTypeOption[]; keywords: string[] }, phase: 'select' | 'judge'): Promise<DecisionResult>;
}
/** Classification runs for one product, before reading that product's Schema. */
export async function classifyProduct(input: ClassificationInput, deps: ClassificationDependencies): Promise<ProductClassification> {
  const first = await deps.keywords(input), keywords = first.output.keywords;
  if (!keywords.length) throw new UserFacingError('模型未返回可用的商品分类关键词');
  const candidates = new Map<string, ProductTypeOption>();
  for (const keyword of keywords) for (const candidate of deps.search(input.targetId, keyword)) candidates.set(candidate.name, candidate);
  if (!candidates.size) for (const candidate of await deps.fallback(input.targetId, keywords.slice(0, 3).join(' '))) candidates.set(candidate.name, candidate);
  if (!candidates.size) throw new UserFacingError('类目库和平台检索均未返回可用商品类型');
  const shortlist = [...candidates.values()].slice(0, 50);
  let choice = await deps.choose({ ...input, keywords, candidates: shortlist }, 'select');
  const decisionIds = [first.id, choice.id], judged = choice.output.ambiguous;
  if (judged) {
    // Judge sees original evidence and the candidates, not a score to rubber-stamp.
    choice = await deps.choose({ ...input, keywords, candidates: shortlist }, 'judge');
    decisionIds.push(choice.id);
  }
  const productType = choice.output.productType;
  if (!productType || !shortlist.some(candidate => candidate.name === productType)) throw new UserFacingError('分类结果不属于实际候选商品类型，请查看商品分类异常');
  return { productType, reason: choice.output.reason, keywords, candidateTypes: shortlist.map(candidate => candidate.name), decisionIds, judged, classifiedAt: new Date().toISOString() };
}
