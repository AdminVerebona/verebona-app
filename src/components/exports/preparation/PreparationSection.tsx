"use client"

/**
 * Carte d'une section du PDF — CDC V12 §5.2 (PREP-SECTIONS,
 * PREP-SECTION-TOOLS), §22.2 (PREP-NAV-001 à 012), §22.3 (PREP-ZON-*).
 *
 * En-tête : numéro et titre de la section (ceux du PDF), description,
 * interrupteur (section optionnelle) ou « Toujours incluse » (section
 * obligatoire verrouillée), badges « Recommandée » et « Sensible »,
 * compteurs retenus / PDF / ZIP, développer / réduire (aria-expanded).
 * Outils : tout cocher (hors sensibles, SEL-GEN-008), tout décocher,
 * restaurer la recommandation. Contenu : éléments, formulaire des
 * informations complémentaires, blocs CIL, ou description du contenu.
 */

import type { ReactNode } from 'react';
import { ChevronDown, Lock, ShieldAlert, Sparkles } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { linkedStatus, sectionCounts, type PrepState } from '@/lib/exports/preparation-state';
import type { ItemMode, PrepSection } from '@/services/exports/v12/preparation/types';
import { DocumentRow, EventRow, PhotoTile } from './PreparationItem';
import { Pill } from './ui';

interface Props {
  section: PrepSection;
  no: string | null;
  state: PrepState;
  editable: boolean;
  expanded: boolean;
  photoCap: number;
  onExpand: (id: string, open: boolean) => void;
  onEnable: (id: string, enabled: boolean) => void;
  onAll: (id: string) => void;
  onNone: (id: string) => void;
  onRestore: (id: string) => void;
  onToggle: (key: string, selected: boolean) => void;
  onMode: (key: string, mode: ItemMode) => void;
  onSelectLinked: (keys: string[]) => void;
  viewUrl: (fileId: number) => Promise<string | null>;
  /** Formulaire des informations complémentaires ou blocs CIL. */
  children?: ReactNode;
  emptyAction?: ReactNode;
}

const TOOL = 'rounded-full px-2.5 py-1 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-[var(--accent-soft)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40';

export function PreparationSection({ section, no, state, editable, expanded, photoCap, onExpand, onEnable, onAll, onNone, onRestore, onToggle, onMode, onSelectLinked, viewUrl, children, emptyAction }: Props) {
  const enabled = section.required || state.sections[section.id] !== false;
  const counts = sectionCounts(state, section);
  const hasItems = section.items.length > 0;
  const bodyId = `prep-sec-${section.id}-body`;
  const titleId = `prep-sec-${section.id}-title`;
  const hasContent = hasItems || !!children || !!section.fedBy || !!section.itemType || section.rows.length > 0;

  return (
    <section id={`prep-sec-${section.id}`} aria-labelledby={titleId} className={cn('scroll-mt-24 rounded-xl border bg-card shadow-[var(--shadow-sm)] transition-opacity', enabled ? 'border-border' : 'border-border/60')}>
      <header className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
        <button
          type="button"
          onClick={() => onExpand(section.id, !expanded)}
          aria-expanded={hasContent ? expanded : undefined}
          aria-controls={hasContent ? bodyId : undefined}
          disabled={!hasContent}
          className="group flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span className="mt-0.5 w-7 shrink-0 font-mono text-[11px] text-muted-foreground">{no ?? '—'}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span id={titleId} className={cn('text-[15px] font-semibold leading-tight', !enabled && 'text-muted-foreground')}>{section.label}</span>
              {section.required && <Pill tone="neutral"><Lock aria-hidden />Toujours incluse</Pill>}
              {!section.required && section.recommended && <Pill tone="info"><Sparkles aria-hidden />Recommandée</Pill>}
              {section.hasSensitive && <Pill tone="warning" title="Cette section propose des pièces sensibles, jamais pré-cochées."><ShieldAlert aria-hidden />Sensible</Pill>}
            </span>
            <span className="mt-1 block text-xs leading-snug text-muted-foreground">{section.description}</span>
            {section.rows.length > 0 && !hasItems && (
              <span className="mt-1.5 block text-[11px] tabular-nums text-muted-foreground">
                <strong className="font-semibold text-foreground">{section.rows.length}</strong> ligne{section.rows.length > 1 ? 's' : ''} saisie{section.rows.length > 1 ? 's' : ''}
              </span>
            )}
            {hasItems && (
              <span className="mt-1.5 block text-[11px] tabular-nums text-muted-foreground">
                <strong className="font-semibold text-foreground">{counts.selected}</strong> / {counts.total} retenu{counts.selected > 1 ? 's' : ''}
                {section.itemType !== 'event' && <> · {counts.pdf} PDF · {counts.zip} ZIP</>}
                {section.itemType === 'photo' && photoCap > 0 && <> · {photoCap} recommandées au plus</>}
              </span>
            )}
          </span>
          {hasContent && <ChevronDown className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} aria-hidden />}
        </button>
        {section.toggleable && (
          <Switch
            checked={enabled}
            disabled={!editable}
            onCheckedChange={(v) => onEnable(section.id, v)}
            aria-label={`Inclure la section « ${section.label} »`}
            className="mt-0.5"
          />
        )}
      </header>

      {expanded && hasContent && (
        <div id={bodyId} className={cn('border-t border-border', !enabled && 'opacity-60')}>
          {hasItems && (
            <div role="toolbar" aria-label={`Outils de la section « ${section.label} »`} className="flex flex-wrap items-center gap-1 px-3 py-2 sm:px-4">
              <button type="button" className={TOOL} disabled={!editable} onClick={() => onAll(section.id)}>Tout cocher</button>
              <button type="button" className={TOOL} disabled={!editable} onClick={() => onNone(section.id)}>Tout décocher</button>
              <button type="button" className={TOOL} disabled={!editable} onClick={() => onRestore(section.id)}>Restaurer la recommandation</button>
              {section.hasSensitive && <span className="ml-auto px-2 text-[11px] text-muted-foreground">« Tout cocher » laisse les pièces sensibles décochées.</span>}
            </div>
          )}

          {children && <div className="px-4 pb-4 pt-3 sm:px-5">{children}</div>}

          {section.fedBy && (
            <p className="px-4 pb-4 pt-3 text-xs text-muted-foreground sm:px-5">
              {section.fedBy}{' '}
              {section.fedFilled === false && <span className="text-[color:var(--text-warning)]">Rien n’est encore renseigné : la section n’apparaîtra pas dans le PDF.</span>}
              {section.fedFilled === true && <span className="text-[color:var(--text-success)]">Renseigné.</span>}
            </p>
          )}

          {section.rows.length > 0 && (
            <ul className="mx-4 mb-4 divide-y divide-border overflow-hidden rounded-lg border border-border sm:mx-5" aria-label={`Lignes saisies : ${section.label}`}>
              {section.rows.map((r) => {
                const l = linkedStatus(state, r.linked);
                return (
                  <li key={r.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium">{r.label}</p>
                      {r.detail && <p className="mt-0.5 text-xs text-muted-foreground">{r.detail}</p>}
                      {r.linked.length > 0 && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {r.linked.length} pièce{r.linked.length > 1 ? 's' : ''} ou photo{r.linked.length > 1 ? 's' : ''} liée{r.linked.length > 1 ? 's' : ''} · {l.retained.length} retenue{l.retained.length > 1 ? 's' : ''}
                          {l.sensitive.length > 0 && <span className="text-[color:var(--text-warning)]"> · {l.sensitive.length} sensible{l.sensitive.length > 1 ? 's' : ''}, à cocher vous-même</span>}
                          {l.missing > 0 && <span> · {l.missing} indisponible{l.missing > 1 ? 's' : ''}</span>}
                        </p>
                      )}
                    </div>
                    {l.addable.length > 0 && (
                      <button type="button" disabled={!editable} onClick={() => onSelectLinked(l.addable)} className={TOOL} title="Seules les pièces retenues sont citées dans le PDF.">
                        Retenir les pièces liées ({l.addable.length})
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {section.itemType && !hasItems && (
            <div className="px-4 pb-4 pt-1 text-xs text-muted-foreground sm:px-5">
              {section.itemType === 'photo' ? 'Aucune photo sur ce bien.' : section.itemType === 'event' ? 'Aucun événement à proposer pour cette section.' : 'Aucun document à proposer.'}
              {emptyAction}
            </div>
          )}

          {hasItems && section.itemType === 'photo' && (
            <ul className="grid grid-cols-2 gap-2.5 px-3 pb-4 sm:grid-cols-3 sm:px-4 xl:grid-cols-4">
              {section.items.map((i) => (
                <PhotoTile key={i.key} item={i} state={state.items[i.key]} disabled={!editable} onToggle={onToggle} onMode={onMode} viewUrl={viewUrl} />
              ))}
            </ul>
          )}
          {hasItems && section.itemType === 'document' && (
            <ul className="divide-y divide-border border-t border-border">
              {section.items.map((i) => (
                <DocumentRow key={i.key} item={i} state={state.items[i.key]} disabled={!editable} onToggle={onToggle} onMode={onMode} viewUrl={viewUrl} />
              ))}
            </ul>
          )}
          {hasItems && section.itemType === 'event' && (
            <ul className="divide-y divide-border border-t border-border">
              {section.items.map((i) => (
                <EventRow key={i.key} item={i} state={state.items[i.key]} disabled={!editable} onToggle={onToggle} onMode={onMode} viewUrl={viewUrl} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
