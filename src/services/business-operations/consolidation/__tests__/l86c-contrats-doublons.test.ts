/**
 * Lot 86C — ticket P1 « T3 / Opérations / Agenda : doublons de contrats,
 * fausses dates de fin et autoréparation ». Règles PURES (tests L86C-U-xx).
 * Scénarios PostgreSQL : src/test/e2e/scenarios/l86c-contrats-doublons.e2e.ts.
 *
 * Cas réel de référence (compte 13, bien #14) reproduit SANS AUCUN nom codé :
 * deux désignations d'un même prestataire (« Télésurveillance Nord » sur les
 * factures, « TSN Services » sur la dernière), période facturée enregistrée
 * comme période contractuelle, « Fin de contrat » projetée à la fin de la
 * dernière période facturée.
 */
import { describe, expect, it } from 'vitest';
import {
  consolidateOperationState, contractualDateSource, buildCandidateIdentity, type CandidateIdentity, type CandidateRecord,
  type PersistedFinancialHint, type SourceContribution,
} from '../model';
import {
  decideCandidate, designationMentioned, isPlausible, operationsMergeable, recurringDesignationLink,
  type ExistingOperation, type MatchContext,
} from '../matching';
import { assessSeries } from '../recurrence';
import { buildProviderEquivalence, canonicalProviderKey, providersEquivalent, type DesignationEvidence } from '../provider-equivalence';
import { decideProjection, projectionKeyOf, type OperationSnapshot } from '../../agenda-projection/model';
import { eventDateMeaning } from '@/services/verebona-assistant/core/semantic-scope';
import { agendaDateProvenance } from '@/services/verebona-assistant/canonical/agenda';
import { agendaBusinessSource, operationBusinessSource } from '@/services/verebona-assistant/canonical/business-sources';
import { contractDatesReason, CONTRACT_DATES_UNPROVEN_REASON } from '../consolidator';

const AUJ = '2026-10-24';
const norm = (v: string) => v.replace(/[^A-Z0-9]/gi, '').toUpperCase();
const ref = (kind: CandidateIdentity['refs'][number]['kind'], value: string) => ({ kind, value, normalized: norm(value) });
const pad = (m: number) => String(m).padStart(2, '0');
/** Période facturée « du 05 au 04 » (cas réel : 05/07 → 04/08). */
const periode = (m: number) => ({ start: `2026-${pad(m)}-05`, end: m === 12 ? '2027-01-04' : `2026-${pad(m + 1)}-04` });
const echeance = (m: number, over: Partial<PersistedFinancialHint> = {}): PersistedFinancialHint => ({
  role: 'REALIZED_COST', amountMinor: 4050, currency: 'EUR', amountScope: 'INSTALLMENT', economicDate: `2026-${pad(m)}-05`,
  periodStart: periode(m).start, periodEnd: periode(m).end, ...over,
});
function facture(m: number, over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: m, candidateKey: 'op1', fileId: 300 + m, established: true, confidence: 'certain', type: 'CONTRACT',
    status: 'REALIZED', role: 'INVOICE', summary: 'Abonnement mensuel Télésurveillance Nord', provider: 'Télésurveillance Nord', providerKey: 'telesurveillancenord',
    assetIds: [14], targetAuthority: 'DOCUMENT', equipmentIds: [], refs: [ref('INVOICE', `FT-${m}`)],
    // T1 recopie la période facturée dans `temporalHints` (cas réel #86) : ce n'est PAS une période contractuelle.
    dates: { plannedDate: null, startDate: periode(m).start, realizedDate: null, endDate: periode(m).end }, hints: [echeance(m)],
    ...over,
  };
}
const src = (sourceId: number, identity: CandidateIdentity): SourceContribution => ({ sourceId, identity });
function contrat(over: Partial<ExistingOperation> = {}): ExistingOperation {
  return {
    id: 5, typeCode: 'CONTRACT', status: 'REALIZED', providerKey: 'telesurveillancenord', assetIds: [14],
    refs: [{ kind: 'INVOICE', normalized: 'FT11' }], plannedDate: null, startDate: null, realizedDate: null, endDate: null,
    periodic: true, periods: ['2025-11-05/2025-12-04'], label: 'Facture d’abonnement Télésurveillance Nord, novembre 2025',
    amounts: [{ kind: 'REALIZED_COST', amountMinor: 4050, currency: 'EUR' }], ...over,
  };
}
const ctx = (operations: ExistingOperation[], over: Partial<MatchContext> = {}): MatchContext => ({
  operations, confirmed: new Set(), rejected: new Set(), assetStatus: new Map(), ...over,
});

// ══ B. Dates contractuelles ≠ périodes facturées ═══════════════════════════

describe('L86C-U-DATES — une période facturée ne date jamais un contrat', () => {
  it('L86C-U-DATES-01 — rôle de la source : contrat oui ; facture, avoir, paiement, devis non ; autre pièce sans période oui', () => {
    expect(contractualDateSource(facture(7, { role: 'CONTRACT_DOCUMENT' }))).toBe(true);
    for (const role of ['INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE', 'PAYMENT_PROOF', 'REFUND_PROOF', 'QUOTE', 'ORDER'] as const) {
      expect(contractualDateSource(facture(7, { role })), role).toBe(false);
    }
    // Courrier de résiliation (OTHER_EVIDENCE) : date de fin contractuelle, sans période facturée.
    expect(contractualDateSource(facture(7, { role: 'OTHER_EVIDENCE', hints: [] }))).toBe(true);
    // Rôle non qualifié portant une période facturée : ses dates en sont le reflet.
    expect(contractualDateSource(facture(7, { role: null }))).toBe(false);
    expect(contractualDateSource(facture(7, { role: null, hints: [] }))).toBe(true);
    expect(contractualDateSource(facture(7, { agenda: { itemId: 1, realizedDate: null, realizationRecord: false } }))).toBe(false);
  });

  it('L86C-U-DATES-03 — cas réel #86 : facture d’abonnement (période 05/07 → 04/08) → aucune date d’effet ni de fin, la période reste sur le coût', () => {
    const s = consolidateOperationState('CONTRACT', [src(1, facture(7))], AUJ);
    expect(s).toMatchObject({ type: 'CONTRACT', startDate: null, endDate: null, contract: { effectiveFrom: null, effectiveTo: null } });
    expect(s.components).toEqual([expect.objectContaining({ amountMinor: 4050, periodStart: '2026-07-05', periodEnd: '2026-08-04' })]);
    expect(s.provenance.endDate).toBeUndefined();
  });

  it('L86C-U-DATES-04 — fin contractuelle PROUVÉE (contrat) : retenue et sourcée ; une facture plus tardive ne la prolonge pas', () => {
    const doc = facture(1, { role: 'CONTRACT_DOCUMENT', hints: [], dates: { plannedDate: null, startDate: '2025-11-05', realizedDate: null, endDate: '2027-11-04' } });
    const s = consolidateOperationState('CONTRACT', [src(1, doc), src(2, facture(10, { dates: { plannedDate: null, startDate: '2026-10-05', realizedDate: null, endDate: '2027-12-31' } }))], AUJ);
    expect(s).toMatchObject({ startDate: '2025-11-05', endDate: '2027-11-04', contract: { effectiveFrom: '2025-11-05', effectiveTo: '2027-11-04' } });
    expect(s.provenance.endDate).toEqual({ sourceId: 1, value: '2027-11-04' });
    // Résiliation (courrier) : fin contractuelle sourcée.
    const r = consolidateOperationState('CONTRACT', [src(1, facture(7)), src(3, facture(8, { role: 'OTHER_EVIDENCE', hints: [], dates: { plannedDate: null, startDate: null, realizedDate: null, endDate: '2026-12-31' } }))], AUJ);
    expect(r.contract?.effectiveTo).toBe('2026-12-31');
    expect(r.provenance.endDate?.sourceId).toBe(3);
  });

  it('L86C-U-DATES-05 — financement : intérêts facturés ne datent pas le prêt ; l’offre de prêt oui', () => {
    const offre = facture(1, { type: 'FINANCING', role: 'CONTRACT_DOCUMENT', hints: [], dates: { plannedDate: null, startDate: '2026-02-15', realizedDate: null, endDate: '2031-02-15' } });
    const interets = facture(2, { type: 'FINANCING', role: 'INVOICE', dates: { plannedDate: null, startDate: '2026-02-15', realizedDate: null, endDate: '2032-02-14' } });
    expect(consolidateOperationState('FINANCING', [src(1, offre), src(2, interets)], AUJ).financing).toMatchObject({ effectiveFrom: '2026-02-15', effectiveTo: '2031-02-15' });
    expect(consolidateOperationState('FINANCING', [src(2, interets)], AUJ).financing).toMatchObject({ effectiveFrom: null, effectiveTo: null });
  });

  it('L86C-U-DATES-06 — persistance : une date retirée faute de source contractuelle porte son propre motif (historique réversible)', () => {
    expect(contractDatesReason({ effective_from: '2026-07-05', effective_to: '2026-08-04' }, { effectiveFrom: null, effectiveTo: null })).toBe(CONTRACT_DATES_UNPROVEN_REASON);
    expect(contractDatesReason({ effective_from: null, effective_to: null }, { effectiveFrom: '2026-01-01', effectiveTo: null })).toBe('T3_DETAILS_CONSOLIDATED');
    expect(contractDatesReason(undefined, { effectiveFrom: null, effectiveTo: null })).toBe('T3_DETAILS_CONSOLIDATED');
  });

  it('L86C-U-DATES-07 — interventions inchangées : la fin de prestation reste la date de réalisation (aucune régression)', () => {
    const inter = facture(3, { type: 'INTERVENTION', hints: [echeance(3, { amountScope: 'TOTAL', periodStart: null, periodEnd: null })], dates: { plannedDate: null, startDate: '2026-03-01', realizedDate: null, endDate: '2026-03-04' } });
    expect(consolidateOperationState('INTERVENTION', [src(1, inter)], AUJ)).toMatchObject({ startDate: '2026-03-01', endDate: '2026-03-04', realizedDate: '2026-03-04' });
  });
});

// ══ B. Agenda : plus de repli `contractEffectiveTo ?? endDate` ══════════════

function snapshot(over: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id: 86, accountId: 13, typeCode: 'CONTRACT', status: 'REALIZED', technicalLabel: 'Abonnement mensuel', provider: 'Télésurveillance Nord',
    plannedDate: null, realizedDate: null, endDate: '2026-11-04', active: true, assetIds: [14], equipmentIds: [], documentFileIds: [336],
    contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: null, ...over,
  };
}

describe('L86C-U-PROJ — échéance « Fin de contrat » seulement sur une fin d’effet établie', () => {
  it('L86C-U-PROJ-01 — fin de la dernière période facturée (end_date) sans fin d’effet : AUCUNE échéance (04/11/2026 non projeté)', () => {
    expect(decideProjection(snapshot(), AUJ)).toEqual({ kind: 'NONE', reason: 'NO_DATE', keepLinks: true });
    expect(projectionKeyOf(snapshot())).toBe('CONTRACT:END');
  });
  it('L86C-U-PROJ-02 — fin d’effet établie : échéance correcte, datée et actionnable', () => {
    expect(decideProjection(snapshot({ contractEffectiveTo: '2027-11-04' }), AUJ)).toMatchObject({
      kind: 'PROJECT', desired: { key: 'CONTRACT:END:2027-11-04', date: '2027-11-04', businessType: 'contract', nature: 'DEADLINE', creatable: true },
    });
  });
});

// ══ A. Désignations d'un même prestataire (preuves, aucun alias codé) ═══════

const preuve = (o: Partial<DesignationEvidence>): DesignationEvidence => ({
  supplierId: 1, supplierName: 'TSN Services SAS', provider: 'Télésurveillance Nord', role: 'INVOICE', reliable: true, fileId: 1, ...o,
});

describe('L86C-U-PROV — équivalence de désignations établie par les preuves du compte', () => {
  it('L86C-U-PROV-01 — facture émise par la fiche fournisseur « TSN Services » au nom commercial « Télésurveillance Nord » : désignations équivalentes', () => {
    const eq = buildProviderEquivalence([preuve({})]);
    expect(canonicalProviderKey('telesurveillancenord', eq)).toBe(canonicalProviderKey('tsnservices', eq));
    expect(providersEquivalent('telesurveillancenord', 'tsnservices', eq)).toBe(true);
    expect([...eq.classes.values()]).toEqual([{ keys: ['telesurveillancenord', 'tsnservices'], supplierIds: [1], fileIds: [1] }]);
  });

  it('L86C-U-PROV-02 — jamais : preuve de paiement (émetteur = banque), rôle non qualifié, lien incertain ; transitivité par fiche commune', () => {
    expect(buildProviderEquivalence([preuve({ role: 'PAYMENT_PROOF' })]).canonical.size).toBe(0);
    expect(buildProviderEquivalence([preuve({ role: null })]).canonical.size).toBe(0);
    expect(buildProviderEquivalence([preuve({ reliable: false })]).canonical.size).toBe(0);
    const eq = buildProviderEquivalence([preuve({ supplierName: 'TSN', provider: 'Télésurveillance Nord', fileId: 1 }), preuve({ supplierName: 'TSN', provider: 'TSN Services', fileId: 2 })]);
    expect(providersEquivalent('telesurveillancenord', 'tsnservices', eq)).toBe(true);
    // Indépendant de l'ordre des preuves.
    expect(buildProviderEquivalence([...[preuve({ fileId: 2, provider: 'TSN Services', supplierName: 'TSN' }), preuve({ fileId: 1, supplierName: 'TSN' })]]).canonical)
      .toEqual(eq.canonical);
    // Deux fournisseurs réellement distincts : aucune équivalence.
    expect(providersEquivalent('alpha', 'beta', buildProviderEquivalence([preuve({ supplierId: 1, supplierName: 'Alpha', provider: 'Alpha' }), preuve({ supplierId: 2, supplierName: 'Beta', provider: 'Beta' })]))).toBe(false);
  });

  it('L86C-U-PROV-03 — identité candidate : clé canonique (origine tracée) → série ÉTABLIE sur la clé de service commune malgré deux désignations', () => {
    const eq = buildProviderEquivalence([preuve({})]);
    const record: CandidateRecord = {
      id: 9, accountId: 13, fileId: 336, candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'CONTRACT', statusHint: 'REALIZED',
      summary: 'Abonnement mensuel', payload: { provider: 'TSN Services', sourceRoleHint: 'INVOICE', businessReferences: [{ kind: 'CUSTOMER', value: 'CL 778 812' }], financialHints: [echeance(7) as never] },
    };
    const id = buildCandidateIdentity(record, { fileAssetId: 14, liveAssetIds: new Set([14]), equipmentAssets: new Map(), providerCanonical: eq.canonical });
    expect(id).toMatchObject({ providerKey: canonicalProviderKey('tsnservices', eq), providerKeyRaw: 'tsnservices' });
    const op = contrat({ providerKey: canonicalProviderKey('telesurveillancenord', eq), providerKeyRaw: 'telesurveillancenord', refs: [{ kind: 'CUSTOMER', normalized: 'CL778812' }] });
    expect(assessSeries(id, op)).toMatchObject({ level: 'ESTABLISHED', keys: ['CUSTOMER:CL778812'] });
    const d = decideCandidate(id, ctx([op]));
    expect(d).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: 5, matchMethod: 'M1' });
    expect(d.detail.designations).toEqual([{ operationId: 5, basis: 'EQUIVALENT', reasons: ['SUPPLIER_EVIDENCE'] }]);
    // Sans preuve d'équivalence : deux tiers, aucune série établie.
    const brut = buildCandidateIdentity(record, { fileAssetId: 14, liveAssetIds: new Set([14]), equipmentAssets: new Map() });
    expect(assessSeries(brut, contrat({ refs: [{ kind: 'CUSTOMER', normalized: 'CL778812' }] })).level).toBe('NONE');
  });
});

describe('L86C-U-LINK — désignation différente sans preuve d’équivalence : M3, jamais une fusion d’office', () => {
  it('L86C-U-LINK-01 — désignation citée dans l’objet : mots entiers seulement', () => {
    expect(designationMentioned('telesurveillancenord', 'Abonnement mensuel Télésurveillance Nord — juillet')).toBe(true);
    expect(designationMentioned('nord', 'Abonnement Nordique')).toBe(false);
    expect(designationMentioned('sa', 'SA Martin')).toBe(false);
  });

  it('L86C-U-LINK-02 — cas réel #86 : facture « TSN Services » citant « Télésurveillance Nord », même bien → PLAUSIBLE → M3_REQUIRED (pas de création de doublon)', () => {
    const c = facture(7, { provider: 'TSN Services', providerKey: 'tsnservices' });
    expect(recurringDesignationLink(c, contrat())).toEqual(['DESIGNATION_CITED']);
    expect(isPlausible(c, contrat())).toBe(true);
    const d = decideCandidate(c, ctx([contrat()]));
    expect(d).toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED' });
    expect(d.detail.designations).toEqual([{ operationId: 5, basis: 'LINKED', reasons: ['DESIGNATION_CITED'] }]);
    // Référence de service commune (compte client) : même indice.
    const c2 = facture(7, { provider: 'TSN Services', providerKey: 'tsnservices', summary: 'Abonnement mensuel', refs: [ref('CUSTOMER', 'CL-1')] });
    expect(recurringDesignationLink(c2, contrat({ refs: [{ kind: 'CUSTOMER', normalized: 'CL1' }] }))).toEqual(['SERVICE_REFERENCE_COMMON']);
  });

  it('L86C-U-LINK-03 — deux tiers sans aucun lien documentaire : création (deux réalités), aucun appel M3', () => {
    const c = facture(7, { provider: 'Alarmes Sud', providerKey: 'alarmessud', summary: 'Abonnement mensuel' });
    expect(recurringDesignationLink(c, contrat())).toEqual([]);
    expect(decideCandidate(c, ctx([contrat()]))).toMatchObject({ outcome: 'CREATE_NEW' });
  });

  it('L86C-U-LINK-04 — deux contrats réellement distincts (références de contrat différentes) : jamais rapprochés, même désignation citée', () => {
    const c = facture(7, { provider: 'TSN Services', providerKey: 'tsnservices', refs: [ref('CONTRACT', 'ABO-2')] });
    expect(recurringDesignationLink(c, contrat({ refs: [{ kind: 'CONTRACT', normalized: 'ABO1' }] }))).toEqual([]);
    expect(decideCandidate(c, ctx([contrat({ refs: [{ kind: 'CONTRACT', normalized: 'ABO1' }] })])).outcome).toBe('CREATE_NEW');
  });

  it('L86C-U-LINK-05 — installation ponctuelle face à l’abonnement : jamais rattachée par le lien de désignation', () => {
    const installation = facture(7, {
      type: 'INTERVENTION', provider: 'TSN Services', providerKey: 'tsnservices', summary: 'Installation du système Télésurveillance Nord',
      hints: [echeance(7, { amountScope: 'TOTAL', periodStart: null, periodEnd: null, amountMinor: 45000 })],
    });
    expect(recurringDesignationLink(installation, contrat())).toEqual([]);
  });

  it('L86C-U-MERGE — fusion de deux Opérations à désignations différentes : seulement sur identité SÉMANTIQUE établie et lien documentaire', () => {
    const a = contrat();
    const b = contrat({ id: 86, providerKey: 'tsnservices', label: 'Abonnement mensuel Télésurveillance Nord', refs: [{ kind: 'INVOICE', normalized: 'FT7' }], periods: ['2026-07-05/2026-08-04'] });
    expect(operationsMergeable(a, b)).toBe(false);
    expect(operationsMergeable(a, b, undefined, { semantic: true })).toBe(true);
    expect(operationsMergeable(a, { ...b, label: 'Abonnement mensuel' }, undefined, { semantic: true })).toBe(false);
    expect(operationsMergeable(a, b, new Set(['5:86']), { semantic: true })).toBe(false);
    expect(operationsMergeable(a, { ...b, assetIds: [15] }, undefined, { semantic: true })).toBe(false);
  });
});

// ══ D. Assistant : une date d'agenda n'est une fin certaine que si sa provenance le justifie ══

describe('L86C-U-ASSIST — assistant Verebona', () => {
  it('L86C-U-ASSIST-01 — provenance d’une échéance d’agenda', () => {
    expect(agendaDateProvenance({ originFieldKey: 'contractEndDate' })).toBe('FIELD');
    expect(agendaDateProvenance({ projectionOrigin: 'OPERATION', isAutomatic: true })).toBe('OPERATION');
    expect(agendaDateProvenance({ isAutomatic: false })).toBe('USER');
    expect(agendaDateProvenance({ isAutomatic: true })).toBe('UNPROVEN');
  });

  it('L86C-U-ASSIST-02 — « Fin de contrat » automatique sans provenance contractuelle : jamais présentée comme une fin certaine', () => {
    expect(eventDateMeaning({ nature: 'DEADLINE', businessType: 'contract' })).toBe('contract_end');
    expect(eventDateMeaning({ nature: 'DEADLINE', businessType: 'contract', provenance: 'UNPROVEN' })).toBe('unknown');
    expect(eventDateMeaning({ nature: 'DEADLINE', businessType: 'contract', provenance: 'OPERATION' })).toBe('contract_end');
    const s = agendaBusinessSource({ id: 9, title: 'Fin de contrat — Télésurveillance Nord', date: '2026-11-04', nature: 'DEADLINE', businessType: 'contract', provenance: 'UNPROVEN' }, 14);
    expect(s.endDate).toBeNull();
    expect(s.detail).toContain('date à confirmer');
  });

  it('L86C-U-ASSIST-03 — contrat : la fin d’une période facturée (`endDate` historique) n’est jamais annoncée comme fin du contrat', () => {
    const op = {
      id: 86, accountId: 13, typeCode: 'CONTRACT', status: 'REALIZED', provider: 'TSN Services', technicalLabel: 'Abonnement mensuel', plannedDate: null,
      startDate: '2026-07-05', realizedDate: null, endDate: '2026-08-04', invalidatedAt: null, mergedIntoOperationId: null, lastReconciledAt: null, version: 1,
      active: true, contractReference: null, effectiveFrom: null, effectiveTo: null, claimStatus: null, claimType: null, insurerClaimRef: null,
      declaredOn: null, assetIds: [14], components: [], documents: [], sourceKinds: ['DOCUMENT'],
    } as unknown as Parameters<typeof operationBusinessSource>[0];
    expect(operationBusinessSource(op, 14, 'Maison').endDate).toBeNull();
    expect(operationBusinessSource({ ...op, effectiveTo: '2027-11-04' }, 14, 'Maison').endDate).toBe('2027-11-04');
  });
});
