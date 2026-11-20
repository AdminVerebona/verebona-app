/**
 * Lot 84C — libellés de la Timeline, partagés par l'interface (desktop et
 * mobile). Aucune dépendance serveur. Le mot « Opération » n'y figure jamais
 * (P1 : l'Opération est invisible).
 */
import { PRESENTATION_BASIS_LABELS, type PresentationDateBasis } from '@/lib/reference-events/presentation-date';
import type { TimelineGroupCounters, TimelineMode } from './model';

export const TIMELINE_MODE_LABELS: Record<TimelineMode, string> = {
  grouped: 'Regroupée',
  detailed: 'Détaillée',
};

/**
 * #744 lot C — lien d'un élément vers son événement de référence (mode
 * détaillé). Texte EXISTANT repris à l'identique (`REFERENCE_EVENT_OPEN_LABEL`
 * du lot 113X, « Voir l'événement de référence ») : égalité vérifiée par
 * `l84c-timeline-ui.test.ts`.
 */
export const TIMELINE_REFERENCE_EVENT_LINK = 'Voir l’opération';

/**
 * #744 lot C — événement de référence sans date : mention explicite, aucune
 * date inventée. Texte EXISTANT de l'Agenda (`AgendaGroupingPanel`, « Sans date »).
 */
export const TIMELINE_UNDATED_LABEL = 'Sans date';

/**
 * Carte #806 §6 (lot 116C, seconde partie) — PROVENANCE du repère de date d'une
 * opération sur la Timeline. Quand le repère n'est pas une date propre de
 * l'opération mais une date DÉDUITE (premier devis, première couverture connue,
 * date de commande), la ligne le dit avec le texte EXISTANT de la fiche
 * (`PRESENTATION_BASIS_LABELS`) : la même date porte le même fondement sur la
 * Timeline et sur la fiche. `null` : date propre (réalisation, début, date
 * prévue) ou sans date — rien n'est ajouté.
 */
export function timelineDateBasisLabel(basis: PresentationDateBasis | null | undefined): string | null {
  return basis ? PRESENTATION_BASIS_LABELS[basis] : null;
}

const COUNTER_ORDER: ReadonlyArray<keyof TimelineGroupCounters> = ['events', 'documents', 'assets', 'rooms', 'equipments'];

/** « 3 événements liés », « 1 document »… (pluriel français). */
export function counterLabel(kind: keyof TimelineGroupCounters, n: number): string {
  const L: Record<keyof TimelineGroupCounters, [string, string]> = {
    events: ['événement lié', 'événements liés'],
    documents: ['document', 'documents'],
    assets: ['bien', 'biens'],
    rooms: ['pièce', 'pièces'],
    equipments: ['équipement', 'équipements'],
  };
  return `${n} ${L[kind][n > 1 ? 1 : 0]}`;
}

/** Compteurs non nuls, dans l'ordre du CDC (§13.7). */
export function visibleCounters(c: TimelineGroupCounters): Array<{ kind: keyof TimelineGroupCounters; n: number; label: string }> {
  return COUNTER_ORDER.filter((k) => c[k] > 0).map((k) => ({ kind: k, n: c[k], label: counterLabel(k, c[k]) }));
}
