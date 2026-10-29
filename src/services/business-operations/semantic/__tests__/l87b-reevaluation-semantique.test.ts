/**
 * Lot 87B — ticket P1 « Code — compléter l'orchestration T3/T4 et la
 * réévaluation sémantique » : règles PURES (contexte large et borné,
 * validation des réponses T4, plan d'application et protections, rôles
 * décidés, besoin de décision) et les huit cas obligatoires au niveau de la
 * projection et du plan. Les mêmes cas sont prouvés de bout en bout sur
 * PostgreSQL 16 dans `l87b-orchestration-t3-t4.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { buildRepresentationInput, DEFAULT_REPRESENTATION_BOUNDS, type RawContext, type RawItem, type RawOperation } from '../context';
import { validateRepresentation } from '../validate';
import { decidedRoles, planRepresentation } from '../plan';
import { representationNeeded } from '../orchestrator';
import { productionRepresentationDecider, representationCapabilityOf, representationEnabled } from '../decider';
import { REPRESENTATION_CONTRACT_VERSION, T4AgendaRepresentationOutput } from '../contract';
import {
  decideProjection, planOperationProjection, type AgendaItemSnapshot, type OperationSnapshot,
} from '../../agenda-projection/model';

const AUJ = '2026-10-24';

function rawOp(over: Partial<RawOperation> = {}): RawOperation {
  return {
    id: 10, typeCode: 'INTERVENTION', status: 'REALIZED', label: 'Réparation fuite cuisine', provider: 'Plomberie Durand',
    plannedDate: null, startDate: null, realizedDate: '2026-03-18', endDate: null, active: true, assetIds: [5], equipmentIds: [], roomIds: [],
    fileIds: [77, 78], amounts: [], references: [], ...over,
  };
}
function rawItem(over: Partial<RawItem> = {}): RawItem {
  return {
    id: 100, title: 'Réparation', date: '2026-03-18', nature: 'HISTORICAL', businessType: 'repair', isAutomatic: true, isAutomaticModified: false,
    manualStatus: null, pendingStatus: false, confirmedByUser: false, projected: false, operationId: null, operationActive: false, role: null, roleOrigin: null,
    fileIds: [77], originFileId: 77, sources: [{ fileId: 77, role: 'EVIDENCE' }], assetIds: [5], restoredByUser: false, ...over,
  };
}
function raw(over: Partial<RawContext> = {}): RawContext {
  return {
    today: AUJ, accountId: 1, operation: rawOp(), neighbours: [], scopeItems: [rawItem({ id: 100 }), rawItem({ id: 101, fileIds: [78], originFileId: 78, title: 'Réparation fuite' })],
    contextItems: [], restorables: [], documents: [
      { id: 77, type: 'INVOICE', title: 'Facture', date: '2026-03-18', provider: 'Plomberie Durand', amounts: [], references: [], excerpts: ['Réparation fuite sous évier'], operationIds: [10] },
      { id: 78, type: 'REPORT', title: 'Rapport', date: '2026-03-18', provider: 'Plomberie Durand', amounts: [], references: [], excerpts: ['Intervention du 18/03'], operationIds: [10] },
    ],
    decisions: { detachedItemIds: [], attachedItemIds: [], detachedLinks: [], principalWithdrawn: false, userPrincipalItemId: null, suppressedKeys: [] },
    prior: [], ...over,
  };
}
const occ = (items: string[], keep: string, role: 'PRINCIPAL' | 'STEP' | 'INDEPENDENT', confidence: 'certain' | 'probable' = 'certain') =>
  ({ items, keep, role, confidence, evidence: [], reason: 'raison' });
const decision = (occurrences: unknown[], extra: Record<string, unknown> = {}) =>
  ({ task: 'AGENDA_REPRESENTATION', outcome: 'DECIDED', occurrences, restorations: [], reason: 'décision', ...extra });

// ── Contexte (CODE-01) ─────────────────────────────────────────────────────

describe('L87B-U-CTX — contexte large, borné, références opaques (CODE-01)', () => {
  it('L87B-U-CTX-01 — Opération, voisines, tous les éléments à décider, documents et extraits, décisions de l’utilisateur ; aucun identifiant technique transmis', () => {
    const b = buildRepresentationInput(raw({
      neighbours: [rawOp({ id: 11, label: 'Entretien chaudière', fileIds: [90] })],
      contextItems: [rawItem({ id: 200, operationId: 11, operationActive: true, fileIds: [90], originFileId: 90 })],
      decisions: { detachedItemIds: [], attachedItemIds: [], detachedLinks: [{ itemId: 100, fileId: 78 }], principalWithdrawn: false, userPrincipalItemId: null, suppressedKeys: [] },
    }));
    expect(b.input.contractVersion).toBe(REPRESENTATION_CONTRACT_VERSION);
    expect(b.input.operation.ref).toBe('O1');
    expect(b.input.neighbours.map((n) => n.ref)).toEqual(['O2']);
    expect(b.input.agendaItems.map((i) => [i.ref, i.inScope, i.operationRef])).toEqual([['A1', true, null], ['A2', true, null], ['A3', false, 'O2']]);
    expect(b.input.documents.map((d) => d.ref)).toEqual(['D1', 'D2']);
    expect(b.input.documents[0].excerpts).toEqual(['Réparation fuite sous évier']);
    expect(b.input.userDecisions).toEqual([{ kind: 'LINK_DETACHED', item: 'A1', document: 'D2' }]);
    // Aucun identifiant technique dans ce qui part vers l'IA.
    const texte = JSON.stringify(b.input);
    expect(texte).not.toMatch(/"(100|101|200|77|78|90)"/);
    expect(b.scope.items.map((i) => i.id)).toEqual([100, 101, 200]);
    expect(b.input.bounds.complete).toBe(true);
  });

  it('L87B-U-CTX-02 — empreinte stable (indépendante de la date du jour et des décisions antérieures) ; bornes déclarées ; trop d’éléments à décider → aucune demande', () => {
    const a = buildRepresentationInput(raw());
    const b = buildRepresentationInput(raw({ today: '2026-11-30', prior: [{ at: 'x', scope: 'T4', status: 'NO_CHANGE', summary: 's' }] }));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(buildRepresentationInput(raw({ scopeItems: [rawItem({ id: 100 })] })).fingerprint).not.toBe(a.fingerprint);
    const borne = { ...DEFAULT_REPRESENTATION_BOUNDS, maxDocuments: 1, maxExcerptsPerDocument: 0 };
    const reduit = buildRepresentationInput(raw(), borne);
    expect(reduit.input.bounds).toMatchObject({ complete: false, droppedDocuments: 1, droppedExcerpts: 1 });
    const trop = buildRepresentationInput(raw({ scopeItems: Array.from({ length: 21 }, (_, k) => rawItem({ id: 300 + k })) }));
    expect(trop.tooLarge).toBe(true);
  });
});

// ── Validation (CODE-10, cas 8) ─────────────────────────────────────────────

describe('L87B-U-VAL — validation des réponses T4 : refus en bloc, jamais d’heuristique de repli (CODE-10, cas 8)', () => {
  const b = buildRepresentationInput(raw({ contextItems: [rawItem({ id: 200, operationId: 11, operationActive: true })] }));
  it('L87B-U-VAL-01 — réponse conforme acceptée ; abstention acceptée', () => {
    expect(validateRepresentation(decision([occ(['A1', 'A2'], 'A1', 'PRINCIPAL')]), b.scope).ok).toBe(true);
    expect(validateRepresentation({ task: 'AGENDA_REPRESENTATION', outcome: 'ABSTAIN', reason: 'preuves insuffisantes' }, b.scope).ok).toBe(true);
  });
  it('L87B-U-VAL-02 / cas 8 — identifiant inexistant, référence hors périmètre, contradiction interne, décision incomplète, hors schéma : REFUSÉE (motifs tracés)', () => {
    const motifs = (out: unknown) => { const v = validateRepresentation(out, b.scope); return v.ok ? [] : v.problems.map((p) => p.issue); };
    expect(motifs(decision([occ(['A1', 'A9'], 'A1', 'PRINCIPAL'), occ(['A2'], 'A2', 'STEP')]))).toContain('UNKNOWN_REFERENCE');
    expect(motifs(decision([occ(['A1', 'A2', 'A3'], 'A1', 'PRINCIPAL')]))).toContain('OUT_OF_SCOPE_REFERENCE');
    expect(motifs(decision([occ(['A1', 'A2'], 'A1', 'PRINCIPAL'), occ(['A2'], 'A2', 'STEP')]))).toContain('ITEM_IN_SEVERAL_OCCURRENCES');
    expect(motifs(decision([occ(['A1'], 'A1', 'PRINCIPAL'), occ(['A2'], 'A2', 'PRINCIPAL')]))).toContain('SEVERAL_PRINCIPALS');
    expect(motifs(decision([occ(['A1'], 'A1', 'PRINCIPAL')]))).toContain('ITEM_NOT_DECIDED');
    expect(motifs(decision([occ(['A1', 'A2'], 'A3', 'PRINCIPAL')]))).toContain('SCHEMA');
    expect(motifs({ task: 'AGENDA_REPRESENTATION', outcome: 'ABSTAIN', occurrences: [occ(['A1'], 'A1', 'STEP')], reason: 'x' })).toContain('SCHEMA');
    expect(motifs({ foo: 'bar' })).toContain('SCHEMA');
    expect(motifs(decision([occ(['A1', 'A2'], 'A1', 'PRINCIPAL')], { identityConcern: { kind: 'SPLIT', items: ['A7'], reason: 'x' } }))).toContain('UNKNOWN_REFERENCE');
  });
  it('L87B-U-VAL-03 — le contrat de sortie est le schéma unique (aucune lecture « tolérante »)', () => {
    expect(T4AgendaRepresentationOutput.safeParse(decision([occ(['A1'], 'A1', 'PRINCIPAL')], { outcome: 'MERGE' })).success).toBe(false);
  });
});

// ── Plan, protections, rôles décidés (CODE-08, CODE-09, CODE-11) ───────────

describe('L87B-U-PLAN — décision validée → mutations ; protections de l’utilisateur ; idempotence', () => {
  it('L87B-U-PLAN-01 / cas 2 — deux descriptions d’une même occurrence : UNE consolidation sur l’élément conservé (preuves conservées par le moteur 76H), rôles mémorisés', () => {
    const b = buildRepresentationInput(raw());
    const d = T4AgendaRepresentationOutput.parse(decision([occ(['A1', 'A2'], 'A1', 'PRINCIPAL')]));
    const p = planRepresentation(d, b.scope);
    expect(p.mutations).toEqual([
      { kind: 'ATTACH', itemId: 100, role: 'PRINCIPAL', reason: 'T4 : raison' },
      { kind: 'CONSOLIDATE', keepId: 100, absorbIds: [101], reason: 'T4 : raison' },
    ]);
    expect(p.refused).toEqual([]);
    expect(decidedRoles(d, b.scope)).toEqual({ 100: 'PRINCIPAL', 101: 'DUPLICATE' });
  });

  it('L87B-U-PLAN-02 / cas 1 — visite préparatoire puis réparation : deux occurrences (principal + étape) rattachées, AUCUNE consolidation', () => {
    const b = buildRepresentationInput(raw({ scopeItems: [rawItem({ id: 100, title: 'Visite préparatoire', date: '2026-03-15', businessType: 'maintenance' }), rawItem({ id: 101, fileIds: [78], originFileId: 78 })] }));
    const d = T4AgendaRepresentationOutput.parse(decision([occ(['A1'], 'A1', 'STEP'), occ(['A2'], 'A2', 'PRINCIPAL')]));
    const p = planRepresentation(d, b.scope);
    expect(p.mutations.map((m) => m.kind)).toEqual(['ATTACH', 'ATTACH']);
    expect(p.mutations.some((m) => m.kind === 'CONSOLIDATE' || m.kind === 'REMOVE_PROJECTION')).toBe(false);
    expect(decidedRoles(d, b.scope)).toEqual({ 100: 'STEP', 101: 'PRINCIPAL' });
  });

  it('L87B-U-PLAN-03 / cas 5 — étapes fusionnées à tort par l’ancienne règle : restauration de l’occurrence absorbée, rattachée comme étape', () => {
    const b = buildRepresentationInput(raw({
      scopeItems: [rawItem({ id: 100, operationId: 10, operationActive: true, role: 'PRINCIPAL', roleOrigin: 'T4' })],
      restorables: [{ journalId: 5, absorbedItemId: 101, principalItemId: 100, title: 'Visite préparatoire', date: '2026-03-15', businessType: 'maintenance', fileIds: [78], reason: 'EQUIVALENT_BY_OPERATION', at: '2026-04-01', restorable: true }],
    }));
    expect(b.input.restorable).toEqual([expect.objectContaining({ ref: 'R1', absorbedInto: 'A1' })]);
    const d = T4AgendaRepresentationOutput.parse(decision([occ(['A1'], 'A1', 'PRINCIPAL')], { restorations: [{ restore: 'R1', role: 'STEP', confidence: 'certain', evidence: [], reason: 'visite distincte' }] }));
    const p = planRepresentation(d, b.scope);
    expect(p.mutations).toEqual([{ kind: 'RESTORE', journalId: 5, absorbedItemId: 101, role: 'RELATED', reason: 'T4 : visite distincte' }]);
    expect(decidedRoles(d, b.scope)).toEqual({ 100: 'PRINCIPAL', 101: 'STEP' });
  });

  it('L87B-U-PLAN-04 / cas 7 — correction de l’utilisateur : un élément détaché par lui n’est jamais rattaché ni absorbé ; une décision qui le toucherait est refusée', () => {
    const b = buildRepresentationInput(raw({ decisions: { detachedItemIds: [101], attachedItemIds: [], detachedLinks: [], principalWithdrawn: false, userPrincipalItemId: null, suppressedKeys: [] } }));
    const absorbe = planRepresentation(T4AgendaRepresentationOutput.parse(decision([occ(['A1', 'A2'], 'A1', 'PRINCIPAL')])), b.scope);
    expect(absorbe.refused).toEqual([expect.objectContaining({ reason: 'USER_DETACHED' })]);
    const rattache = planRepresentation(T4AgendaRepresentationOutput.parse(decision([occ(['A1'], 'A1', 'PRINCIPAL'), occ(['A2'], 'A2', 'STEP')])), b.scope);
    expect(rattache.refused).toEqual([expect.objectContaining({ reason: 'USER_DETACHED' })]);
    expect(rattache.mutations.some((m) => m.kind === 'ATTACH' && m.itemId === 101)).toBe(false);
  });

  it('L87B-U-PLAN-04b / cas 7 — document détaché par l’utilisateur de l’élément conservé : absorber un élément issu de ce document est refusé (relation corrigée jamais rétablie)', () => {
    const b = buildRepresentationInput(raw({ decisions: { detachedItemIds: [], attachedItemIds: [], detachedLinks: [{ itemId: 100, fileId: 78 }], principalWithdrawn: false, userPrincipalItemId: null, suppressedKeys: [] } }));
    const p = planRepresentation(T4AgendaRepresentationOutput.parse(decision([occ(['A1', 'A2'], 'A1', 'PRINCIPAL')])), b.scope);
    expect(p.refused).toEqual([expect.objectContaining({ reason: 'USER_DETACHED_LINK' })]);
    expect(p.mutations.some((m) => m.kind === 'CONSOLIDATE')).toBe(false);
  });

  it('L87B-U-PLAN-05 — élément touché par l’utilisateur, principal de l’utilisateur, élément d’une autre Opération : jamais absorbés ni remplacés (refus tracé)', () => {
    const touche = buildRepresentationInput(raw({ scopeItems: [rawItem({ id: 100 }), rawItem({ id: 101, isAutomaticModified: true })] }));
    expect(planRepresentation(T4AgendaRepresentationOutput.parse(decision([occ(['A1', 'A2'], 'A1', 'PRINCIPAL')])), touche.scope).refused)
      .toEqual([expect.objectContaining({ reason: 'USER_TOUCHED' })]);
    const user = buildRepresentationInput(raw({
      scopeItems: [rawItem({ id: 100, operationId: 10, operationActive: true, role: 'PRINCIPAL', roleOrigin: 'USER', isAutomatic: false }), rawItem({ id: 101 })],
      decisions: { detachedItemIds: [], attachedItemIds: [], detachedLinks: [], principalWithdrawn: false, userPrincipalItemId: 100, suppressedKeys: [] },
    }));
    expect(planRepresentation(T4AgendaRepresentationOutput.parse(decision([occ(['A1'], 'A1', 'STEP'), occ(['A2'], 'A2', 'PRINCIPAL')])), user.scope).refused.map((r) => r.reason))
      .toEqual(expect.arrayContaining(['USER_PRINCIPAL']));
  });

  it('L87B-U-PLAN-06 — idempotence : la même décision sur l’état qu’elle a produit ne produit AUCUNE mutation ; une décision non certaine ne mute rien', () => {
    const apres = buildRepresentationInput(raw({ scopeItems: [rawItem({ id: 100, operationId: 10, operationActive: true, role: 'PRINCIPAL', roleOrigin: 'T4' })] }));
    expect(planRepresentation(T4AgendaRepresentationOutput.parse(decision([occ(['A1'], 'A1', 'PRINCIPAL')])), apres.scope)).toEqual({ mutations: [], refused: [] });
    const b = buildRepresentationInput(raw());
    const p = planRepresentation(T4AgendaRepresentationOutput.parse(decision([occ(['A1', 'A2'], 'A1', 'PRINCIPAL', 'probable')])), b.scope);
    expect(p.mutations).toEqual([]);
    expect(p.refused.every((r) => r.reason === 'NOT_CERTAIN')).toBe(true);
  });
});

describe('L87B-U-ORCH — besoin de décision, capacité de production', () => {
  it('L87B-U-ORCH-01 — plusieurs éléments à décider, consolidation historique, ou candidat demandé non rattaché → décision T4 ; une seule représentation liée → rien', () => {
    expect(representationNeeded(buildRepresentationInput(raw()))).toBe(true);
    const seul = buildRepresentationInput(raw({ scopeItems: [rawItem({ id: 100, operationId: 10, operationActive: true, role: 'PRINCIPAL' })] }));
    expect(representationNeeded(seul)).toBe(false);
    const candidat = buildRepresentationInput(raw({ scopeItems: [rawItem({ id: 100 })] }));
    expect(representationNeeded(candidat)).toBe(false);
    expect(representationNeeded(candidat, [100])).toBe(true);
  });
  it('L87B-U-ORCH-02 — prompt T4 livré (sans le marqueur, lot 97A) : capacité de production INDISPONIBLE (aucun appel), coupure d’urgence', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { executionConfigFor } = await import('@/services/ai/master-prompts/structured-context');
    const texte = readFileSync(join(process.cwd(), 'src/services/ai/prompts/agenda/t4_master_v1.txt'), 'utf-8');
    expect(representationCapabilityOf({ text: texte, version: 'file', execution: executionConfigFor({ masterPromptCode: 't4_master_v1', source: 'file' }) }))
      .toEqual({ available: false, version: null, reason: 'CONTRACT_PENDING', contractState: 'MARKER_MISSING' });
    expect(representationEnabled({ T4_AGENDA_REPRESENTATION_ENABLED: '0' })).toBe(false);
    const prev = process.env.T4_AGENDA_REPRESENTATION_ENABLED;
    process.env.T4_AGENDA_REPRESENTATION_ENABLED = '0';
    try {
      expect(await productionRepresentationDecider.capability()).toEqual({ available: false, version: null, reason: 'DISABLED' });
    } finally {
      if (prev === undefined) delete process.env.T4_AGENDA_REPRESENTATION_ENABLED; else process.env.T4_AGENDA_REPRESENTATION_ENABLED = prev;
    }
  });
});

// ── Projection : les cas du ticket au niveau du plan (CODE-03, CODE-04) ─────

function op(over: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id: 10, accountId: 1, typeCode: 'INTERVENTION', status: 'REALIZED', technicalLabel: 'Réparation fuite cuisine', provider: 'Plomberie Durand',
    plannedDate: null, realizedDate: '2026-03-18', endDate: null, active: true, assetIds: [5], equipmentIds: [], documentFileIds: [77, 78],
    contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: null, exclusiveFileIds: [77, 78], ...over,
  };
}
function t4(over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot {
  return {
    id: 100, title: 'Réparation — Maison', date: '2026-03-18', manualStatus: null, isAutomatic: true, isAutomaticModified: false, projected: false,
    businessOperationId: null, linkedOperationActive: false, nature: 'HISTORICAL', businessType: 'repair', homeCategory: 'information', functionalKey: null,
    originRefType: 'asset_file', originRefId: 77, assetIds: [5], equipmentIds: [], fileIds: [77], pendingStatus: false, originFieldKey: null, sourceCount: 1, ...over,
  };
}
const planDe = (o: OperationSnapshot, p: { linked?: AgendaItemSnapshot[]; candidates?: AgendaItemSnapshot[]; roles?: Array<[number, 'PRINCIPAL' | 'STEP' | 'INDEPENDENT' | 'DUPLICATE']> } = {}) =>
  planOperationProjection({
    op: o, decision: decideProjection(o, AUJ), linked: p.linked ?? [], suppressedKeys: new Set(), candidates: p.candidates ?? [],
    statusCardItems: new Set(), t4Roles: p.roles ? new Map(p.roles) : undefined,
  });

describe('L87B-U-CAS — les cas du ticket au niveau de la projection (aucune fusion décidée par le code)', () => {
  it('L87B-U-CAS-01 — une Opération, deux étapes (visite préparatoire puis réparation, dates proches) : aucune fusion ; décision T4 ; une fois décidée, deux éléments', () => {
    const visite = t4({ id: 100, title: 'Visite préparatoire', date: '2026-03-16', businessType: 'maintenance', originRefId: 77, fileIds: [77] });
    const reparation = t4({ id: 101, originRefId: 78, fileIds: [78] });
    const p = planDe(op(), { candidates: [visite, reparation] });
    expect(p.some((a) => a.kind === 'LINK' || a.kind === 'REMOVE')).toBe(false);
    expect(p).toContainEqual({ kind: 'REPRESENTATION_REQUIRED', itemIds: [100, 101], reason: 'SEVERAL_COVERED_REPRESENTATIONS' });
    // T4 a décidé : réparation principale (liée), visite étape (liée) — plus rien à demander, rien n'est créé ni retiré.
    const apres = planDe(op(), {
      linked: [{ ...reparation, businessOperationId: 10, linkedOperationActive: true, operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' },
        { ...visite, businessOperationId: 10, linkedOperationActive: true, operationRole: 'RELATED', operationRoleOrigin: 'T4' }],
      roles: [[101, 'PRINCIPAL'], [100, 'STEP']],
    });
    expect(apres.some((a) => a.kind === 'REPRESENTATION_REQUIRED' || a.kind === 'ABSTAIN' || a.kind === 'REMOVE' || a.kind === 'CREATE')).toBe(false);
  });

  it('L87B-U-CAS-03 — deux interventions proches mais distinctes (même bien, même prestataire) : chaque Opération garde son événement, aucune fusion', () => {
    const a = t4({ id: 100, title: 'Réparation fuite', originRefId: 77, fileIds: [77], coveredByOperationId: 10 });
    const b = t4({ id: 101, title: 'Entretien chaudière', businessType: 'maintenance', date: '2026-03-19', originRefId: 78, fileIds: [78], coveredByOperationId: 11 });
    const opA = op({ id: 10, documentFileIds: [77], exclusiveFileIds: [77] });
    const opB = op({ id: 11, documentFileIds: [78], exclusiveFileIds: [78], technicalLabel: 'Entretien chaudière', realizedDate: '2026-03-19' });
    expect(planDe(opA, { candidates: [a, b] })[0]).toEqual({ kind: 'LINK', itemId: 100, reason: 'représentation établie par l’Opération (T3)' });
    expect(planDe(opB, { candidates: [a, b] })[0]).toEqual({ kind: 'LINK', itemId: 101, reason: 'représentation établie par l’Opération (T3)' });
  });

  it('L87B-U-CAS-YIELD — projection technique et événement T4 d’un document dont l’Opération est la SEULE Opération : la projection cède sa place (provenance exacte) ; document partagé : décision T4', () => {
    const projete = t4({ id: 200, title: 'Réparation fuite cuisine', projected: true, businessOperationId: 10, linkedOperationActive: true,
      originRefType: 'business_operation', originRefId: 10, functionalKey: 'bo:v1:10:INTERVENTION', fileIds: [], operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' });
    const evt = t4({ id: 100, title: 'Intervention plombier', originSoleOperationId: 10 });
    const o = op({ exclusiveFileIds: [] });
    expect(planDe(o, { linked: [projete], candidates: [projete, evt] }).slice(0, 2)).toEqual([
      { kind: 'REMOVE', itemId: 200, reason: 'PROJECTION_YIELDS_TO_T4_REPRESENTATION' },
      { kind: 'LINK', itemId: 100, reason: 'représentation établie par l’Opération (T3)' },
    ]);
    const partage = planDe(o, { linked: [projete], candidates: [projete, { ...evt, originSoleOperationId: null }] });
    expect(partage).toContainEqual({ kind: 'REPRESENTATION_REQUIRED', itemIds: [200, 100], reason: 'CANDIDATES_BESIDE_SLOT' });
    expect(partage.some((a) => a.kind === 'REMOVE')).toBe(false);
  });

  it('L87B-U-CAS-07 — document d’origine détaché par l’utilisateur : l’origine n’est plus une provenance (aucun rattachement d’office)', () => {
    const item = t4({ id: 100, originLinkRejected: true, fileIds: [] });
    const p = planDe(op(), { candidates: [item] });
    expect(p.some((a) => a.kind === 'LINK')).toBe(false);
  });

  it('L87B-U-CAS-SIG — « même bien + même catégorie + date proche » (exemple interdit du ticket) n’est jamais une décision : candidat soumis à T4 et à l’utilisateur', () => {
    const saisi = t4({ id: 100, isAutomatic: false, originRefType: null, originRefId: null, fileIds: [], title: 'Réparation fuite' });
    const p = planDe(op({ exclusiveFileIds: [] }), { candidates: [saisi] });
    expect(p).toEqual([expect.objectContaining({ kind: 'ABSTAIN', itemId: 100 }), { kind: 'REPRESENTATION_REQUIRED', itemIds: [100], reason: 'UNCERTAIN_EXISTING_EVENT' }]);
  });
});
