/** A 1688 offer link identifies the purchased product, not the supplier's shop. */
export function sourceProductUrl(source: { source: string; sourceItemId: string; sourceItemUrl: string }): string {
  if (source.source.trim() !== '1688') return '';
  const id = source.sourceItemId.trim(), raw = source.sourceItemUrl.trim();
  if (id && !/^[1-9]\d{4,19}$/.test(id)) return '';
  if (!raw) return id ? `https://detail.1688.com/offer/${id}.html` : '';
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || /[\\\s]/.test(raw)) return '';
    if (!['detail.1688.com', 'm.1688.com'].includes(url.hostname)) return '';
    const matched = /^\/offer\/([1-9]\d{4,19})\.html$/.exec(url.pathname);
    if (!matched || id && matched[1] !== id) return '';
    return `https://detail.1688.com/offer/${matched[1]}.html`;
  } catch { return ''; }
}
