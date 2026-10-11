/** Explicit historical v3 scope for tests of frozen finite evidence/normalization rules. */
import { buildListingContext as current } from '../../src/main/listing-ai/context.ts';
export { listingModelPayload } from '../../src/main/listing-ai/context.ts';
export const buildListingContext=(...args:Parameters<typeof current>)=>current(args[0],args[1],args[2],true);
import { ListingAiService } from '../../src/main/listing-ai/service.ts';
export class LegacyListingAiService extends ListingAiService {
  override currentContext(...args:Parameters<ListingAiService['currentContext']>){return super.currentContext(args[0],args[1],args[2],true);}
}
