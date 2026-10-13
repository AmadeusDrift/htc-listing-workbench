import { createHash } from 'node:crypto';
/** Preserve the historical JSON insertion order exactly; no canonicalization. */
export const listingFingerprint=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
