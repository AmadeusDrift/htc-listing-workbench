import type { ReactNode } from 'react';
import { CheckCircle2, CircleMinus, CircleX, Info, TriangleAlert } from 'lucide-react';

export type SettingsStatusTone = 'success' | 'neutral' | 'info' | 'warning' | 'danger';
const icons = { success: CheckCircle2, neutral: CircleMinus, info: Info, warning: TriangleAlert, danger: CircleX };

export function SettingsStatusBadge({ tone, children }: { tone: SettingsStatusTone; children: ReactNode }) {
  const Icon = icons[tone];
  return <span className={`settings-status-badge ${tone}`}><Icon size={14} aria-hidden="true" /><span>{children}</span></span>;
}
