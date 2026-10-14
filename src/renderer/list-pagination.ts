export const PAGE_SIZES = [20, 50, 100] as const;
export function normalizePageSize(value: unknown): number { const size = Number(value); return PAGE_SIZES.some(n => n === size) ? size : 20; }
export function pageWindow(count: number, size: number, requested: number) { const pages = Math.max(1, Math.ceil(count / size)), page = Math.max(1, Math.min(requested, pages)); return { page, pages, start: (page - 1) * size, end: page * size }; }
