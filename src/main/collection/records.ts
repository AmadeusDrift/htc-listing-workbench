import type { DatabaseSync } from 'node:sqlite';
import { CollectionError, validateCollectionCapture, validateCollectionReceipt } from './validation.ts';

/** Historical SKU mappings survive deletion; an ID still present must belong to the original product. */
export function assertCollectionHistory(db: DatabaseSync): void {
  const receipts = new Map(db.prepare('SELECT record_json FROM collection_receipts').all().map(row => { const value = validateCollectionReceipt(JSON.parse(String(row.record_json))); return [value.id, value] as const; }));
  const captures = new Map(db.prepare('SELECT record_json FROM collection_captures').all().map(row => { const value = validateCollectionCapture(JSON.parse(String(row.record_json))); return [value.id, value] as const; }));
  const fingerprints = new Set<string>(), products = new Set<string>(), variants = new Set<string>();
  const reject = () => { throw new CollectionError('INVALID_SNAPSHOT'); };
  for (const receipt of receipts.values()) {
    if (fingerprints.has(receipt.fingerprint) || products.has(receipt.productId) || !db.prepare('SELECT id FROM products WHERE id=?').get(receipt.productId)) reject();
    fingerprints.add(receipt.fingerprint); products.add(receipt.productId);
    const first = captures.get(receipt.firstCaptureId);
    if (!first || first.duplicate || first.receiptId !== receipt.id || first.receivedAt !== receipt.receivedAt || first.capturedAt !== receipt.snapshot.capturedAt) reject();
    for (const mapping of receipt.skuMappings) {
      if (variants.has(mapping.localVariantId)) reject(); variants.add(mapping.localVariantId);
      const current = db.prepare('SELECT product_id FROM variants WHERE id=?').get(mapping.localVariantId);
      if (current && current.product_id !== receipt.productId) reject();
    }
  }
  for (const capture of captures.values()) {
    const receipt = receipts.get(capture.receiptId);
    if (!receipt || capture.fingerprint !== receipt.fingerprint || capture.duplicate !== (capture.id !== receipt.firstCaptureId)) reject();
  }
}
