/**
 * Lot 111F (ticket P1 TCO §4) — historique de valorisation restitué à l'écran
 * (route `/api/assets/[id]/valuations`, `ValuationHistoryDrawer`). PUR.
 * Règle d'admissibilité PARTAGÉE avec le moteur TCO (`assessValuations`) :
 * aucun historique concurrent, aucune règle à l'écran.
 */
import { isIsoDate } from '../finance/engine';
import { assessValuations, VALUATION_REJECTION_LABELS, type ValuationRejection } from './ownership-indicators';

export type ValuationEntry = {
  id: string;
  value: number | null;
  /** Date EFFECTIVE de la valorisation (lot 111F : obligatoire à la saisie, jamais la date d'ajout). */
  date: string | null;
  mode: string | null;
  source: 'USER' | 'AI';
  /** Date d'ajout / d'enregistrement dans Verebona (distincte de la date de valorisation). */
  addedAt: string;
  currency?: string | null;
};

/**
 * Lot 111F — entrée restituée à l'écran : admissibilité calculée par la règle
 * PARTAGÉE avec le moteur TCO (`assessValuations`) — retenue pour le coût net
 * ou motif (non datée, future, antérieure à l'achat…). Aucune règle à l'écran.
 */
export type ValuationEntryView = ValuationEntry & { retained: boolean; rejection: ValuationRejection | null; rejectionLabel: string | null };

/**
 * Lot 111F : historique trié par DATE DE VALORISATION (la plus récente d'abord ; à date égale, la dernière
 * enregistrée ; non datées en dernier) — jamais par ordre d'ajout. Pure.
 */
export function valuationHistoryView(history: readonly ValuationEntry[], ctx: { today: string; acquisitionDate: string | null }): ValuationEntryView[] {
  const r = assessValuations(history, { asOf: ctx.today, acquisitionDate: ctx.acquisitionDate });
  const vues = history.map((v, i) => {
    const rejection = r.items[i]?.rejection ?? null;
    return { ...v, retained: r.retainedIndex === i, rejection, rejectionLabel: rejection ? VALUATION_REJECTION_LABELS[rejection] : null };
  });
  const jour = (d: string | null) => (isIsoDate(d) ? d.slice(0, 10) : '');
  return vues.map((v, i) => ({ v, i }))
    .sort((a, b) => jour(b.v.date).localeCompare(jour(a.v.date)) || String(b.v.addedAt ?? '').localeCompare(String(a.v.addedAt ?? '')) || b.i - a.i)
    .map((x) => x.v);
}

