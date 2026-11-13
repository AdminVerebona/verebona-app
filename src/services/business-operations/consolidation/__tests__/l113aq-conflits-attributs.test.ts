/**
 * Lot 113AQ (Trello #750 / #751, anomalie BO #12) — contradictions
 * d'attributs d'Opération : causes de faux conflits DÉMONTRÉES sur le relevé
 * 78A, qualification par rôle (même attribut, même rôle, même fait),
 * contrat de diagnostic, lecture des signalements, anti-réouverture.
 * Tests purs (aucune base, aucune IA).
 */
import { describe, expect, it } from 'vitest';
import { consolidateOperationState, type CandidateIdentity, type SourceContribution } from '../model';
import {
  ALERTING_QUALIFICATIONS, normalizeConflictDate, normalizeConflictProvider, qualifyAttributeConflicts, semanticRoleOf, markAdminArbitrated,
} from '../attribute-conflicts';
import {
  buildConflictEntries, conflictCounters, materialKeyOf, occurrenceLines, occurrenceTimeline, HISTORICAL_DETAIL_NOT_KEPT,
} from '../../diagnostics/attribute-conflicts-model';

const BIEN = 7;
const TODAY = '2026-11-12';

function cand(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: 10, established: true, confidence: 'certain', type: 'INTERVENTION',
    status: 'REALIZED', role: 'INVOICE', summary: 'Prestation', provider: null, providerKey: null,
    assetIds: [BIEN], targetAuthority: 'INFERENCE', equipmentIds: [], refs: [],
    dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: null }, hints: [], ...over,
  };
}
const d = (over: Partial<CandidateIdentity['dates']>) => ({ plannedDate: null, startDate: null, realizedDate: null, endDate: null, ...over });
const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: value.toUpperCase() });
const src = (sourceId: number, identity: CandidateIdentity): SourceContribution => ({ sourceId, identity });

/** Relevé 78A puis qualification 113AQ (même chemin que le consolidateur). */
function relever(type: CandidateIdentity['type'], sources: SourceContribution[], opts: { suspect?: number[]; authority?: Record<number, string> } = {}) {
  const s = consolidateOperationState(type, sources, TODAY);
  const q = qualifyAttributeConflicts(s.attributeConflicts, {
    type: s.type, contributions: sources, provenance: s.provenance,
    sourceMeta: new Map(sources.map((x) => [x.sourceId, { authority: opts.authority?.[x.sourceId] ?? 'DOCUMENT', kind: 'DOCUMENT' }])),
    suspectSourceIds: new Set(opts.suspect ?? []),
  });
  return { state: s, ...q };
}

describe('L113AQ-U-CAUSES — causes de faux conflits démontrées sur le relevé 78A (avant 113AQ : tout écart = contradiction)', () => {
  it('cause 1 — rôles de dates différents : facture (réalisation) et preuve de paiement 14 mois plus tard → relevé 78A, AUCUN conflit qualifié', () => {
    const r = relever('INTERVENTION', [
      src(1, cand({ role: 'INVOICE', dates: d({ realizedDate: '2024-01-10' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'PAYMENT_PROOF', dates: d({ realizedDate: '2025-03-20' }) })),
    ]);
    expect(r.state.attributeConflicts.map((c) => c.field)).toEqual(['realizedDate']); // ancien comportement : contradiction
    expect(r.alerting).toEqual([]);
    expect(r.divergences).toEqual([expect.objectContaining({ field: 'realizedDate', qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'ROLES_DIFFER', role: 'MIXED' })]);
  });

  it('cause 2 — rôles de parties différents : fournisseur facturant / banque / office notarial / intervenant → aucun conflit', () => {
    const r = relever('INTERVENTION', [
      src(1, cand({ role: 'INVOICE', provider: 'Plomberie Durand', providerKey: 'plomberiedurand' })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'PAYMENT_PROOF', provider: 'Banque Populaire', providerKey: 'banquepopulaire' })),
      src(3, cand({ candidateId: 3, fileId: 12, role: 'REPORT', provider: 'Diagnostics Ouest', providerKey: 'diagnosticsouest' })),
    ]);
    expect(r.state.attributeConflicts.map((c) => c.field)).toEqual(['provider']);
    expect(r.alerting).toEqual([]);
    expect(r.divergences[0]).toMatchObject({ qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'ROLES_DIFFER' });
    expect(r.divergences[0].values.flatMap((v) => v.sources.map((s) => s.role)).sort()).toEqual(['EXECUTANT', 'PAYMENT_INTERMEDIARY', 'SUPPLIER']);
  });

  it('cause 3 — formats / désignations équivalents (« & » / « et », « Ets », équivalence prouvée 86C) → aucune fausse divergence', () => {
    expect(normalizeConflictProvider('Dupont & Fils')).toBe(normalizeConflictProvider('Ets Dupont et Fils'));
    const r = relever('INTERVENTION', [
      src(1, cand({ provider: 'Dupont & Fils', providerKey: 'dupontfils' })),
      src(2, cand({ candidateId: 2, fileId: 11, provider: 'Ets Dupont et Fils', providerKey: 'etsdupontetfils' })),
    ]);
    expect(r.state.attributeConflicts).toHaveLength(1);
    expect(r.alerting).toEqual([]);
    expect(r.divergences[0]).toMatchObject({ reasonCode: 'FORMAT_EQUIVALENT', qualification: 'LEGITIMATE_DIFFERENCE' });
    // Équivalence prouvée du compte (86C) : clé canonique.
    const eq = relever('INTERVENTION', [
      src(1, cand({ provider: 'EDF', providerKey: 'edf' })),
      src(2, cand({ candidateId: 2, fileId: 11, provider: 'Électricité de France', providerKey: 'edf', providerKeyRaw: 'electricitedefrance' })),
    ]);
    expect(eq.alerting).toEqual([]);
    expect(eq.divergences[0].reasonCode).toBe('FORMAT_EQUIVALENT');
  });

  it('cause 4 — révision successive d’une relation durable (avenant, autre date d’effet) → divergence légitime, valeur actuelle non remplacée', () => {
    const r = relever('CONTRACT', [
      src(1, cand({ type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', provider: 'Assureur A', providerKey: 'assureura', refs: [ref('CONTRACT', 'P-1')], dates: d({ startDate: '2022-01-01' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, type: 'CONTRACT', role: 'CONTRACT_DOCUMENT', provider: 'Assureur B', providerKey: 'assureurb', refs: [ref('CONTRACT', 'P-1')], dates: d({ startDate: '2024-01-01' }) })),
    ]);
    expect(r.alerting).toEqual([]);
    expect(r.divergences[0]).toMatchObject({ qualification: 'LEGITIMATE_DIFFERENCE', reasonCode: 'SUCCESSIVE_REVISION', role: 'SUPPLIER' });
    expect(r.state.provider).toBe('Assureur A'); // règle de rétention inchangée (113AQ n'écrit rien de plus)
  });

  it('cause 5 — mauvaise identité de source : doute d’identité OUVERT (78A) → SOURCE_LINK_ERROR_SUSPECTED, jamais « conflit prouvé »', () => {
    const r = relever('ACQUISITION', [
      src(1, cand({ type: 'ACQUISITION', role: 'INVOICE', provider: 'Tikamoon', dates: d({ realizedDate: '2025-05-12' }), refs: [ref('ORDER', 'TK-1')] })),
      src(2, cand({ candidateId: 2, fileId: 11, type: 'ACQUISITION', role: 'SALE_DOCUMENT', provider: 'Office notarial', dates: d({ realizedDate: '2021-06-30' }) })),
    ], { suspect: [1] });
    expect(r.alerting).toEqual([expect.objectContaining({ field: 'realizedDate', role: 'REALIZATION', qualification: 'SOURCE_LINK_ERROR_SUSPECTED', reasonCode: 'IDENTITY_REVIEW_OPEN' })]);
    // Prestataire : facturant vs rédacteur de l'acte — rôles différents, pas un conflit.
    expect(r.divergences.map((x) => [x.field, x.reasonCode])).toEqual([['provider', 'ROLES_DIFFER']]);
  });

  it('cause 5 bis — cibles explicites disjointes entre valeurs → SOURCE_LINK_ERROR_SUSPECTED (TARGETS_DISJOINT)', () => {
    const r = relever('INTERVENTION', [
      src(1, cand({ provider: 'A', providerKey: 'a', assetIds: [1], targetAuthority: 'DOCUMENT' })),
      src(2, cand({ candidateId: 2, fileId: 11, provider: 'B', providerKey: 'b', assetIds: [2], targetAuthority: 'DOCUMENT' })),
    ]);
    expect(r.alerting[0]).toMatchObject({ qualification: 'SOURCE_LINK_ERROR_SUSPECTED', reasonCode: 'TARGETS_DISJOINT' });
  });
});

describe('L113AQ-U-QUALIF — qualification (AC02–AC07, AC11, AC12)', () => {
  it('AC02 — devis du 05/11 puis facture du 12/11, même prestation : deux rôles, zéro conflit', () => {
    const r = relever('INTERVENTION', [
      src(1, cand({ role: 'QUOTE', status: 'ENVISAGED', dates: d({ plannedDate: '2025-11-05' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'INVOICE', dates: d({ realizedDate: '2025-11-12' }) })),
    ]);
    expect(r.state.attributeConflicts).toEqual([]);
    expect(r.alerting).toEqual([]);
    // Devis 2024 et facture de période jusqu'en 2026 : fin de validité ≠ fin de période facturée.
    const v = relever('INTERVENTION', [
      src(1, cand({ role: 'QUOTE', status: 'ENVISAGED', dates: d({ endDate: '2024-01-31' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'INVOICE', dates: d({ endDate: '2026-06-30' }) })),
    ]);
    expect(v.state.attributeConflicts.map((c) => c.field)).toEqual(['endDate']);
    expect(v.alerting).toEqual([]);
    expect(semanticRoleOf('endDate', { role: 'QUOTE' })).toBe('QUOTE_VALIDITY_END');
    expect(semanticRoleOf('endDate', { role: 'INVOICE' })).toBe('BILLING_PERIOD_END');
  });

  it('AC03 — signature / prise d’effet / première couverture : trois faits, aucune date inventée, aucun conflit', () => {
    const r = relever('INTERVENTION', [
      src(1, cand({ role: 'CONTRACT_DOCUMENT', dates: d({ startDate: '2023-01-01' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'OTHER_EVIDENCE', coverageDocument: true, dates: d({ startDate: '2024-04-01' }) })),
      src(3, cand({ candidateId: 3, fileId: 12, role: 'INVOICE', dates: d({ startDate: '2025-02-01' }) })),
    ]);
    expect(r.state.startDate).toBe('2023-01-01');
    expect(r.alerting.filter((x) => x.qualification !== 'INSUFFICIENT_EVIDENCE')).toEqual([]);
    expect(semanticRoleOf('startDate', { role: 'OTHER_EVIDENCE', coverageDocument: true })).toBe('UNKNOWN');
    expect(semanticRoleOf('startDate', { role: 'CONTRACT_DOCUMENT', coverageDocument: true })).toBe('COVERAGE_START');
    expect(r.divergences.every((x) => ['ROLES_DIFFER', 'ROLE_UNKNOWN_NOT_COMPARABLE'].includes(x.reasonCode))).toBe(true);
  });

  it('AC04 — même date métier, même référence, valeurs incompatibles : conflit réel avec les DEUX valeurs et leurs sources', () => {
    const r = relever('INTERVENTION', [
      src(1, cand({ role: 'INVOICE', refs: [ref('INVOICE', 'F-77')], dates: d({ realizedDate: '2023-02-01' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'INVOICE', refs: [ref('INVOICE', 'F-77')], dates: d({ realizedDate: '2025-02-01' }) })),
    ]);
    expect(r.alerting).toEqual([expect.objectContaining({ qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE', role: 'REALIZATION', impact: ['OPERATION', 'TIMELINE_AGENDA'] })]);
    expect(r.alerting[0].values.map((v) => [v.value, v.sourceIds])).toEqual([['2023-02-01', [1]], ['2025-02-01', [2]]]);
  });

  it('AC05 — deux prestataires pour le MÊME rôle et la même référence : conflit documenté ; sans référence commune : non vérifiable', () => {
    const memeRef = relever('INTERVENTION', [
      src(1, cand({ role: 'INVOICE', provider: 'Alpha', providerKey: 'alpha', refs: [ref('ORDER', 'C-1')] })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'ORDER', provider: 'Beta', providerKey: 'beta', refs: [ref('ORDER', 'C-1')] })),
    ]);
    expect(memeRef.alerting[0]).toMatchObject({ field: 'provider', role: 'SUPPLIER', qualification: 'REAL_CONFLICT_UNRESOLVED' });
    const sans = relever('INTERVENTION', [
      src(1, cand({ role: 'INVOICE', provider: 'Alpha', providerKey: 'alpha' })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'INVOICE', provider: 'Beta', providerKey: 'beta' })),
    ]);
    expect(sans.alerting[0]).toMatchObject({ qualification: 'INSUFFICIENT_EVIDENCE', reasonCode: 'FACT_IDENTITY_NOT_ESTABLISHED' });
  });

  it('AC06 — devis révisé (deux devis, dates prévues éloignées) : la révision ne contredit rien', () => {
    const r = relever('INTERVENTION', [
      src(1, cand({ role: 'QUOTE', status: 'ENVISAGED', dates: d({ plannedDate: '2023-01-10' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'QUOTE', status: 'ENVISAGED', dates: d({ plannedDate: '2024-06-10' }) })),
    ]);
    expect(r.alerting).toEqual([]);
    expect(r.divergences[0]).toMatchObject({ reasonCode: 'QUOTE_REVISION' });
  });

  it('AC07 — normalisation : formats de date et instants Paris équivalents ; vraies différences préservées', () => {
    expect(normalizeConflictDate('05/11/2025')).toBe('2025-11-05');
    expect(normalizeConflictDate('2025-11-04T23:30:00Z')).toBe('2025-11-05');
    expect(normalizeConflictDate('2025-11-05T10:00:00')).toBe('2025-11-05');
    expect(normalizeConflictDate('n’importe quoi')).toBeNull();
    expect(normalizeConflictProvider('Alpha')).not.toBe(normalizeConflictProvider('Alphonse'));
  });

  it('AC11 / AC12 — valeur de l’utilisateur retenue : contradiction tranchée et protégée, aucune alerte ; non retenue : jamais masquée', () => {
    const doc = src(1, cand({ role: 'INVOICE', dates: d({ realizedDate: '2023-03-01' }) }));
    const agenda = src(2, cand({ candidateId: 2, fileId: 0, role: null, dates: d({ realizedDate: '2024-09-01' }), agenda: { itemId: 5, realizedDate: '2024-09-01', realizationRecord: true } }));
    const s = consolidateOperationState('INTERVENTION', [doc, agenda], TODAY);
    expect(s.attributeConflicts.map((c) => c.field)).toEqual(['realizedDate']);
    const prov = { ...s.provenance, realizedDate: { sourceId: 2, value: '2024-09-01' } };
    const retenu = qualifyAttributeConflicts(s.attributeConflicts.map((c) => ({ ...c, retained: '2024-09-01' })), {
      type: 'INTERVENTION', contributions: [doc, agenda], provenance: prov,
      sourceMeta: new Map([[1, { authority: 'DOCUMENT', kind: 'DOCUMENT' }], [2, { authority: 'USER', kind: 'AGENDA' }]]),
    });
    expect(retenu.alerting).toEqual([]);
    expect(retenu.divergences[0]).toMatchObject({ qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: 'USER_VALUE_RETAINED', protection: 'USER', resolution: { by: 'USER', sourceId: 2 } });
    const nonRetenu = qualifyAttributeConflicts(s.attributeConflicts.map((c) => ({ ...c, retained: '2023-03-01' })), {
      type: 'INTERVENTION', contributions: [doc, agenda], provenance: { realizedDate: { sourceId: 1, value: '2023-03-01' } },
      sourceMeta: new Map([[1, { authority: 'DOCUMENT', kind: 'DOCUMENT' }], [2, { authority: 'USER', kind: 'AGENDA' }]]),
    });
    expect(nonRetenu.alerting[0]).toMatchObject({ qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'USER_VALUE_NOT_RETAINED', protection: 'USER' });
  });

  it('fait unique (achat) daté différemment par deux sources de même rôle : conflit réel (SINGLE_FACT_OPERATION)', () => {
    const r = relever('ACQUISITION', [
      src(1, cand({ type: 'ACQUISITION', role: 'SALE_DOCUMENT', dates: d({ realizedDate: '2021-06-30' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, type: 'ACQUISITION', role: 'SALE_DOCUMENT', dates: d({ realizedDate: '2007-04-02' }) })),
    ]);
    expect(r.alerting[0]).toMatchObject({ qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SINGLE_FACT_OPERATION' });
  });

  it('jamais une nouvelle contradiction : la qualification ne fait que partager le relevé 78A ; déterministe (idempotence)', () => {
    const sources = [
      src(1, cand({ role: 'INVOICE', provider: 'A', providerKey: 'a', dates: d({ realizedDate: '2022-01-01' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'INVOICE', provider: 'B', providerKey: 'b', dates: d({ realizedDate: '2024-01-01' }) })),
    ];
    const a = relever('INTERVENTION', sources);
    const b = relever('INTERVENTION', [...sources].reverse());
    expect(JSON.stringify(a.alerting)).toBe(JSON.stringify(b.alerting));
    const fields = new Set(a.state.attributeConflicts.map((c) => c.field));
    for (const x of [...a.alerting, ...a.divergences]) expect(fields.has(x.field)).toBe(true);
    expect(ALERTING_QUALIFICATIONS).not.toContain('LEGITIMATE_DIFFERENCE');
    expect(markAdminArbitrated(a.alerting[0])).toMatchObject({ qualification: 'REAL_CONFLICT_RESOLVED', protection: 'ADMIN', impact: [] });
  });
});

describe('L113AQ-U-DIAG — contrat de diagnostic #751', () => {
  const sourcesInfo = new Map([
    [1, { sourceId: 1, kind: 'DOCUMENT', fileId: 101, documentType: 'FACTURE', documentRole: 'INVOICE', authority: 'DOCUMENT', active: true, availability: 'EXISTING' as const, version: 'c1' }],
    [2, { sourceId: 2, kind: 'DOCUMENT', fileId: 102, documentType: 'FACTURE', documentRole: 'INVOICE', authority: 'DOCUMENT', active: true, availability: 'EXISTING' as const, version: 'c2' }],
  ]);
  const base = {
    accountId: 13, operationId: 81, typeCode: 'INTERVENTION', status: 'REALIZED', technicalLabel: 'Entretien', invalidated: false, mergedInto: null,
    current: { realizedDate: '2023-02-01', provider: 'Alpha' }, sources: sourcesInfo, technicalError: null, arbitrations: [],
  };
  const now = new Date('2026-11-12T10:00:00Z');

  it('AC01 / AC02 — entrée v2 : vrai compte, attribut, rôle, valeurs côte à côte avec sources, retenue / persistée, verdict motivé', () => {
    const r = relever('INTERVENTION', [
      src(1, cand({ role: 'INVOICE', refs: [ref('INVOICE', 'F-1')], dates: d({ realizedDate: '2023-02-01' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'INVOICE', refs: [ref('INVOICE', 'F-1')], dates: d({ realizedDate: '2025-02-01' }) })),
    ]);
    const e = buildConflictEntries({ ...base, lastReconciledAt: '2026-11-12T08:00:00Z', provenance: { version: 2, rules: 'iac-113aq-v2', conflicts: r.alerting, divergences: r.divergences } }, now);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      accountId: 13, operationId: 81, attribute: { key: 'realizedDate', kind: 'DATE' }, role: { code: 'REALIZATION', known: true },
      qualification: 'REAL_CONFLICT_UNRESOLVED', lineState: 'ACTIVE', retainedValue: '2025-02-01', persistedValue: '2023-02-01',
      lastCheck: { result: 'PRESENT', fresh: true, rules: 'iac-113aq-v2' }, impact: { status: 'TO_VERIFY' }, appliedAction: { kind: 'VALUES_KEPT' },
    });
    expect(e[0].values.map((v) => [v.raw, v.sources.map((s) => s.fileId)])).toEqual([['2023-02-01', [101]], ['2025-02-01', [102]]]);
    expect(e[0].reason).toMatch(/même référence/);
  });

  it('AC04 — écart légitime : consultable, « pas un conflit », hors compteur actif', () => {
    const r = relever('INTERVENTION', [
      src(1, cand({ role: 'INVOICE', dates: d({ realizedDate: '2024-01-10' }) })),
      src(2, cand({ candidateId: 2, fileId: 11, role: 'PAYMENT_PROOF', dates: d({ realizedDate: '2025-03-20' }) })),
    ]);
    const e = buildConflictEntries({ ...base, lastReconciledAt: '2026-11-12T08:00:00Z', provenance: { version: 2, conflicts: r.alerting, divergences: r.divergences } }, now);
    expect(e.map((x) => [x.qualification, x.lineState])).toEqual([['LEGITIMATE_DIFFERENCE', 'NOT_A_CONFLICT']]);
    expect(conflictCounters(e)).toMatchObject({ activeConflicts: 0, legitimateDifferences: 1, operations: 0 });
  });

  it('AC06 — relevé ancien (v1), contrôle vieux ou T3 en échec : « non vérifiable » motivé, jamais un verdict inventé', () => {
    const legacy = buildConflictEntries({ ...base, lastReconciledAt: '2026-10-23T08:00:00Z', provenance: { version: 1, conflicts: [{ field: 'provider', values: [{ value: 'A', sourceIds: [1] }, { value: 'B', sourceIds: [2] }], retained: 'A' }] } }, now);
    expect(legacy[0]).toMatchObject({ qualification: 'INSUFFICIENT_EVIDENCE', reasonCode: 'LEGACY_RULES_NOT_RECHECKED', lineState: 'NON_VERIFIABLE', role: { known: false },
      lastCheck: { result: 'UNKNOWN', fresh: false, rulesVersion: 1 }, impact: { status: 'NOT_ESTABLISHED' }, appliedAction: { kind: 'AWAITING_RECHECK' } });
    const echec = buildConflictEntries({ ...base, technicalError: 'erreur technique T3 PROVIDER_UNAVAILABLE', lastReconciledAt: '2026-11-12T08:00:00Z',
      provenance: { version: 2, conflicts: [{ field: 'provider', role: 'SUPPLIER', qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE', values: [{ value: 'A', sourceIds: [1] }, { value: 'B', sourceIds: [2] }], retained: 'A', impact: ['OPERATION'] }] } }, now);
    expect(echec[0]).toMatchObject({ qualification: 'CHECK_FAILED', lineState: 'NON_VERIFIABLE', lastCheck: { result: 'FAILED' } });
    const vieux = buildConflictEntries({ ...base, lastReconciledAt: '2026-11-01T08:00:00Z',
      provenance: { version: 2, conflicts: [{ field: 'provider', role: 'SUPPLIER', qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE', values: [], retained: 'A' }] } }, now);
    expect(vieux[0]).toMatchObject({ lineState: 'NON_VERIFIABLE', lastCheck: { fresh: false } });
    expect(vieux[0].lineStateReason).toMatch(/à reconfirmer/);
  });

  it('AC05 / AC07 — arbitrage BO tracé à part (résolu) ; l’autre conflit de la même Opération reste actif', () => {
    const e = buildConflictEntries({ ...base, lastReconciledAt: '2026-11-12T08:00:00Z', provenance: {
      version: 2,
      conflicts: [{ field: 'provider', role: 'SUPPLIER', qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE', values: [{ value: 'A', sourceIds: [1] }, { value: 'B', sourceIds: [2] }], retained: 'A', impact: ['OPERATION', 'SUPPLIER'] }],
      arbitratedConflicts: [{ field: 'realizedDate', role: 'REALIZATION', qualification: 'REAL_CONFLICT_RESOLVED', reasonCode: 'ADMIN_RESTORED_SOURCE', resolution: { by: 'ADMIN' }, values: [{ value: '2021-01-01', sourceIds: [1] }], retained: '2021-01-01' }],
    } }, now);
    expect(e.map((x) => [x.attribute.key, x.lineState, x.appliedAction.kind])).toEqual([['provider', 'ACTIVE', 'VALUES_KEPT'], ['realizedDate', 'RESOLVED', 'ADMIN_RESTORE']]);
    expect(conflictCounters(e)).toMatchObject({ activeConflicts: 1, resolved: 1, operations: 1, attributes: 1 });
  });

  it('AC08 — 20 signalements identiques ≠ 20 incidents ; l’ajout de #5 est une évolution de population ; ancien détail « non conservé »', () => {
    const occ = [{ id: 1, occurredAt: '2026-10-23T05:00:00Z', technicalDetail: { operationIds: '8, 81, 76, 82' } },
      { id: 2, occurredAt: '2026-10-24T05:00:00Z', technicalDetail: { operationIds: '8, 81, 5, 76, 82' } },
      ...Array.from({ length: 19 }, (_, i) => ({ id: 3 + i, occurredAt: `2026-10-${String(25 + Math.min(i, 6)).padStart(2, '0')}T05:${String(i).padStart(2, '0')}:00Z`, technicalDetail: { operationIds: '8, 81, 5, 76, 82' } }))];
    const t = occurrenceTimeline(occ);
    expect(t.counters).toEqual({ total: 21, material: 2, periodic: 19, withoutDetail: 21 });
    const ajout = t.items.find((i) => i.kind === 'POPULATION_CHANGE')!;
    expect(ajout).toMatchObject({ id: 2, added: ['5'], removed: [] });
    expect(t.items.every((i) => i.detail === HISTORICAL_DETAIL_NOT_KEPT)).toBe(true);
    // Occurrences structurées (113AQ) : association compte ↔ Opération explicite.
    const s = occurrenceTimeline([{ id: 30, occurredAt: '2026-11-13T05:00:00Z', technicalDetail: { conflicts: ['11:8:provider:INSUFFICIENT_EVIDENCE', '13:81:realizedDate:REAL_CONFLICT_UNRESOLVED'], materialKey: 'k1' } }]);
    expect(s.items[0]).toMatchObject({ detail: 'STRUCTURED', operationIds: ['8', '81'] });
  });

  it('AC09 / AC10 — relevé compact d’occurrence : compte et Opération associés, trié, borné ; empreinte matérielle stable', () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({ accountId: 11 + (i % 2) * 2, operationId: 1000 + i, field: 'provider', qualification: 'INSUFFICIENT_EVIDENCE', values: ['A', 'B'] }));
    const o = occurrenceLines(lines);
    expect(o.truncated).toBe(true);
    expect(JSON.stringify(o.conflicts).length).toBeLessThan(2000);
    expect(o.conflicts[0]).toBe('11:1000:provider:INSUFFICIENT_EVIDENCE');
    expect(materialKeyOf(lines)).toBe(materialKeyOf([...lines].reverse()));
    expect(materialKeyOf(lines)).not.toBe(materialKeyOf(lines.map((l, i) => (i === 0 ? { ...l, values: ['A', 'C'] } : l))));
  });
});
