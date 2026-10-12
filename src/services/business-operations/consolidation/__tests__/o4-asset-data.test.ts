/**
 * Lot 43 (O4) — sources ASSET_DATA : données structurées du bien → Opérations
 * (règles pures). CDC Opérations V1 C2, C5, C7.1, C7.3, C7.6, C11.1, C18,
 * B13.1, B13.3, B13.6, B18 ; décisions PO Q5, Q6, Q12. Un test par règle :
 * O4-xx, cas F-xxx du CDC cités.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const {
  applyStructuredAuthority, assetDataFacts, assetDataIdentity, assetDataFingerprint, assetDataContribution, parisDay,
  OPERATION_ASSET_DATA_KEYS,
} = await import('../asset-data');
const { decideCandidate } = await import('../matching');
const { buildCandidateIdentity, consolidateOperationState } = await import('../model');
type ExistingOperation = import('../matching').ExistingOperation;
type AssetDataRow = import('../asset-data').AssetDataRow;

function bien(kc: Record<string, unknown> = {}, over: Partial<AssetDataRow> = {}): AssetDataRow {
  return { id: 7, account_id: 1, category: 'VEHICULE', key_characteristics: JSON.stringify(kc), status: 'EN_SERVICE', status_changed_at: null, ...over } as AssetDataRow;
}
const humain = (k: string, v: unknown, origin = 'USER') => ({ [k]: v, [`${k}__origin`]: origin });

function op(over: Partial<ExistingOperation> = {}): ExistingOperation {
  return {
    id: 100, typeCode: 'ACQUISITION', status: 'REALIZED', providerKey: null, assetIds: [7], refs: [],
    plannedDate: null, startDate: null, realizedDate: '2021-03-01', endDate: null, ...over,
  };
}
const ctx = (operations: ExistingOperation[], status = 'EN_SERVICE') => ({
  operations, confirmed: new Set<number>(), rejected: new Set<number>(), assetStatus: new Map([[7, status]]),
});

describe('O4 — réalités établies par la fiche (C2, garde anti-blanchiment)', () => {
  it('O4-01 / F-178 / B13.1 achat saisi (date et prix) → ACQUISITION, prix en centimes EUR', () => {
    const f = assetDataFacts(bien({ ...humain('acquisitionDate', '2021-03-01'), ...humain('acquisitionPrice', 18490.5) }));
    expect(f.ACQUISITION).toEqual({ nature: 'ACQUISITION', date: '2021-03-01', dateBasis: 'FIELD', amountMinor: 1849050, provider: null, reference: null });
    expect(f.DISPOSAL).toBeNull();
    expect(f.CONTRACT).toBeNull();
    // Date seule ou prix seul suffisent (C5 : « date / montant peuvent rester partiels »).
    expect(assetDataFacts(bien(humain('acquisitionPrice', 900))).ACQUISITION?.amountMinor).toBe(90000);
    // Colonne historique sans origine tracée : protégée comme une saisie (readOrigin → USER).
    expect(assetDataFacts(bien({}, { purchase_date: '2019-05-02' } as never)).ACQUISITION?.date).toBe('2019-05-02');
  });

  it('O4-02 / C2 anti-blanchiment : une valeur écrite automatiquement (T1, T3, règle système) ne crée rien', () => {
    for (const origin of ['DOCUMENT_EXTRACTION', 'RECONCILIATION', 'SYSTEM_RULE', 'IMPORT']) {
      const f = assetDataFacts(bien({
        ...humain('acquisitionDate', '2021-03-01', origin), ...humain('acquisitionPrice', 1000, origin),
        ...humain('insurer', 'MAAF', origin), ...humain('insuranceContractNumber', 'AU-1', origin),
      }));
      expect(f, origin).toEqual({ ACQUISITION: null, DISPOSAL: null, CONTRACT: null });
    }
    // ADMIN (correction du back-office) est une origine humaine.
    expect(assetDataFacts(bien(humain('acquisitionPrice', 10, 'ADMIN'))).ACQUISITION?.amountMinor).toBe(1000);
    // Mixte : seule la valeur humaine compte.
    expect(assetDataFacts(bien({ ...humain('acquisitionDate', '2021-03-01'), ...humain('acquisitionPrice', 5, 'RECONCILIATION') })).ACQUISITION)
      .toMatchObject({ date: '2021-03-01', amountMinor: null });
  });

  it('O4-03 / F-019 / C7.6 / C11.1 VENDU : DISPOSAL ; date de vente saisie, sinon date du passage au statut (Paris)', () => {
    const vendu = assetDataFacts(bien({ ...humain('saleDate', '2026-09-30'), ...humain('salePrice', 12000) }, { status: 'VENDU', status_changed_at: '2026-10-11T22:30:00Z' }));
    expect(vendu.DISPOSAL).toEqual({ nature: 'DISPOSAL', date: '2026-09-30', dateBasis: 'FIELD', amountMinor: 1200000, provider: null, reference: null, disposalKind: 'SALE' });
    const sansDate = assetDataFacts(bien({}, { status: 'VENDU', status_changed_at: '2026-10-11T22:30:00Z' }));
    expect(sansDate.DISPOSAL).toMatchObject({ date: '2026-10-12', dateBasis: 'STATUS_CHANGE', amountMinor: null });
    expect(parisDay('2026-10-11T22:30:00Z')).toBe('2026-10-12');
    // Bien vendu avant le lot (date inconnue) : jamais inventée.
    expect(assetDataFacts(bien({}, { status: 'VENDU' })).DISPOSAL).toMatchObject({ date: null, dateBasis: null });
  });

  it('O4-04 / Q5 TRANSMIS : cession SANS prix, même si un prix traîne sur la fiche', () => {
    const f = assetDataFacts(bien({ ...humain('saleDate', '2026-08-01'), ...humain('salePrice', 5000) }, { status: 'TRANSMIS' }));
    expect(f.DISPOSAL).toMatchObject({ date: '2026-08-01', amountMinor: null, disposalKind: 'TRANSMISSION' });
    expect(assetDataIdentity(7, f.DISPOSAL!).hints).toEqual([]);
  });

  it('O4-05 / Q6 / C23.1 CONTRACT seulement si l\'assureur ET le n° de contrat sont saisis', () => {
    expect(assetDataFacts(bien(humain('insurer', 'MAAF'))).CONTRACT).toBeNull();
    expect(assetDataFacts(bien(humain('insuranceContractNumber', 'AU-559201'))).CONTRACT).toBeNull();
    expect(assetDataFacts(bien({ ...humain('insurer', 'MAAF'), ...humain('insuranceContractNumber', '   ') })).CONTRACT).toBeNull();
    const f = assetDataFacts(bien({ ...humain('insurer', 'MAAF Assurances'), ...humain('insuranceContractNumber', 'AU-559201') }));
    expect(f.CONTRACT).toEqual({ nature: 'CONTRACT', date: null, dateBasis: null, amountMinor: null, provider: 'MAAF Assurances', reference: 'AU-559201' });
    const id = assetDataIdentity(7, f.CONTRACT!, { forMatching: true });
    expect(id.refs.map((r) => `${r.kind}:${r.normalized}`)).toEqual(['POLICY:AU559201', 'CONTRACT:AU559201']);
    expect(assetDataIdentity(7, f.CONTRACT!).refs.map((r) => r.kind)).toEqual(['POLICY']);
    expect(id.dates).toEqual({ plannedDate: null, startDate: null, realizedDate: null, endDate: null });
  });

  it('O4-06 / C13 véhicule en LLD / LOA / prêt : pas d\'entrée en possession, aucune ACQUISITION', () => {
    for (const statut of ['LLD', 'LOA', 'PRET_GRATUIT']) {
      expect(assetDataFacts(bien({ ...humain('acquisitionPrice', 30000), ...humain('vehicleOwnershipStatus', statut) })).ACQUISITION, statut).toBeNull();
    }
    expect(assetDataFacts(bien({ ...humain('acquisitionPrice', 30000), ...humain('vehicleOwnershipStatus', 'CREDIT') })).ACQUISITION).not.toBeNull();
  });

  it('O4-07 / F-018 / B18 / C18 / Q12 prix souhaité et valeur estimée : jamais une Opération', () => {
    const f = assetDataFacts(bien({ ...humain('estimatedValue', 15000), ...humain('listingPrice', 16000), desiredSalePriceCents: 1600000 }));
    expect(f).toEqual({ ACQUISITION: null, DISPOSAL: null, CONTRACT: null });
    // Bien EN SERVICE avec un prix de vente saisi par erreur : pas de cession sans statut VENDU.
    expect(assetDataFacts(bien(humain('salePrice', 9000))).DISPOSAL).toBeNull();
  });

  it('O4-08 empreinte stable (rejouée = même repère) et sensible aux données', () => {
    const a = assetDataFacts(bien(humain('acquisitionPrice', 900)));
    expect(assetDataFingerprint(a, 'EN_SERVICE')).toBe(assetDataFingerprint(assetDataFacts(bien(humain('acquisitionPrice', 900))), 'EN_SERVICE'));
    expect(assetDataFingerprint(a, 'EN_SERVICE')).not.toBe(assetDataFingerprint(assetDataFacts(bien(humain('acquisitionPrice', 901))), 'EN_SERVICE'));
    expect(assetDataFingerprint(a, 'EN_SERVICE')).not.toBe(assetDataFingerprint(a, 'VENDU'));
  });

  it('O4-09 TRG-008 à TRG-010 : clés de la fiche qui réévaluent les Opérations', () => {
    expect([...OPERATION_ASSET_DATA_KEYS].sort()).toEqual(
      ['acquisitionDate', 'acquisitionPrice', 'insuranceContractNumber', 'insurer', 'saleDate', 'salePrice', 'vehicleOwnershipStatus']);
  });
});

describe('O4 — rapprochement C7 avec les Opérations documentaires (jamais de doublon)', () => {
  const achat = (kc: Record<string, unknown>) => assetDataIdentity(7, assetDataFacts(bien(kc)).ACQUISITION!, { forMatching: true });

  it('O4-10 / F-044 / C7.1 achat saisi + ACQUISITION documentaire du même cycle → MATCH (M2), pas de création', () => {
    const d = decideCandidate(achat(humain('acquisitionPrice', 18000)), ctx([op()]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 100, matchMethod: 'M2' });
    expect(decideCandidate(achat(humain('acquisitionDate', '2021-03-01')), ctx([op({ realizedDate: null })])).operationId).toBe(100);
  });

  it('O4-11 / F-045 achat saisi daté APRÈS une cession réalisée → nouveau cycle, nouvelle ACQUISITION', () => {
    const cession = op({ id: 101, typeCode: 'DISPOSAL', realizedDate: '2023-01-01' });
    expect(decideCandidate(achat(humain('acquisitionDate', '2024-06-01')), ctx([op(), cession])).outcome).toBe('CREATE_NEW');
  });

  it('O4-12 / F-042 / C7.6 bien VENDU + DISPOSAL documentaire (acte de vente) → même Cession', () => {
    const f = assetDataFacts(bien({}, { status: 'VENDU', status_changed_at: '2026-10-01T10:00:00Z' })).DISPOSAL!;
    const d = decideCandidate(assetDataIdentity(7, f), ctx([op({ typeCode: 'DISPOSAL', realizedDate: '2026-09-28' })], 'VENDU'));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', matchMethod: 'M2' });
    // Sans Cession : création permise sur un bien VENDU (seule la Cession l'est, C5 / lot 41).
    expect(decideCandidate(assetDataIdentity(7, f), ctx([], 'VENDU')).outcome).toBe('CREATE_NEW');
  });

  it('O4-13 / F-035 / C7.3 même police (référence extraite POLICY ou CONTRACT) → même CONTRACT ; même assureur sans référence → aucune création (P06)', () => {
    const f = assetDataFacts(bien({ ...humain('insurer', 'MAAF'), ...humain('insuranceContractNumber', 'AU-559201') })).CONTRACT!;
    const id = assetDataIdentity(7, f, { forMatching: true });
    const contrat = (refs: ExistingOperation['refs']) => op({ typeCode: 'CONTRACT', providerKey: 'maaf', realizedDate: null, refs });
    expect(decideCandidate(id, ctx([contrat([{ kind: 'CONTRACT', normalized: 'AU559201' }])])).operationId).toBe(100);
    expect(decideCandidate(id, ctx([contrat([{ kind: 'POLICY', normalized: 'AU559201' }])])).operationId).toBe(100);
    expect(decideCandidate(id, ctx([contrat([])]))).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED' });
    expect(decideCandidate(id, ctx([contrat([{ kind: 'POLICY', normalized: 'AUTRE1' }])])).outcome).toBe('CREATE_NEW');
    // Bien sorti du portefeuille : relation actuelle non certaine, aucun contrat créé.
    expect(decideCandidate(id, ctx([], 'VENDU')).outcome).toBe('HOLD_UNRESOLVED');
  });
});

describe('O4 — autorité de la saisie sur le fait qu\'elle porte (9.3, C12.1)', () => {
  const doc = (amountMinor: number, realizedDate: string | null = '2021-03-02') => ({
    sourceId: 1,
    identity: buildCandidateIdentity({
      id: 1, accountId: 1, fileId: 50, candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'ACQUISITION',
      statusHint: 'REALIZED', summary: 'Achat', payload: {
        sourceRoleHint: 'INVOICE', temporalHints: { realizedDate },
        financialHints: [{ role: 'REALIZED_COST', amountMinor, currency: 'EUR', amountScope: 'TOTAL' }],
      },
    }, { fileAssetId: 7, liveAssetIds: new Set([7]), equipmentAssets: new Map() }),
  });
  const saisie = (kc: Record<string, unknown>, over: Partial<AssetDataRow> = {}) => {
    const row = bien(kc, over);
    const nature = assetDataFacts(row).DISPOSAL ? 'DISPOSAL' : 'ACQUISITION';
    return assetDataContribution(2, row, nature)!;
  };
  const etat = (sources: Parameters<typeof consolidateOperationState>[1], type: 'ACQUISITION' | 'DISPOSAL' = 'ACQUISITION') =>
    applyStructuredAuthority(consolidateOperationState(type, sources, '2026-10-12'), sources);

  it('O4-14 / F-044 achat saisi + facture d\'achat de même montant → UNE composante soutenue par les deux sources', () => {
    const s = etat([doc(1849050), saisie({ ...humain('acquisitionDate', '2021-03-01'), ...humain('acquisitionPrice', 18490.5) })]);
    expect(s.components.map((c) => [c.kind, c.amountMinor, c.sourceIds])).toEqual([['REALIZED_COST', 1849050, [1, 2]]]);
    // Date : la saisie prime sur la date du document (correction explicite).
    expect(s.realizedDate).toBe('2021-03-01');
  });

  it('O4-15 montants différents → la saisie prime, jamais deux prix pour un même achat', () => {
    const s = etat([doc(1900000), saisie(humain('acquisitionPrice', 18490.5))]);
    expect(s.components.map((c) => [c.kind, c.amountMinor, c.sourceIds])).toEqual([['REALIZED_COST', 1849050, [2]]]);
    // Sans date saisie : la date du document reste.
    expect(s.realizedDate).toBe('2021-03-02');
  });

  it('O4-16 Cession : prix réalisé = PROCEED ; date du passage au statut seulement à défaut d\'une date documentaire', () => {
    const sale = (amountMinor: number) => ({
      sourceId: 1,
      identity: buildCandidateIdentity({
        id: 1, accountId: 1, fileId: 50, candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'DISPOSAL',
        statusHint: 'REALIZED', summary: 'Acte de vente', payload: { sourceRoleHint: 'SALE_DOCUMENT', temporalHints: { realizedDate: '2026-09-28' },
          financialHints: [{ role: 'PROCEED', amountMinor, currency: 'EUR', amountScope: 'TOTAL' }] },
      }, { fileAssetId: 7, liveAssetIds: new Set([7]), equipmentAssets: new Map() }),
    });
    const repli = saisie({}, { status: 'VENDU', status_changed_at: '2026-10-10T08:00:00Z' });
    expect(etat([sale(1200000), repli], 'DISPOSAL')).toMatchObject({ realizedDate: '2026-09-28' });
    expect(etat([repli], 'DISPOSAL')).toMatchObject({ status: 'REALIZED', realizedDate: '2026-10-10', components: [] });
    const prix = saisie(humain('salePrice', 12000), { status: 'VENDU', status_changed_at: '2026-10-10T08:00:00Z' });
    expect(etat([sale(1200000), prix], 'DISPOSAL').components.map((c) => [c.kind, c.amountMinor, c.sourceIds])).toEqual([['PROCEED', 1200000, [1, 2]]]);
  });

  it('O4-17 donnée retirée (valeur effacée, devenue automatique, statut quitté) → plus de contribution', () => {
    expect(assetDataContribution(2, bien({}), 'ACQUISITION')).toBeNull();
    expect(assetDataContribution(2, bien(humain('acquisitionPrice', 10, 'RECONCILIATION')), 'ACQUISITION')).toBeNull();
    expect(assetDataContribution(2, bien({}, { status: 'EN_SERVICE' }), 'DISPOSAL')).toBeNull();
    expect(assetDataContribution(2, bien({}), 'INCONNUE')).toBeNull();
  });
});
