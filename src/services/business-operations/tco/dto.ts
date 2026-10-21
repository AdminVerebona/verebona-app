/**
 * TCO — forme transmise à l'interface et validation des forfaits (lot 54D).
 * PUR : aucun import serveur (utilisable par le tiroir, desktop et mobile).
 */
import { EXCLUSION_LABELS, type ExclusionReason } from '../finance/engine';
import {
  DOCUMENT_LINE_REASON_LABELS, ECONOMIC_LINE_STATUS_LABELS, type EconomicLineReason, type EconomicLineStatus,
} from '../finance/economic-lines';
import {
  TCO_CATEGORY_LABELS, USAGE_BUDGET_CATEGORY_LABELS, USAGE_BUDGET_PERIODICITY_LABELS, validateUsageBudget, type TcoCategory,
  type TcoEconomicLine, type TcoResult, type TcoWarning, type UsageBudget,
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
  DOCUMENTS_NOT_QUALIFIED: 'Des justificatifs portent un montant dont la nature n’est pas établie : ils ne sont pas comptés.',
  UNCONFIRMED_ASSET_EXPENSES: 'Des justificatifs de ce bien sont rattachés à une dépense dont le bien n’est pas confirmé : non comptés ici.',
  AMOUNTS_UNKNOWN: 'Des justificatifs de dépense n’ont pas de montant lisible : leur montant est inconnu, le coût cumulé est incomplet.',
  UNCERTAIN_MATCHES: 'Des dépenses ressemblent à une autre dépense sans preuve qu’il s’agisse de la même : elles sont comptées, à vérifier.',
  ACQUISITION_AMBIGUOUS: 'Plusieurs factures d’achat pourraient correspondre à l’achat du bien : renseignez le prix d’achat de la fiche.',
};

/** Lot 61 : libellé du motif d'une ligne économique (moteur ou qualification documentaire). */
export const ECONOMIC_LINE_REASON_LABELS: Readonly<Record<EconomicLineReason, string>> = { ...EXCLUSION_LABELS, ...DOCUMENT_LINE_REASON_LABELS };

/** Lignes transmises par page à l'interface (les plus utiles d'abord) — la trace complète reste côté serveur et BO. */
export const TCO_DTO_MAX_LINES = 400;
/** Lot 75D (J) : taille maximale d'une page demandée (chargement complémentaire). */
export const TCO_DTO_MAX_PAGE = 1000;

/**
 * Lot 68 (68A) — motif pour lequel une ligne examinée n'est PAS montrée sur
 * la fiche du bien (elle reste au diagnostic BO, avec son motif) :
 *   · OTHER_ASSET : dépense (ou composante) attribuée à un autre bien — sans
 *     intérêt pour CE bien ;
 *   · CONSOLIDATED_SHOWN : justificatif repris par une dépense consolidée déjà
 *     affichée — le justificatif est ouvrable depuis cette ligne.
 */
export type TcoHiddenReason = 'OTHER_ASSET' | 'CONSOLIDATED_SHOWN';

export const TCO_HIDDEN_REASON_LABELS: Readonly<Record<TcoHiddenReason, string>> = {
  OTHER_ASSET: 'Masquée sur la fiche : attribuée à un autre bien',
  CONSOLIDATED_SHOWN: 'Masquée sur la fiche : justificatif ouvrable depuis la dépense consolidée',
};

/** Ligne montrée sur la fiche : justificatifs repris par la dépense consolidée (en plus de `fileId`). */
export type TcoUserLine = TcoEconomicLine & { supportingDocuments?: Array<{ fileId: number; title: string }> };

const RETENUE = (s: EconomicLineStatus) => s === 'RETAINED_DIRECT' || s === 'RETAINED_CONSOLIDATED';

/**
 * Lot 68 (68A) — vue utilisateur des lignes examinées (pure, testée L68-TCO-1x).
 * Ne change AUCUN montant : seules des lignes à 0 € retenu sont masquées.
 *   1. ligne `OUT_OF_SCOPE` (autre bien) : masquée ;
 *   2. justificatif `CONSOLIDATED_ELSEWHERE` dont l'Opération a une ligne
 *      montrée : masqué, et ajouté aux justificatifs de cette ligne (la
 *      retenue de préférence) ; sans ligne montrée, il reste expliqué.
 * Les autres motifs (non qualifiée, devise, non ventilée, prévision, doublon…) restent visibles.
 */
export function tcoUserView(lines: readonly TcoEconomicLine[]): { lines: TcoUserLine[]; hidden: Record<string, TcoHiddenReason> } {
  const hidden: Record<string, TcoHiddenReason> = {};
  for (const l of lines) if (l.status === 'OUT_OF_SCOPE') hidden[l.id] = 'OTHER_ASSET';
  const out: TcoUserLine[] = lines.filter((l) => !hidden[l.id]).map((l) => ({ ...l }));
  const porteuses = new Map<number, TcoUserLine>();
  for (const l of out) {
    if (l.source !== 'OPERATION' || l.operationId == null) continue;
    const cur = porteuses.get(l.operationId);
    if (!cur || (!RETENUE(cur.status) && RETENUE(l.status))) porteuses.set(l.operationId, l);
  }
  for (const l of out) {
    if (l.source !== 'DOCUMENT' || l.status !== 'CONSOLIDATED_ELSEWHERE' || l.operationId == null) continue;
    const p = porteuses.get(l.operationId);
    if (!p) continue;
    hidden[l.id] = 'CONSOLIDATED_SHOWN';
    if (l.fileId != null && l.fileId !== p.fileId && !(p.supportingDocuments ?? []).some((d) => d.fileId === l.fileId)) {
      p.supportingDocuments = [...(p.supportingDocuments ?? []), { fileId: l.fileId, title: l.label }];
    }
  }
  return { lines: out.filter((l) => !hidden[l.id]), hidden };
}

export type TcoDto = Omit<TcoResult, 'entries' | 'lines' | 'citedOnlyDocuments'> & {
  /** Lot 68 : lignes utiles à l'utilisateur pour CE bien (`tcoUserView`), les plus utiles d'abord. */
  lines: TcoUserLine[];
  /** Lot 68 : lignes examinées non montrées sur la fiche (autre bien, justificatif déjà porté) — visibles au BO. */
  hiddenLinesCount: number;
  excludedLabels: Record<ExclusionReason, string>;
  /** Lot 61 : libellés des statuts et motifs des lignes économiques. */
  lineStatusLabels: Record<EconomicLineStatus, string>;
  lineReasonLabels: Record<EconomicLineReason, string>;
  categoryLabels: Record<TcoCategory, string>;
  /** Nombre de lignes montrables (la liste peut être tronquée à `TCO_DTO_MAX_LINES`). */
  linesTotal: number;
  /**
   * Lot 75D (J) : page de lignes transmise — position, nombre, et totaux par
   * groupe (retenues / écartées) sur TOUTES les lignes montrables ; les
   * montants (synthèse, ventilation) sont toujours calculés sur la trace
   * complète, jamais sur la page.
   */
  linesOffset: number;
  linesCount: number;
  linesTruncated: boolean;
  retainedLinesTotal: number;
  otherLinesTotal: number;
  warningLabels: string[];
  usageLabels: { categories: typeof USAGE_BUDGET_CATEGORY_LABELS; periodicities: typeof USAGE_BUDGET_PERIODICITY_LABELS };
  /** Nombre de composantes examinées (trace complète côté serveur). */
  componentsExamined: number;
};

/** Lot 75D (J) : paramètres de page (`linesOffset`, `linesLimit`) — valeurs bornées, jamais d'erreur. */
export function parseTcoLinesPage(params: { get(k: string): string | null }): { linesOffset: number; linesLimit: number } {
  const n = (v: string | null, d: number) => (v && /^\d{1,7}$/.test(v) ? Number(v) : d);
  return { linesOffset: n(params.get('linesOffset'), 0), linesLimit: Math.min(Math.max(n(params.get('linesLimit'), TCO_DTO_MAX_LINES), 1), TCO_DTO_MAX_PAGE) };
}

export function toTcoDto(t: TcoResult, page: { linesOffset?: number; linesLimit?: number } = {}): TcoDto {
  // `citedOnlyDocuments` : diagnostic BO seulement (lot 68), jamais transmis à la fiche.
  const { entries, lines: toutes, citedOnlyDocuments: _bo, ...rest } = t;
  const vue = tcoUserView(toutes);
  const lines = vue.lines;
  // Retenues d'abord, puis écartées : la liste d'un bien très documenté reste lisible. Ordre STABLE (identifiant
  // en dernier critère) : les pages successives ne se recouvrent pas.
  const rang = (s: EconomicLineStatus) => (RETENUE(s) ? 0 : 1);
  const tri = [...lines].sort((a, b) => rang(a.status) - rang(b.status) || (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id));
  const offset = Math.max(0, Math.min(page.linesOffset ?? 0, tri.length));
  const limit = Math.min(Math.max(page.linesLimit ?? TCO_DTO_MAX_LINES, 1), TCO_DTO_MAX_PAGE);
  const pageLignes = tri.slice(offset, offset + limit);
  const retenues = lines.filter((l) => RETENUE(l.status)).length;
  return {
    ...rest,
    lines: pageLignes,
    linesTotal: lines.length,
    linesOffset: offset,
    linesCount: pageLignes.length,
    linesTruncated: offset > 0 || offset + pageLignes.length < lines.length,
    retainedLinesTotal: retenues,
    otherLinesTotal: lines.length - retenues,
    hiddenLinesCount: Object.keys(vue.hidden).length,
    categoryLabels: { ...TCO_CATEGORY_LABELS },
    lineStatusLabels: { ...ECONOMIC_LINE_STATUS_LABELS },
    lineReasonLabels: { ...ECONOMIC_LINE_REASON_LABELS },
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
