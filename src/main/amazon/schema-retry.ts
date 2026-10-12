import type { SchemaSelection } from '../../shared/amazon-contracts.ts';
import { AiError } from '../ai/errors.ts';
/** Only a known transient failure of a Schema GET, never provider or authorization errors. */
export class SchemaTransientError extends AiError {
  readonly transientReason: 'NETWORK' | 'BODY_INCOMPLETE';
  selection?: SchemaSelection;
  constructor(reason: 'NETWORK' | 'BODY_INCOMPLETE') {
    super('OUTPUT_INVALID');this.message=reason==='NETWORK'?'Amazon Schema 下载失败或超时':'Amazon Schema 正文下载未完成或超时，内容未缓存；等待有限重试';
    this.name='SchemaTransientError';this.transientReason=reason;
  }
}
export const isSchemaTransientError=(error:unknown):error is SchemaTransientError=>error instanceof SchemaTransientError;

