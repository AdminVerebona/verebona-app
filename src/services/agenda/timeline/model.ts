/**
 * Lot 84C — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-4 :
 * TIMELINE D'UN BIEN — règles pures (aucun accès base).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CALCULÉE À LA LECTURE, AUCUNE TABLE PROPRE
 *
 * La Timeline d'un bien = ses éléments d'agenda (`agenda_items` liés par
 * `agenda_asset_links`, statut « annule » exclu, comme avant le lot). Deux
 * modes (§13.1) :
 *
 *   · REGROUPÉE (par défaut, §13.2 ; jamais mémorisée — AC22, AC24) : quand
 *     l'élément PRINCIPAL d'une Opération active est DATÉ et figure sur la
 *     Timeline du bien, il représente le groupe ; les autres éléments de la
 *     même Opération présents sur cette Timeline sont masqués de la liste et
 *     portés par le groupe (dépliable). Ils restent visibles dans l'Agenda
 *     (§12) et accessibles depuis le tiroir du principal (§13.4).
 *   · DÉTAILLÉE : tous les éléments, individuellement (AC23).
 *
 * Opération sans principal (§13.5) → rien n'est masqué. Principal SANS DATE
 * (§13.6, AC25) → le regroupement ne s'active pas : le principal est une
 * ligne comme une autre, placée avec les éléments sans date (en fin de
 * Timeline, règle d'affichage existante), et ses éléments liés datés restent
 * visibles à leur date.
 *
 * E10 — LE REGROUPEMENT PRÉCÈDE LA PAGINATION : la requête (`read.ts`)
 * calcule les groupes sur TOUTE la Timeline du bien (fenêtre SQL par
 * Opération) puis pagine des ENTRÉES (un groupe = une entrée) : un groupe
 * n'est jamais coupé entre deux pages. Pagination par curseur (clé de tri
 * stable : date décroissante, sans date en dernier, puis identifiant).
 *
 * Aucun libellé produit ici ne contient le mot « Opération » (P1).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isHistoricalAgendaEvent } from '@/services/agenda/agenda-historical';

export type TimelineMode = 'grouped' | 'detailed';
const TIMELINE_MODES: readonly TimelineMode[] = ['grouped', 'detailed'];
/** Mode par défaut (§13.2) : à CHAQUE ouverture — jamais mémorisé (AC24). */
export const DEFAULT_TIMELINE_MODE: TimelineMode = 'grouped';

/** Taille de page par défaut et maximale (entrées, un groupe = une entrée). */
export const TIMELINE_PAGE_DEFAULT = 12;
export const TIMELINE_PAGE_MAX = 100;

/** Élément d'agenda tel qu'affiché sur la Timeline (forme historique de la vue d'ensemble). */
export interface TimelineItemView {
  itemType: 'agenda';
  id: string;
  title: string;
  /** AAAA-MM-JJ ; null : élément sans date. */
  effectiveDate: string | null;
  isDone: boolean;
  isOverdue: boolean;
  /** Lot 53 (D17) : fait passé sans preuve de réalisation. */
  toConfirm: boolean;
}

/** Compteurs distincts d'un groupe (§13.7, AC26). */
export interface TimelineGroupCounters {
  /** Éléments d'agenda liés, HORS principal (annulés exclus). */
  events: number;
  documents: number;
  assets: number;
  rooms: number;
  equipments: number;
}

/**
 * Entrée de la Timeline. Compatible avec l'ancienne liste plate : les champs
 * de l'élément sont au premier niveau (`id`, `title`, `effectiveDate`…).
 */
export type TimelineEntry =
  | (TimelineItemView & { kind: 'item' })
  | (TimelineItemView & {
      kind: 'group';
      /** Éléments liés masqués de la liste (présents sur la Timeline de ce bien), triés comme la Timeline. */
      members: TimelineItemView[];
      counters: TimelineGroupCounters;
    });

export interface TimelinePage {
  mode: TimelineMode;
  entries: TimelineEntry[];
  /** Curseur de la page suivante ; null : dernière page. */
  nextCursor: string | null;
  /** Entrées restantes à partir de cette page (incluse). */
  remaining: number;
}

/** Ligne SQL d'un élément (sortie de `read.ts`). */
export interface TimelineItemRow {
  id: number | string;
  title: string;
  start_date: string | null;
  manual_status: string | null;
  origin_field_key: string | null;
  event_nature: string | null;
  business_type: string | null;
}

export function parseTimelineMode(v: string | null | undefined): TimelineMode | null {
  if (v === null || v === undefined || v === '') return DEFAULT_TIMELINE_MODE;
  return (TIMELINE_MODES as readonly string[]).includes(v) ? (v as TimelineMode) : null;
}

export function clampTimelineLimit(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : v ? Number.parseInt(String(v), 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return TIMELINE_PAGE_DEFAULT;
  return Math.min(Math.floor(n), TIMELINE_PAGE_MAX);
}

// ── Curseur ────────────────────────────────────────────────────────────────

/** Position après laquelle reprendre : clé de tri de la dernière entrée servie. */
export interface TimelineCursor {
  mode: TimelineMode;
  /** AAAA-MM-JJ, ou '-infinity' pour la section « sans date ». */
  sortDate: string;
  id: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function encodeTimelineCursor(c: TimelineCursor): string {
  return Buffer.from(JSON.stringify([c.mode === 'grouped' ? 'g' : 'd', c.sortDate, c.id]), 'utf8').toString('base64url');
}

/** Curseur décodé ; null : absent ; 'INVALID' : illisible ou d'un autre mode. */
export function decodeTimelineCursor(raw: string | null | undefined, mode: TimelineMode): TimelineCursor | null | 'INVALID' {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(v) || v.length !== 3) return 'INVALID';
    const [m, d, id] = v as [unknown, unknown, unknown];
    const cm: TimelineMode | null = m === 'g' ? 'grouped' : m === 'd' ? 'detailed' : null;
    if (cm !== mode) return 'INVALID';
    if (typeof d !== 'string' || (d !== '-infinity' && !DATE_RE.test(d))) return 'INVALID';
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return 'INVALID';
    return { mode, sortDate: d, id };
  } catch {
    return 'INVALID';
  }
}

// ── États d'affichage (règles existantes 47B / 53 D17, inchangées) ─────────

export function timelineItemView(r: TimelineItemRow, today: string): TimelineItemView {
  const effectiveDate = r.start_date ?? null;
  const historique = isHistoricalAgendaEvent({
    eventNature: r.event_nature ?? null,
    businessType: r.business_type ?? null,
    originFieldKey: r.origin_field_key ?? null,
  });
  const ouvert = !r.manual_status || r.manual_status.trim() === '';
  return {
    itemType: 'agenda',
    id: String(r.id),
    title: r.title,
    effectiveDate,
    isDone: r.manual_status === 'realise',
    isOverdue: ouvert && !historique && !!effectiveDate && effectiveDate < today,
    toConfirm: ouvert && historique && !!effectiveDate && effectiveDate < today,
  };
}

/** Ordre de la Timeline : date décroissante, sans date en dernier, puis identifiant décroissant. */
export function compareTimelineItems(a: { effectiveDate: string | null; id: string }, b: { effectiveDate: string | null; id: string }): number {
  const da = a.effectiveDate ?? '';
  const db = b.effectiveDate ?? '';
  if (da !== db) return da < db ? 1 : -1;
  return Number(b.id) - Number(a.id);
}
