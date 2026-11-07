/**
 * Récurrence d'une série d'agenda — extrait du module `agenda-status-sync.ts`
 * (lot 14) supprimé au lot 113P (#715 : plus de réconciliation de STATUT des
 * échéances). Fonction pure, inchangée.
 */
import { getField } from '@/services/canonical/registry';
import type { ExistingAgendaItem } from '@/services/ai/agenda/types';

type Recurrence = NonNullable<ExistingAgendaItem['recurrence']>;
const FREQUENCES = new Set(['daily', 'weekly', 'monthly', 'yearly']);

/**
 * Récurrence de la série au format de `ExistingAgendaItem` : `recurrence_json`
 * (`{ frequency, interval }`, ou règle `FREQ=…;INTERVAL=…`), sinon la
 * récurrence du registre pour le champ d'origine.
 */
export function parseSeriesRecurrence(json: unknown, originFieldKey?: string | null): Recurrence | null {
  const depuisRegle = (rule: string): Recurrence | null => {
    const f = /FREQ=([A-Z]+)/i.exec(rule)?.[1]?.toLowerCase();
    if (!f || !FREQUENCES.has(f)) return null;
    const i = Number(/INTERVAL=(\d+)/i.exec(rule)?.[1] ?? 1);
    return { frequency: f as Recurrence['frequency'], interval: Math.max(1, i) };
  };
  if (json && typeof json === 'object') {
    const r = json as { frequency?: unknown; interval?: unknown; rule?: unknown };
    const f = typeof r.frequency === 'string' ? r.frequency.toLowerCase() : null;
    if (f && FREQUENCES.has(f)) {
      return { frequency: f as Recurrence['frequency'], interval: Math.max(1, Number(r.interval) || 1) };
    }
    if (typeof r.rule === 'string') {
      const x = depuisRegle(r.rule);
      if (x) return x;
    }
  }
  const effet = originFieldKey ? getField(originFieldKey)?.agendaEffect : undefined;
  return effet?.recurrence ? depuisRegle(effet.recurrence) : null;
}
