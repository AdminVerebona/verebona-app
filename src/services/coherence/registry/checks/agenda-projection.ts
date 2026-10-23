/**
 * Contrôles Agenda / T4 du registre — lot 83E (CDC cohérence §4.5 « échéances
 * calculables mais absentes de l'agenda », « événements obsolètes » ;
 * arbitrages C-Q1, C-Q2, C-Q9, V-Q5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T4 CÔTÉ CODE : LA PROJECTION OPÉRATIONS → AGENDA EST REJOUÉE, JAMAIS RECOPIÉE
 *
 * La projection (`business-operations/agenda-projection/service.ts`, chantier
 * 83A pour O-7) est appelée par ses fonctions PUBLIQUES seulement :
 *   · diagnostic : `projectAccountOperations(compte, { operationIds, dryRun })`
 *     — plan SIMULÉ (aucune écriture, aucun appel IA) ;
 *   · réparation : `projectAccountOperations(compte, { operationIds })` — même
 *     moteur appliqué (idempotent, suppressions utilisateur respectées,
 *     éléments touchés par l'utilisateur protégés, retraits tracés 0223).
 * Aucune règle de projection n'est réécrite ici : si 83A change la décision
 * (`decideProjection`) ou le plan (`planOperationProjection`), ce contrôle en
 * hérite tel quel (C-Q11).
 *
 *   COH-AGENDA-OPERATION-PROJECTION — pour chaque Opération du compte, le plan
 *     simulé ne doit plus rien prévoir d'autre que des abstentions :
 *       CREATE      échéance CALCULABLE absente (date connue, échéance
 *                   actionnable) — MISSING_CALCULABLE_EVENT ;
 *       REMOVE /    événement OBSOLÈTE (Opération invalidée, fusionnée, type
 *       DETACH      plus projeté) — OBSOLETE_EVENT ;
 *       SYNC        date, intitulé, nature ou liens divergents — EVENT_OUT_OF_SYNC ;
 *       MARK_DONE   réalisation non propagée — COMPLETION_NOT_PROPAGATED ;
 *       ROLE        rôle principal / lié non appliqué (82D) — EVENT_ROLE_MISMATCH ;
 *       LINK        (hors interventions) événement existant non relié — EVENT_NOT_LINKED.
 *     LINK / CONSOLIDATE d'une INTERVENTION : COH-AGENDA-OCCURRENCES (76H) —
 *     une seule chaîne de constat. ABSTAIN avec candidats : AMBIGUOUS (carte
 *     de rapprochement D14 existante, jamais tranchée ici).
 *   COH-AGENDA-PROJECTION-ORPHANS — événement issu de la projection dont
 *     l'Opération n'existe plus (supprimée, autre compte) : nettoyage par le
 *     passage COMPLET de la projection (seul point public de son nettoyage
 *     tracé et protégé : intact → retrait restaurable, touché → détaché).
 *
 * Le balayage horaire de convergence `startAgendaProjectionSweep` (racine T3,
 * lot 54D), qui réparait les MÊMES écarts par une seconde chaîne, est RETIRÉ
 * (C-Q9). La projection événementielle (bus Opérations) reste la fonction
 * métier ; ce contrôle en garantit la convergence (campagne quotidienne).
 *
 *   COH-AGENDA-T4-DOCUMENT-DEADLINES — POINT D'EXTENSION DÉCLARÉ (PLANNED) :
 *     échéances DOCUMENTAIRES décidées par T4 (IA). Les décisions T4 ne sont
 *     pas conservées durablement avec leur candidat (seulement la trace
 *     d'exécution et le contexte de reprise d'un travail) : elles ne peuvent
 *     pas être rejouées sans appel IA. Lacune signalée, jamais réputée couverte.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

type Action = { kind: string; itemId?: number; candidates?: unknown[]; [k: string]: unknown };

const ANOMALIE_PAR_ACTION: Record<string, string> = {
  CREATE: 'MISSING_CALCULABLE_EVENT',
  REMOVE: 'OBSOLETE_EVENT',
  DETACH: 'OBSOLETE_EVENT',
  SYNC: 'EVENT_OUT_OF_SYNC',
  MARK_DONE: 'COMPLETION_NOT_PROPAGATED',
  ROLE: 'EVENT_ROLE_MISMATCH',
  LINK: 'EVENT_NOT_LINKED',
};
/** Ordre de gravité du constat (le premier présent nomme l'anomalie). */
const PRIORITE = ['CREATE', 'REMOVE', 'DETACH', 'MARK_DONE', 'SYNC', 'LINK', 'ROLE'];

/**
 * Actions d'un plan qui constituent un ÉCART (pure, testée). Intervention :
 * LINK / CONSOLIDATE appartiennent à COH-AGENDA-OCCURRENCES (76H).
 */
export function projectionGaps(typeCode: string | null, actions: readonly Action[]): Action[] {
  return actions.filter((a) => a.kind in ANOMALIE_PAR_ACTION && !(a.kind === 'LINK' && typeCode === 'INTERVENTION'));
}

/** Anomalie nommée d'un ensemble d'écarts (pure). */
export function projectionAnomaly(gaps: readonly Action[]): string | null {
  const k = PRIORITE.find((x) => gaps.some((a) => a.kind === x));
  return k ? ANOMALIE_PAR_ACTION[k] : null;
}

/** Empreinte stable d'un plan (identifiants et natures, jamais de texte libre). */
const empreintePlan = (actions: readonly Action[]) =>
  actions.map((a) => [a.kind, a.itemId ?? null, (a as { functionalKey?: string }).functionalKey ?? null, a.kind === 'SYNC' ? Object.keys((a as { changes?: object }).changes ?? {}).sort() : null]);

export const agendaOperationProjectionCheck: CoherenceCheck = {
  id: 'COH-AGENDA-OPERATION-PROJECTION',
  version: 1,
  status: 'ACTIVE',
  title: 'Agenda : échéances calculables des Opérations présentes, événements obsolètes retirés (projection T4 rejouée sans IA)',
  domain: 'agenda',
  level: 'N3',
  objectType: 'business_operation',
  scope: 'toutes les Opérations du compte (actives, invalidées ou fusionnées encore citées)',
  sources: ['business_operations', 'business_operation_sources', 'business_operation_contract_details', 'agenda_items', 'business_operation_projection_suppressions'],
  applicability: 'compte éligible ; colonnes 0223 présentes (sinon la projection s’abstient : aucun écart constaté)',
  invariant: 'la représentation Agenda d’une Opération est exactement celle que décide la projection courante (plan simulé vide hors abstentions)',
  anomalies: ['MISSING_CALCULABLE_EVENT', 'OBSOLETE_EVENT', 'EVENT_OUT_OF_SYNC', 'COMPLETION_NOT_PROPAGATED', 'EVENT_ROLE_MISMATCH', 'EVENT_NOT_LINKED', 'PROJECTION_MATCH_UNCERTAIN'],
  autoRepairWhen: 'plan de projection certain (actions de la projection courante), appliqué par le même moteur',
  forbiddenRepairs: [
    'recopier une règle de projection', 'appeler T4 (IA)', 'recréer un événement supprimé par l’utilisateur',
    'modifier un événement touché par l’utilisateur', 'trancher un rapprochement incertain',
  ],
  services: ['business-operations/agenda-projection/service#projectAccountOperations'],
  chain: ['T3', 'T4', 'PROJECTION'],
  triggers: ['AGENDA_ITEM_UPDATED', 'SOURCE_ANALYZED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé (agenda, analyse)',
  criticality: 'MEDIUM',
  tests: ['L83E-E2E-01', 'L83E-E2E-02', 'L83E-U-PROJECTION'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE o.account_id = $1 AND o.id > $2 ORDER BY o.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === 'SOURCE_ANALYZED') {
      return idsOf(await rows(ctx.sql, `
        SELECT DISTINCT s.operation_id AS id FROM business_operation_sources s
         WHERE s.account_id = $1 AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text ORDER BY 1`, [accountId, e.entityId]));
    }
    return idsOf(await rows(ctx.sql, `
      SELECT i.business_operation_id AS id FROM agenda_items i WHERE i.account_id = $1 AND i.id = $2 AND i.business_operation_id IS NOT NULL`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    const vivantes = new Map((await rows(ctx.sql, `SELECT id, type_code FROM business_operations WHERE account_id = $1 AND id = ANY($2::bigint[])`, [accountId, intArray(ids)]))
      .map((x) => [Number(x.id), (x.type_code as string | null) ?? null]));
    const enCours = ids.filter((id) => vivantes.has(id));
    // Plan SIMULÉ d'un lot (une lecture, aucune écriture, aucun appel IA).
    const sim = enCours.length
      ? await projectAccountOperations(accountId, { operationIds: enCours, dryRun: true, correlationId: ctx.correlationId, today: ctx.today })
      : { plans: [] as Array<{ operationId: number; typeCode: string | null; decision: string; actions: Action[] }> };
    const plans = new Map((sim.plans ?? []).map((p) => [p.operationId, p]));
    for (const id of ids) {
      if (!vivantes.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const p = plans.get(id);
      const actions = (p?.actions ?? []) as Action[];
      const ecarts = projectionGaps(vivantes.get(id) ?? null, actions);
      const detail = { decision: p?.decision ?? null, actions: actions.map((a) => a.kind) };
      if (ecarts.length) {
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: projectionAnomaly(ecarts)!, faultyLink: 'PROJECTION',
          expected: 'représentation Agenda décidée par la projection courante', observed: ecarts.map((a) => ({ kind: a.kind, itemId: a.itemId ?? null })), detail,
          inputHash: hashOf({ id, plan: empreintePlan(ecarts) }),
        });
        continue;
      }
      if (actions.some((a) => a.kind === 'ABSTAIN' && Array.isArray(a.candidates) && a.candidates.length > 0)) {
        out.set(id, { verdict: 'AMBIGUOUS', anomaly: 'PROJECTION_MATCH_UNCERTAIN', faultyLink: 'T3', detail, inputHash: hashOf({ id, plan: empreintePlan(actions) }) });
        continue;
      }
      out.set(id, { verdict: 'CONSISTENT', detail });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    for (const { id } of items) {
      const r = await projectAccountOperations(accountId, { operationIds: [id], correlationId: ctx.correlationId, today: ctx.today });
      out.set(id, {
        called: true, service: 'projectAccountOperations', aiCalls: 0,
        result: { created: r.created, updated: r.updated, linked: r.linked, removed: r.removed, detached: r.detached, markedDone: r.markedDone, roles: r.roles ?? 0, changes: r.changes, skipped: r.skipped ?? null },
        // Retraits : trace 0223 (`agenda_item_removals`, restaurable) ; créations : clé fonctionnelle de l'Opération.
        rollbackRef: `agenda_item_removals:correlation=${ctx.correlationId};agenda_items:business_operation_id=${id}`,
      });
    }
    return out;
  },
};

// ── COH-AGENDA-PROJECTION-ORPHANS ───────────────────────────────────────────

const ORPHELIN_SQL = `i.account_id = $1 AND i.projection_origin = 'OPERATION'
  AND (i.business_operation_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM business_operations o WHERE o.id = i.business_operation_id AND o.account_id = i.account_id))`;

export const agendaProjectionOrphansCheck: CoherenceCheck = {
  id: 'COH-AGENDA-PROJECTION-ORPHANS',
  version: 1,
  status: 'ACTIVE',
  title: 'Agenda : événements projetés dont l’Opération n’existe plus',
  domain: 'agenda',
  level: 'N1',
  objectType: 'agenda_item',
  scope: 'événements du compte issus de la projection des Opérations (projection_origin = OPERATION)',
  sources: ['agenda_items', 'business_operations'],
  applicability: 'compte éligible ; colonnes 0223 présentes',
  invariant: 'un événement projeté représente une Opération existante du même compte',
  anomalies: ['PROJECTED_EVENT_WITHOUT_OPERATION'],
  autoRepairWhen: 'toujours, par le passage complet de la projection (événement intact retiré et restaurable, événement touché par l’utilisateur détaché)',
  forbiddenRepairs: ['supprimer un événement touché par l’utilisateur', 'retirer sans trace'],
  services: ['business-operations/agenda-projection/service#projectAccountOperations(all)'],
  chain: ['PROJECTION'],
  triggers: ['AGENDA_ITEM_UPDATED'],
  frequency: 'campagne exhaustive quotidienne',
  criticality: 'LOW',
  tests: ['L83E-E2E-02'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT i.id FROM agenda_items i WHERE i.account_id = $1 AND i.projection_origin = 'OPERATION' AND i.id > $2 ORDER BY i.id LIMIT $3`,
    [accountId, afterId, limit]).catch((e: Error) => {
      if (/projection_origin/.test(e.message)) return []; // colonnes 0223 absentes : projection suspendue
      throw e;
    }));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `SELECT i.id FROM agenda_items i WHERE ${ORPHELIN_SQL} AND i.id = $2`, [accountId, e.entityId]).catch(() => []));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const tous = new Set(idsOf(await rows(ctx.sql, `SELECT id FROM agenda_items WHERE account_id = $1 AND id = ANY($2::int[])`, [accountId, intArray(ids)])));
    const orphelins = new Set(idsOf(await rows(ctx.sql, `SELECT i.id FROM agenda_items i WHERE ${ORPHELIN_SQL} AND i.id = ANY($2::int[])`, [accountId, intArray(ids)])));
    for (const id of ids) {
      if (!tous.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      if (!orphelins.has(id)) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: 'PROJECTED_EVENT_WITHOUT_OPERATION', faultyLink: 'PROJECTION',
        expected: 'événement retiré (intact) ou détaché (touché par l’utilisateur)', observed: 'événement projeté sans Opération', inputHash: hashOf({ id, orphan: true }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    // Le nettoyage des projections orphelines n'est public qu'au travers du passage COMPLET (idempotent).
    const r = await projectAccountOperations(accountId, { all: true, correlationId: ctx.correlationId, today: ctx.today });
    for (const { id } of items) {
      out.set(id, {
        called: true, service: 'projectAccountOperations(all)', aiCalls: 0, result: { removed: r.removed, detached: r.detached, changes: r.changes },
        rollbackRef: `agenda_item_removals:agenda_item_id=${id}`,
      });
    }
    return out;
  },
};

// ── COH-AGENDA-T4-DOCUMENT-DEADLINES (point d'extension) ────────────────────

export const agendaT4DocumentDeadlinesCheck: CoherenceCheck = {
  id: 'COH-AGENDA-T4-DOCUMENT-DEADLINES',
  version: 1,
  status: 'PLANNED',
  title: 'Agenda : échéances documentaires décidées par T4 présentes (rejeu des décisions sans IA)',
  domain: 'agenda',
  level: 'N3',
  objectType: 'document',
  scope: 'documents analysés portant des candidats d’échéance T4',
  sources: ['ai_usage_event.metadata.t4Decision (trace d’exécution, sans candidat)', 'agenda_items', 'agenda_item_sources'],
  applicability: 'NON EXÉCUTÉ : les décisions T4 ne sont pas conservées durablement avec leur candidat — rejeu impossible sans appel IA',
  invariant: 'toute échéance acceptée par T4 pour un document est présente dans l’Agenda (ou retirée par l’utilisateur)',
  anomalies: ['T4_ACCEPTED_DEADLINE_MISSING'],
  autoRepairWhen: 'quand une décision T4 durable (candidat + décision + empreinte) sera persistée : rejeu par la primitive d’écriture Agenda',
  forbiddenRepairs: ['relancer T4 systématiquement', 'décider dans le code qu’un événement doit exister (V-Q5)'],
  services: ['ai/agenda (décision T4 DURABLE à persister — contrôle non exécuté)', 'agenda/agenda-write-primitive'],
  chain: ['T4', 'PROJECTION'],
  triggers: [],
  frequency: 'non exécuté (lacune déclarée)',
  criticality: 'MEDIUM',
  tests: ['L83E-U-COVERAGE'],
};
