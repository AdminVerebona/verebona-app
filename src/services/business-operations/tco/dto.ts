/**
 * TCO — forme transmise à l'interface et validation des forfaits (lot 54D).
 * PUR : aucun import serveur (utilisable par le tiroir, desktop et mobile).
 */
import { EXCLUSION_LABELS, type ExclusionReason } from '../finance/engine';
import {
  USAGE_BUDGET_CATEGORY_LABELS, USAGE_BUDGET_PERIODICITY_LABELS, validateUsageBudget,
  type TcoResult, type TcoWarning, type UsageBudget,
} from './model';

export const TCO_PREMIUM_MESSAGE = 'Le coût de possession est disponible avec Premium et Premium Duo.';

/** Libellés des signalements de fiabilité (aucun terme technique, P09). */
export const TCO_WARNING_LABELS: Readonly<Record<TcoWarning, string>> = {
  ACQUISITION_DATE_MISSING: 'Date d’acquisition non renseignée : la période de possession n’est pas établie.',
  ACQUISITION_COST_MISSING: 'Aucun coût d’acquisition documenté : le coût cumulé peut être incomplet.',
  UNCONVERTED_AMOUNTS: 'Des montants en devise étrangère, sans contre-valeur en euros, ne sont pas comptés.',
  UNALLOCATED_AMOUNTS: 'Des montants communs à plusieurs biens ne sont pas ventilés : ils ne sont pas comptés ici.',
  NO_RELIABLE_VALUATION: 'Aucune valorisation datée : seul le coût cumulé est affiché, aucune dépréciation n’est estimée.',
  DISPOSAL_PRICE_MISSING: 'Prix de cession réalisé non documenté : le coût net final n’est pas établi.',
  DISPOSAL_DATE_MISSING: 'Date de cession non renseignée.',
  PARTIAL_READ: 'Volume exceptionnel : seule une partie des éléments a pu être lue, résultat partiel.',
  PRORATA_APPLIED: 'Une période payée dépasse la cession : seule la part jusqu’à la cession est comptée (prorata au jour).',
};

export type TcoDto = Omit<TcoResult, 'entries'> & {
  excludedLabels: Record<ExclusionReason, string>;
  warningLabels: string[];
  usageLabels: { categories: typeof USAGE_BUDGET_CATEGORY_LABELS; periodicities: typeof USAGE_BUDGET_PERIODICITY_LABELS };
  /** Nombre de composantes examinées (trace complète côté serveur). */
  componentsExamined: number;
};

export function toTcoDto(t: TcoResult): TcoDto {
  const { entries, ...rest } = t;
  return {
    ...rest,
    excludedLabels: { ...EXCLUSION_LABELS },
    warningLabels: t.reliability.warnings.map((w) => TCO_WARNING_LABELS[w]),
    usageLabels: { categories: USAGE_BUDGET_CATEGORY_LABELS, periodicities: USAGE_BUDGET_PERIODICITY_LABELS },
    componentsExamined: entries.length,
  };
}

type BudgetValue = Omit<UsageBudget, 'id' | 'assetId'>;

/** Corps d'un forfait (POST / PATCH) → valeur validée. */
export function parseUsageBudgetBody(body: unknown): { ok: true; value: BudgetValue } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Corps attendu : un objet.' };
  const b = body as Record<string, unknown>;
  const v = {
    category: b.category, amountMinor: b.amountMinor, currency: typeof b.currency === 'string' ? b.currency.trim().toUpperCase() : 'EUR',
    periodicity: b.periodicity, validFrom: b.validFrom ?? null, validTo: b.validTo ?? null,
    label: typeof b.label === 'string' && b.label.trim() ? b.label.trim() : null,
  };
  const err = validateUsageBudget(v);
  if (err) return { ok: false, message: err };
  return {
    ok: true,
    value: {
      category: v.category as BudgetValue['category'], amountMinor: v.amountMinor as number, currency: v.currency,
      periodicity: v.periodicity as BudgetValue['periodicity'], label: v.label,
      validFrom: (v.validFrom as string | null) || null, validTo: (v.validTo as string | null) || null,
    },
  };
}
