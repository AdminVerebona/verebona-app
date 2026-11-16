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
 *
 * ── RÈGLE REMPLACÉE (carte #744, lot C — CDC « Opérations / Agenda V2.0 »
 *    §13, AC26 à AC31, AC38, AC40) ──────────────────────────────────────────
 * Le mode REGROUPÉ ne dépend plus de l'élément « principal » ni de la colonne
 * historique `agenda_items.business_operation_id` : il lit le GRAPHE CANONIQUE
 * (`business_operation_agenda_links`, N↔N, lot B).
 *   · une entrée `group` par ÉVÉNEMENT DE RÉFÉRENCE actif pertinent pour le
 *     bien : celui qui a au moins un élément d'agenda sur la Timeline du bien,
 *     OU qui est relié au bien (`business_operation_asset_links`) — y compris
 *     sans aucun élément d'agenda et sans date (AC26, AC35) ; aucun élément
 *     fictif n'est fabriqué ;
 *   · l'identité de l'entrée est celle de l'événement de référence
 *     (`operationId`), jamais celle d'un élément d'agenda ;
 *   · son dépliage ne porte QUE ses éléments d'agenda réels présents sur la
 *     Timeline de CE bien (AC27, AC30) ; un élément partagé par deux
 *     événements de référence figure dans le dépliage de chacun, une seule
 *     fois par liste, avec la même identité ;
 *   · les éléments d'agenda sans événement de référence actif restent des
 *     entrées individuelles (AC29) ;
 *   · REPÈRE de date du groupe (`effectiveDate`, `dateBasis`) — RÈGLE
 *     REMPLACÉE (carte #744, point F) : la DATE DE PRÉSENTATION du CDC §11
 *     (`@/lib/reference-events/presentation-date` : réalisation, premier
 *     devis, début, première couverture connue, date prévue, selon le type) ;
 *     à défaut, AUCUNE date (entrée « sans date », en fin de Timeline, jamais
 *     d'horodatage inventé, jamais la date d'un élément d'agenda). Ce repère
 *     ne déplace aucun élément d'agenda : en mode détaillé et dans l'Agenda,
 *     chacun reste à SA date (AC25).
 * Le mode DÉTAILLÉ est inchangé (un élément = une ligne, à sa date, une seule
 * fois même s'il est partagé — AC31) ; chaque ligne porte en plus la liste de
 * ses événements de référence (`operations`).
 * Pagination : identités TYPÉES (événement de référence / élément), tri
 * (date décroissante, sans date en dernier, événement de référence avant
 * élément à date égale, identifiant décroissant) — AC38.
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { PresentationDateBasis } from '@/lib/reference-events/presentation-date';

export type TimelineMode = 'grouped' | 'detailed';
const TIMELINE_MODES: readonly TimelineMode[] = ['grouped', 'detailed'];
/** Mode par défaut (§13.2) : à CHAQUE ouverture — jamais mémorisé (AC24). */
export const DEFAULT_TIMELINE_MODE: TimelineMode = 'grouped';

/** Taille de page par défaut et maximale (entrées, un groupe = une entrée). */
export const TIMELINE_PAGE_DEFAULT = 12;
export const TIMELINE_PAGE_MAX = 100;

/** Événement de référence d'un élément d'agenda (lien cliquable ; jamais le mot « Opération »). */
export interface TimelineOperationRef {
  operationId: number;
  /** Libellé utilisateur existant (`referenceEventLabel`). */
  label: string;
}

/** Élément d'agenda tel qu'affiché sur la Timeline (forme historique de la vue d'ensemble). */
export interface TimelineItemView {
  itemType: 'agenda';
  id: string;
  title: string;
  /** AAAA-MM-JJ ; null : élément sans date. */
  effectiveDate: string | null;
  /**
   * #744 lot C : événements de référence ACTIFS de l'élément (graphe N↔N),
   * renseigné en mode détaillé. Absent ou vide : élément autonome.
   */
  operations?: TimelineOperationRef[];
  /*
   * Lot 113P (#715, décision PO du 06/11/2026) : plus de statut d'événement —
   * `isDone`, `isOverdue`, `toConfirm` et `effectiveStatus` sont RETIRÉS. La
   * date situe l'élément sur la Timeline.
   */
}

/**
 * Fondement du repère de date d'un groupe ; null : sans date.
 * RÈGLE REMPLACÉE (carte #744, point F — CDC §11) : le repère est la DATE DE
 * PRÉSENTATION de l'événement de référence (`presentationDateOf`), et non
 * plus « date propre, sinon plus ancien élément d'agenda lié ». Les anciennes
 * valeurs `REFERENCE_EVENT` / `FIRST_EVENT` n'existent plus.
 */
export type TimelineGroupDateBasis = PresentationDateBasis;

/** Événement de référence tel qu'affiché en tête de groupe (#744 lot C). */
export interface TimelineGroupView {
  itemType: 'operation';
  /** Identité TYPÉE de l'entrée (`op-<identifiant>`) : ne se confond jamais avec un élément d'agenda. */
  id: string;
  operationId: number;
  /** Libellé utilisateur de l'événement de référence. */
  title: string;
  /** Repère de date (AAAA-MM-JJ) ; null : événement de référence sans date (aucune date inventée). */
  effectiveDate: string | null;
  dateBasis: TimelineGroupDateBasis | null;
}

/** Compteurs distincts d'un groupe (§13.7, AC26). */
export interface TimelineGroupCounters {
  /** Éléments d'agenda réels liés à l'événement de référence (compte entier ; #744 : plus de « principal » à exclure). */
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
  | (TimelineGroupView & {
      kind: 'group';
      /** Éléments d'agenda RÉELS de l'événement de référence présents sur la Timeline de ce bien, triés comme la Timeline. */
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
  origin_field_key: string | null;
  event_nature: string | null;
  business_type: string | null;
  /** Lot 111R : heure / fin de l'élément (même règle de date que l'Agenda). */
  start_time?: string | null;
  end_date?: string | null;
  end_time?: string | null;
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
  /**
   * #744 lot C : nature de la dernière entrée servie. Absent : élément
   * d'agenda (curseurs historiques et mode détaillé inchangés).
   */
  kind?: 'group';
}

/** Identité typée d'un groupe dans la liste (`op-12`). */
export const timelineGroupEntryId = (operationId: number): string => `op-${operationId}`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function encodeTimelineCursor(c: TimelineCursor): string {
  const v: unknown[] = [c.mode === 'grouped' ? 'g' : 'd', c.sortDate, c.id];
  if (c.kind === 'group') v.push('o');
  return Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
}

/** Curseur décodé ; null : absent ; 'INVALID' : illisible ou d'un autre mode. */
export function decodeTimelineCursor(raw: string | null | undefined, mode: TimelineMode): TimelineCursor | null | 'INVALID' {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(v) || (v.length !== 3 && v.length !== 4)) return 'INVALID';
    const [m, d, id] = v as [unknown, unknown, unknown];
    // Quatrième valeur : entrée « événement de référence », en mode regroupé seulement.
    if (v.length === 4 && (v[3] !== 'o' || m !== 'g')) return 'INVALID';
    const cm: TimelineMode | null = m === 'g' ? 'grouped' : m === 'd' ? 'detailed' : null;
    if (cm !== mode) return 'INVALID';
    if (typeof d !== 'string' || (d !== '-infinity' && !DATE_RE.test(d))) return 'INVALID';
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return 'INVALID';
    return v.length === 4 ? { mode, sortDate: d, id, kind: 'group' } : { mode, sortDate: d, id };
  } catch {
    return 'INVALID';
  }
}

// ── Vue d'un élément ────────────────────────────────────────────────────────
//
// Lot 113P (#715) : plus de statut (« réalisé », « en retard », « à
// confirmer ») — l'élément est présenté à sa date, sans état.

/** Vue d'un élément. `_now` : conservé pour la compatibilité des appelants (sans effet). */
export function timelineItemView(r: TimelineItemRow, _now?: string | Date): TimelineItemView {
  return {
    itemType: 'agenda',
    id: String(r.id),
    title: r.title,
    effectiveDate: r.start_date ?? null,
  };
}

/** Ordre de la Timeline : date décroissante, sans date en dernier, puis identifiant décroissant. */
export function compareTimelineItems(a: { effectiveDate: string | null; id: string }, b: { effectiveDate: string | null; id: string }): number {
  const da = a.effectiveDate ?? '';
  const db = b.effectiveDate ?? '';
  if (da !== db) return da < db ? 1 : -1;
  return Number(b.id) - Number(a.id);
}
