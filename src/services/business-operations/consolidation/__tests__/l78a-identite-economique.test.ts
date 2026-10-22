/**
 * Lot 78A — identité économique des Opérations (ticket « [P1] Opérations &
 * TCO », §2A, §2B, §2C, §5, §7). Règles PURES : rapprochements déterministes
 * M1 / M2 sécurisés, contrôle avant tout MATCH_AND_ENRICH, réévaluation des
 * rattachements historiques, candidats d'un même document.
 */
import { describe, expect, it } from 'vitest';
import { applyM3Verdict, decideCandidate, operationsMergeable, sameDocumentReality, sameTransactionDescription, type ExistingOperation, type MatchContext } from '../matching';
import {
  assessEconomicIdentity, footprintOfIdentity, reviewExistingAttachment, type OperationMember,
} from '../economic-identity';
import type { CandidateIdentity, PersistedFinancialHint } from '../model';

const MAISON = 7;

function cand(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: 10, established: true, confidence: 'certain', type: 'ACQUISITION',
    status: 'REALIZED', role: 'INVOICE', summary: 'Achat', provider: null, providerKey: null,
    assetIds: [MAISON], targetAuthority: 'INFERENCE', equipmentIds: [], refs: [],
    dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: null }, hints: [], ...over,
  };
}
const fh = (role: string, amountMinor: number, over: Partial<PersistedFinancialHint> = {}): PersistedFinancialHint =>
  ({ role, amountMinor, currency: 'EUR', amountScope: null, economicDate: null, periodStart: null, periodEnd: null, ...over });
const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: value.toUpperCase() });
const date = (realizedDate: string) => ({ plannedDate: null, startDate: null, realizedDate, endDate: null });

/** Commande de quatre chaises de jardin (cas réel #76). */
const chaises = (over: Partial<CandidateIdentity> = {}) => cand({
  candidateId: 1, fileId: 1, summary: 'Commande de quatre chaises de jardin', provider: 'Tikamoon', providerKey: 'tikamoon',
  role: 'INVOICE', dates: date('2025-05-12'), hints: [fh('REALIZED_COST', 27735)], refs: [ref('ORDER', 'TK-5521')], ...over,
});
/** Document d'acquisition de la maison (cas réel #76). */
const acte = (over: Partial<CandidateIdentity> = {}) => cand({
  candidateId: 2, fileId: 2, summary: 'Acte authentique de vente de la maison', provider: 'Office notarial Martin', providerKey: 'officenotarialmartin',
  role: 'SALE_DOCUMENT', dates: date('2021-06-30'), hints: [fh('REALIZED_COST', 49_000_000)], ...over,
});

function opDe(id: number, c: CandidateIdentity, over: Partial<ExistingOperation> = {}): ExistingOperation {
  return {
    id, typeCode: c.type, status: c.status, providerKey: c.providerKey, assetIds: c.assetIds, label: c.summary,
    refs: c.refs.map((r) => ({ kind: r.kind, normalized: r.normalized })),
    plannedDate: c.dates.plannedDate, startDate: c.dates.startDate, realizedDate: c.dates.realizedDate, endDate: c.dates.endDate,
    amounts: c.hints.map((h) => ({ kind: h.role, amountMinor: h.amountMinor, currency: h.currency })), ...over,
  };
}
const membre = (sourceId: number, c: CandidateIdentity, anchor = false): OperationMember => ({ sourceId, footprint: footprintOfIdentity(c), anchor });
const ctx = (operations: ExistingOperation[], over: Partial<MatchContext> = {}): MatchContext => ({
  operations, confirmed: new Set(), rejected: new Set(), assetStatus: new Map(), ...over,
});

describe('L78A §2B — M2 « même cycle de possession » : jamais une preuve à lui seul (correction bloquante)', () => {
  it('L78A-T01 / §7.1 — #76 : acte de la maison (490 000 €) face à la commande de chaises (277,35 €), même bien, même cycle → JAMAIS rattaché ; nouvelle Opération', () => {
    const tikamoon = opDe(76, chaises());
    const d = decideCandidate(acte(), ctx([tikamoon]));
    expect(d.outcome).toBe('CREATE_NEW');
    expect(d.detail.certain).toEqual([]);
    expect(d.detail.excluded).toContainEqual({ operationId: 76, why: 'ECONOMIC_IDENTITY_CONTRADICTED' });
    expect(d.detail.identity).toEqual([expect.objectContaining({ operationId: 76, basis: 'OWNERSHIP_CYCLE', outcome: 'REFUSED', signals: expect.arrayContaining(['!AMOUNT_INCOMPATIBLE', '-PROVIDER_DIFFERENT', '-DATE_APART']) })]);
    // Et l'inverse : la commande face à l'Opération de la maison.
    expect(decideCandidate(chaises(), ctx([opDe(80, acte())])).outcome).toBe('CREATE_NEW');
  });

  it('L78A-T02 — même bien, même cycle, AUCUN montant ni tiers comparables (deux documents muets) → différé (M3), jamais rattaché d\'office', () => {
    const d = decideCandidate(cand({ summary: 'Achat', dates: date('2024-01-10') }), ctx([opDe(5, cand({ summary: 'Achat', dates: date('2024-02-01') }))]));
    expect(d).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED' });
    expect(d.detail.plausible).toEqual([5]);
    expect(d.detail.identity?.[0]).toMatchObject({ basis: 'OWNERSHIP_CYCLE', outcome: 'DEFERRED' });
  });

  it('L78A-T03 / §7.2 — plusieurs documents d\'UN achat immobilier (acte, attestation notariée, montant concordant) → même Opération (M2 confirmé), y compris tiers différents (notaire / agence)', () => {
    const op = opDe(9, acte());
    const attestation = cand({ candidateId: 3, fileId: 3, summary: 'Attestation d\'acquisition', provider: 'Agence du Centre', providerKey: 'agenceducentre', dates: date('2021-07-02'), hints: [fh('REALIZED_COST', 49_000_000)] });
    const d = decideCandidate(attestation, ctx([op]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 9, matchMethod: 'M2', reason: 'MATCH_M2' });
    expect(d.detail.identity?.[0]).toMatchObject({ outcome: 'CONFIRMED', signals: expect.arrayContaining(['+AMOUNT_COHERENT']) });
  });

  it('L78A-T04 — même vendeur, deux achats d\'ordres de grandeur différents sur le même bien → deux Opérations ; montants proches mais différents → différé', () => {
    const table = cand({ provider: 'Tikamoon', providerKey: 'tikamoon', dates: date('2025-05-20'), hints: [fh('REALIZED_COST', 450_000)] });
    expect(decideCandidate(table, ctx([opDe(76, chaises())])).outcome).toBe('CREATE_NEW');
    const coussins = cand({ provider: 'Tikamoon', providerKey: 'tikamoon', dates: date('2025-05-20'), hints: [fh('REALIZED_COST', 39_900)] });
    expect(decideCandidate(coussins, ctx([opDe(76, chaises())]))).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED' });
  });

  it('L78A-T05 — équipements explicites disjoints (achat du four ≠ achat du réfrigérateur) ; fiche du bien ≠ achat d\'un équipement', () => {
    const four = cand({ equipmentIds: [1], provider: 'Darty', providerKey: 'darty', dates: date('2024-03-01') });
    const achatFrigo = cand({ equipmentIds: [2], provider: 'Darty', providerKey: 'darty', dates: date('2024-03-01') });
    const frigo = opDe(3, achatFrigo, { members: [membre(5, achatFrigo, true)] });
    expect(decideCandidate(four, ctx([frigo])).outcome).toBe('CREATE_NEW');
    const fiche = cand({ structured: { nature: 'ACQUISITION', dateBasis: 'FIELD' }, dates: date('2024-03-01'), hints: [] });
    const a = assessEconomicIdentity(footprintOfIdentity(fiche), footprintOfIdentity(four), 'OWNERSHIP_CYCLE');
    expect(a).toMatchObject({ verdict: 'CONTRADICTED', strong: ['OBJECT_INCOMPATIBLE'] });
  });

  it('L78A-T06 — non-régression lot 43 / C7-01 : fiche du bien sans élément comparable, document de même date → rapprochés ; après une CESSION → autre cycle', () => {
    const fiche = cand({ structured: { nature: 'ACQUISITION', dateBasis: 'FIELD' }, dates: date('2020-01-10'), hints: [fh('REALIZED_COST', 1_500_000)] });
    const facture = opDe(1, cand({ dates: date('2020-01-12'), provider: 'Garage', providerKey: 'garage' }));
    expect(decideCandidate(fiche, ctx([facture]))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 1 });
    const ces = opDe(2, cand({ type: 'DISPOSAL', dates: date('2023-05-01') }), { status: 'REALIZED' });
    expect(decideCandidate(cand({ dates: date('2025-01-01'), provider: 'Garage', providerKey: 'garage' }), ctx([facture, ces])).outcome).toBe('CREATE_NEW');
  });
});

describe('L78A §2B — tout MATCH_AND_ENRICH contrôlé (M1, M3, fusion)', () => {
  it('L78A-T07 — M1 : une référence commune ne rattache pas une transaction d\'un autre ordre de grandeur → HOLD (référence contredite)', () => {
    const op = opDe(4, cand({ type: 'INTERVENTION', providerKey: 'garage', refs: [ref('INVOICE', 'F1')], hints: [fh('REALIZED_COST', 18_000)] }));
    const d = decideCandidate(cand({ type: 'INTERVENTION', providerKey: 'garage', refs: [ref('INVOICE', 'F1')], hints: [fh('REALIZED_COST', 4_500_000)] }), ctx([op]));
    expect(d).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'CONTRADICTORY_REFERENCE' });
    // Devis 1 000 € puis facture 1 200 € citant le devis : rattachement conservé (écart attendu).
    const devis = opDe(5, cand({ type: 'INTERVENTION', providerKey: 'garage', refs: [ref('QUOTE', 'D1')], hints: [fh('FORECAST_COST', 100_000)] }));
    expect(decideCandidate(cand({ type: 'INTERVENTION', providerKey: 'garage', refs: [ref('QUOTE', 'D1'), ref('INVOICE', 'F9')], hints: [fh('REALIZED_COST', 120_000)] }), ctx([devis])))
      .toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 5, matchMethod: 'M1' });
  });

  it('L78A-T08 — M3 : un verdict IA « même Opération » contredit économiquement → arbitrage utilisateur, jamais un rattachement silencieux', () => {
    const op = opDe(6, chaises({ type: 'INTERVENTION' }));
    const c = acte({ type: 'INTERVENTION' });
    const base = { outcome: 'HOLD_UNRESOLVED' as const, operationId: null, matchMethod: null, reason: 'M3_REQUIRED', detail: { certain: [], plausible: [6], contradictions: [], excluded: [] } };
    const d = applyM3Verdict(c, base, { decision: 'SAME_OPERATION', matchedOperationId: 6, confidence: 'certain', concordantSignals: [], contradictions: [], reason: 'x', resolution: 'ATTACH' }, { operations: [op], assetStatus: new Map() });
    expect(d).toMatchObject({ outcome: 'ARBITRATION_REQUIRED', reason: 'M3_IDENTITY_CONTRADICTED' });
  });

  it('L78A-T09 — fusion V1 refusée entre deux Opérations économiquement incompatibles', () => {
    const a = opDe(1, chaises(), { refs: [] });
    const b = opDe(2, chaises({ hints: [fh('REALIZED_COST', 49_000_000)] }), { refs: [] });
    expect(operationsMergeable(a, b)).toBe(false);
    expect(operationsMergeable(a, opDe(3, chaises(), { refs: [] }))).toBe(true);
  });
});

describe('L78A §5 — réévaluation des rattachements historiques (continuité de source)', () => {
  const tikamoon = chaises();
  const acte1 = acte();
  const acte2 = acte({ candidateId: 3, fileId: 3, summary: 'Compromis de vente', dates: date('2021-03-15'), provider: 'Agence du Centre', providerKey: 'agenceducentre' });

  it('L78A-T10 — #76 : document de la maison rattaché à l\'Opération fondée par la commande → SÉPARÉ (certain) ; la commande fondatrice reste', () => {
    const op76 = opDe(76, tikamoon, { sameSource: true, sameSourceMethod: 'M2', members: [membre(1, tikamoon, true), membre(3, acte2)] });
    const d = decideCandidate(acte1, ctx([op76]));
    expect(d.outcome).toBe('CREATE_NEW');
    expect(d.detail.excluded).toContainEqual({ operationId: 76, why: 'SAME_SOURCE_IDENTITY_CONTRADICTED' });
    expect(d.detail.identity?.[0]).toMatchObject({ basis: 'SAME_SOURCE', outcome: 'SEPARATED', againstSourceIds: [1] });
    // La commande fondatrice, réexaminée : conservée (les intrus partent chacun à son tour).
    const d2 = decideCandidate(tikamoon, ctx([opDe(76, tikamoon, { sameSource: true, members: [membre(2, acte1), membre(3, acte2)] })]));
    expect(d2).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 76 });
    expect(d2.detail.identity?.[0]).toMatchObject({ outcome: 'SUSPECT' });
  });

  it('L78A-T11 — fondatrice non concluante (fiche sans prix) : l\'intrus contredit par les autres sources et confirmé par aucune → séparé ; les sources cohérentes restent', () => {
    const fiche = cand({ candidateId: 9, structured: { nature: 'ACQUISITION', dateBasis: 'FIELD' }, dates: date('2021-06-30'), hints: [] });
    const r = reviewExistingAttachment(footprintOfIdentity(tikamoon), [membre(9, fiche, true), membre(2, acte1), membre(3, acte2)]);
    expect(r.outcome).toBe('SEPARATE');
    expect(reviewExistingAttachment(footprintOfIdentity(acte1), [membre(9, fiche, true), membre(3, acte2)]).outcome).toBe('KEEP');
  });

  it('L78A-T12 — un rattachement décidé par l\'IA (M3) ou confirmé par l\'utilisateur (M0) n\'est JAMAIS défait automatiquement', () => {
    const op = opDe(76, tikamoon, { sameSource: true, sameSourceMethod: 'M3', members: [membre(1, tikamoon, true)] });
    const d = decideCandidate(acte1, ctx([op]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 76 });
    expect(d.detail.identity?.[0]).toMatchObject({ outcome: 'SUSPECT' });
    const m0 = decideCandidate(acte1, ctx([{ ...op, sameSourceMethod: 'M2' }], { confirmed: new Set([76]) }));
    expect(m0).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 76, matchMethod: 'M0' });
  });

  it('L78A-T13 — sans sources chargées (appelants historiques) : continuité inchangée', () => {
    expect(decideCandidate(acte1, ctx([opDe(76, tikamoon, { sameSource: true })]))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 76, matchMethod: 'M2' });
  });
});

describe('L78A §2A — candidats d\'un même document', () => {
  const base = { type: 'ACQUISITION' as const, provider: 'Tikamoon', providerKey: 'tikamoon', dates: date('2025-05-12') };
  const commande = cand({ ...base, candidateKey: 'op1', role: 'ORDER', summary: 'Commande de chaises de jardin', hints: [fh('FORECAST_COST', 27735)] });
  const facture = cand({ ...base, candidateKey: 'op2', role: 'INVOICE', summary: 'Facture chaises', hints: [fh('REALIZED_COST', 27735)] });
  const reglement = cand({ ...base, candidateKey: 'op3', role: 'PAYMENT_PROOF', summary: 'Paiement par carte', hints: [fh('PAYMENT', 27735)] });

  it('L78A-T14 / §7.3 — trois candidats redondants (commande, facture, règlement) d\'une transaction → même réalité', () => {
    expect(sameDocumentReality(facture, commande)).toBe(true);
    expect(sameDocumentReality(reglement, commande)).toBe(true);
    const op = opDe(20, commande, { sameDocument: true });
    expect(decideCandidate(facture, ctx([op]))).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 20, reason: 'MATCH_M2' });
  });

  it('L78A-T15 / §7.4 — plusieurs transactions réelles dans un document (montants ou objets différents) → distinctes', () => {
    const table = cand({ ...base, candidateKey: 'op2', summary: 'Table de jardin', hints: [fh('REALIZED_COST', 89_900)] });
    expect(sameDocumentReality(table, commande)).toBe(false);
    const parasol = cand({ ...base, candidateKey: 'op2', summary: 'Parasol déporté', hints: [fh('REALIZED_COST', 27735)] });
    expect(sameTransactionDescription(parasol, commande)).toBe(false);
    expect(sameDocumentReality(cand({ ...base, candidateKey: 'op2', summary: 'Chaises', hints: [] }), cand({ ...base, summary: 'Chaises', hints: [] }))).toBe(false);
  });

  it('L78A-T16 — réanalyse : doublon historique d\'un même document → la source rejoint l\'Opération la plus ancienne (jamais une fusion)', () => {
    const propre = opDe(31, facture, { sameSource: true, sameSourceSolo: true });
    const autre = opDe(30, commande, { sameDocument: true });
    const d = decideCandidate(facture, ctx([autre, propre]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 30, reason: 'MATCH_SAME_DOCUMENT' });
    expect(d.mergeIds).toBeUndefined();
    // La plus ancienne reste où elle est.
    expect(decideCandidate(commande, ctx([opDe(30, commande, { sameSource: true, sameSourceSolo: true }), opDe(31, facture, { sameDocument: true })])))
      .toMatchObject({ operationId: 30, reason: 'MATCH_M2' });
  });
});

describe('L78A §2C — dates ou prestataires contradictoires : aucune consolidation arbitraire', () => {
  it('L78A-T17 / §7.5 — même bien, même cycle, dates à 4 ans et prestataires différents, sans montant → refusé', () => {
    const a = cand({ provider: 'A', providerKey: 'a', dates: date('2021-01-01') });
    const d = decideCandidate(a, ctx([opDe(1, cand({ provider: 'B', providerKey: 'b', dates: date('2025-01-01') }))]));
    expect(d.outcome).toBe('CREATE_NEW');
    expect(d.detail.identity?.[0]).toMatchObject({ outcome: 'REFUSED', signals: ['-PROVIDER_DIFFERENT', '-DATE_APART'] });
  });
});

describe('L78A §2C / §6 — consolidation : provenance, contradictions d\'attributs, lien composante → indice T1', () => {
  it('L78A-T18 — dates de réalisation contradictoires (2025 / 2007) : la date de la source fondatrice est conservée, la contradiction tracée ; tiers différents tracés', async () => {
    const { consolidateOperationState } = await import('../model');
    const s = consolidateOperationState('ACQUISITION', [
      { sourceId: 1, identity: chaises() },
      { sourceId: 2, identity: acte({ dates: date('2007-04-02') }) },
    ], '2026-10-12');
    expect(s.realizedDate).toBe('2025-05-12');
    expect(s.provenance.realizedDate).toEqual({ sourceId: 1, value: '2025-05-12' });
    expect(s.provenance.provider).toEqual({ sourceId: 1, value: 'Tikamoon' });
    expect(s.attributeConflicts.map((c) => [c.field, c.retained])).toEqual([['realizedDate', '2025-05-12'], ['provider', 'Tikamoon']]);
    // Dates dans la fenêtre d'une même transaction : règle historique (première date), aucune contradiction.
    const t = consolidateOperationState('ACQUISITION', [
      { sourceId: 1, identity: acte({ dates: date('2021-07-02') }) },
      { sourceId: 2, identity: acte({ dates: date('2021-06-30') }) },
    ], '2026-10-12');
    expect(t.realizedDate).toBe('2021-06-30');
    expect(t.attributeConflicts).toEqual([]);
  });

  it('L78A-T19 — chaque composante porte, par source, le candidat T1, l\'indice et le fait persisté qui la justifient', async () => {
    const { consolidateOperationState } = await import('../model');
    const avecFait = (factId: number, candidateId: number) => acte({ candidateId, hints: [{ ...fh('REALIZED_COST', 49_000_000, { economicDate: '2021-06-30' }), evidence: { factId }, index: 0 }] });
    const s = consolidateOperationState('ACQUISITION', [{ sourceId: 1, identity: avecFait(501, 11) }, { sourceId: 2, identity: avecFait(777, 12) }], '2026-10-12');
    expect(s.components).toHaveLength(1);
    expect(s.components[0].evidenceBySource).toEqual({
      1: { candidateId: 11, hintIndexes: [0], factIds: [501] },
      2: { candidateId: 12, hintIndexes: [0], factIds: [777] },
    });
  });
});
