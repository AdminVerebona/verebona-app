/**
 * Contrôles Opérations du registre — lot 83B (C4 ; CDC cohérence §4.3 ;
 * CDC v5 O-1 ; arbitrages C-Q2, C-Q11, V-Q5).
 *
 * 1. INVARIANTS O-1 DU REGROUPEMENT (`grouping/invariants.ts`) — BRANCHÉS,
 *    pas recopiés : un contrôle `COH-<invariant>` par entrée de
 *    `OPERATIONS_GROUPING_INVARIANTS`, construit à partir de la liste ENTIÈRE
 *    au chargement du registre. Un invariant ajouté dans `invariants.ts`
 *    (chantier 83A, projection Agenda O-7, ou toute évolution future) entre
 *    dans le registre sans autre changement ; sa `version` est celle de
 *    l'invariant (la changer réexamine le stock, §6.4).
 *      · objet contrôlé : le COMPTE (les invariants portent sur ses
 *        Opérations, éléments d'agenda, liens Document ↔ Agenda,
 *        appartenances) — seulement s'il en possède ;
 *      · inspection : `detect` de l'invariant (lecture seule) ;
 *      · réparation : EXCLUSIVEMENT `repairGroupingFinding` (service unique
 *        de regroupement), dans une écriture de regroupement du compte
 *        (`withGroupingWrite` : transaction, verrou 39101, historique
 *        corrélé, événements après commit), constats relus SOUS VERROU ;
 *        un invariant « constat seul » (O1-ANTI-CARTESIAN) n'est jamais
 *        réparé ; recontrôle par `detect` (moteur).
 *
 * 2. COH-OPS-IDENTITY — identité économique 78A rendue PÉRIODIQUE, en
 *    DÉTECTION : chaque Opération active est relue source par source avec
 *    le code 78A existant (`loadOperationMembers`, `reviewExistingAttachment`,
 *    `identitySignals`) — aucune copie des règles. Une source contredite
 *    face à la fondatrice (ce que le réexamen 78A séparerait) ou mise en
 *    doute est un CONSTAT tracé ; la correction reste celle du réexamen 78A
 *    par la consolidation T3 (par version), jamais une écriture du contrôle.
 */
import {
  OPERATIONS_GROUPING_INVARIANTS, type GroupingFinding, type GroupingInvariant,
} from '@/services/business-operations/grouping/invariants';
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

/** Type relayé par `events.ts` pour toute écriture d'une Opération (bus des Opérations). */
const OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';

// ── 1. Invariants O-1 ────────────────────────────────────────────────────────

/** Le compte porte-t-il des objets du regroupement (Opérations, appartenances, liens Document ↔ Agenda) ? */
async function compteConcerne(ctx: CheckContext, accountId: number): Promise<boolean> {
  const [r] = await rows(ctx.sql, `
    SELECT EXISTS (SELECT 1 FROM business_operations o WHERE o.account_id = $1)
        OR EXISTS (SELECT 1 FROM agenda_items i WHERE i.account_id = $1 AND (i.business_operation_id IS NOT NULL OR i.operation_role IS NOT NULL))
        OR EXISTS (SELECT 1 FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = $1) AS ok`, [accountId]);
  return r?.ok === true;
}

const tracer = (fs: readonly GroupingFinding[]) => fs.slice(0, 20).map((f) => ({ objectKey: f.objectKey, nature: f.nature, repairable: f.repairable }));

/** Contrôle du registre pour UN invariant O-1 (construit, jamais recopié). */
export function groupingInvariantCheck(inv: GroupingInvariant): CoherenceCheck {
  const reparable = inv.repair === 'DETERMINISTIC' && typeof inv.repairFinding === 'function';
  const check: CoherenceCheck = {
    id: `COH-${inv.id}`,
    version: inv.version,
    status: 'ACTIVE',
    title: `Opérations (O-1) : ${inv.id}`,
    domain: 'operations',
    level: inv.level,
    objectType: 'account',
    scope: `objets du regroupement du compte : ${inv.objects.join(', ')}`,
    sources: [...inv.objects],
    applicability: 'compte éligible portant des Opérations, des appartenances d’agenda ou des liens Document ↔ Agenda',
    invariant: inv.description,
    anomalies: ['GROUPING_INVARIANT_VIOLATED'],
    autoRepairWhen: reparable ? 'constat réparable de l’invariant, relu sous le verrou du compte, réparé par le service de regroupement' : 'jamais : constat seul (aucune réparation sans preuve)',
    forbiddenRepairs: ['écrire hors du service unique de regroupement', 'retirer un lien ou un rattachement sans preuve', 'remplacer un choix de l’utilisateur', 'regrouper entre deux comptes'],
    services: ['business-operations/grouping/invariants#detect', ...(reparable ? ['business-operations/grouping/invariants#repairGroupingFinding', 'business-operations/grouping/service#withGroupingWrite'] : [])],
    chain: ['T3', 'T4', 'PERSISTENCE'],
    triggers: [OPERATION_CHANGED, 'AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'DOCUMENT_DELETED', 'SOURCE_ANALYZED'],
    frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque écriture d’Opération ou d’agenda',
    criticality: inv.level === 'N1' ? 'MEDIUM' : 'HIGH',
    tests: ['L82D-E10', 'L83B-U-OPS', 'L83B-E2E-06', 'L83B-E2E-10'],

    async listObjects(ctx, accountId, afterId) {
      return afterId < accountId && (await compteConcerne(ctx, accountId)) ? [accountId] : [];
    },

    async objectsForEvent(ctx, accountId) {
      return (await compteConcerne(ctx, accountId)) ? [accountId] : [];
    },

    async inspect(ctx, accountId, ids) {
      const out = new Map<number, Inspection>();
      const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
      for (const id of ids) {
        if (id !== accountId) { out.set(id, { verdict: 'GONE' }); continue; }
        const fs = await inv.detect(postgresRunner(ctx.sql), accountId);
        if (!fs.length) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
        const aReparer = reparable ? fs.filter((f) => f.repairable) : [];
        out.set(id, {
          verdict: aReparer.length ? 'REPAIRABLE' : 'FINDING', anomaly: 'GROUPING_INVARIANT_VIOLATED', faultyLink: 'PERSISTENCE',
          expected: inv.id, observed: tracer(fs),
          detail: { invariant: inv.id, findings: fs.length, repairable: aReparer.length, natures: [...new Set(fs.map((f) => f.nature))] },
          inputHash: hashOf({ inv: inv.id, v: inv.version, f: fs.map((f) => [f.objectKey, f.nature, f.detail]) }),
        });
      }
      return out;
    },
  };
  if (reparable) {
    check.repair = async (ctx, accountId, items) => {
      const out = new Map<number, RepairResult>();
      const [{ withGroupingWrite }, { repairGroupingFinding }] = await Promise.all([
        import('@/services/business-operations/grouping/service'), import('@/services/business-operations/grouping/invariants'),
      ]);
      for (const { id } of items) {
        // Constats RELUS sous le verrou du compte (état courant), réparés un à un par le service de regroupement.
        const bilan = await withGroupingWrite(accountId, async (g) => {
          const { lockGroupingAccount } = await import('@/services/business-operations/grouping/runner');
          await lockGroupingAccount(g.runner, accountId);
          const fs = (await inv.detect(g.runner, accountId)).filter((f) => f.repairable);
          let repaired = 0;
          let changed = 0;
          for (const f of fs) {
            const r = await repairGroupingFinding(g, f);
            if (r.repaired) repaired++;
            if (r.changed) changed++;
          }
          return { findings: fs.length, repaired, changed, keys: fs.slice(0, 20).map((f) => `${f.objectKey}:${f.nature}`) };
        }, { correlationId: ctx.correlationId });
        out.set(id, {
          called: true, service: 'repairGroupingFinding', aiCalls: 0, result: { invariant: inv.id, ...bilan },
          rollbackRef: `business_operation_history:correlation_id=${ctx.correlationId}`,
        });
      }
      return out;
    };
  }
  return check;
}

/**
 * Contrôles des invariants O-1, construits depuis la liste ENTIÈRE de
 * `invariants.ts` (aucune copie figée : un invariant ajouté y est branché).
 */
export const operationsGroupingChecks: readonly CoherenceCheck[] = OPERATIONS_GROUPING_INVARIANTS.map(groupingInvariantCheck);

// ── 2. Identité économique 78A, périodique, en détection ─────────────────────

const OPERATIONS_ACTIVES_SQL = `o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`;

export interface MemberReview {
  sourceId: number;
  outcome: 'SEPARATE' | 'SUSPECT';
  signals: string[];
  against: number[];
  /** Rattachement décidé par l'utilisateur (M0) ou l'IA (M3) : jamais défait d'office par 78A. */
  protectedMethod: string | null;
}

/**
 * Relecture 78A d'une Opération (pure, code 78A) : chaque source NON
 * fondatrice face aux autres sources (`reviewExistingAttachment`).
 */
export async function reviewOperationMembers(
  members: ReadonlyArray<{ sourceId: number; footprint: unknown; anchor: boolean }>, methods: ReadonlyMap<number, string | null>,
): Promise<MemberReview[]> {
  const { reviewExistingAttachment, identitySignals } = await import('@/services/business-operations/consolidation/economic-identity');
  const out: MemberReview[] = [];
  for (const m of members) {
    if (m.anchor) continue;
    const autres = members.filter((x) => x.sourceId !== m.sourceId) as Parameters<typeof reviewExistingAttachment>[1];
    const r = reviewExistingAttachment(m.footprint as Parameters<typeof reviewExistingAttachment>[0], autres);
    if (r.outcome === 'KEEP') continue;
    const methode = methods.get(m.sourceId) ?? null;
    const protege = methode === 'M0' || methode === 'M3' ? methode : null;
    out.push({
      sourceId: m.sourceId, outcome: r.outcome === 'SEPARATE' && !protege ? 'SEPARATE' : 'SUSPECT',
      signals: r.assessment ? identitySignals(r.assessment) : [], against: r.against, protectedMethod: protege,
    });
  }
  return out;
}

export const operationsIdentityCheck: CoherenceCheck = {
  id: 'COH-OPS-IDENTITY',
  version: 1,
  status: 'ACTIVE',
  title: 'Opérations : identité économique des sources regroupées (78A, détection périodique)',
  domain: 'operations',
  level: 'N2',
  objectType: 'business_operation',
  scope: 'Opérations actives du compte (sources gérées : documents, données structurées)',
  sources: ['business_operations', 'business_operation_sources', 'document_operation_candidates', 'business_operation_identity_reviews'],
  applicability: 'compte éligible ; Opération active ayant au moins deux sources gérées',
  invariant: 'chaque source regroupée partage l’identité économique de la source fondatrice (aucune contradiction forte ni double contradiction faible)',
  anomalies: ['IDENTITY_CONTRADICTED', 'IDENTITY_SUSPECT'],
  autoRepairWhen: 'aucune (détection, C4) : la séparation relève du réexamen 78A par la consolidation T3',
  forbiddenRepairs: ['séparer ou fusionner hors de la consolidation T3', 'défaire un rattachement décidé par l’utilisateur ou l’IA', 'écrire depuis le contrôle'],
  services: ['business-operations/consolidation/consolidator#loadOperationMembers', 'business-operations/consolidation/economic-identity#reviewExistingAttachment'],
  chain: ['T1', 'T3'],
  triggers: [OPERATION_CHANGED, 'SOURCE_ANALYZED'],
  frequency: 'campagne exhaustive quotidienne (toutes les Opérations, y compris inchangées) + contrôle ciblé à chaque écriture d’Opération',
  criticality: 'HIGH',
  tests: ['L83B-U-OPS', 'L83B-E2E-07', 'L83B-E2E-10'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${OPERATIONS_ACTIVES_SQL} AND o.id > $2 ORDER BY o.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === OPERATION_CHANGED) {
      return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${OPERATIONS_ACTIVES_SQL} AND o.id = $2`, [accountId, e.entityId]));
    }
    return idsOf(await rows(ctx.sql, `
      SELECT DISTINCT o.id FROM business_operations o
        JOIN business_operation_sources s ON s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = $2::text
       WHERE ${OPERATIONS_ACTIVES_SQL} ORDER BY o.id`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const [{ db }, { sql: dsql }, { loadOperationMembers, IDENTITY_MEMBERS_OPERATION_LIMIT }, { IDENTITY_REVIEW_VERSION }] = await Promise.all([
      import('@/db'), import('drizzle-orm'), import('@/services/business-operations/consolidation/consolidator'),
      import('@/services/business-operations/consolidation/identity-review'),
    ]);
    const vivantes = new Set(idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${OPERATIONS_ACTIVES_SQL} AND o.id = ANY($2::bigint[])`, [accountId, intArray(ids)])));
    const methodes = new Map((await rows(ctx.sql, `
      SELECT id, match_method FROM business_operation_sources WHERE account_id = $1 AND active AND operation_id = ANY($2::bigint[])`, [accountId, intArray(ids)]))
      .map((r) => [Number(r.id), (r.match_method as string | null) ?? null]));
    const journal = new Map((await rows(ctx.sql, `
      SELECT operation_id, count(*)::int AS n FROM business_operation_identity_reviews
       WHERE account_id = $1 AND operation_id = ANY($2::bigint[]) AND status = 'OPEN' GROUP BY operation_id`, [accountId, intArray(ids)]).catch(() => []))
      .map((r) => [Number(r.operation_id), Number(r.n)]));
    // Code 78A, sans aucune écriture : ses lectures verrouillent les candidats
    // (`FOR UPDATE`, conçues pour la consolidation) — transaction courte,
    // attente de verrou bornée, TOUJOURS annulée (rien ne peut être validé).
    const membres = new Map<number, Array<{ sourceId: number; footprint: unknown; anchor: boolean }>>();
    const actives = ids.filter((id) => vivantes.has(id));
    const ANNULEE = Symbol('lecture 78A annulée');
    await db.transaction(async (tx) => {
      await tx.execute(dsql`SET LOCAL lock_timeout = '2s'`);
      for (let i = 0; i < actives.length; i += IDENTITY_MEMBERS_OPERATION_LIMIT) {
        const m = await loadOperationMembers(tx, accountId, actives.slice(i, i + IDENTITY_MEMBERS_OPERATION_LIMIT), null);
        for (const [opId, info] of m) membres.set(opId, info.members);
      }
      throw ANNULEE;
    }).catch((e) => { if (e !== ANNULEE) throw e; });
    for (const id of ids) {
      if (!vivantes.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const ms = membres.get(id) ?? [];
      if (ms.length < 2) { out.set(id, { verdict: 'CONSISTENT', detail: { managedSources: ms.length } }); continue; }
      const revues = await reviewOperationMembers(ms, methodes);
      if (!revues.length) { out.set(id, { verdict: 'CONSISTENT', detail: { managedSources: ms.length } }); continue; }
      const contredite = revues.some((r) => r.outcome === 'SEPARATE');
      out.set(id, {
        verdict: 'FINDING', anomaly: contredite ? 'IDENTITY_CONTRADICTED' : 'IDENTITY_SUSPECT', faultyLink: 'T3',
        expected: 'sources de la même réalité économique que la source fondatrice', observed: revues.slice(0, 20),
        detail: { managedSources: ms.length, reviewVersion: IDENTITY_REVIEW_VERSION, open78aReviews: journal.get(id) ?? 0,
          repairChain: 'réexamen 78A par la consolidation T3 (aucune écriture du contrôle)' },
        inputHash: hashOf({ id, r: revues.map((r) => [r.sourceId, r.outcome, r.signals]) }),
      });
    }
    return out;
  },
};
