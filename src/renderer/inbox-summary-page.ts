import type { MiaoshouInboxSummary } from '../shared/miaoshou-contracts.ts';

/** Keep IPC reads bounded and publish a page only after every batch succeeds. */
export async function loadInboxSummaryPage(
  productIds: string[],
  read: (input: { productIds: string[] }) => Promise<MiaoshouInboxSummary[]>,
  isActive: () => boolean,
): Promise<MiaoshouInboxSummary[] | null> {
  const rows: MiaoshouInboxSummary[] = [];
  for (let offset = 0; offset < productIds.length; offset += 50) {
    if (!isActive()) return null;
    const batch = await read({ productIds: productIds.slice(offset, offset + 50) });
    if (!isActive()) return null;
    rows.push(...batch);
  }
  return isActive() ? rows : null;
}
