"use client"

/**
 * Lot 84C — Timeline d'un bien (CDC v5 §13, AC22–AC26) : desktop ET mobile.
 *
 *   · bascule « Regroupée » / « Détaillée » : s'ouvre TOUJOURS en
 *     « Regroupée » (§13.2) ; le choix vit dans l'état du composant le temps
 *     de la visite, jamais en stockage ni dans l'adresse (AC24) ;
 *   · un groupe (événement principal daté et ses éléments liés présents sur
 *     cette Timeline) est une ligne dépliable, avec ses compteurs distincts
 *     (événements liés, documents, biens, pièces, équipements — AC26) ;
 *   · « Afficher plus » : page suivante par curseur ; un groupe n'est jamais
 *     coupé entre deux pages (E10, calcul serveur) ;
 *   · un clic sur un élément ou un groupe passe par `onOpenItem` — POINT
 *     D'APPEL UNIQUE des tiroirs : la fiche du bien y ouvre le tiroir Agenda
 *     EXISTANT ; un tiroir dédié (chantier 84B) se branche là, sans toucher
 *     à ce composant.
 *
 * Le mot « Opération » n'apparaît jamais (P1).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { SegmentedControl } from '@/components/documents/v2/DocumentsToolbar';
import type { TimelineEntry, TimelineItemView, TimelineMode } from '@/services/agenda/timeline/model';
import { TIMELINE_MODE_LABELS, visibleCounters } from '@/services/agenda/timeline/labels';

/** Ce qui est demandé au tiroir : l'élément, et s'il ouvre un groupe ou un élément d'un groupe. */
export interface TimelineOpenRequest {
  itemId: string;
  context: 'item' | 'group' | 'member';
  /** Élément représentant le groupe (contexte « member »). */
  groupItemId?: string;
}

export interface TimelinePageInfo {
  mode: TimelineMode;
  nextCursor: string | null;
  remaining: number;
}

export interface AssetTimelineState {
  mode: TimelineMode;
  entries: TimelineEntry[];
  nextCursor: string | null;
  /** Entrées restantes au-delà de celles affichées. */
  rest: number;
  loading: boolean;
  error: boolean;
  expanded: ReadonlySet<string>;
}

export interface AssetTimelineActions {
  setMode(mode: TimelineMode): void;
  loadMore(): void;
  toggle(groupId: string): void;
}

const formatDate = (d: string | null) => {
  if (!d) return null;
  try {
    return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return d; }
};

/**
 * État partagé des deux variantes (desktop et mobile) : une seule lecture.
 * `initial` : première page fournie par la vue d'ensemble (mode regroupé).
 */
export function useAssetTimeline(assetId: number, initial: { entries: TimelineEntry[]; page?: TimelinePageInfo | null } | null): [AssetTimelineState, AssetTimelineActions] {
  const [state, setState] = useState<AssetTimelineState>(() => fromPage('grouped', initial?.entries ?? [], initial?.page ?? null));
  const modeRef = useRef<TimelineMode>('grouped');
  const seq = useRef(0);

  const fetchPage = useCallback(async (mode: TimelineMode, cursor: string | null) => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: false }));
    try {
      const qs = new URLSearchParams({ section: 'timeline', mode });
      if (cursor) qs.set('cursor', cursor);
      const res = await apiClient.get<{ timeline: TimelineEntry[]; timelinePage: TimelinePageInfo }>(`/api/assets/${assetId}/overview?${qs}`, { useCache: false });
      if (n !== seq.current) return;
      setState((s) => {
        const base = cursor ? s.entries : [];
        const next = fromPage(mode, [...base, ...res.timeline], res.timelinePage, res.timeline.length);
        return { ...next, expanded: cursor ? s.expanded : new Set() };
      });
    } catch {
      if (n !== seq.current) return;
      setState((s) => ({ ...s, loading: false, error: true }));
    }
  }, [assetId]);

  // Nouvelle vue d'ensemble (premier chargement, élément modifié) : le mode
  // choisi pendant la visite est conservé ; en « Détaillée », relecture.
  useEffect(() => {
    if (!initial) return;
    if (modeRef.current === 'grouped') {
      seq.current++;
      setState((s) => ({ ...fromPage('grouped', initial.entries, initial.page ?? null), expanded: s.expanded }));
    } else {
      void fetchPage(modeRef.current, null);
    }
  }, [initial, fetchPage]);

  const actions: AssetTimelineActions = {
    setMode: (mode) => {
      if (mode === modeRef.current) return;
      modeRef.current = mode;
      setState((s) => ({ ...s, mode }));
      void fetchPage(mode, null);
    },
    loadMore: () => { if (state.nextCursor && !state.loading) void fetchPage(state.mode, state.nextCursor); },
    toggle: (id) => setState((s) => {
      const e = new Set(s.expanded);
      if (e.has(id)) e.delete(id); else e.add(id);
      return { ...s, expanded: e };
    }),
  };
  return [state, actions];
}

function fromPage(mode: TimelineMode, entries: TimelineEntry[], page: TimelinePageInfo | null, served?: number): AssetTimelineState {
  const pageCount = served ?? entries.length;
  return {
    mode,
    entries,
    nextCursor: page?.nextCursor ?? null,
    rest: page ? Math.max(0, page.remaining - pageCount) : 0,
    loading: false,
    error: false,
    expanded: new Set(),
  };
}

function dotClass(item: TimelineItemView): string {
  return item.isOverdue
    ? 'bg-destructive'
    : item.toConfirm
    ? 'bg-[color:var(--badge-todo)]'
    : item.isDone
    ? 'bg-[color:var(--accent)]'
    : 'bg-[color:var(--text-muted)]';
}

interface RowProps {
  item: TimelineItemView;
  variant: 'desktop' | 'mobile';
  readOnly: boolean;
  busy: boolean;
  onOpen?: () => void;
  small?: boolean;
  children?: React.ReactNode;
}

/** Ligne d'un élément : pastille d'état, date (et « statut à confirmer »), titre. */
function TimelineRow({ item, variant, readOnly, busy, onOpen, small, children }: RowProps) {
  const dot = small ? 'w-2.5 h-2.5 mt-1.5' : 'w-3.5 h-3.5 mt-1';
  return (
    <div className={`relative flex gap-3 ${variant === 'mobile' ? 'pb-4' : 'pb-5'}`} data-timeline-item={item.id}>
      <div className={`relative z-10 ${dot} rounded-full border-2 border-background shrink-0 ${dotClass(item)} ${busy ? 'animate-pulse' : ''}`} />
      <div className="flex-1 min-w-0">
        <button
          type="button"
          className={`w-full min-w-0 -mt-0.5 text-left transition-opacity ${variant === 'mobile' ? 'min-h-[32px]' : ''} ${readOnly ? 'cursor-default' : 'hover:opacity-70'}`}
          onClick={readOnly ? undefined : onOpen}
          disabled={busy || readOnly}
        >
          {item.effectiveDate && (
            <p className="text-[10px] text-muted-foreground leading-none mb-0.5">
              {formatDate(item.effectiveDate)}
              {item.toConfirm && <span className="text-[color:var(--attention-on-soft)]"> · statut à confirmer</span>}
            </p>
          )}
          <p className={`text-xs font-medium leading-snug ${variant === 'desktop' ? 'truncate' : ''} ${item.isDone ? 'text-muted-foreground' : 'text-foreground'}`}>
            {item.title}
          </p>
        </button>
        {children}
      </div>
    </div>
  );
}

export interface AssetTimelineProps {
  state: AssetTimelineState;
  actions: AssetTimelineActions;
  variant: 'desktop' | 'mobile';
  readOnly?: boolean;
  /** Élément en cours d'ouverture (pastille animée). */
  busyItemId?: string | null;
  /** Point d'appel unique des tiroirs (voir l'en-tête). */
  onOpenItem: (req: TimelineOpenRequest) => void;
}

/** Bascule « Regroupée » / « Détaillée » (charte : contrôle segmenté du design system). */
export function TimelineModeSwitch({ mode, onChange }: { mode: TimelineMode; onChange: (m: TimelineMode) => void }) {
  return (
    <SegmentedControl<TimelineMode>
      label="Affichage de la Timeline"
      options={[{ value: 'grouped', label: TIMELINE_MODE_LABELS.grouped }, { value: 'detailed', label: TIMELINE_MODE_LABELS.detailed }]}
      value={mode}
      onChange={onChange}
    />
  );
}

/** Liste de la Timeline (sans en-tête) : entrées, groupes dépliables, « Afficher plus ». */
export function AssetTimelineList({ state, actions, variant, readOnly = false, busyItemId = null, onOpenItem }: AssetTimelineProps) {
  const key = (id: string) => `${variant}-${id}`;
  if (state.entries.length === 0) {
    return <p className="text-xs text-muted-foreground">{state.loading ? 'Chargement…' : state.error ? 'Timeline indisponible pour le moment.' : 'Aucune entrée'}</p>;
  }
  return (
    <div className="relative" aria-busy={state.loading} data-timeline-mode={state.mode}>
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
      <ul className="space-y-0 list-none p-0 m-0">
        {state.entries.map((entry) => {
          if (entry.kind !== 'group') {
            return (
              <li key={key(entry.id)}>
                <TimelineRow item={entry} variant={variant} readOnly={readOnly} busy={busyItemId === entry.id}
                  onOpen={() => onOpenItem({ itemId: entry.id, context: 'item' })} />
              </li>
            );
          }
          const open = state.expanded.has(entry.id);
          const panelId = `timeline-${variant}-groupe-${entry.id}`;
          const counters = visibleCounters(entry.counters);
          const n = entry.members.length;
          return (
            <li key={key(entry.id)} data-timeline-group={entry.id}>
              <TimelineRow item={entry} variant={variant} readOnly={readOnly} busy={busyItemId === entry.id}
                onOpen={() => onOpenItem({ itemId: entry.id, context: 'group' })}>
                {counters.length > 0 && (
                  <p className="text-[11px] text-muted-foreground leading-snug mt-1" data-timeline-counters>
                    {counters.map((c) => c.label).join(' · ')}
                  </p>
                )}
                {n > 0 && (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => actions.toggle(entry.id)}
                    className={`mt-1 inline-flex items-center gap-1 rounded-[8px] text-[11px] font-semibold text-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] px-1.5 -ml-1.5 ${variant === 'mobile' ? 'min-h-[32px]' : 'py-0.5'}`}
                  >
                    {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    {open ? 'Masquer' : 'Afficher'} {n > 1 ? `les ${n} éléments liés` : 'l’élément lié'}
                  </button>
                )}
                {open && n > 0 && (
                  <ul id={panelId} className="mt-2 ml-0.5 pl-3 border-l border-[color:var(--border-subtle)] list-none">
                    {entry.members.map((m) => (
                      <li key={key(`${entry.id}-${m.id}`)}>
                        <TimelineRow item={m} variant={variant} readOnly={readOnly} busy={busyItemId === m.id} small
                          onOpen={() => onOpenItem({ itemId: m.id, context: 'member', groupItemId: entry.id })} />
                      </li>
                    ))}
                  </ul>
                )}
              </TimelineRow>
            </li>
          );
        })}
      </ul>
      {state.nextCursor && (
        <button
          type="button"
          onClick={actions.loadMore}
          disabled={state.loading}
          className={`relative flex gap-3 items-center text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60 ${variant === 'mobile' ? 'min-h-[40px]' : ''}`}
        >
          <div className="relative z-10 w-3.5 h-3.5 rounded-full border-2 border-border bg-background shrink-0" />
          <span>{state.loading ? 'Chargement…' : `Afficher plus${state.rest > 0 ? ` (${state.rest})` : ''}`}</span>
        </button>
      )}
      {state.error && <p className="text-xs text-muted-foreground mt-2">Impossible de charger la suite. Réessayez dans un instant.</p>}
    </div>
  );
}
