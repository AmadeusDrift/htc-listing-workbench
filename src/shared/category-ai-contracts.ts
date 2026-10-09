export interface CategoryDecision {
  kind: 'category-decision';
  phase: 'keywords' | 'select' | 'judge';
  keywords: string[];
  productType: string | null;
  reason: string;
  ambiguous: boolean;
}
export interface ProductClassification {
  productType: string; reason: string; keywords: string[]; candidateTypes: string[];
  decisionIds: string[]; judged: boolean; classifiedAt: string;
}
