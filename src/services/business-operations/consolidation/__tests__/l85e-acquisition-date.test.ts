/**
 * Lot 85E — acquisition RÉALISÉE sans date alors que la date d'acquisition
 * canonique du bien est connue (ticket PO P1 du 23/10/2026).
 *
 * Règles pures : la garde anti-blanchiment ASSET_DATA reste entière pour
 * CRÉER (valeur humaine seulement) ; une date canonique d'origine
 * automatique (T1, T3, document, import) ENRICHIT seulement une Opération
 * ACQUISITION existante sans date — provenance conservée (78A), contradiction
 * tracée (règles T3, jamais d'écrasement), jamais une preuve d'existence.
 *
 *   L85E-U-01  date automatique seule : aucune réalité « création » ; fait
 *              d'enrichissement (date + origine) seulement sur demande ;
 *   L85E-U-02  prix saisi + date automatique : date de création vide, date
 *              canonique portée par le fait d'enrichissement ;
 *   L85E-U-03  Opération réalisée sans date → la date canonique est posée,
 *              provenance = source ASSET_DATA + origine de la valeur ;
 *   L85E-U-04  Opération déjà datée (même date ou dans la fenêtre) → inchangée,
 *              aucune contradiction ;
 *   L85E-U-05  date contradictoire (hors fenêtre) → date conservée, contradiction
 *              tracée (arbitrage 83A), aucun écrasement ;
 *   L85E-U-06  Opération envisagée, date future, date non normalisée → rien ;
 *   L85E-U-07  une contribution d'enrichissement seule ne prouve ni l'existence,
 *              ni le statut, ni un montant ;
 *   L85E-U-08  état de réconciliation : jamais « à jour » pour une acquisition
 *              réalisée sans date quand une date canonique exploitable existe.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const {
  applyStructuredAuthority, assetDataFacts, assetDataContribution, canonicalAcquisitionDate, isEnrichmentOnly,
} = await import('../asset-data');
const { buildCandidateIdentity, consolidateOperationState, computeProvenance } = await import('../model');
const { reconciliationView } = await import('../../diagnostics/model');
type AssetDataRow = import('../asset-data').AssetDataRow;

const TODAY = '2026-10-24';
function bien(kc: Record<string, unknown> = {}, over: Partial<AssetDataRow> = {}): AssetDataRow {
  return { id: 7, account_id: 1, category: 'VEHICULE', key_characteristics: JSON.stringify(kc), status: 'EN_SERVICE', status_changed_at: null, ...over } as AssetDataRow;
}
const valeur = (k: string, v: unknown, origin = 'USER') => ({ [k]: v, [`${k}__origin`]: origin });

const doc = (realizedDate: string | null, amountMinor = 1849050, sourceId = 1) => ({
  sourceId,
  identity: buildCandidateIdentity({
    id: sourceId, accountId: 1, fileId: 50, candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'ACQUISITION',
    statusHint: 'REALIZED', summary: 'Achat', payload: {
      sourceRoleHint: 'INVOICE', temporalHints: { realizedDate },
      financialHints: [{ role: 'REALIZED_COST', amountMinor, currency: 'EUR', amountScope: 'TOTAL' }],
    },
  }, { fileAssetId: 7, liveAssetIds: new Set([7]), equipmentAssets: new Map() }),
});
const etat = (sources: Parameters<typeof consolidateOperationState>[1], type: 'ACQUISITION' | 'DISPOSAL' = 'ACQUISITION') => {
  const probantes = sources.filter((s) => !isEnrichmentOnly(s));
  const s = applyStructuredAuthority(consolidateOperationState(type, probantes, TODAY), sources, TODAY);
  return { ...s, provenance: computeProvenance(s, sources) };
};

describe('L85E — garde de CRÉATION inchangée, enrichissement distinct', () => {
  it('L85E-U-01 date automatique seule (T1 / T3 / document / import) : aucune réalité pour créer ; fait d’enrichissement sur demande', () => {
    for (const origin of ['DOCUMENT_EXTRACTION', 'RECONCILIATION', 'SYSTEM_RULE', 'IMPORT']) {
      const row = bien(valeur('acquisitionDate', '2021-03-01', origin));
      expect(assetDataFacts(row).ACQUISITION, origin).toBeNull();
      expect(canonicalAcquisitionDate(row), origin).toEqual({ date: '2021-03-01', origin });
      expect(assetDataFacts(row, { enrichment: true }).ACQUISITION, origin).toEqual({
        nature: 'ACQUISITION', date: null, dateBasis: null, amountMinor: null, provider: null, reference: null,
        canonicalDate: { date: '2021-03-01', origin }, enrichmentOnly: true,
      });
    }
    // Une date humaine n'est pas un « enrichissement » : c'est la date du fait (règle lot 43).
    expect(canonicalAcquisitionDate(bien(valeur('acquisitionDate', '2021-03-01')))).toBeNull();
    // Véhicule en LLD : aucune acquisition, même pour enrichir (C13).
    expect(assetDataFacts(bien({ ...valeur('acquisitionDate', '2021-03-01', 'RECONCILIATION'), ...valeur('vehicleOwnershipStatus', 'LLD') }), { enrichment: true }).ACQUISITION).toBeNull();
  });

  it('L85E-U-02 prix saisi + date automatique : la création ne reçoit aucune date automatique ; l’enrichissement la porte', () => {
    const row = bien({ ...valeur('acquisitionPrice', 18490.5), ...valeur('acquisitionDate', '2021-03-01', 'DOCUMENT_EXTRACTION') });
    expect(assetDataFacts(row).ACQUISITION).toEqual({ nature: 'ACQUISITION', date: null, dateBasis: null, amountMinor: 1849050, provider: null, reference: null });
    const f = assetDataFacts(row, { enrichment: true }).ACQUISITION!;
    expect(f).toMatchObject({ date: null, amountMinor: 1849050, canonicalDate: { date: '2021-03-01', origin: 'DOCUMENT_EXTRACTION' } });
    expect(f.enrichmentOnly).toBeUndefined();
    const c = assetDataContribution(2, row, 'ACQUISITION')!;
    // Jamais dans les dates de l'identité (qui fondent statut, fenêtres et contradictions documentaires).
    expect(c.identity.dates.realizedDate).toBeNull();
    expect(c.identity.hints).toEqual([expect.objectContaining({ amountMinor: 1849050, economicDate: null })]);
    expect(c.identity.structured).toMatchObject({ nature: 'ACQUISITION', canonicalDate: { date: '2021-03-01', origin: 'DOCUMENT_EXTRACTION' } });
  });
});

describe('L85E — enrichissement d’une Opération ACQUISITION existante', () => {
  const saisiePrix = (origin = 'RECONCILIATION', date = '2021-03-01') =>
    assetDataContribution(2, bien({ ...valeur('acquisitionPrice', 18490.5), ...valeur('acquisitionDate', date, origin) }), 'ACQUISITION')!;
  const dateSeule = (origin = 'DOCUMENT_EXTRACTION', date = '2021-03-01', sourceId = 3) =>
    assetDataContribution(sourceId, bien(valeur('acquisitionDate', date, origin)), 'ACQUISITION')!;

  it('L85E-U-03 réalisée sans date → date canonique posée ; provenance : source ASSET_DATA et origine de la valeur', () => {
    const s = etat([saisiePrix()]);
    expect(s).toMatchObject({ status: 'REALIZED', realizedDate: '2021-03-01', attributeConflicts: [] });
    expect(s.provenance.realizedDate).toEqual({ sourceId: 2, value: '2021-03-01', origin: 'RECONCILIATION' });
    // Opération documentaire sans date + date T1 de la fiche (source d'enrichissement seule).
    const d = etat([doc(null), dateSeule()]);
    expect(d).toMatchObject({ status: 'REALIZED', realizedDate: '2021-03-01', attributeConflicts: [] });
    expect(d.provenance.realizedDate).toEqual({ sourceId: 3, value: '2021-03-01', origin: 'DOCUMENT_EXTRACTION' });
    // Un seul prix (celui du document) : l'enrichissement n'apporte aucun montant.
    expect(d.components.map((c) => [c.kind, c.amountMinor, c.sourceIds])).toEqual([['REALIZED_COST', 1849050, [1]]]);
  });

  it('L85E-U-04 déjà datée (même date, ou écart dans la fenêtre de l’achat) → inchangée, aucune contradiction', () => {
    expect(etat([doc('2021-03-01'), dateSeule()])).toMatchObject({ realizedDate: '2021-03-01', attributeConflicts: [] });
    const proche = etat([doc('2021-03-20'), dateSeule()]);
    expect(proche).toMatchObject({ realizedDate: '2021-03-20', attributeConflicts: [] });
    expect(proche.provenance.realizedDate).toEqual({ sourceId: 1, value: '2021-03-20' });
  });

  it('L85E-U-05 date contradictoire → la date existante est conservée, la contradiction est tracée (arbitrage existant)', () => {
    const s = etat([doc('2019-06-01'), dateSeule('RECONCILIATION', '2021-03-01')]);
    expect(s.realizedDate).toBe('2019-06-01');
    expect(s.attributeConflicts).toEqual([{
      field: 'realizedDate', retained: '2019-06-01',
      values: [{ value: '2019-06-01', sourceIds: [1] }, { value: '2021-03-01', sourceIds: [3] }],
    }]);
    // Contradiction documentaire déjà tracée : la date canonique s'y ajoute (une seule contradiction).
    const t = etat([doc('2019-06-01'), doc('2020-09-01', 1849050, 4), dateSeule('RECONCILIATION', '2021-03-01')]);
    expect(t.attributeConflicts.filter((c) => c.field === 'realizedDate')).toHaveLength(1);
    expect(t.attributeConflicts[0].values.map((v) => v.value)).toEqual(['2019-06-01', '2020-09-01', '2021-03-01']);
    expect(t.realizedDate).toBe('2019-06-01');
  });

  it('L85E-U-06 envisagée, date future, valeur non normalisée → aucune date posée', () => {
    const envisagee = { sourceId: 1, identity: { ...doc(null).identity, status: 'ENVISAGED' as const } };
    expect(etat([envisagee, dateSeule()]).realizedDate).toBeNull();
    expect(etat([doc(null), dateSeule('DOCUMENT_EXTRACTION', '2027-01-01')]).realizedDate).toBeNull();
    // Normalisée par le registre canonique (JJ/MM/AAAA → AAAA-MM-JJ) : exploitable ; texte libre : non.
    expect(canonicalAcquisitionDate(bien(valeur('acquisitionDate', '01/03/2021', 'DOCUMENT_EXTRACTION')))).toEqual({ date: '2021-03-01', origin: 'DOCUMENT_EXTRACTION' });
    expect(canonicalAcquisitionDate(bien(valeur('acquisitionDate', 'printemps 2021', 'DOCUMENT_EXTRACTION')))).toBeNull();
    expect(canonicalAcquisitionDate(bien(valeur('acquisitionDate', '2021-02-30', 'DOCUMENT_EXTRACTION')))).toBeNull();
  });

  it('L85E-U-07 une contribution d’enrichissement seule ne prouve ni existence, ni statut, ni montant', () => {
    const c = dateSeule();
    expect(isEnrichmentOnly(c)).toBe(true);
    expect(isEnrichmentOnly(saisiePrix())).toBe(false);
    expect(c.identity.hints).toEqual([]);
    expect(c.identity.dates).toEqual({ plannedDate: null, startDate: null, realizedDate: null, endDate: null });
    // Seule : l'état ne la voit pas (aucune réalisation prouvée → pas de date).
    expect(etat([c])).toMatchObject({ status: 'ENVISAGED', realizationProven: false, realizedDate: null, components: [] });
  });
});

describe('L85E — état de réconciliation (diagnostic BO)', () => {
  it('L85E-U-08 jamais « à jour » quand une acquisition réalisée reste sans date alors que la fiche la connaît', () => {
    const base = { pending: 0, blocked: 0, lastReconciledAt: '2026-10-24T08:00:00Z', active: true };
    expect(reconciliationView(base).state).toBe('A_JOUR');
    const v = reconciliationView({ ...base, knownDateMissing: true });
    expect(v.state).toBe('EN_ATTENTE');
    expect(v.label).toContain('date d’acquisition connue sur la fiche du bien');
  });
});

describe('L85E — registre de cohérence (C-Q11)', () => {
  it('L85E-U-09 COH-OPS-ACQUISITION-DATE actif, ajouté après les contrôles du lot 84 (sans réordonner), couvert « operations » et « biens »', async () => {
    const { COHERENCE_REGISTRY, getCheck, activeChecks } = await import('@/services/coherence/registry');
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    const ordre = COHERENCE_REGISTRY.map((x) => x.id);
    expect(ordre.indexOf('COH-OPS-ACQUISITION-DATE')).toBeGreaterThan(ordre.indexOf('COH-OPS-RECURRING-SERIES'));
    expect(activeChecks().map((c) => c.id)).toContain('COH-OPS-ACQUISITION-DATE');
    const c = getCheck('COH-OPS-ACQUISITION-DATE')!;
    expect(c).toMatchObject({ version: 1, status: 'ACTIVE', objectType: 'operation', domain: 'operations' });
    expect(c.services).toEqual(expect.arrayContaining([
      'business-operations/consolidation/asset-data-consolidator#consolidateAssetData', 'business-operations/agenda-projection/service#projectAccountOperations',
    ]));
    expect(c.forbiddenRepairs).toEqual(expect.arrayContaining(['créer une Opération depuis une date automatique', 'écraser une date existante', 'créer un second événement Achat']));
    for (const d of ['operations', 'biens']) expect(COVERAGE_INVENTORY.find((e) => e.domain === d)!.checks).toContain('COH-OPS-ACQUISITION-DATE');
  });
});
