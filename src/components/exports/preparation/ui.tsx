"use client"

/**
 * Petits éléments visuels de l'écran de préparation, alignés sur le système
 * de design de l'application : pastilles « lavis + bordure + texte clair »
 * portées par les variables sémantiques (lisibles dans les deux thèmes),
 * sur-titres en capitales espacées, numéros de section façon PDF.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type Tone = 'warning' | 'danger' | 'success' | 'info' | 'neutral';

export const TONE: Record<Tone, string> = {
  warning: 'bg-[var(--bg-warning)] border-[color:var(--border-warning)] text-[color:var(--text-warning)]',
  danger: 'bg-[var(--bg-danger)] border-[color:var(--border-danger)] text-[color:var(--text-danger)]',
  success: 'bg-[var(--bg-success)] border-[color:var(--border-success)] text-[color:var(--text-success)]',
  info: 'bg-[var(--bg-info)] border-[color:var(--border-info)] text-[color:var(--text-info)]',
  neutral: 'bg-[var(--accent-soft)] border-border text-muted-foreground',
};

/** Pastille de statut (capsule, 11 px). */
export function Pill({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap [&>svg]:size-3', TONE[tone], className)}>
      {children}
    </span>
  );
}

/** Sur-titre (« DOSSIER PRÊT À L'EMPLOI »). */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-[10px] font-semibold uppercase tracking-[.08em] text-muted-foreground', className)}>{children}</p>;
}

/** Encadré de message (alerte, information). */
export function Callout({ tone, icon, children, role, className }: { tone: Tone; icon?: ReactNode; children: ReactNode; role?: 'alert' | 'status'; className?: string }) {
  return (
    <div role={role} className={cn('flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] leading-snug', TONE[tone], className)}>
      {icon && <span className="mt-px shrink-0 [&>svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Tuile de format (« PDF », « DOCX ») à la place d'une miniature. */
export function FormatTile({ format, className }: { format: string | null; className?: string }) {
  const f = (format ?? 'FICHIER').toUpperCase().slice(0, 4);
  const tone = f === 'PDF' ? 'text-[color:var(--text-danger)]' : ['JPG', 'JPEG', 'PNG', 'WEBP', 'HEIC'].includes(f) ? 'text-[color:var(--text-info)]' : 'text-muted-foreground';
  return (
    <span aria-hidden className={cn('flex h-10 w-9 shrink-0 items-end justify-center rounded-md border border-border bg-[var(--accent-soft)] pb-1 font-mono text-[9px] font-bold tracking-wide', tone, className)}>
      {f}
    </span>
  );
}

export const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
};

export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
};
