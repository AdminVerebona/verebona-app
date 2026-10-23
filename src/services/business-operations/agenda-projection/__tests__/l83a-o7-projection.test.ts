/**
 * Lot 83A — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-7
 * (T4 / projection Agenda) : règles PURES — emplacement = principal,
 * principal facultatif, sans date, dates contradictoires, relations durables,
 * carte de date, invariant O7.
 */
import { describe, expect, it } from 'vitest';
import {
  decideProjection, establishedRealizedDate, planOperationProjection, realizedDateContested,
  type AgendaItemSnapshot, type OperationSnapshot,
} from '../model';
import { evaluateInferredPrincipal, OPERATIONS_GROUPING_INVARIANTS } from '../../grouping/invariants';
import { DURABLE_RELATION_TYPES, isDurableRelation } from '../../grouping/model';
import { agendaDateAdmissibility, OPERATION_PRINCIPAL_DATE_REASON } from '@/services/to-process/producers.service';
import { isAgendaDateValue } from '@/services/to-process/agenda-date-writer';

const AUJ = '2026-10-23';
function op(over: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id: 10, accountId: 1, typeCode: 'CLAIM', status: 'REALIZED', technicalLabel: 'Dégât des eaux', provider: null,
    plannedDate: null, realizedDate: '2026-03-12', endDate: null, active: true, assetIds: [5], equipmentIds: [], documentFileIds: [77],
    contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: 'SALE', ...over,
  };
}
function item(over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot {
  return {
    id: 100, title: 'Événement', date: '2026-03-12', manualStatus: null, isAutomatic: false, isAutomaticModified: false, projected: false,
    businessOperationId: 10, linkedOperationActive: true, nature: null, businessType: null, homeCategory: null, functionalKey: null,
    originRefType: null, originRefId: null, assetIds: [5], equipmentIds: [], fileIds: [], operationRole: 'RELATED', operationRoleOrigin: 'USER', ...over,
  };
}
const plan = (o: OperationSnapshot, p: { linked?: AgendaItemSnapshot[]; candidates?: AgendaItemSnapshot[] } = {}) =>
  planOperationProjection({
    op: o, decision: decideProjection(o, AUJ), linked: p.linked ?? [], suppressedKeys: new Set(), candidates: p.candidates ?? [],
    taken: new Set((p.linked ?? []).map((i) => i.id)), statusCardItems: new Set(),
  });

describe('L83A-U01 — clé de projection = principal (E01, E04, AC15, AC34)', () => {
  it('un membre lié n’est JAMAIS l’emplacement parce qu’il est lié : étape à une autre date → principal créé, étape intacte', () => {
    const visite = item({ id: 1, title: 'Visite expert', date: '2026-03-21' });
    const actions = plan(op(), { linked: [visite] });
    expect(actions).toEqual([expect.objectContaining({ kind: 'CREATE', functionalKey: 'bo:v1:10:CLAIM' })]);
  });
  it('AC15 : membre qui représente CERTAINEMENT l’événement global (même bien, même date, intitulé explicite) → reconnu comme principal', () => {
    const degat = item({ id: 2, title: 'Dégâts des eaux cuisine', date: '2026-03-12' });
    expect(plan(op(), { linked: [degat] })).toEqual([{ kind: 'LINK', itemId: 2, reason: expect.stringContaining('élément du regroupement') }]);
  });
  it('un membre seulement PROBABLE (même document, autre date) ne bloque pas : aucune abstention sur une étape (§6.5)', () => {
    const etape = item({ id: 3, title: 'Rapport', date: '2026-03-25', fileIds: [77], assetIds: [] });
    expect(plan(op(), { linked: [etape] })[0]).toMatchObject({ kind: 'CREATE' });
  });
  it('principal en place (quel qu’en soit l’auteur) : seul emplacement ; les étapes ne sont ni promues ni absorbées', () => {
    const principal = item({ id: 4, title: 'Dégât des eaux', projected: true, isAutomatic: true, nature: 'HISTORICAL', businessType: 'claim',
      homeCategory: 'information', functionalKey: 'bo:v1:10:CLAIM', operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' });
    const etapes = [item({ id: 5, title: 'Visite expert', date: '2026-03-21' }), item({ id: 6, title: 'Réparation plafond', date: '2026-04-18', operationRoleOrigin: 'T3' })];
    expect(plan(op(), { linked: [principal, ...etapes] })).toEqual([]);
  });
  it('propre projection d’un AUTRE type d’événement global (type requalifié) : reste l’emplacement, mise à jour, jamais dupliquée', () => {
    const ancienne = item({ id: 7, title: 'Intervention', projected: true, isAutomatic: true, nature: 'HISTORICAL', businessType: 'maintenance',
      homeCategory: 'information', functionalKey: 'bo:v1:10:INTERVENTION', operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' });
    expect(plan(op(), { linked: [ancienne] })).toEqual([{
      kind: 'SYNC', itemId: 7, changes: { title: 'Dégât des eaux', businessType: 'claim', functionalKey: 'bo:v1:10:CLAIM' },
    }]);
  });
  it('C16.1 / V-Q4 : propre projection INTACTE + membre qui représente CERTAINEMENT la même occurrence → la projection (vrai doublon) part, le membre devient principal ; une étape ne l’évince jamais', () => {
    const projection = item({ id: 20, title: 'Dégât des eaux', projected: true, isAutomatic: true, nature: 'HISTORICAL', businessType: 'claim',
      homeCategory: 'information', functionalKey: 'bo:v1:10:CLAIM', operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' });
    const saisi = item({ id: 21, title: 'Dégâts des eaux salle de bain', date: '2026-03-13', operationRoleOrigin: 'T3' });
    expect(plan(op(), { linked: [projection, saisi] })).toEqual([
      { kind: 'REMOVE', itemId: 20, reason: 'DUPLICATE_PROJECTION' },
      { kind: 'LINK', itemId: 21, reason: expect.stringContaining('élément du regroupement') },
    ]);
    const etape = { ...saisi, title: 'Visite expert', date: '2026-03-21' };
    expect(plan(op(), { linked: [projection, etape] })).toEqual([]);
    // Projection modifiée par l'utilisateur, ou principal choisi par l'utilisateur : jamais évincé.
    expect(plan(op(), { linked: [{ ...projection, isAutomaticModified: true }, saisi] }).some((a) => a.kind === 'REMOVE')).toBe(false);
    expect(plan(op(), { linked: [{ ...projection, operationRoleOrigin: 'USER' }, saisi] }).some((a) => a.kind === 'REMOVE')).toBe(false);
  });
  it('rôle posé par l’utilisateur jamais modifié par la projection (principal retiré par l’utilisateur : la projection ne le repromeut pas)', () => {
    const relache = item({ id: 8, title: 'Dégât des eaux', projected: true, isAutomatic: true, nature: 'HISTORICAL', businessType: 'claim',
      homeCategory: 'information', functionalKey: 'bo:v1:10:CLAIM', operationRole: 'RELATED', operationRoleOrigin: 'USER' });
    expect(plan(op(), { linked: [relache] })).toEqual([]);
  });
});

describe('L83A-U02 — principal sans date, date découverte, dates contradictoires (AC16 – AC20)', () => {
  it('AC17 / AC18 : événement réalisé sans date → CRÉÉ sans date ; aucune date inventée ; envisagé sans date → rien', () => {
    for (const typeCode of ['CLAIM', 'ACQUISITION', 'DISPOSAL', 'INTERVENTION'] as const) {
      const d = decideProjection(op({ typeCode, realizedDate: null }), AUJ);
      expect(d).toMatchObject({ kind: 'PROJECT', desired: { date: null, creatable: true, nature: 'HISTORICAL' } });
      expect(plan(op({ typeCode, realizedDate: null }))).toEqual([expect.objectContaining({ kind: 'CREATE', desired: expect.objectContaining({ date: null }) })]);
    }
    expect(decideProjection(op({ typeCode: 'CLAIM', status: 'ENVISAGED', realizedDate: null }), AUJ)).toMatchObject({ kind: 'NONE' });
  });
  it('AC19 : date établie ensuite → posée sur la projection intacte ; posée sur un principal T4 automatique intact resté sans date ; jamais sur une saisie', () => {
    const projete = item({ id: 9, title: 'Dégât des eaux', date: null, projected: true, isAutomatic: true, nature: 'HISTORICAL', businessType: 'claim',
      homeCategory: 'information', functionalKey: 'bo:v1:10:CLAIM', operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' });
    expect(plan(op(), { linked: [projete] })).toEqual([{ kind: 'SYNC', itemId: 9, changes: { date: '2026-03-12' } }]);
    const t4 = item({ id: 10, title: 'Sinistre', date: null, isAutomatic: true, operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' });
    expect(plan(op(), { linked: [t4] })).toEqual([{ kind: 'DATE', itemId: 10, date: '2026-03-12' }]);
    expect(plan(op(), { linked: [{ ...t4, isAutomaticModified: true }] })).toEqual([]);
    expect(plan(op(), { linked: [{ ...t4, isAutomatic: false }] })).toEqual([]);
    expect(plan(op(), { linked: [{ ...t4, pendingStatus: true }] })).toEqual([]);
  });
  it('AC20 / §11.8 : dates contradictoires de T3 → aucune date retenue ; la date projetée est retirée ; une saisie n’est jamais touchée', () => {
    const conteste = op({ realizedDateConflict: ['2025-09-02', '2026-03-12'] });
    expect(realizedDateContested(conteste)).toBe(true);
    expect(establishedRealizedDate(conteste)).toBeNull();
    expect(realizedDateContested(op({ realizedDateConflict: ['2026-03-12'] }))).toBe(false);
    expect(realizedDateContested(op({ realizedDateConflict: ['2026-03-12', 'n/a'] }))).toBe(false);
    expect(decideProjection(conteste, AUJ)).toMatchObject({ kind: 'PROJECT', desired: { date: null, creatable: true } });
    const projete = item({ id: 11, title: 'Dégât des eaux', projected: true, isAutomatic: true, nature: 'HISTORICAL', businessType: 'claim',
      homeCategory: 'information', functionalKey: 'bo:v1:10:CLAIM', operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' });
    expect(plan(conteste, { linked: [projete] })).toEqual([{ kind: 'SYNC', itemId: 11, changes: { date: null } }]);
    expect(plan(conteste, { linked: [{ ...projete, isAutomaticModified: true }] })).toEqual([]);
  });
  it('F-140 conservé : une occurrence PLANIFIÉE projetée garde sa date quand la réalisation n’a pas de date', () => {
    const planifie = item({ id: 12, title: 'Dégât des eaux', projected: true, isAutomatic: true, nature: 'DEADLINE', businessType: 'maintenance',
      homeCategory: 'action', functionalKey: 'bo:v1:10:INTERVENTION', date: '2026-02-01', operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' });
    expect(plan(op({ typeCode: 'INTERVENTION', realizedDate: null }), { linked: [planifie] })).toEqual([{ kind: 'SYNC', itemId: 12, changes: { manualStatus: 'realise' } }]);
  });
});

describe('L83A-U03 — principal facultatif : relation durable, regroupement non qualifié (AC52, §11.10)', () => {
  it('relations durables : contrat et financement (liste unique)', () => {
    expect([...DURABLE_RELATION_TYPES]).toEqual(['CONTRACT', 'FINANCING']);
    expect(isDurableRelation('CONTRACT')).toBe(true);
    expect(isDurableRelation('CLAIM')).toBe(false);
    expect(isDurableRelation(null)).toBe(false);
  });
  it('contrat sans échéance : rien n’est créé ; un principal DÉDUIT est rétrogradé, celui de l’utilisateur reste ; aucun élément détaché', () => {
    const contrat = op({ typeCode: 'CONTRACT', realizedDate: null });
    expect(plan(contrat)).toEqual([]);
    const deduit = item({ id: 13, operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' });
    expect(plan(contrat, { linked: [deduit] })).toEqual([{ kind: 'ROLE', itemId: 13, role: 'RELATED' }]);
    expect(plan(contrat, { linked: [{ ...deduit, operationRoleOrigin: 'USER' }] })).toEqual([]);
  });
  it('contrat avec échéance : l’échéance est un élément lié ; un principal déduit ailleurs est rétrogradé (une action par élément)', () => {
    const contrat = op({ typeCode: 'CONTRACT', contractEffectiveTo: '2027-03-01', realizedDate: null });
    const echeance = item({ id: 14, title: 'Fin de contrat', date: '2027-03-01', projected: true, isAutomatic: true, nature: 'DEADLINE', businessType: 'contract',
      homeCategory: 'action', functionalKey: 'bo:v1:10:CONTRACT:END:2027-03-01', fileIds: [77], operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4' });
    expect(plan(contrat, { linked: [echeance] })).toEqual([{ kind: 'ROLE', itemId: 14, role: 'RELATED' }]);
  });
  it('regroupement non qualifié (type nul) ou financement : aucun élément détaché, aucun principal créé ; projection intacte retirée', () => {
    const a = item({ id: 15 });
    const proj = item({ id: 16, projected: true, isAutomatic: true, operationRoleOrigin: 'T4' });
    for (const typeCode of [null, 'OTHER', 'FINANCING'] as const) {
      expect(plan(op({ typeCode }), { linked: [a, proj] })).toEqual([{ kind: 'REMOVE', itemId: 16, reason: 'TYPE_NOT_PROJECTED' }]);
    }
    // Opération invalidée : ses éléments la quittent (O1-AGENDA-ONE-OPERATION).
    expect(plan(op({ active: false }), { linked: [a] })).toEqual([{ kind: 'DETACH', itemId: 15, reason: 'INACTIVE' }]);
  });
});

describe('L83A-U04 — carte de date existante (DATA-AGENDA-DATE) et invariant O7', () => {
  const faits = { homeCategory: 'information', originType: 'deduced_rule', isAutomatic: true, isAutomaticModified: false, requiresQualification: false, createdAt: null, sourceDate: null };
  it('principal sans date : date NÉCESSAIRE même informatif (OPERATION_PRINCIPAL_DATE) ; « Sans échéance » prime ; non-principal informatif : aucune carte', () => {
    expect(agendaDateAdmissibility({ ...faits, operationPrincipal: true })).toMatchObject({ outcome: 'CREATE_ACTION' });
    expect(JSON.stringify(agendaDateAdmissibility({ ...faits, operationPrincipal: true }))).toContain(OPERATION_PRINCIPAL_DATE_REASON);
    expect(agendaDateAdmissibility({ ...faits, operationPrincipal: true, noDeadline: true }).outcome).not.toBe('CREATE_ACTION');
    expect(agendaDateAdmissibility({ ...faits }).outcome).not.toBe('CREATE_ACTION');
  });
  it('écrivain de la carte : date calendaire AAAA-MM-JJ valide seulement', () => {
    expect(isAgendaDateValue('2026-03-12')).toBe(true);
    for (const v of ['2026-02-30', '12/03/2026', '', null, 20260312]) expect(isAgendaDateValue(v)).toBe(false);
  });
  it('invariant O7-NO-INFERRED-PRINCIPAL : déclaré (même format que les O1-*), constat sur un principal déduit d’une relation durable seulement', () => {
    const inv = OPERATIONS_GROUPING_INVARIANTS.find((i) => i.id === 'O7-NO-INFERRED-PRINCIPAL')!;
    expect(inv).toMatchObject({ level: 'N2', repair: 'DETERMINISTIC', domain: 'operations', version: 1 });
    expect(typeof inv.repairFinding).toBe('function');
    const rows = [
      { operationId: 1, typeCode: 'CONTRACT', itemId: 11, origin: 'T4' as const },
      { operationId: 2, typeCode: 'FINANCING', itemId: 12, origin: null },
      { operationId: 3, typeCode: 'CONTRACT', itemId: 13, origin: 'USER' as const },
      { operationId: 4, typeCode: 'CLAIM', itemId: 14, origin: 'T4' as const },
    ];
    expect(evaluateInferredPrincipal(9, rows).map((f) => [f.objectKey, f.nature, f.repairable])).toEqual([
      ['operation:1', 'INFERRED_PRINCIPAL_ON_DURABLE_RELATION', true], ['operation:2', 'INFERRED_PRINCIPAL_ON_DURABLE_RELATION', true],
    ]);
  });
});
