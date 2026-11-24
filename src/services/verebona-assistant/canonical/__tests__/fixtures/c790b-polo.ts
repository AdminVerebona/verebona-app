/**
 * Carte #790 (relance du 21/11/2026, E03) — jeu « Polo » : les montants EXACTS de la carte.
 *   2 476,41 € de coût cumulé documenté = 559,51 € (entretien, réparations, travaux)
 *   + 1 115,53 € (contrats, assurances) + 801,37 € (autres) ;
 *   pas de date d'achat (moyenne annuelle non calculable), pas de valeur actuelle admissible
 *   (coût net estimé non calculable), coût d'acquisition inconnu (total possiblement incomplet).
 * Forme : celle que rend le moteur TCO (`TcoResult`) ; seuls les champs lus par la réponse de
 * l'Assistant sont renseignés (jeu de test, jamais importé par l'application).
 */
import type { TcoResult } from '@/services/business-operations/tco/model';

export const POLO = { id: 41, name: 'Polo', category: 'VEHICULE', subtype: null };

export const POLO_MONTANTS = { total: 247_641, entretien: 55_951, contrats: 111_553, autres: 80_137 } as const;

export const MOTIF_MOYENNE_POLO = 'Date d’achat du bien inconnue : renseignez-la sur la fiche pour calculer la moyenne.';
export const MOTIF_NET_POLO = 'Aucune estimation de valeur admissible postérieure à l’achat.';

export function poloTco(over: Partial<TcoResult> = {}): TcoResult {
  const base = {
    assetId: POLO.id,
    status: 'INCOMPLETE',
    disposed: false,
    period: { start: null, startSource: null, end: '2026-11-21', endSource: 'TODAY', days: null, startStatus: 'MISSING' },
    summary: {
      cumulativeCostCents: POLO_MONTANTS.total, acquisitionCents: 0, additionalCostsCents: POLO_MONTANTS.total,
      acquisitionStatus: 'MISSING', currentValue: null, netEstimatedCents: null, netFinalCents: null,
      estimatedUsageComplementCents: 0, totalWithEstimatesCents: POLO_MONTANTS.total,
    },
    breakdown: [
      { category: 'MAINTENANCE', label: 'Entretien, réparations et travaux', costsCents: POLO_MONTANTS.entretien, count: 3 },
      { category: 'CONTRACTS', label: 'Contrats et assurances', costsCents: POLO_MONTANTS.contrats, count: 2 },
      { category: 'OTHER', label: 'Autres coûts', costsCents: POLO_MONTANTS.autres, count: 2 },
    ],
    reductionsCents: 0, refundsCents: 0, indemnitiesCents: 0,
    disposal: { desiredPriceCents: null, estimatedValueCents: null, realizedPriceCents: null, feesCents: 0, resultKind: 'NONE', provisionalNetCents: null },
    usage: { items: [], annualEstimateCents: 0, otherCurrencies: [], complement: null },
    reliability: {
      operationsCounted: 0, documentsCounted: 7,
      documents: [11, 12, 13, 14, 15, 16, 17].map((fileId) => ({ fileId, title: `Justificatif ${fileId}` })),
      excluded: [], unconverted: [], unallocated: { count: 0, eurCents: 0 }, anomalies: [], warnings: ['ACQUISITION_DATE_MISSING', 'ACQUISITION_COST_MISSING'],
    },
    lines: [], entries: [], annual: null,
    indicators: {
      total: null,
      annualAverage: { documentedCents: null, unavailableReason: MOTIF_MOYENNE_POLO },
      net: { kind: 'ESTIMATED', cents: null, documentedCents: null, valuation: null, realizedPriceCents: null, disposalFeesCents: 0, unavailableReason: MOTIF_NET_POLO, info: MOTIF_NET_POLO },
      financing: { loans: [], costToDateCents: 0, remainingCents: 0, contractualTotalCents: null, estimated: false, basisLabel: null, outstanding: null },
    },
  };
  return { ...(base as unknown as TcoResult), ...over };
}
