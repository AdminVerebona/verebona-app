/**
 * Lot 84C — libellés de la Timeline, partagés par l'interface (desktop et
 * mobile). Aucune dépendance serveur. Le mot « Opération » n'y figure jamais
 * (P1 : l'Opération est invisible).
 */
import type { TimelineGroupCounters, TimelineMode } from './model';

export const TIMELINE_MODE_LABELS: Record<TimelineMode, string> = {
  grouped: 'Regroupée',
  detailed: 'Détaillée',
};

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
