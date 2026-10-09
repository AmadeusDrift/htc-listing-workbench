import { Box, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ProductSummary } from '../shared/contracts';

export function ProductThumb({ product }: { product: ProductSummary }) {
  return <span className="workspace-thumb">{product.coverUrl ? <img src={product.coverUrl} alt="" loading="lazy" /> : <Box size={24} strokeWidth={1.35} />}</span>;
}
export function WorkspaceEmpty({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="workspace-empty"><span className="workspace-empty-icon"><Inbox size={32} strokeWidth={1.3} /></span><h2>{title}</h2><p>{description}</p>{children && <div className="empty-actions">{children}</div>}</div>;
}
