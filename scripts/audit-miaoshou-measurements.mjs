import { readFile, writeFile } from 'node:fs/promises';
import { analyzeMiaoshouMeasurements } from '../src/shared/miaoshou-measurements.ts';

// Offline replay of the previous whitelisted API audit; no credentials, transport, or workspace writes.
const directory = new URL('../artifacts/miaoshou-api-field-audit-2026-10-07/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'));
const audit = await read('audit.json'), text = await read('text-evidence.json');
const started = performance.now();
const products = audit.products.filter(p => p.normalized).map(p => {
  const t = text.products.find(t => t.id === p.remoteId);
  if (!t?.success) throw new Error(`Missing text evidence for ${p.remoteId}`);
  const snapshot = { remoteId: p.remoteId, title: p.title, description: t.description, detailText: t.htmlDescriptionText,
    capturedAt: text.date, attributes: t.attributes, sources: t.sources, images: [], warnings: [], skus: p.skus,
    dimensions: p.dimensions.map(d => ({ ...d, values: d.values.map(v => ({ id: v.id, name: v.name, imageUrls: [] })) })) };
  const report = analyzeMiaoshouMeasurements(snapshot);
  return { id: p.remoteId, title: p.title, skuCount: report.skus.length,
    itemDimensions: report.skus.filter(s => ['item.length', 'item.width', 'item.height'].some(f => s.values[f])).length,
    packageDimensions: report.skus.filter(s => ['package.length', 'package.width', 'package.height'].every(f => s.values[f])).length,
    itemWeight: report.skus.filter(s => s.values['item.weight']).length,
    packageWeight: report.skus.filter(s => s.values['package.weight']).length,
    contentWeight: report.skus.filter(s => s.values['content.weight']).length,
    skus: report.skus.map(s => ({ sourceKey: s.sourceKey, specification: s.specification,
      values: Object.fromEntries(Object.entries(s.values).map(([field, e]) => [field, { value: e.value, unit: e.unit, sourceValue: e.sourceValue, sourceUnit: e.sourceUnit, inferredUnit: e.inferredUnit, evidence: e.evidence }])),
      missingPackageFields: s.missingPackageFields, warnings: [...new Set(s.evidence.filter(e => !['usable', 'inferred', 'superseded'].includes(e.status)).map(e => e.reason))] })) };
});
const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
const sum = field => products.reduce((sum, p) => sum + p[field], 0);
const summary = { products: products.length, skus: sum('skuCount'), itemDimensions: sum('itemDimensions'), packageDimensions: sum('packageDimensions'), itemWeight: sum('itemWeight'), packageWeight: sum('packageWeight'), contentWeight: sum('contentWeight'), elapsedMs };
await writeFile(new URL('measurement-replay.json', directory), JSON.stringify({ generatedAt: new Date().toISOString(), method: 'Offline text extraction; not live API/OCR or Amazon validation', summary, products }, null, 2) + '\n');
console.log(JSON.stringify({ summary, products: products.map(({ skus, ...p }) => p) }, null, 2));
