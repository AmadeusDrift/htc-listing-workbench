import type {DatabaseSync} from 'node:sqlite';
import type {AiCall,AiResult} from '../../shared/ai-contracts.ts';
/** Main-only owner port. Callbacks are synchronous and borrow M07's physical transaction. */
export interface AiDurableRequestPort {
 fileId:string;
 reserve(db:DatabaseSync,call:AiCall):void;
 resultStored(db:DatabaseSync,result:AiResult):void;
 effect?(db:DatabaseSync,kind:import('../../shared/image-workflow-contracts.ts').ImageReviewRequestV2['effects'][number]['kind'],event:'permit'|'received',at:string):void;
}
