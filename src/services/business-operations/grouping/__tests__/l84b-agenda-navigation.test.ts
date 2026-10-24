/**
 * Lot 84B — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lot O-3
 * (Agenda et navigation) : règles PURES et structure du code.
 *
 *   L84B-U01  retrait du rôle principal par l'utilisateur : seule une nouvelle désignation USER le rétablit
 *   L84B-U02  projection T4 : retrait mémorisé → ni reconnaissance, ni création, ni promotion, ni éviction
 *   L84B-U03  invariant O3-PRINCIPAL-WITHDRAWN : déclaré (registre de cohérence), évaluateur pur
 *   L84B-U04  mémoire unifiée : objet PRINCIPAL (modèle, migration 0684 sur-ensemble de 0656, schéma)
 *   L84B-U05  vocabulaire : jamais « Opération » ni « principal » dans les libellés de l'interface
 *   L84B-U06  résumé chiffré du tiroir léger
 *   L84B-U07  routes : compte actif, lecture seule refusée AVANT toute écriture, aucune écriture hors service
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideProjection, planOperationProjection, type AgendaItemSnapshot, type OperationSnapshot } from '../../agenda-projection/model';
import { evaluateWithdrawnPrincipal, GROUPING_INVARIANTS_VERSION, OPERATIONS_GROUPING_INVARIANTS } from '../invariants';
import { DECISION_SUBJECTS, mayDesignatePrincipal } from '../model';
import { GROUPING_ACTIONS, GROUPING_LABELS, groupingCountsSummary, isGroupingAction } from '@/lib/agenda/grouping-view';

const ROOT = process.cwd();
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

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
const plan = (o: OperationSnapshot, p: { linked?: AgendaItemSnapshot[]; candidates?: AgendaItemSnapshot[]; withdrawn?: boolean } = {}) =>
  planOperationProjection({
    op: o, decision: decideProjection(o, AUJ), linked: p.linked ?? [], suppressedKeys: new Set(), candidates: p.candidates ?? [],
    taken: new Set((p.linked ?? []).map((i) => i.id)), statusCardItems: new Set(), principalWithdrawn: p.withdrawn,
  });

describe('L84B-U01 — rôle principal retiré par l’utilisateur (point ouvert 83A)', () => {
  it('une inférence (T4, T3, reprise) ne rétablit jamais un principal retiré ; l’utilisateur seul le peut', () => {
    for (const o of ['T4', 'T3', 'SYSTEM'] as const) {
      expect(mayDesignatePrincipal(o, true)).toBe(false);
      expect(mayDesignatePrincipal(o, false)).toBe(true);
    }
    expect(mayDesignatePrincipal('USER', true)).toBe(true);
  });
  it('le service applique la règle à la désignation, mémorise le retrait et la nouvelle désignation (aucune règle sémantique)', () => {
    const s = code('src/services/business-operations/grouping/service.ts');
    expect(s).toMatch(/mayDesignatePrincipal\(p\.origin, await principalWithdrawnByUser\(ctx\.runner, ctx\.accountId, p\.operationId\)\)/);
    expect(s).toMatch(/subject: 'PRINCIPAL', entityId: cur\.itemId, decision: 'REJECTED'/);
    expect(s).toMatch(/liftPrincipalWithdrawals\(ctx\.runner, ctx\.accountId, p\.operationId\)/);
  });
});

describe('L84B-U02 — projection T4 face à un retrait mémorisé (V-Q5 : T4 décide, l’utilisateur prime)', () => {
  it('sans retrait : l’événement global est créé (témoin) ; avec retrait : rien n’est créé', () => {
    const visite = item({ id: 1, title: 'Visite expert', date: '2026-03-21' });
    expect(plan(op(), { linked: [visite] })[0]).toMatchObject({ kind: 'CREATE' });
    expect(plan(op(), { linked: [visite], withdrawn: true })).toEqual([{ kind: 'SUPPRESSED', key: 'CLAIM' }]);
  });
  it('avec retrait : un membre qui représenterait CERTAINEMENT l’événement n’est pas reconnu comme principal (aucun LINK ni ROLE)', () => {
    const degat = item({ id: 2, title: 'Dégâts des eaux cuisine', date: '2026-03-12' });
    expect(plan(op(), { linked: [degat] })).toEqual([expect.objectContaining({ kind: 'LINK', itemId: 2 })]);
    const p = plan(op(), { linked: [degat], withdrawn: true });
    expect(p.some((a) => a.kind === 'LINK' || a.kind === 'ROLE' || a.kind === 'CREATE')).toBe(false);
  });
  it('avec retrait : la propre projection redevenue élément lié n’est pas repromue (même si son rôle vient de T4) et n’est pas évincée', () => {
    const projection = item({ id: 20, title: 'Dégât des eaux', projected: true, isAutomatic: true, nature: 'HISTORICAL', businessType: 'claim',
      homeCategory: 'information', functionalKey: 'bo:v1:10:CLAIM', operationRole: 'RELATED', operationRoleOrigin: 'T4' });
    expect(plan(op(), { linked: [projection] })).toEqual([{ kind: 'ROLE', itemId: 20, role: 'PRINCIPAL' }]);
    expect(plan(op(), { linked: [projection], withdrawn: true })).toEqual([]);
    const saisi = item({ id: 21, title: 'Dégâts des eaux salle de bain', date: '2026-03-13', operationRoleOrigin: 'T3' });
    expect(plan(op(), { linked: [projection, saisi], withdrawn: true }).some((a) => a.kind === 'REMOVE' || a.kind === 'LINK')).toBe(false);
  });
  it('la projection lit le retrait dans la mémoire unifiée (décision PRINCIPAL REJECTED active)', () => {
    const s = code('src/services/business-operations/agenda-projection/service.ts');
    expect(s).toMatch(/source_kind = 'PRINCIPAL' AND decision = 'REJECTED' AND active/);
    expect(s).toContain('principalWithdrawn: retraits.has(op.id)');
  });
});

describe('L84B-U03 — invariant O3-PRINCIPAL-WITHDRAWN (registre de cohérence, C-Q11)', () => {
  it('déclaré à la suite des invariants existants, réparation déterministe par le service ; version de l’ensemble l84b-v3', () => {
    const ids = OPERATIONS_GROUPING_INVARIANTS.map((i) => i.id);
    expect(ids.slice(-2)).toEqual(['O7-NO-INFERRED-PRINCIPAL', 'O3-PRINCIPAL-WITHDRAWN']);
    const inv = OPERATIONS_GROUPING_INVARIANTS.find((i) => i.id === 'O3-PRINCIPAL-WITHDRAWN')!;
    expect(inv).toMatchObject({ level: 'N2', repair: 'DETERMINISTIC', domain: 'operations', version: 1 });
    expect(inv.repairFinding).toBeTypeOf('function');
    expect(GROUPING_INVARIANTS_VERSION).toBe('l84b-v3');
  });
  it('constat : principal déduit après un retrait actif ; jamais un principal choisi par l’utilisateur, jamais sans retrait', () => {
    expect(evaluateWithdrawnPrincipal(5, [
      { operationId: 7, itemId: 3, origin: 'T4', withdrawnItemIds: [2] },
      { operationId: 8, itemId: 4, origin: 'USER', withdrawnItemIds: [1] },
      { operationId: 9, itemId: 6, origin: 'T3', withdrawnItemIds: [] },
    ])).toEqual([expect.objectContaining({
      invariantId: 'O3-PRINCIPAL-WITHDRAWN', objectKey: 'operation:7', nature: 'INFERRED_PRINCIPAL_AFTER_USER_WITHDRAWAL', repairable: true,
      detail: { operationId: 7, itemId: 3, origin: 'T4', withdrawnItemIds: [2] },
    })]);
  });
  it('réparation par releasePrincipal (service unique), jamais une écriture SQL dans la réparation', () => {
    const s = code('src/services/business-operations/grouping/invariants.ts');
    const bloc = s.slice(s.indexOf("id: 'O3-PRINCIPAL-WITHDRAWN'"), s.indexOf('async function recomputePrincipalFor'));
    expect(bloc).toContain("releasePrincipal(ctx, { operationId: Number(f.detail.operationId), origin: 'T4', reasonCode: 'COHERENCE_PRINCIPAL_WITHDRAWN_BY_USER' })");
    expect(bloc).not.toMatch(/\b(UPDATE|INSERT INTO|DELETE FROM)\b/);
  });
});

describe('L84B-U04 — mémoire unifiée des décisions : objet PRINCIPAL', () => {
  it('modèle, migration 0684 (sur-ensemble strict de 0656, idempotente) et schéma alignés', () => {
    expect(DECISION_SUBJECTS).toContain('PRINCIPAL');
    const m = code('src/db/migrations/0684_l84b_retrait_principal_memorise.sql');
    for (const k of ['DOCUMENT', 'ASSET_DATA', 'EQUIPMENT_DATA', 'AGENDA', 'CLAIM_FORM', 'USER_ARBITRATION', 'MIGRATION', 'ROOM', 'EQUIPMENT', 'PRINCIPAL_LINK', 'PRINCIPAL']) {
      expect(m).toContain(`'${k}'`);
    }
    expect(m).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);
    expect(m).toMatch(/NOT LIKE '%''PRINCIPAL''::text%'/);
    // Lot 86D (0736) : sur-ensemble — AGENDA_FILE_LINK ajouté après PRINCIPAL.
    expect(code('src/db/schema.ts')).toContain("'ROOM', 'EQUIPMENT', 'PRINCIPAL_LINK', 'PRINCIPAL'");
  });
});

describe('L84B-U05 — vocabulaire (P1, AC03)', () => {
  const textes = JSON.stringify(GROUPING_LABELS);
  it('aucun libellé visible ne contient « Opération » ni « principal »', () => {
    expect(textes).not.toMatch(/op[ée]ration/i);
    expect(textes).not.toMatch(/principal/i);
  });
  it('composants et tiroirs : aucun texte JSX « Opération » / « principal »', () => {
    for (const f of ['src/components/agenda/AgendaGroupingSection.tsx', 'src/components/agenda/AgendaGroupingPanel.tsx', 'src/components/agenda/AgendaItemDrawer.tsx', 'src/components/assets/DocumentDrawer.tsx']) {
      const jsx = sansCommentaires(code(f));
      expect(jsx, f).not.toMatch(/>[^<{]*Op[ée]ration[^<{]*</);
      expect(jsx, f).not.toMatch(/>[^<{]*[Pp]rincipal[^<{]*</);
      expect(jsx, f).not.toMatch(/["'`][^"'`]*\b[Pp]rincipal\b[^"'`]*["'`]\s*\}/);
    }
  });
  it('messages d’erreur des routes : jamais le mot « Opération »', () => {
    for (const f of ['src/app/api/agenda/[id]/liens/route.ts', 'src/app/api/documents/[id]/agenda-liens/route.ts']) {
      const msgs = [...sansCommentaires(code(f)).matchAll(/message: '([^']*)'|error: '([^']*)'/g)].map((x) => x[1] ?? x[2]);
      expect(msgs.length, f).toBeGreaterThan(0);
      for (const m of msgs) expect(m, f).not.toMatch(/op[ée]ration|principal/i);
    }
  });
});

describe('L84B-U06 — tiroir léger : indication du contexte global, jamais le détail', () => {
  it('résumé chiffré, accords, catégories vides omises', () => {
    expect(groupingCountsSummary({ items: 2, documents: 1, assets: 1, rooms: 0, equipments: 3 })).toBe('2 étapes · 1 document · 1 bien · 3 équipements');
    expect(groupingCountsSummary({ items: 0, documents: 0, assets: 0, rooms: 1, equipments: 0 })).toBe('1 pièce');
    expect(groupingCountsSummary(null)).toBe('');
  });
  it('gestes connus seulement', () => {
    expect(GROUPING_ACTIONS).toContain('retirer-reference');
    expect(isGroupingAction('relier-document')).toBe(true);
    expect(isGroupingAction('supprimer-tout')).toBe(false);
  });
});

describe('L84B-U07 — routes et gestes', () => {
  it('écriture : session → compte actif → refus lecture seule AVANT le geste ; erreurs techniques traduites', () => {
    for (const f of ['src/app/api/agenda/[id]/liens/route.ts', 'src/app/api/documents/[id]/agenda-liens/route.ts']) {
      const s = sansCommentaires(code(f));
      const post = s.slice(s.indexOf('export async function POST'));
      expect(post.indexOf('refuserSiLectureSeule(c.accountId)'), f).toBeGreaterThan(0);
      expect(post.indexOf('refuserSiLectureSeule(c.accountId)'), f).toBeLessThan(post.indexOf('applyAgendaDrawerAction'));
      expect(s, f).toContain('session.currentAccountId');
    }
  });
  it('gestes du tiroir : service unique de regroupement, auteur tracé, aucune écriture SQL', () => {
    const s = sansCommentaires(code('src/services/business-operations/grouping/drawer-actions.ts'));
    expect(s).toContain('withGroupingWrite(accountId, async (ctx) =>');
    expect(s).toContain('{ actorUserId }');
    expect(s).not.toMatch(/\b(UPDATE|INSERT INTO|DELETE FROM)\b/);
    for (const a of GROUPING_ACTIONS) expect(s, a).toContain(`case '${a}':`);
  });
  it('lecture des tiroirs : bornée au compte, n’utilise pas l’API Timeline (chantier O-4)', () => {
    const s = sansCommentaires(code('src/services/business-operations/grouping/read.ts'));
    expect(s).not.toMatch(/overview|timeline/i);
    expect(s).not.toMatch(/\b(UPDATE|INSERT INTO|DELETE FROM)\b/);
  });
});
