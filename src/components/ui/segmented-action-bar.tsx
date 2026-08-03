"use client"

import type { LucideIcon } from 'lucide-react';

export interface SegmentedAction {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  tone?: 'default' | 'accent' | 'danger' | 'success';
  disabled?: boolean;
}

const TONE: Record<NonNullable<SegmentedAction['tone']>, string> = {
  default: 'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] hover:bg-white/[.03]',
  accent: 'text-[color:var(--accent)] hover:bg-blue-500/10',
  danger: 'text-red-400 hover:bg-red-500/10',
  success: 'text-emerald-400 hover:bg-emerald-500/10',
};

/**
 * Barre d'actions segmentée — pied commun des drawers de détail, formulaires
 * et confirmations : cellules égales, icône 16px au-dessus d'un libellé 11px uppercase.
 */
export function SegmentedActionBar({ items, className = '' }: { items: SegmentedAction[]; className?: string }) {
  return (
    <div className={`flex rounded-[14px] border border-[color:var(--border-subtle)] overflow-hidden bg-[color:var(--bg-card)] ${className}`}>
      {items.map((a, i) => (
        <button
          key={a.label}
          type="button"
          disabled={a.disabled}
          onClick={a.onClick}
          className={`flex-1 flex flex-col items-center gap-1.5 py-3.5 text-[11px] font-semibold uppercase tracking-wider transition-colors disabled:opacity-50 disabled:pointer-events-none ${i > 0 ? 'border-l border-[color:var(--border-subtle)]' : ''} ${TONE[a.tone ?? 'default']}`}
        >
          <a.icon className="w-4 h-4" />
          {a.label}
        </button>
      ))}
    </div>
  );
}
