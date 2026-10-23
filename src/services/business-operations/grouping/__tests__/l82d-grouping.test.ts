/**
 * Lot 82D — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-1
 * (socle) : règles PURES du service unique de regroupement, des invariants
 * déclarés pour le registre de cohérence (82B) et adaptation de la
 * projection T4 / consolidation 76H (V-Q4). Les écritures sont prouvées sur
 * PostgreSQL 16 par `l82d-operations-socle.e2e.ts`.
 *
 *   L82D-U01  rôle de la représentation T4 (événement global / échéance, §11.10, AC52)
 *   L82D-U02  autorité sur le principal (USER > T4 > T3 > SYSTEM, §10)
 *   L82D-U03  provenances d'un lien (normalisation, ajout, retrait, déduction)
 *   L82D-U04  propagation vers le principal : P4, rétroactivité, transfert, refus, idempotence
 *   L82D-U05  lien Agenda ↔ Agenda : les quatre cas (§8.3)
 *   L82D-U06  fusion : un seul principal, jamais d'absorption (V-Q4)
 *   L82D-U07  garde anti-cartésienne (P19, AC50)
 *   L82D-U08  invariants : évaluateurs purs (registre 82B)
 *   L82D-U09  projection : doublon de projection seulement à clé égale (V-Q4, échéances distinctes)
 *   L82D-U10  76H : un principal ou un élément rattaché par l'utilisateur n'est jamais absorbé (V-Q4)
 *   L82D-U11  projection : rôle planifié, principal utilisateur prioritaire
 *   L82D-U12  exécuteur : SQL paramétré (aucune interpolation de valeur)
 *   L82D-U13  V-Q6 : aucun texte visible « sous-structure » (Pièce seul terme métier)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

import {
  canReplacePrincipal, detectCartesian, guardDocumentEquipmentLinks, inferredProvenance, normalizeProvenances,
  planLinkAgendaItems, planPrincipalLinks, principalAfterMerge, projectionRoleOf, withProvenance, withoutProvenance,
} from '../model';
import {
  evaluateAgendaMembership, evaluateAntiCartesian, evaluateDocumentMembership, evaluateLinkProvenance,
  evaluatePrincipalDocuments, evaluatePrincipalUniqueness, OPERATIONS_GROUPING_INVARIANTS,
} from '../invariants';
import { compileSql } from '../runner';
import { coveredEquivalents, planOperationProjection, type AgendaItemSnapshot, type OperationSnapshot } from '../../agenda-projection/model';

describe('L82D-U01 — rôle de la représentation T4', () => {
  it('événement global → PRINCIPAL ; échéance de contrat et types non projetés → RELATED', () => {
    expect(['INTERVENTION', 'CLAIM', 'ACQUISITION', 'DISPOSAL'].map(projectionRoleOf)).toEqual(['PRINCIPAL', 'PRINCIPAL', 'PRINCIPAL', 'PRINCIPAL']);
    expect(projectionRoleOf('CONTRACT:END:2027-01-31')).toBe('RELATED');
    expect(projectionRoleOf('CONTRACT:END')).toBe('RELATED');
    expect(projectionRoleOf(null)).toBe('RELATED');
  });
});

describe('L82D-U02 — autorité sur le principal', () => {
  it('une inférence ne remplace jamais un principal choisi par l’utilisateur ; T4 corrige T4 ; l’utilisateur remplace tout', () => {
    expect(canReplacePrincipal('USER', 'T4')).toBe(false);
    expect(canReplacePrincipal('USER', 'T3')).toBe(false);
    expect(canReplacePrincipal('T4', 'T4')).toBe(true);
    expect(canReplacePrincipal('SYSTEM', 'T4')).toBe(true);
    expect(canReplacePrincipal('T4', 'USER')).toBe(true);
    expect(canReplacePrincipal(null, 'SYSTEM')).toBe(true);
  });
});

describe('L82D-U03 — provenances', () => {
  it('ensemble normalisé, cumul, retrait, déduction de la reprise 0654', () => {
    expect(normalizeProvenances(['OPERATION_PRINCIPAL', 'X', 'MANUAL_DIRECT', 'MANUAL_DIRECT'])).toEqual(['MANUAL_DIRECT', 'OPERATION_PRINCIPAL']);
    expect(withProvenance(['AI_DIRECT'], 'OPERATION_PRINCIPAL')).toEqual(['AI_DIRECT', 'OPERATION_PRINCIPAL']);
    expect(withoutProvenance(['AI_DIRECT', 'OPERATION_PRINCIPAL'], 'AI_DIRECT')).toEqual(['OPERATION_PRINCIPAL']);
    expect(withoutProvenance(['AI_DIRECT'], 'ALL')).toEqual([]);
    expect(inferredProvenance({ projected: true, isAutomatic: true, role: 'PRINCIPAL' })).toBe('OPERATION_PRINCIPAL');
    expect(inferredProvenance({ projected: true, isAutomatic: true, role: 'RELATED' })).toBe('AI_DIRECT');
    expect(inferredProvenance({ projected: false, isAutomatic: true, role: null })).toBe('AI_DIRECT');
    expect(inferredProvenance({ projected: false, isAutomatic: false, role: 'PRINCIPAL' })).toBe('MANUAL_DIRECT');
  });
});

describe('L82D-U04 — propagation des documents vers le principal (§7, P4)', () => {
  const base = { memberItemIds: [10, 11], rejectedFileIds: [] as number[] };
  it('AC05 / AC06 : tous les documents membres sont liés au principal, y compris ceux arrivés avant lui', () => {
    const p = planPrincipalLinks({ ...base, principalItemId: 10, memberFileIds: [1, 2, 3], links: [] });
    expect(p).toEqual({ add: [{ itemId: 10, fileId: 1 }, { itemId: 10, fileId: 2 }, { itemId: 10, fileId: 3 }], remove: [] });
  });
  it('AC08 : un lien précis existant reçoit la propagation sans être remplacé ; Opération sans principal : rien (§7.2)', () => {
    const p = planPrincipalLinks({ ...base, principalItemId: 10, memberFileIds: [1], links: [{ itemId: 10, fileId: 1, provenances: ['MANUAL_DIRECT'] }, { itemId: 11, fileId: 1, provenances: ['AI_DIRECT'] }] });
    expect(p).toEqual({ add: [{ itemId: 10, fileId: 1 }], remove: [] });
    expect(planPrincipalLinks({ ...base, principalItemId: null, memberFileIds: [1, 2], links: [] })).toEqual({ add: [], remove: [] });
  });
  it('AC07 / §11.9 : changement de principal — OPERATION_PRINCIPAL transférée, liens précis conservés', () => {
    const p = planPrincipalLinks({ ...base, principalItemId: 11, memberFileIds: [1, 2], links: [
      { itemId: 10, fileId: 1, provenances: ['OPERATION_PRINCIPAL'] },
      { itemId: 10, fileId: 2, provenances: ['MANUAL_DIRECT', 'OPERATION_PRINCIPAL'] },
    ] });
    expect(p.remove).toEqual([{ itemId: 10, fileId: 1 }, { itemId: 10, fileId: 2 }]);
    expect(p.add).toEqual([{ itemId: 11, fileId: 1 }, { itemId: 11, fileId: 2 }]);
  });
  it('§10 : un lien propagé refusé par l’utilisateur n’est pas recréé ; document retiré de l’Opération : propagation retirée', () => {
    const p = planPrincipalLinks({ ...base, principalItemId: 10, memberFileIds: [1], rejectedFileIds: [2], links: [
      { itemId: 10, fileId: 2, provenances: ['OPERATION_PRINCIPAL'] }, { itemId: 10, fileId: 3, provenances: ['OPERATION_PRINCIPAL', 'AI_DIRECT'] },
    ] });
    expect(p).toEqual({ add: [{ itemId: 10, fileId: 1 }], remove: [{ itemId: 10, fileId: 2 }, { itemId: 10, fileId: 3 }] });
  });
  it('idempotence : un état conforme rend un plan vide', () => {
    expect(planPrincipalLinks({ ...base, principalItemId: 10, memberFileIds: [1], links: [{ itemId: 10, fileId: 1, provenances: ['OPERATION_PRINCIPAL'] }] }))
      .toEqual({ add: [], remove: [] });
  });
});

describe('L82D-U05 — lien Agenda ↔ Agenda (§8.3)', () => {
  it('les quatre cas, fusion vers la plus ancienne Opération', () => {
    expect(planLinkAgendaItems({ itemId: 1, operationId: null }, { itemId: 2, operationId: null })).toEqual({ kind: 'CREATE' });
    expect(planLinkAgendaItems({ itemId: 1, operationId: 7 }, { itemId: 2, operationId: null })).toEqual({ kind: 'ATTACH', operationId: 7, itemId: 2 });
    expect(planLinkAgendaItems({ itemId: 1, operationId: null }, { itemId: 2, operationId: 7 })).toEqual({ kind: 'ATTACH', operationId: 7, itemId: 1 });
    expect(planLinkAgendaItems({ itemId: 1, operationId: 7 }, { itemId: 2, operationId: 7 })).toEqual({ kind: 'NOOP', operationId: 7 });
    expect(planLinkAgendaItems({ itemId: 1, operationId: 9 }, { itemId: 2, operationId: 7 })).toEqual({ kind: 'MERGE', canonicalId: 7, absorbedId: 9 });
  });
});

describe('L82D-U06 — fusion : un seul principal (V-Q4, §6.5)', () => {
  it('la canonique garde le sien ; à défaut celui de l’absorbée ; un choix utilisateur de l’absorbée prime sur une inférence', () => {
    expect(principalAfterMerge({ itemId: 1, origin: 'T4' }, { itemId: 2, origin: 'T4' })).toEqual({ keep: { itemId: 1, origin: 'T4' }, demote: [2] });
    expect(principalAfterMerge(null, { itemId: 2, origin: 'T4' })).toEqual({ keep: { itemId: 2, origin: 'T4' }, demote: [] });
    expect(principalAfterMerge({ itemId: 1, origin: 'T4' }, { itemId: 2, origin: 'USER' })).toEqual({ keep: { itemId: 2, origin: 'USER' }, demote: [1] });
    expect(principalAfterMerge(null, null)).toEqual({ keep: null, demote: [] });
  });
});

describe('L82D-U07 — garde anti-cartésienne (P19, AC50)', () => {
  const ctx = { memberFileIds: [1, 2, 3], equipmentIds: [20, 21] };
  it('seuls les liens portant une preuve propre au document passent ; l’appartenance à l’Opération n’en est jamais une', () => {
    const r = guardDocumentEquipmentLinks([
      { fileId: 1, equipmentId: 20, evidence: { kind: 'T1_TARGET', fileId: 1, ref: 'fact-1' } },
      { fileId: 2, equipmentId: 20, evidence: null },
      { fileId: 3, equipmentId: 21, evidence: { kind: 'IDENTIFIER', fileId: 1, ref: 'SN-1' } },
      { fileId: 9, equipmentId: 20, evidence: { kind: 'USER', fileId: 9 } },
      { fileId: 1, equipmentId: 99, evidence: { kind: 'USER', fileId: 1 } },
    ], ctx);
    expect(r.accepted).toEqual([{ fileId: 1, equipmentId: 20, evidence: { kind: 'T1_TARGET', fileId: 1, ref: 'fact-1' } }]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['NO_PER_DOCUMENT_EVIDENCE', 'NO_PER_DOCUMENT_EVIDENCE', 'NOT_MEMBER', 'EQUIPMENT_NOT_IN_OPERATION']);
  });
  it('une même preuve recopiée sur plusieurs documents est refusée (propagation déguisée)', () => {
    const r = guardDocumentEquipmentLinks([
      { fileId: 1, equipmentId: 20, evidence: { kind: 'AI_DECISION', fileId: 1, ref: 'op-ctx' } },
      { fileId: 2, equipmentId: 20, evidence: { kind: 'AI_DECISION', fileId: 2, ref: 'op-ctx' } },
    ], ctx);
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['SHARED_EVIDENCE', 'SHARED_EVIDENCE']);
  });
  it('détection : tous les documents × tous les équipements liés automatiquement → constat ; un lien utilisateur ne compte pas', () => {
    const tous = [1, 2].flatMap((f) => [20, 21].map((e) => ({ fileId: f, equipmentId: e, userOrigin: false })));
    expect(detectCartesian({ memberFileIds: [1, 2], equipmentIds: [20, 21], links: tous })).toEqual({ cartesian: true, pairs: 4 });
    expect(detectCartesian({ memberFileIds: [1, 2], equipmentIds: [20, 21], links: tous.slice(1) })).toEqual({ cartesian: false, pairs: 0 });
    expect(detectCartesian({ memberFileIds: [1, 2], equipmentIds: [20, 21], links: tous.map((l, i) => ({ ...l, userOrigin: i === 0 })) }).cartesian).toBe(false);
    expect(detectCartesian({ memberFileIds: [1], equipmentIds: [20, 21], links: tous }).cartesian).toBe(false);
  });
});

describe('L82D-U08 — invariants déclarés (registre 82B)', () => {
  it('registre : identifiants, niveaux, réparation déterministe sauf l’anti-cartésien (constat seul)', () => {
    expect(OPERATIONS_GROUPING_INVARIANTS.map((i) => [i.id, i.level, i.repair])).toEqual([
      ['O1-PRINCIPAL-UNIQUE', 'N1', 'DETERMINISTIC'], ['O1-AGENDA-ONE-OPERATION', 'N1', 'DETERMINISTIC'], ['O1-LINK-PROVENANCE', 'N1', 'DETERMINISTIC'],
      ['O1-PRINCIPAL-DOCUMENTS', 'N2', 'DETERMINISTIC'], ['O1-DOCUMENT-MEMBERSHIP', 'N2', 'DETERMINISTIC'], ['O1-ANTI-CARTESIAN', 'N2', 'DETECT_ONLY'],
      // Lot 83A (O-7, AC52) — invariant ajouté, même format : test complété.
      ['O7-NO-INFERRED-PRINCIPAL', 'N2', 'DETERMINISTIC'],
    ]);
    expect(OPERATIONS_GROUPING_INVARIANTS.every((i) => (i.repair === 'DETECT_ONLY') === !i.repairFinding)).toBe(true);
  });
  const m = (over: Partial<Parameters<typeof evaluateAgendaMembership>[1][number]>) => ({
    itemId: 1, accountId: 5, operationId: 7, role: 'RELATED' as const, operationAccountId: 5, operationActive: true, mergedInto: null, ...over,
  });
  it('unicité du principal et appartenance 0..1 (même compte, Opération active, rôle cohérent)', () => {
    expect(evaluatePrincipalUniqueness(5, [m({ itemId: 1, role: 'PRINCIPAL' }), m({ itemId: 2, role: 'PRINCIPAL' }), m({ itemId: 3 })]))
      .toEqual([expect.objectContaining({ objectKey: 'operation:7', nature: 'MULTIPLE_PRINCIPALS', detail: { operationId: 7, itemIds: [1, 2] } })]);
    expect(evaluateAgendaMembership(5, [
      m({}), m({ itemId: 2, operationId: null, role: 'RELATED' }), m({ itemId: 3, operationAccountId: 6 }), m({ itemId: 4, mergedInto: 8, operationActive: false }),
      m({ itemId: 5, operationActive: false }), m({ itemId: 6, role: null }), m({ itemId: 7, operationAccountId: null }),
    ]).map((f) => [f.objectKey, f.nature])).toEqual([
      ['agenda_item:2', 'ROLE_WITHOUT_OPERATION'], ['agenda_item:3', 'CROSS_ACCOUNT'], ['agenda_item:4', 'MERGED_OPERATION'],
      ['agenda_item:5', 'INACTIVE_OPERATION'], ['agenda_item:6', 'OPERATION_WITHOUT_ROLE'], ['agenda_item:7', 'OPERATION_MISSING'],
    ]);
  });
  it('provenance non vide, propagation, appartenance SOURCE, anti-cartésien (constat non réparable)', () => {
    expect(evaluateLinkProvenance(5, [{ itemId: 1, fileId: 2, provenances: [], projected: false, isAutomatic: true, role: null }, { itemId: 1, fileId: 3, provenances: ['AI_DIRECT'], projected: false, isAutomatic: true, role: null }]))
      .toEqual([expect.objectContaining({ nature: 'EMPTY_PROVENANCE', detail: { itemId: 1, fileId: 2, inferred: 'AI_DIRECT' } })]);
    expect(evaluatePrincipalDocuments(5, [{ operationId: 7, principalItemId: 1, memberItemIds: [1], memberFileIds: [2], rejectedFileIds: [], links: [] }])[0])
      .toMatchObject({ nature: 'MISSING_PRINCIPAL_LINK', detail: { add: [{ itemId: 1, fileId: 2 }] } });
    expect(evaluatePrincipalDocuments(5, [{ operationId: 7, principalItemId: 1, memberItemIds: [1], memberFileIds: [2], rejectedFileIds: [], links: [{ itemId: 1, fileId: 2, provenances: ['OPERATION_PRINCIPAL'] }] }])).toEqual([]);
    expect(evaluateDocumentMembership(5, [{ operationId: 7, fileId: 2, hasSourceOrigin: true, hasActiveSource: false }, { operationId: 7, fileId: 3, hasSourceOrigin: true, hasActiveSource: true }]).map((f) => f.nature))
      .toEqual(['STALE_SOURCE_MEMBERSHIP']);
    const tous = [1, 2].flatMap((f) => [20, 21].map((e) => ({ fileId: f, equipmentId: e, userOrigin: false })));
    expect(evaluateAntiCartesian(5, [{ operationId: 7, memberFileIds: [1, 2], equipmentIds: [20, 21], links: tous }]))
      .toEqual([expect.objectContaining({ invariantId: 'O1-ANTI-CARTESIAN', repairable: false, detail: expect.objectContaining({ pairs: 4 }) })]);
  });
});

// ── Projection T4 et consolidation 76H (V-Q4) ──────────────────────────────

const op = (over: Partial<OperationSnapshot> = {}): OperationSnapshot => ({
  id: 7, accountId: 5, typeCode: 'CONTRACT', status: 'REALIZED', technicalLabel: null, provider: 'Assur', plannedDate: null, realizedDate: null,
  endDate: '2027-01-31', active: true, assetIds: [3], equipmentIds: [], documentFileIds: [], contractEffectiveTo: '2027-01-31', claimHistoryEventId: null,
  disposalKind: null, exclusiveFileIds: [], ...over,
});
const item = (over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot => ({
  id: 1, title: 'Fin de contrat — Assur', date: '2027-01-31', manualStatus: null, isAutomatic: true, isAutomaticModified: false, projected: true,
  businessOperationId: 7, linkedOperationActive: true, nature: 'DEADLINE', businessType: 'contract', homeCategory: 'action', functionalKey: 'bo:v1:7:CONTRACT:END:2027-01-31',
  originRefType: 'business_operation', originRefId: 7, assetIds: [3], equipmentIds: [], fileIds: [], ...over,
});

describe('L82D-U09 — doublon de projection : seulement la même clé (V-Q4)', () => {
  it('deux échéances distinctes d’un contrat liées à la même Opération : aucune n’est retirée', () => {
    const o = op();
    const plan = planOperationProjection({
      op: o, decision: { kind: 'PROJECT', desired: { key: 'CONTRACT:END:2027-01-31', nature: 'DEADLINE', businessType: 'contract', date: '2027-01-31', title: 'Fin de contrat — Assur', category: 'action', target: 'OPEN', creatable: true } },
      linked: [item(), item({ id: 2, date: '2026-01-31', functionalKey: 'bo:v1:7:CONTRACT:END:2026-01-31' })], suppressedKeys: new Set(), candidates: [],
    });
    expect(plan.filter((a) => a.kind === 'REMOVE')).toEqual([]);
  });
  it('fusion : la projection de même clé de l’absorbée reste retirée (C22)', () => {
    const o = op();
    const plan = planOperationProjection({
      op: o, decision: { kind: 'PROJECT', desired: { key: 'CONTRACT:END:2027-01-31', nature: 'DEADLINE', businessType: 'contract', date: '2027-01-31', title: 'Fin de contrat — Assur', category: 'action', target: 'OPEN', creatable: true } },
      linked: [item(), item({ id: 2, functionalKey: 'bo:v1:9:CONTRACT:END:2027-01-31' })], suppressedKeys: new Set(), candidates: [],
    });
    expect(plan).toContainEqual({ kind: 'REMOVE', itemId: 2, reason: 'DUPLICATE_PROJECTION' });
  });
});

describe('L82D-U10 — 76H : jamais le principal, ni une étape rattachée par l’utilisateur (V-Q4)', () => {
  it('coveredEquivalents écarte un principal et un élément rattaché par l’utilisateur', () => {
    const o = op({ typeCode: 'INTERVENTION', realizedDate: '2021-07-07', exclusiveFileIds: [40], contractEffectiveTo: null, endDate: null });
    const d = { key: 'INTERVENTION', nature: 'HISTORICAL' as const, businessType: 'maintenance', date: '2021-07-07', title: 'x', category: 'information' as const, target: 'REALIZED' as const, creatable: true };
    const t4 = (over: Partial<AgendaItemSnapshot>) => item({ projected: false, businessOperationId: null, linkedOperationActive: false, nature: 'HISTORICAL', businessType: 'repair', date: '2021-07-07', originRefType: 'asset_file', originRefId: 40, functionalKey: null, ...over });
    const pool = [t4({ id: 1 }), t4({ id: 2, operationRole: 'PRINCIPAL', operationRoleOrigin: 'T4', businessOperationId: 7, linkedOperationActive: true }), t4({ id: 3, operationRole: 'RELATED', operationRoleOrigin: 'USER', businessOperationId: 7, linkedOperationActive: true })];
    expect(coveredEquivalents(o, d, pool).map((x) => x.id)).toEqual([1]);
  });
  it('ABSORBABLE_ROLE_SQL est appliqué à l’absorption, pas au changement d’intitulé du principal', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/business-operations/agenda-projection/consolidation.ts'), 'utf8');
    expect(src).toMatch(/AND \$\{ABSORBABLE_SQL\} \$\{ABSORBABLE_ROLE_SQL\}/);
    expect(src).toMatch(/i\.title = \$5 AND \$\{ABSORBABLE_SQL\}\s*\n\s*RETURNING/);
    expect(src).toMatch(/operation_role IS DISTINCT FROM 'PRINCIPAL'[\s\S]*operation_role_origin IS DISTINCT FROM 'USER'/);
  });
});

describe('L82D-U11 — projection : rôle de la représentation', () => {
  const d = { key: 'INTERVENTION', nature: 'HISTORICAL' as const, businessType: 'maintenance', date: '2026-01-05', title: 'Toiture', category: 'information' as const, target: 'REALIZED' as const, creatable: true };
  const o = op({ typeCode: 'INTERVENTION', realizedDate: '2026-01-05', technicalLabel: 'Toiture', contractEffectiveTo: null, endDate: null });
  const projete = (over: Partial<AgendaItemSnapshot> = {}) => item({ title: 'Toiture', date: '2026-01-05', nature: 'HISTORICAL', businessType: 'maintenance', homeCategory: 'information', functionalKey: 'bo:v1:7:INTERVENTION', ...over });
  it('élément représentatif encore RELATED → ROLE PRINCIPAL ; déjà principal → aucun ; rôle non lu (undefined) → aucun', () => {
    expect(planOperationProjection({ op: o, decision: { kind: 'PROJECT', desired: d }, linked: [projete({ operationRole: 'RELATED' })], suppressedKeys: new Set(), candidates: [] }))
      .toEqual([{ kind: 'ROLE', itemId: 1, role: 'PRINCIPAL' }]);
    expect(planOperationProjection({ op: o, decision: { kind: 'PROJECT', desired: d }, linked: [projete({ operationRole: 'PRINCIPAL' })], suppressedKeys: new Set(), candidates: [] })).toEqual([]);
    expect(planOperationProjection({ op: o, decision: { kind: 'PROJECT', desired: d }, linked: [projete()], suppressedKeys: new Set(), candidates: [] })).toEqual([]);
  });
  it('principal : les documents ne sont plus recopiés par la projection (propagation du service de regroupement)', () => {
    const plan = planOperationProjection({ op: { ...o, documentFileIds: [40] }, decision: { kind: 'PROJECT', desired: d }, linked: [projete({ operationRole: 'PRINCIPAL', fileIds: [] })], suppressedKeys: new Set(), candidates: [] });
    expect(plan).toEqual([]);
  });
  it('un principal désigné par l’utilisateur reste la représentation, même face à une projection', () => {
    const plan = planOperationProjection({
      op: o, decision: { kind: 'PROJECT', desired: d }, suppressedKeys: new Set(), candidates: [],
      linked: [projete({ id: 1, operationRole: 'RELATED' }), projete({ id: 2, projected: false, isAutomatic: false, title: 'Toit refait', operationRole: 'PRINCIPAL', operationRoleOrigin: 'USER' })],
    });
    expect(plan).toContainEqual({ kind: 'REMOVE', itemId: 1, reason: 'DUPLICATE_PROJECTION' });
    expect(plan.some((a) => a.kind === 'ROLE')).toBe(false);
  });
});

describe('L82D-U12 — exécuteur SQL', () => {
  it('paramètres liés, jamais interpolés ; paramètre absent refusé', () => {
    const q = new PgDialect().sqlToQuery(compileSql(`SELECT $1::int AS a, $2::text AS b WHERE x = $1`, [3, "o'k"]));
    expect(q.sql).not.toContain("o'k");
    expect(q.sql).toMatch(/^SELECT \$1::int AS a, \$2::text AS b WHERE x = \$3$/);
    expect(q.params).toEqual([3, "o'k", 3]);
    expect(() => compileSql('SELECT $2', [1])).toThrow(/paramètre/);
  });
});

describe('L82D-U13 — V-Q6 : « Pièce » seul terme métier visible', () => {
  it('aucun texte visible (interfaces, libellés BO, exports) ne dit « sous-structure »', () => {
    const racine = join(process.cwd(), 'src');
    const visibles: string[] = [];
    const parcourir = (d: string) => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) { if (!['__tests__', 'migrations', 'node_modules', 'test'].includes(n)) parcourir(f); continue; }
        if (!/\.(ts|tsx)$/.test(n)) continue;
        const t = readFileSync(f, 'utf8').split('\n');
        t.forEach((l, i) => {
          const code = l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/\/\*.*?\*\//g, '');
          if (/['"`][^'"`]*sous[- ]structure/i.test(code)) visibles.push(`${f.slice(racine.length + 1)}:${i + 1}`);
        });
      }
    };
    parcourir(racine);
    expect(visibles).toEqual([]);
  });
});
