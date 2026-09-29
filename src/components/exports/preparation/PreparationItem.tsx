"use client"

/**
 * Élément sélectionnable de l'écran de préparation — CDC V12 §5.2
 * (PREP-ITEM, PREP-DOC, PREP-SENSITIVE), §22.4 (PREP-ITE-001 à 015).
 *
 * Document : case, libellé, type, date, format, taille, source (infobulle),
 * sensibilité (« Sensible », discret, jamais bloquant — MSG-PREP-003),
 * compatibilité, mode PDF / ZIP (un format non intégrable n'offre que le ZIP :
 * bascule automatique, DEC-005), message d'erreur, aperçu et « Voir ».
 * Photo : vignette choisie une par une. Événement : date, titre, nature.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { AlertCircle, Eye, ImageOff, ShieldAlert } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { formatBytes, type ItemState } from '@/lib/exports/preparation-state';
import { PREP_MESSAGES } from '@/services/exports/v12/preparation/messages';
import type { ItemMode, PrepItem } from '@/services/exports/v12/preparation/types';
import { FormatTile, Pill, formatDate } from './ui';

interface ItemProps {
  item: PrepItem;
  state: ItemState | undefined;
  disabled: boolean;
  onToggle: (key: string, selected: boolean) => void;
  onMode: (key: string, mode: ItemMode) => void;
  viewUrl: (fileId: number) => Promise<string | null>;
}

const MODES = ['PDF', 'ZIP'] as const;

/** Choix PDF / ZIP d'une pièce retenue (PREP-ITE-008 / 009). */
export function ModeToggle({ item, mode, disabled, onMode, compact = false }: { item: PrepItem; mode: ItemMode | null; disabled: boolean; onMode: (m: ItemMode) => void; compact?: boolean }) {
  if (item.allowedModes.length === 1 && item.allowedModes[0] === 'ZIP') {
    return (
      <Pill tone="info" title="Ce format ne peut pas être intégré au PDF : la pièce est jointe au ZIP.">
        ZIP{compact ? '' : ' · format non intégrable'}
      </Pill>
    );
  }
  return (
    // Groupe radio (WAI-ARIA) : une seule option dans l'ordre de tabulation
    // (la cochée), flèches pour changer de destination.
    <div
      role="radiogroup"
      aria-label={`Destination de « ${item.label} »`}
      aria-disabled={disabled || undefined}
      className="inline-flex shrink-0 rounded-full border border-border bg-[var(--accent-soft)] p-0.5"
      onKeyDown={(e) => {
        if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const opts = MODES.filter((m) => item.allowedModes.includes(m));
        if (opts.length < 2) return;
        const i = Math.max(0, opts.indexOf(mode ?? opts[0]));
        const next = e.key === 'Home' ? opts[0] : e.key === 'End' ? opts[opts.length - 1]
          : opts[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? opts.length - 1 : 1)) % opts.length];
        onMode(next);
        (e.currentTarget.querySelector(`[data-mode="${next}"]`) as HTMLButtonElement | null)?.focus();
      }}
    >
      {MODES.map((m) => {
        const allowed = item.allowedModes.includes(m);
        const checked = (mode ?? item.allowedModes[0]) === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            data-mode={m}
            aria-checked={checked}
            tabIndex={checked && !disabled ? 0 : -1}
            disabled={disabled || !allowed}
            onClick={() => onMode(m)}
            title={m === 'PDF' ? 'Intégrée au PDF, dans les annexes' : 'Jointe au ZIP, dossier /documents ou /photos'}
            className={cn(
              'rounded-full font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50',
              compact ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]',
              checked ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}

/** Aperçu miniature chargé à l'approche de l'écran (PREP-ITE-014). */
export function FileThumb({ fileId, alt, viewUrl, className }: { fileId: number | null; alt: string; viewUrl: (id: number) => Promise<string | null>; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (fileId == null || !ref.current) return;
    let cancelled = false;
    const load = () => { viewUrl(fileId).then((u) => { if (!cancelled) { if (u) setSrc(u); else setFailed(true); } }).catch(() => !cancelled && setFailed(true)); };
    if (typeof IntersectionObserver === 'undefined') { load(); return () => { cancelled = true; }; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(); } }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => { cancelled = true; io.disconnect(); };
  }, [fileId, viewUrl]);
  return (
    <div ref={ref} className={cn('relative overflow-hidden bg-[var(--accent-soft)]', className)}>
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground/60">
          {failed ? <ImageOff className="size-5" aria-hidden /> : <span className="size-5 animate-pulse rounded bg-muted-foreground/20" aria-hidden />}
        </div>
      )}
    </div>
  );
}

/** Bouton « Voir » (PREP-ITE-015) : ouvre le fichier dans un nouvel onglet. */
function ViewButton({ item, viewUrl }: { item: PrepItem; viewUrl: ItemProps['viewUrl'] }) {
  const [busy, setBusy] = useState(false);
  if (item.fileId == null || item.compatibility === 'missing') return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // Onglet ouvert pendant le clic (sinon bloqué), puis dirigé vers l'URL signée.
        const w = window.open('about:blank', '_blank');
        if (w) w.opener = null;
        const url = await viewUrl(item.fileId!);
        setBusy(false);
        if (url && w) w.location.href = url; else w?.close();
      }}
      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground outline-none hover:bg-[var(--accent-soft)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Eye className="size-3.5" aria-hidden />Voir<span className="sr-only"> « {item.label} »</span>
    </button>
  );
}

function metaLine(item: PrepItem): string {
  return [item.typeLabel, formatDate(item.date), item.format, item.sizeBytes != null ? formatBytes(item.sizeBytes) : null, item.detail]
    .filter(Boolean).join(' · ');
}

/** Document (PREP-DOC). */
export const DocumentRow = memo(function DocumentRow({ item, state, disabled, onToggle, onMode, viewUrl }: ItemProps) {
  const id = `prep-${item.key.replace(':', '-')}`;
  const selected = !!state?.selected;
  return (
    <li className={cn('flex items-start gap-3 px-4 py-3 transition-colors', selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--accent-soft)]/60')}>
      <Checkbox
        id={id}
        className="mt-2.5"
        checked={selected}
        disabled={disabled || !item.selectable}
        onCheckedChange={(v) => onToggle(item.key, v === true)}
        aria-describedby={`${id}-meta${item.error ? ` ${id}-err` : ''}`}
      />
      <FormatTile format={item.format} />
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className={cn('block truncate text-sm font-medium', item.selectable ? 'cursor-pointer' : 'text-muted-foreground')}>{item.label}</label>
        <p id={`${id}-meta`} className="mt-0.5 truncate text-xs text-muted-foreground" title={`Source : ${item.source}`}>
          {metaLine(item)}<span className="sr-only"> — source : {item.source}</span>
        </p>
        {(item.sensitive || item.recommended || item.compatibility === 'zip_only') && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {item.sensitive && (
              <Pill tone="warning" title="Pièce personnelle : jamais pré-cochée, à inclure seulement si vous le souhaitez.">
                <ShieldAlert aria-hidden />{PREP_MESSAGES['MSG-PREP-003']}
              </Pill>
            )}
            {item.recommended && <Pill tone="neutral">Recommandé</Pill>}
          </div>
        )}
        {item.error && (
          <p id={`${id}-err`} className="mt-1.5 flex items-center gap-1 text-xs text-[color:var(--text-danger)]">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden />{item.error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center">
        {item.selectable && (selected || item.compatibility === 'zip_only') && (
          <ModeToggle item={item} mode={state?.mode ?? item.mode} disabled={disabled || !selected} onMode={(m) => onMode(item.key, m)} />
        )}
        <ViewButton item={item} viewUrl={viewUrl} />
      </div>
    </li>
  );
});

/** Photo choisie une par une. */
export const PhotoTile = memo(function PhotoTile({ item, state, disabled, onToggle, onMode, viewUrl }: ItemProps) {
  const id = `prep-${item.key.replace(':', '-')}`;
  const selected = !!state?.selected;
  return (
    <li className={cn('group relative overflow-hidden rounded-xl border bg-card transition-shadow', selected ? 'border-primary/70 ring-1 ring-primary/60' : 'border-border')}>
      <label htmlFor={id} className="block cursor-pointer">
        <FileThumb fileId={item.fileId} alt={item.label} viewUrl={viewUrl} className="aspect-[4/3] w-full" />
        <span className="absolute left-2 top-2 rounded-md bg-black/55 p-1 backdrop-blur-sm">
          <Checkbox id={id} checked={selected} disabled={disabled || !item.selectable} onCheckedChange={(v) => onToggle(item.key, v === true)} aria-describedby={`${id}-meta`} />
        </span>
        {item.detail && <span className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">{item.detail}</span>}
      </label>
      <div className="space-y-1.5 px-2.5 py-2">
        <p className="truncate text-xs font-medium" title={item.label}>{item.label}</p>
        <div className="flex items-center gap-2">
          <p id={`${id}-meta`} className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={`Source : ${item.source}`}>
            {[formatDate(item.date), item.format].filter(Boolean).join(' · ')}
          </p>
          {item.selectable && selected && <ModeToggle item={item} mode={state?.mode ?? item.mode} disabled={disabled} onMode={(m) => onMode(item.key, m)} compact />}
        </div>
      </div>
      {item.error && <p className="px-2.5 pb-2 text-[11px] text-[color:var(--text-danger)]">{item.error}</p>}
    </li>
  );
});

/** Événement du suivi ou de l'agenda. */
export const EventRow = memo(function EventRow({ item, state, disabled, onToggle }: ItemProps) {
  const id = `prep-${item.key.replace(':', '-')}`;
  return (
    <li className={cn('flex items-center gap-3 px-4 py-2.5', state?.selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--accent-soft)]/60')}>
      <Checkbox id={id} checked={!!state?.selected} disabled={disabled} onCheckedChange={(v) => onToggle(item.key, v === true)} aria-describedby={`${id}-meta`} />
      <span className="w-[88px] shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{formatDate(item.date) || 'Sans date'}</span>
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block cursor-pointer truncate text-sm">{item.label}</label>
        <p id={`${id}-meta`} className="truncate text-xs text-muted-foreground" title={`Source : ${item.source}`}>
          {[item.typeLabel, item.detail, item.source].filter(Boolean).join(' · ')}
        </p>
      </div>
      {item.recommended && <Pill tone="neutral" className="hidden sm:inline-flex">Recommandé</Pill>}
    </li>
  );
});
