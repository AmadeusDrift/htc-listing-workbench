import type { WorkspaceStore } from '../store.ts';
import { CollectionError } from './validation.ts';

/** Read-only compatibility owner. It has no socket, registration files or receive command. */
export class CollectionHistory {
  private store:Pick<WorkspaceStore,'getCollectionReceipt'>;private paused=false;private closed=false;
  constructor(store:Pick<WorkspaceStore,'getCollectionReceipt'>){this.store=store;}
  get busy(){return false;}
  getReceipt(productId:string){if(this.closed||this.paused)throw new CollectionError('APP_BUSY');return this.store.getCollectionReceipt(productId);}
  pauseForRestore():()=>void{if(this.closed)throw new CollectionError('APP_BUSY');this.paused=true;let released=false;return()=>{if(!released){released=true;this.paused=false;}};}
  async close(){this.closed=true;}
}
export type CollectionHistoryPort=Pick<CollectionHistory,'busy'|'getReceipt'|'pauseForRestore'|'close'>;
