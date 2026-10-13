import type { DatabaseSync } from 'node:sqlite';
import type { AiResult } from '../../shared/ai-contracts.ts';
import { validateAiResult,validateAiCall } from './validation.ts';
import { resultHasOwner } from './result-owner.ts';
import { AiError } from './errors.ts';

/** M07 owns the insert; the domain owner must link its recovery in this same transaction. */
export function recordRecoveredAiResult(db:DatabaseSync,raw:AiResult):AiResult{
  if(!db.isTransaction)throw new AiError('INVALID_CONFIG');
  const result=validateAiResult(raw),row=db.prepare('SELECT record_json FROM ai_calls WHERE id=?').get(result.callId);
  if(!result.localRecovery&&!result.fieldCandidateRecovery&&!result.imagePlanRecovery||!row||!resultHasOwner(result,validateAiCall(JSON.parse(String(row.record_json)))))throw new AiError('INVALID_CONFIG');
  db.prepare('INSERT INTO ai_results(id,record_json) VALUES(?,?)').run(result.id,JSON.stringify(result));return result;
}
