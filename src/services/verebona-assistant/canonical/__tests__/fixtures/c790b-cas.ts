/**
 * Carte #790 (relance du 21/11/2026, E03) — CAS de référence des réponses déterministes.
 *
 * `produireCas()` exécute les stratégies de PRODUCTION (`structured-answers.ts`) sur des jeux fixes.
 * Le même module a servi deux fois :
 *   · AVANT le correctif (commit 7b59464, `phrases.join(' ')`), pour enregistrer la référence
 *     `c790b-avant-correctif.json` ;
 *   · APRÈS, dans `c790b-reponses-en-blocs.test.ts`, qui compare strictement les deux :
 *     mêmes montants, mêmes sources, mêmes affirmations, même stratégie, même nature de résultat.
 * Jeu de test : jamais importé par l'application.
 */
import type { TcoResult } from '@/services/business-operations/tco/model';
import { POLO, poloTco } from './c790b-polo';

export interface CasProduit {
  strategy: string;
  kind: string;
  answer: string;
  claims: Array<{ claimKey: string; text: string; sourceIds: string[]; derivation?: string }>;
  sources: Array<{ id: string; type: string; title?: string | null; content?: string | null; meta?: Record<string, unknown> }>;
}

const CLIO = { id: 7, name: 'Clio', category: 'VEHICULE', subtype: null };
const MAISON = { id: 9, name: 'Maison', category: 'IMMOBILIER', subtype: null };
const src = (id: string, title: string) => ({ id, type: 'document', title, content: title, relevanceScore: 1, meta: {} });

/** TCO « riche » : tous les indicateurs et toutes les réserves que la réponse sait dire. */
function tcoRiche(): TcoResult {
  const pret = (label: string, cents: number) => ({ label, outstanding: { status: 'ESTABLISHED', cents, asOf: '2026-10-05', label: 'Capital restant dû lu sur le tableau d’amortissement.' } });
  return poloTco({
    assetId: CLIO.id,
    status: 'PARTIAL',
    period: { start: '2021-06-15', startSource: 'ASSET_DATA', end: '2026-11-21', endSource: 'TODAY', days: 1985, startStatus: 'RESOLVED', startKind: 'PURCHASE' } as TcoResult['period'],
    summary: {
      cumulativeCostCents: 2_345_678, acquisitionCents: 1_850_000, additionalCostsCents: 495_678, acquisitionStatus: 'DOCUMENTED',
      currentValue: { cents: 900_000, date: '2026-09-01', mode: null, source: null }, netEstimatedCents: 1_445_678, netFinalCents: null,
      estimatedUsageComplementCents: 36_000, totalWithEstimatesCents: 2_381_678,
    } as TcoResult['summary'],
    breakdown: [
      { category: 'ACQUISITION', label: 'Acquisition', costsCents: 1_850_000, count: 1 },
      { category: 'MAINTENANCE', label: 'Entretien, réparations et travaux', costsCents: 312_345, count: 6 },
      { category: 'CONTRACTS', label: 'Contrats et assurances', costsCents: 210_000, count: 4 },
      { category: 'FINANCING', label: 'Financement (intérêts et frais)', costsCents: 43_333, count: 12 },
    ],
    reductionsCents: 20_000, refundsCents: 15_000, indemnitiesCents: 35_000,
    usage: { items: [], annualEstimateCents: 48_000, otherCurrencies: [], complement: null } as unknown as TcoResult['usage'],
    reliability: {
      operationsCounted: 9, documentsCounted: 3, documents: [{ fileId: 31, title: 'Facture 31' }],
      excluded: [], unconverted: [{ currency: 'CHF', amountMinor: 30_000, kind: 'REALIZED_COST' }], unallocated: { count: 1, eurCents: 12_000 }, anomalies: [], warnings: [],
    } as unknown as TcoResult['reliability'],
    indicators: {
      total: null,
      annualAverage: { documentedCents: 91_234, unavailableReason: null },
      net: { kind: 'ESTIMATED', cents: 1_445_678, documentedCents: 1_445_678, valuation: null, realizedPriceCents: null, disposalFeesCents: 0, unavailableReason: null, info: null },
      financing: {
        loans: [pret('Prêt auto', 640_000)], costToDateCents: 43_333, remainingCents: 21_000, contractualTotalCents: 64_333, estimated: true,
        basisLabel: 'selon l’échéancier du prêt', outstanding: { status: 'ESTABLISHED', cents: 640_000 },
      },
    } as unknown as TcoResult['indicators'],
  });
}

/** Bien vendu : coût net final après cession. */
function tcoCede(): TcoResult {
  return poloTco({
    assetId: CLIO.id, status: 'COMPLETE', disposed: true,
    period: { start: '2019-01-02', startSource: 'ASSET_DATA', end: '2025-05-01', endSource: 'ASSET_DATA', days: 2311, startStatus: 'RESOLVED', startKind: 'POSSESSION' } as TcoResult['period'],
    summary: {
      cumulativeCostCents: 1_200_000, acquisitionCents: 900_000, additionalCostsCents: 300_000, acquisitionStatus: 'DOCUMENTED', currentValue: null,
      netEstimatedCents: null, netFinalCents: 700_000, estimatedUsageComplementCents: 0, totalWithEstimatesCents: 1_200_000,
    } as TcoResult['summary'],
    breakdown: [
      { category: 'ACQUISITION', label: 'Acquisition', costsCents: 900_000, count: 1 },
      { category: 'MAINTENANCE', label: 'Entretien, réparations et travaux', costsCents: 300_000, count: 5 },
    ],
    disposal: { desiredPriceCents: null, estimatedValueCents: null, realizedPriceCents: 500_000, feesCents: 0, resultKind: 'FINAL', provisionalNetCents: null },
    indicators: null as unknown as TcoResult['indicators'],
  });
}

const depenses = (o: Record<string, unknown> = {}) => ({
  theme: null,
  byTheme: [
    { theme: 'maintenance', label: 'entretien', sumCents: 43_000, count: 2, fileIds: [1, 2] },
    { theme: 'repair', label: 'réparations', sumCents: 125_050, count: 1, fileIds: [3] },
    { theme: 'insurance', label: 'assurance', sumCents: 61_200, count: 1, fileIds: [4] },
  ],
  qualifiedSumCents: 229_250, qualifiedCount: 4,
  unqualified: { count: 2, sumCents: 9_900, fileIds: [5, 6], undatedCount: 0 },
  duplicates: { count: 1, fileIds: [7] }, excluded: { count: 2, byType: { QUOTE: 2 } }, complete: false,
  ...o,
});

type Scope = { assets: Array<{ id: number; name: string }>; ambiguous: boolean; unresolved: boolean; label: string | null; cardinality: string };
const portee = (assets: Array<{ id: number; name: string }>): (() => Promise<never>) => async () =>
  ({ assets, ambiguous: false, unresolved: assets.length === 0, label: assets.length === 1 ? assets[0].name : null, cardinality: assets.length === 1 ? 'SINGLE' : 'COLLECTION' } satisfies Scope) as never;

/** Exécute chaque cas par les fonctions de production ; clés stables (référence d'avant correctif). */
export async function produireCas(): Promise<Record<string, CasProduit>> {
  const s = await import('../../structured-answers');
  const cas: Record<string, unknown> = {};
  const scopeClio = { assets: [CLIO], ambiguous: false, unresolved: false, label: 'Clio' } as never;

  // ── Coût de possession (structured.ownership_cost) ──────────────────────
  cas.polo = s.ownershipCostAnswer(POLO as never, poloTco());
  cas.tco_riche = s.ownershipCostAnswer(CLIO as never, tcoRiche());
  cas.tco_cede = s.ownershipCostAnswer(CLIO as never, tcoCede());
  cas.tco_date_incertaine = s.ownershipCostAnswer(POLO as never, poloTco({
    period: { start: null, startSource: null, end: '2026-11-21', endSource: 'TODAY', days: null, startStatus: 'UNDETERMINED' } as TcoResult['period'],
  }));
  cas.verrou_bien = s.ownershipCostLockedAnswer(POLO);
  cas.verrou_sans_bien = s.ownershipCostLockedAnswer(null);

  // ── Règlements (structured.payments) ────────────────────────────────────
  const preuves = {
    proofs: [
      { fileId: 51, title: 'Virement Garage Martin', date: '2026-03-12', amountCents: 110_000, operationId: null },
      { fileId: 52, title: 'Reçu carte', date: '2026-04-02', amountCents: null, operationId: null },
    ],
    sumCents: 110_000, withoutAmount: 1,
  };
  const ctx = { pour: ' pour Clio', scopeLabel: 'Clio', assetIds: [CLIO.id], assets: [CLIO] as never };
  cas.paiements = s.paymentsAnswer(preuves, depenses() as never, ctx);
  cas.paiements_aucune_preuve = s.paymentsAnswer({ proofs: [], sumCents: 0, withoutAmount: 0 }, depenses() as never, ctx);

  // ── Sinistres, contrats, coûts d'interventions, historique ──────────────
  const sinistre = (operationId: number, label: string, o: Record<string, unknown> = {}) => ({
    operationId, label, assetIds: [CLIO.id], occurredOn: '2025-02-10', declaredOn: '2025-02-12', statusLabel: 'En cours', insurerClaimRef: `SIN-${operationId}`,
    closed: false, indemnityCents: 80_000, grossCents: 125_000, netCents: 45_000, documentIds: [operationId * 10], agendaItemId: null, ...o,
  });
  cas.sinistres = s.claimAnswer([sinistre(61, 'bris de glace'), sinistre(62, 'dégât des eaux', { indemnityCents: null, grossCents: 0, statusLabel: null, closed: true })] as never, scopeClio, [CLIO] as never);
  cas.sinistre_seul = s.claimAnswer([sinistre(61, 'bris de glace')] as never, scopeClio, [CLIO] as never);
  const contrat = (operationId: number, label: string, o: Record<string, unknown> = {}) => ({
    operationId, label, provider: 'Assureur A', reference: `C-${operationId}`, from: '2025-01-01', to: '2025-12-31', status: 'REALIZED',
    realizedCents: 61_200, forecastCents: null, assetIds: [CLIO.id], source: src(`doc_${operationId}`, `Contrat ${operationId}`), ...o,
  });
  cas.contrats = s.contractsAnswer([contrat(71, 'assurance auto'), contrat(72, 'contrat d’entretien', { provider: 'Garage Martin', realizedCents: null, forecastCents: 24_000, to: null })] as never, scopeClio);
  const cout = (operationId: number, label: string, o: Record<string, unknown> = {}) => ({
    operationId, label, date: '2026-03-02', provider: 'Garage Martin', costCents: 125_050, indemnityCents: 0, forecastCents: 0, foreign: [], unattributedCents: 0,
    status: 'REALIZED', source: src(`doc_${operationId}`, `Facture ${operationId}`), ...o,
  });
  cas.couts = s.operationCostAnswer([cout(81, 'réparation de l’embrayage'), cout(82, 'réparation du toit', { costCents: 310_000, indemnityCents: 100_000, date: null })] as never, scopeClio);
  cas.cout_seul = s.operationCostAnswer([cout(81, 'réparation de l’embrayage')] as never, scopeClio);
  const entree = (label: string, date: string | null, amountCents: number | null) => ({
    date, theme: 'repair', kind: 'operation', label, amountCents, status: null, provider: 'Garage Martin', operationId: 1, fileId: null, source: src(`doc_h_${label.length}`, label),
  });
  cas.historique = s.historyAnswer(CLIO as never, [entree('Remplacement embrayage', '2026-03-02', 125_050), entree('Vidange', null, 9_900)] as never, null);

  // ── Par la cascade (`tryCanonicalStructured`), ports simulés ────────────
  const demander = async (message: string, port: Record<string, unknown>, assets: Array<{ id: number; name: string }>) =>
    s.tryCanonicalStructured({ port: { today: () => '2026-11-21', listAssets: async () => assets, ...port } as never, accountId: 1, message, resolveScope: portee(assets) });
  cas.depenses_par_theme = await demander('Combien ai-je dépensé pour Clio ?', { sumQualifiedExpenses: async () => depenses() }, [CLIO]);
  cas.depenses_un_theme = await demander('Combien ai-je dépensé en entretien pour Clio ?', {
    sumQualifiedExpenses: async () => depenses({ theme: 'maintenance', byTheme: [{ theme: 'maintenance', label: 'entretien', sumCents: 43_000, count: 2, fileIds: [1, 2] }], qualifiedSumCents: 43_000, qualifiedCount: 2 }),
  }, [CLIO]);
  cas.depenses_complet = await demander('Combien ai-je dépensé en entretien pour Clio ?', {
    sumQualifiedExpenses: async () => depenses({
      theme: 'maintenance', byTheme: [{ theme: 'maintenance', label: 'entretien', sumCents: 43_000, count: 2, fileIds: [1, 2] }], qualifiedSumCents: 43_000, qualifiedCount: 2,
      unqualified: { count: 0, sumCents: 0, fileIds: [], undatedCount: 0 }, duplicates: { count: 0, fileIds: [] }, excluded: { count: 0, byType: {} }, complete: true,
    }),
  }, [CLIO]);
  cas.manquants = await demander('Qu’est-ce qui manque sur mes fiches ?', {
    listMissingInformation: async () => [
      { assetId: CLIO.id, assetName: 'Clio', missing: [{ key: 'mileage', label: 'Kilométrage' }, { key: 'acquisitionDate', label: 'Date d’achat' }], toProcess: [] },
      { assetId: MAISON.id, assetName: 'Maison', missing: [{ key: 'acquisitionPrice', label: 'Prix d’achat' }], toProcess: [{ id: 1 }] },
    ],
  }, [CLIO, MAISON]);
  cas.echeances = await demander('Quelles échéances arrivent bientôt ?', {
    listUpcomingAgenda: async () => [
      { id: 91, title: 'Contrôle technique', date: '2026-12-01', forecast: false, assetNames: ['Clio'] },
      { id: 92, title: 'Assurance habitation', date: '2026-12-15', forecast: true, assetNames: ['Maison'] },
    ],
  }, [CLIO, MAISON]);
  const achat = { priceCents: 1_850_000, date: '2021-06-15', foreign: [], source: src('operation_9', 'Achat'), documentPrices: [{ title: 'Bon de commande', amountMinor: 1_870_000, currency: 'EUR' }], fees: [{ title: 'Carte grise', amountMinor: 31_000, currency: 'EUR' }] };
  cas.cout_large_premium = await demander('Combien m’a coûté ma Clio ?', {
    readAcquisition: async () => achat, ownershipCostAllowed: async () => true, readOwnershipCost: async () => tcoRiche(), readAssetField: async () => null,
    sumQualifiedExpenses: async () => depenses(),
  }, [CLIO]);
  cas.cout_large_standard = await demander('Combien m’a coûté ma Clio ?', {
    readAcquisition: async () => achat, ownershipCostAllowed: async () => false, readOwnershipCost: async () => { throw new Error('jamais lu hors offre'); }, readAssetField: async () => null,
    sumQualifiedExpenses: async () => depenses(),
  }, [CLIO]);
  cas.achat_et_depenses = await demander('J’ai payé combien pour la Clio ?', {
    readAcquisition: async () => achat, readPayments: async () => preuves, readAssetField: async () => null, sumQualifiedExpenses: async () => depenses(),
  }, [CLIO]);
  cas.verrou_question = await demander('Quel est le coût de possession de Polo ?', {
    ownershipCostAllowed: async () => false, readOwnershipCost: async () => { throw new Error('jamais lu hors offre'); },
  }, [POLO]);
  cas.polo_question = await demander('Quel est le coût de possession de Polo ?', {
    ownershipCostAllowed: async () => true, readOwnershipCost: async () => poloTco(),
  }, [POLO]);

  for (const [k, v] of Object.entries(cas)) {
    if (!v || typeof v !== 'object' || !('strategy' in v)) throw new Error(`cas ${k} : aucune réponse structurée (${JSON.stringify(v)?.slice(0, 200)})`);
  }
  return JSON.parse(JSON.stringify(cas)) as Record<string, CasProduit>;
}
