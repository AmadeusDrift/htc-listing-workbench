import type { AutomaticImageCandidatePreview, ImageWorkflowRun } from '../../shared/image-workflow-contracts.ts';
import type { ImageGenerationService } from '../image-generation/service.ts';
import { UserFacingError } from '../../shared/errors.ts';
import { integer, keys, uuid } from '../ai/validation.ts';

/** Only saved, validated local candidates belonging to this draft's slot may be previewed. */
export async function readWorkflowCandidatePreview(raw: unknown, getProgress: (draftId: string) => ImageWorkflowRun | null, readCandidate: ImageGenerationService['readCandidate']): Promise<AutomaticImageCandidatePreview> {
  const input = keys(raw, ['draftId', 'slot', 'candidateId']);
  const draftId = uuid(input.draftId), index = integer(input.slot, 1, 7), candidateId = uuid(input.candidateId);
  const ownsCandidate = (run: ImageWorkflowRun | null) => run?.draftId === draftId && run.slots?.some(slot => slot.index === index && slot.attempts.some(attempt => attempt.candidateId === candidateId));
  const run = getProgress(draftId);
  if (!run || !ownsCandidate(run)) throw new UserFacingError('图片候选记录已变化，请刷新后查看');
  const local = await readCandidate(candidateId), current = getProgress(draftId);
  if (!current || current.id !== run.id || !ownsCandidate(current) || local.candidate.id !== candidateId || local.candidate.productId !== run.productId || local.candidate.productRevision !== run.productRevision) {
    throw new UserFacingError('图片候选记录已变化，请刷新后查看');
  }
  return { candidateId, previewUrl: `data:image/png;base64,${local.preview.toString('base64')}`, width: local.candidate.width, height: local.candidate.height };
}
