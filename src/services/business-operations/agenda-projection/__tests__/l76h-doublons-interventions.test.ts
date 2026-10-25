/**
 * Lot 76H — [P1] Opérations → Agenda : doublons d'interventions (« Réparation
 * — Maison » / « Entretien réalisé — Prestation » du 07/07/2021 issus d'un
 * même document). Règles PURES : projection (convergence, abstention,
 * protections), T3 (deux candidats d'un même document), diagnostic BO.
 */
import { describe, expect, it } from 'vitest';
import {
  choosePrincipal, coveredEquivalents, decideProjection, isGenericAgendaTitle, planOperationProjection, preciseOperationTitle,
  type AgendaItemSnapshot, type OperationSnapshot,
} from '../model';
import { sameDocumentReality } from '../../consolidation/matching';
import type { CandidateIdentity } from '../../consolidation/model';
import { classifyDuplicateCause } from '../../diagnostics/agenda-duplicates';

const AUJ = '2026-10-21';
const DOC = 77;
const BIEN = 5;

function op(over: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id: 10, accountId: 1, typeCode: 'INTERVENTION', status: 'REALIZED', technicalLabel: 'Remplacement du ballon d’eau chaude', provider: 'Plomberie Durand',
    plannedDate: null, realizedDate: '2021-07-07', endDate: null, active: true, assetIds: [BIEN], equipmentIds: [], documentFileIds: [DOC],
    contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: 'SALE', exclusiveFileIds: [DOC], ...over,
  };
}
/** Événement automatique T4 intact produit par le document `DOC`. */
function t4(over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot {
  return {
    id: 100, title: 'Réparation — Maison', date: '2021-07-07', manualStatus: null, isAutomatic: true, isAutomaticModified: false, projected: false,
    businessOperationId: null, linkedOperationActive: false, nature: 'HISTORICAL', businessType: 'repair', homeCategory: 'information', functionalKey: null,
    originRefType: 'asset_file', originRefId: DOC, assetIds: [BIEN], equipmentIds: [], fileIds: [DOC], pendingStatus: false, originFieldKey: null, sourceCount: 1, ...over,
  };
}
const reparation = () => t4({ id: 101, title: 'Réparation — Maison', businessType: 'repair', originFieldKey: null });
const entretien = () => t4({ id: 102, title: 'Entretien réalisé — Prestation', businessType: 'maintenance', originFieldKey: 'lastRevision', sourceCount: 2 });
const plan = (o: OperationSnapshot, p: { linked?: AgendaItemSnapshot[]; candidates?: AgendaItemSnapshot[]; suppressed?: string[]; taken?: number[] } = {}) =>
  planOperationProjection({
    op: o, decision: decideProjection(o, AUJ), linked: p.linked ?? [], suppressedKeys: new Set(p.suppressed ?? []),
    candidates: p.candidates ?? [], statusCardItems: new Set(), taken: new Set(p.taken ?? []),
  });

describe('L76H — projection : une intervention établie = une représentation d’agenda', () => {
  it('L76H-01 / C16-13 adapté — une Opération, deux événements T4 (entretien + réparation du même document, identité établie par T3) : décision T4 demandée, aucune absorption par le code', () => {
    // Lot 87B — test corrigé (ticket « orchestration T3/T4 », CODE-04, cas 1 et 2) : l'ancienne attente
    // (CONSOLIDATE 102 ← 101) encodait une décision sémantique du code (provenance + type + date). Doublons
    // ou étapes distinctes : T4 décide (REPRESENTATION_REQUIRED) ; à défaut, carte D14 (ordre de présentation
    // `choosePrincipal` : champ explicite, plus de preuves).
    const actions = plan(op(), { candidates: [reparation(), entretien()] });
    expect(actions).toEqual([
      { kind: 'ABSTAIN', reason: 'PROBABLE_EQUIVALENT: plusieurs représentations possibles', itemId: 102, key: 'INTERVENTION', candidates: [
        expect.objectContaining({ itemId: 102 }), expect.objectContaining({ itemId: 101 }),
      ] },
      { kind: 'REPRESENTATION_REQUIRED', itemIds: [101, 102], reason: 'SEVERAL_COVERED_REPRESENTATIONS' },
    ]);
    expect(actions.some((a) => a.kind === 'LINK' || a.kind === 'REMOVE' || a.kind === 'RETITLE')).toBe(false);
  });

  it('L87B-U-PROJ-01 — une seule représentation T4 d’un document dont T3 a fait la preuve de l’Opération : rattachée par provenance (aucune fusion)', () => {
    const actions = plan(op(), { candidates: [entretien()] });
    expect(actions[0]).toEqual({ kind: 'LINK', itemId: 102, reason: 'représentation établie par l’Opération (T3)' });
    expect(actions[1]).toEqual({ kind: 'RETITLE', itemId: 102, title: 'Remplacement du ballon d’eau chaude', from: 'Entretien réalisé — Prestation' });
  });

  it('L76H-02 / C16-13 — identité INCERTAINE (T3 n’a pas consolidé toute la preuve du document) : abstention et arbitrage, aucune fusion', () => {
    const actions = plan(op({ exclusiveFileIds: [] }), { candidates: [reparation(), entretien()] });
    // Lot 87B : la décision est aussi demandée à T4 (rattachement ou événements distincts).
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'ABSTAIN', reason: expect.stringContaining('PROBABLE_EQUIVALENT') }),
      expect.objectContaining({ kind: 'REPRESENTATION_REQUIRED', reason: 'UNCERTAIN_EXISTING_EVENT' }),
    ]);
    expect(actions.some((a) => a.kind === 'LINK' || a.kind === 'REMOVE')).toBe(false);
  });

  it('L76H-03 — même document + même date + même bien ne suffit JAMAIS (sans décision T3 : liste vide)', () => {
    const o = op({ exclusiveFileIds: undefined });
    const d = decideProjection(o, AUJ);
    if (d.kind !== 'PROJECT') throw new Error('projection attendue');
    expect(coveredEquivalents(o, d.desired, [reparation(), entretien()])).toEqual([]);
  });

  it('L76H-04 — deux interventions distinctes (deux Opérations du même document, même date) : aucune n’est exclusive → deux événements conservés', () => {
    const o1 = op({ id: 10, exclusiveFileIds: [], technicalLabel: 'Réparation fuite' });
    const o2 = op({ id: 11, exclusiveFileIds: [], technicalLabel: 'Entretien chaudière' });
    for (const o of [o1, o2]) {
      const actions = plan(o, { candidates: [reparation(), entretien()] });
      // Lot 87B : abstention (carte D14) + demande de décision T4 ; jamais un rattachement.
      expect(actions.every((a) => a.kind === 'ABSTAIN' || a.kind === 'REPRESENTATION_REQUIRED')).toBe(true);
      expect(actions.some((a) => a.kind === 'ABSTAIN')).toBe(true);
    }
  });

  it('L76H-05 — événement modifié par l’utilisateur : jamais absorbé ni renommé ; identité incertaine → arbitrage', () => {
    const modifie = t4({ id: 103, title: 'Réparation — Maison', isAutomaticModified: true });
    const actions = plan(op(), { candidates: [modifie, entretien()] });
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'ABSTAIN', candidates: expect.arrayContaining([expect.objectContaining({ itemId: 103 })]) }),
      expect.objectContaining({ kind: 'REPRESENTATION_REQUIRED', itemIds: expect.arrayContaining([102, 103]) }),
    ]);
    // Statut posé par l'utilisateur, saisi à la main : idem (jamais un rattachement ni un retrait).
    for (const x of [t4({ id: 104, manualStatus: 'realise' }), t4({ id: 105, isAutomatic: false })]) {
      expect(plan(op(), { candidates: [x, entretien()] }).some((a) => a.kind === 'LINK' || a.kind === 'REMOVE')).toBe(false);
    }
  });

  it('L76H-06 — statut « à qualifier » / « à confirmer » ou consolidation restaurée : jamais absorbé', () => {
    const aQualifier = t4({ id: 106, pendingStatus: true });
    const actions = plan(op(), { candidates: [aQualifier, entretien()] });
    expect(actions.some((a) => a.kind === 'LINK' || a.kind === 'REMOVE')).toBe(false);
    expect(actions[0]).toMatchObject({ kind: 'ABSTAIN' });
  });

  it('L76H-07 — T3 avant T4 : l’Opération est déjà représentée (projection) ; plusieurs événements T4 créés ensuite → décision T4 (lot 87B), la projection ne cède pas', () => {
    const projete = t4({
      id: 200, title: 'Remplacement du ballon d’eau chaude', projected: true, businessOperationId: 10, linkedOperationActive: true, businessType: 'maintenance',
      originRefType: 'business_operation', originRefId: 10, functionalKey: 'bo:v1:10:INTERVENTION', homeCategory: 'information',
    });
    const actions = plan(op(), { linked: [projete], candidates: [projete, reparation(), entretien()], taken: [200] });
    // Lot 87B — test corrigé : l'absorption par la projection (CONSOLIDATE 200 ← 101, 102) était une fusion décidée par le code.
    expect(actions).toEqual([{ kind: 'REPRESENTATION_REQUIRED', itemIds: [200, 101, 102], reason: 'EQUIVALENTS_BESIDE_SLOT' }]);
    // UNE seule représentation T4 : la projection technique intacte lui cède la place (retrait tracé, rattachement par provenance).
    expect(plan(op(), { linked: [projete], candidates: [projete, entretien()], taken: [200] })).toEqual([
      { kind: 'REMOVE', itemId: 200, reason: 'PROJECTION_YIELDS_TO_T4_REPRESENTATION' },
      { kind: 'LINK', itemId: 102, reason: 'représentation établie par l’Opération (T3)' },
      { kind: 'RETITLE', itemId: 102, title: 'Remplacement du ballon d’eau chaude', from: 'Entretien réalisé — Prestation' },
    ]);
    // Une projection qui porte une décision de l'utilisateur (lien détaché) ne cède jamais sa place : T4 décide.
    expect(plan(op(), { linked: [{ ...projete, userLinkDecision: true }], candidates: [projete, entretien()], taken: [200] }))
      .toEqual([{ kind: 'REPRESENTATION_REQUIRED', itemIds: [200, 102], reason: 'EQUIVALENTS_BESIDE_SLOT' }]);
  });

  it('L76H-08 — réanalyse après consolidation : état à jour → plan VIDE (aucun doublon recréé, aucune écriture)', () => {
    const principal = entretien();
    // Lot 83A : après consolidation, l'élément conservé est le PRINCIPAL de l'Opération.
    const lie = { ...principal, businessOperationId: 10, linkedOperationActive: true, title: 'Remplacement du ballon d’eau chaude', operationRole: 'PRINCIPAL' as const, operationRoleOrigin: 'T4' };
    expect(plan(op(), { linked: [lie], candidates: [lie], taken: [lie.id] })).toEqual([]);
  });

  it('L76H-09 — Opération liée à plusieurs événements T4 équivalents : lot 87B — plus aucune absorption par le code, décision T4, convergence une fois décidée', () => {
    const a = { ...reparation(), businessOperationId: 10, linkedOperationActive: true, operationRole: 'RELATED' as const, operationRoleOrigin: 'T4' };
    const b = { ...entretien(), businessOperationId: 10, linkedOperationActive: true, operationRole: 'RELATED' as const, operationRoleOrigin: 'T4' };
    const actions = plan(op(), { linked: [a, b], candidates: [a, b], taken: [101, 102] });
    // Lot 83A : sans principal, aucun membre n'est l'emplacement du seul fait d'être lié. Lot 87B — test
    // corrigé : ni absorption, ni principal choisi par le code — décision T4 (et carte D14 à défaut).
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'ABSTAIN', itemId: 102 }),
      { kind: 'REPRESENTATION_REQUIRED', itemIds: [101, 102], reason: 'SEVERAL_COVERED_REPRESENTATIONS' },
    ]);
    // Principal déjà désigné : il garde son rôle ; l'autre n'est plus absorbé — T4 dit s'il est un doublon ou une étape.
    const avecPrincipal = plan(op(), { linked: [{ ...a, operationRole: 'PRINCIPAL' }, b], candidates: [a, b], taken: [101, 102] });
    expect(avecPrincipal[0]).toEqual({ kind: 'REPRESENTATION_REQUIRED', itemIds: [101, 102], reason: 'EQUIVALENTS_BESIDE_SLOT' });
    expect(avecPrincipal.some((x) => x.kind === 'REMOVE' || x.kind === 'LINK')).toBe(false);
    // T4 a décidé (étape distincte) : plus aucune demande, plus aucune carte (convergence, CODE-11).
    const decide = planOperationProjection({
      op: op(), decision: decideProjection(op(), AUJ), linked: [{ ...a, operationRole: 'PRINCIPAL' }, b], suppressedKeys: new Set(),
      candidates: [a, b], statusCardItems: new Set(), taken: new Set([101, 102]), t4Roles: new Map([[101, 'PRINCIPAL'], [102, 'STEP']]),
    });
    expect(decide.some((x) => x.kind === 'REPRESENTATION_REQUIRED' || x.kind === 'ABSTAIN')).toBe(false);
  });

  it('L76H-10 — fusion de deux Opérations : l’événement de l’Opération absorbée (inactive) devient la représentation de la canonique', () => {
    const residuel = { ...reparation(), businessOperationId: 11, linkedOperationActive: false };
    const actions = plan(op(), { candidates: [residuel, entretien()] });
    // Lot 87B — test corrigé : candidats de la canonique, décision T4 (aucune absorption par le code).
    expect(actions[1]).toMatchObject({ kind: 'REPRESENTATION_REQUIRED', itemIds: [101, 102] });
    // L'Opération absorbée ne se projette plus (liens retirés, détachement gardé côté service).
    expect(decideProjection(op({ id: 11, active: false }), AUJ)).toMatchObject({ kind: 'NONE', reason: 'INACTIVE' });
  });

  it('L76H-11 — contrôle, DPE, autre nature ou autre date : jamais absorbés', () => {
    const o = op();
    const d = decideProjection(o, AUJ);
    if (d.kind !== 'PROJECT') throw new Error('projection attendue');
    const exclus = [
      t4({ id: 300, businessType: 'inspection' }), t4({ id: 301, businessType: 'dpe' }), t4({ id: 302, nature: 'DEADLINE' }),
      t4({ id: 303, date: '2021-07-20' }), t4({ id: 304, originRefId: 999 }), t4({ id: 305, assetIds: [6] }),
      t4({ id: 306, businessOperationId: 12, linkedOperationActive: true }), t4({ id: 307, projected: true }),
    ];
    expect(coveredEquivalents(o, d.desired, exclus)).toEqual([]);
  });

  it('L76H-15 — événements d’un autre document représentant une AUTRE intervention établie par T3 : pas des candidats (chaque Opération converge sur les siens)', () => {
    const autreDoc = (id: number, bt: string) => t4({ id, businessType: bt, originRefId: 78, fileIds: [78], coveredByOperationId: 11 });
    const actions = plan(op(), { candidates: [reparation(), entretien(), autreDoc(201, 'repair'), autreDoc(202, 'maintenance')] });
    // Lot 87B : seuls les événements de SES documents sont soumis à T4 pour cette Opération.
    expect(actions[1]).toEqual({ kind: 'REPRESENTATION_REQUIRED', itemIds: [101, 102], reason: 'SEVERAL_COVERED_REPRESENTATIONS' });
    // Sans décision T3 sur l'autre document : identité incertaine → arbitrage (et décision T4).
    const incertain = plan(op(), { candidates: [reparation(), entretien(), t4({ id: 203, originRefId: 78, fileIds: [78] })] });
    expect(incertain[0]).toMatchObject({ kind: 'ABSTAIN' });
    expect(incertain.every((a) => a.kind === 'ABSTAIN' || a.kind === 'REPRESENTATION_REQUIRED')).toBe(true);
  });

  it('L76H-12 — suppression de projection mémorisée : ni lien, ni consolidation', () => {
    expect(plan(op(), { candidates: [reparation(), entretien()], suppressed: ['INTERVENTION'] })).toEqual([{ kind: 'SUPPRESSED', key: 'INTERVENTION' }]);
  });

  it('L76H-13 — ordre de présentation des candidats (lot 87B : ne décide plus le principal) : déjà lié, date exacte, champ explicite, preuves, plus ancien', () => {
    const a = t4({ id: 1, date: '2021-07-08' });
    const b = t4({ id: 2, originFieldKey: 'lastRevision' });
    const c = t4({ id: 3, sourceCount: 5 });
    expect(choosePrincipal([a, b, c], 10, '2021-07-07').id).toBe(2);
    expect(choosePrincipal([a, c], 10, '2021-07-07').id).toBe(3);
    expect(choosePrincipal([b, { ...a, businessOperationId: 10 }], 10, '2021-07-07').id).toBe(1);
    expect(choosePrincipal([c, b, a], 10, '2021-07-07').id).toBe(choosePrincipal([a, b, c], 10, '2021-07-07').id);
  });

  it('L76H-14 — intitulés : générique T4 remplacé seulement par une description PRÉCISE et prouvée ; jamais inventée', () => {
    expect(isGenericAgendaTitle('Réparation — Maison')).toBe(true);
    expect(isGenericAgendaTitle('Entretien réalisé — Prestation')).toBe(true);
    expect(isGenericAgendaTitle('Intervention — Plomberie Durand')).toBe(true);
    expect(isGenericAgendaTitle('Entretien chaudière')).toBe(false);
    expect(preciseOperationTitle({ technicalLabel: 'Remplacement du ballon d’eau chaude' })).toBe('Remplacement du ballon d’eau chaude');
    for (const t of [null, 'Intervention', 'Réparation', 'Facture travaux', 'Opération de maintenance']) expect(preciseOperationTitle({ technicalLabel: t })).toBeNull();
    // Libellé générique : rien n'est renommé.
    expect(plan(op({ technicalLabel: 'Intervention' }), { candidates: [entretien()] }).some((a) => a.kind === 'RETITLE')).toBe(false);
  });
});

// ── T3 : deux candidats T1 d'un même document ───────────────────────────────

function cand(over: Partial<CandidateIdentity> = {}): CandidateIdentity {
  return {
    candidateId: 1, candidateKey: 'op1', fileId: DOC, established: true, confidence: 'certain', type: 'INTERVENTION', status: 'REALIZED', role: 'INVOICE',
    summary: 'Réparation fuite', provider: 'Plomberie Durand', providerKey: 'plomberiedurand', assetIds: [BIEN], targetAuthority: 'DOCUMENT', equipmentIds: [],
    refs: [{ kind: 'INVOICE', value: 'F-2021-77', normalized: 'f202177' }],
    dates: { plannedDate: null, startDate: null, realizedDate: '2021-07-07', endDate: null }, hints: [], ...over,
  };
}

describe('L76H — T3 : deux candidats T1 d’un même document', () => {
  it('L76H-T3-01 — même facture (référence identifiante commune), même prestataire : MÊME réalité → une Opération', () => {
    expect(sameDocumentReality(cand({ candidateKey: 'op2', candidateId: 2, summary: 'Entretien' }), cand())).toBe(true);
  });
  it('L76H-T3-02 / F-027 — sans référence propre commune : deux réalités (aucune fusion sur la date, le bien ou le type)', () => {
    expect(sameDocumentReality(cand({ candidateKey: 'op2', refs: [] }), cand({ refs: [] }))).toBe(false);
    expect(sameDocumentReality(cand({ candidateKey: 'op2', refs: [{ kind: 'INVOICE', value: 'X', normalized: 'x' }] }), cand())).toBe(false);
  });
  it('L76H-T3-03 — ordres de travail distincts, prestataires différents, autre document, même candidat : jamais fusionnés', () => {
    const ot = (v: string) => [{ kind: 'INVOICE' as const, value: 'F', normalized: 'f' }, { kind: 'WORK_ORDER' as const, value: v, normalized: v }];
    expect(sameDocumentReality(cand({ candidateKey: 'op2', refs: ot('ot1') }), cand({ refs: ot('ot2') }))).toBe(false);
    expect(sameDocumentReality(cand({ candidateKey: 'op2', providerKey: 'autre' }), cand())).toBe(false);
    expect(sameDocumentReality(cand({ candidateKey: 'op2', fileId: 78 }), cand())).toBe(false);
    expect(sameDocumentReality(cand(), cand())).toBe(false);
  });
});

// ── Diagnostic BO (§3.1) ────────────────────────────────────────────────────

describe('L76H — diagnostic de la cause réelle (BO)', () => {
  const items = [
    { id: 101, title: 'Réparation — Maison', date: '2021-07-07', businessType: 'repair', businessOperationId: null, projected: false, touched: false },
    { id: 102, title: 'Entretien réalisé — Prestation', date: '2021-07-07', businessType: 'maintenance', businessOperationId: null, projected: false, touched: false },
  ];
  const c = (k: string, opId: number | null, refs: string[] = ['INVOICE:f202177']) =>
    ({ candidateKey: k, typeHint: 'INTERVENTION', established: true, t3Pending: false, t3Outcome: opId ? 'CREATE_NEW' : 'HOLD_UNRESOLVED', t3Reason: opId ? null : 'M3_REQUIRED', canonicalOperationId: opId, refs });
  const o = (id: number, exclusive: boolean) => ({ id, typeCode: 'INTERVENTION', status: 'REALIZED', date: '2021-07-07', label: 'Réparation', exclusive });

  it('L76H-D-01 — une seule Opération : défaut de convergence Opération → Agenda', () => {
    const v = classifyDuplicateCause({ items, operations: [o(10, true)], candidates: [c('op1', 10)] });
    expect(v.cause).toBe('ONE_OPERATION');
    expect(v.remedy).toMatch(/T4/);
  });
  it('L76H-D-02 — deux Opérations et référence commune : défaut de consolidation T3 ; sans référence commune : interventions distinctes', () => {
    expect(classifyDuplicateCause({ items, operations: [o(10, false), o(11, false)], candidates: [c('op1', 10), c('op2', 11)] }))
      .toMatchObject({ cause: 'TWO_OPERATIONS', label: expect.stringMatching(/défaut de consolidation T3/) });
    expect(classifyDuplicateCause({ items, operations: [o(10, false), o(11, false)], candidates: [c('op1', 10, []), c('op2', 11, [])] }))
      .toMatchObject({ cause: 'TWO_OPERATIONS', label: expect.stringMatching(/distinctes/) });
  });
  it('L76H-D-03 — aucune Opération : motif T3 rendu, aucune Opération artificielle', () => {
    const v = classifyDuplicateCause({ items, operations: [], candidates: [c('op1', null)] });
    expect(v.cause).toBe('NO_OPERATION');
    expect(v.findings.join(' ')).toMatch(/M3_REQUIRED/);
    expect(v.remedy).toMatch(/Aucune Opération artificielle/);
  });
});
