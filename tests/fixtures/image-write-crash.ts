import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageVersionService } from '../../src/main/image-versions/service.ts';
import { assertTestRoot, seedImage } from './image-write-fixture.ts';

const root = assertTestRoot(process.argv[2]), checkpoint = process.argv[3], f = await seedImage(root);
await writeFile(join(root, 'context.json'), JSON.stringify({ product: f.product, asset: f.asset, result: f.result, input: f.input }));
const service = new ImageVersionService(root, f.store, { listResults: () => [f.result] }, {
  decode: f.decode, download: async () => f.output,
  checkpoint: point => { if (point === checkpoint) process.exit(73); },
});
try { await service.save(f.input); } finally { await service.close(); f.store.close(); }
