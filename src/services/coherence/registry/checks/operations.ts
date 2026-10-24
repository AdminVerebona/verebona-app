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
 *
 *    Lot 86C (v2, ticket P1 « doublons de contrats ») — DOUBLONS ENTRE
 *    OPÉRATIONS : une relation récurrente (contrat, échéances) que le
 *    réexamen rétroactif T3 réunirait à une autre Opération du compte,
 *    décision RECALCULÉE en simulation (`previewOperationDuplicates` :
 *    mêmes règles que `examineRetro`, sans IA, transaction annulée), y
 *    compris pour des Opérations anciennes, déjà consolidées, sans nouveau
 *    document et quel que soit l'état technique de leur dernier passage
 *    (DONE, NO_CHANGE, « à jour »).
 *      · doublon CERTAIN (décision utilisateur, référence, série établie,
 *        verdict M3 rendu) → REPAIRABLE `DUPLICATE_OPERATIONS` ;
 *      · doublon PLAUSIBLE non encore soumis (prestataire désigné autrement,
 *        série sans clé) → REPAIRABLE `DUPLICATE_OPERATIONS_SUSPECTED` : la
 *        réparation déclenche le réexamen T3, dont la phase M3 existante
 *        tranche (plafonds inchangés) — fusion seulement sur identité établie ;
 *      · réexamen déjà en cours, ou doute soumis à l'utilisateur → AMBIGUOUS.
 *    Réparation : `reconsolidateRecurringDocuments` (reconsolidation ciblée
 *    O-6 : marque de réexamen + consolidation T3 + fusion EXISTANTE, preuves,
 *    historiques, composantes et décisions conservés ; liens directs
 *    équipement recalculés) — jamais une écriture du contrôle, jamais d'IA.
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

/** Lot 86C : anomalies « doublon entre Opérations » (réparées par le réexamen T3). */
export const DUPLICATE_ANOMALIES: ReadonlySet<string> = new Set(['DUPLICATE_OPERATIONS', 'DUPLICATE_OPERATIONS_SUSPECTED']);

/**
 * Lot 86C : Opérations de relation récurrente (contrat, ou coûts à période
 * facturée) qui ont une VOISINE active de type compatible sur un bien commun
 * — préfiltre de lecture ; la décision reste la simulation T3.
 */
const DOUBLON_POSSIBLE_SQL = `(o.type_code IS NULL OR o.type_code IN ('CONTRACT', 'INTERVENTION', 'OTHER'))
  AND (o.type_code = 'CONTRACT' OR EXISTS (SELECT 1 FROM business_operation_financial_components fc
        WHERE fc.operation_id = o.id AND fc.active AND fc.period_start IS NOT NULL AND fc.period_end > fc.period_start))
  AND EXISTS (SELECT 1 FROM business_operations y
               JOIN business_operation_asset_links ly ON ly.operation_id = y.id AND ly.active
               JOIN business_operation_asset_links lo ON lo.operation_id = o.id AND lo.active AND lo.asset_id = ly.asset_id
              WHERE y.account_id = o.account_id AND y.id <> o.id AND y.invalidated_at IS NULL AND y.merged_into_operation_id IS NULL
                AND (y.type_code IS NULL OR y.type_code IN ('CONTRACT', 'INTERVENTION', 'OTHER')))`;

export const operationsIdentityCheck: CoherenceCheck = {
  id: 'COH-OPS-IDENTITY',
  // Lot 86C : v2 — doublons ENTRE Opérations (réexamen du stock entier, y compris inchangé).
  version: 2,
  status: 'ACTIVE',
  title: 'Opérations : identité économique des sources regroupées (78A) et doublons entre Opérations (même relation contractuelle)',
  domain: 'operations',
  level: 'N2',
  objectType: 'business_operation',
  scope: 'Opérations actives du compte (sources gérées : documents, données structurées) ; relations récurrentes ayant une voisine sur un bien commun',
  sources: ['business_operations', 'business_operation_sources', 'document_operation_candidates', 'business_operation_identity_reviews',
    'business_operation_asset_links', 'business_operation_financial_components', 'business_operation_match_decisions', 'document_suppliers', 'suppliers'],
  applicability: 'compte éligible ; Opération active ayant au moins deux sources gérées, ou relation récurrente ayant une voisine compatible',
  invariant: 'chaque source regroupée partage l’identité économique de la source fondatrice ; une relation contractuelle établie n’est portée que par UNE Opération (deux périodes facturées ne font pas deux contrats ; deux contrats réellement distincts restent deux Opérations)',
  anomalies: ['IDENTITY_CONTRADICTED', 'IDENTITY_SUSPECT', 'DUPLICATE_OPERATIONS', 'DUPLICATE_OPERATIONS_SUSPECTED'],
  autoRepairWhen: 'doublon entre Opérations dont la décision T3 recalculée (sans IA) réunit les deux, ou qu’un rapprochement plausible non encore soumis rend examinable par M3 : réexamen T3 ciblé (fusion existante seulement sur identité établie). Identité 78A interne : aucune (détection, réexamen 78A par la consolidation T3)',
  forbiddenRepairs: ['séparer ou fusionner hors de la consolidation T3', 'défaire un rattachement décidé par l’utilisateur ou l’IA', 'écrire depuis le contrôle',
    'fusionner deux contrats distincts (références, équipements) ou contre une décision de l’utilisateur', 'fusionner sur le seul prestataire', 'appeler l’IA depuis le contrôle',
    'supprimer une facture, une composante ou un historique'],
  services: ['business-operations/consolidation/consolidator#loadOperationMembers', 'business-operations/consolidation/economic-identity#reviewExistingAttachment',
    'business-operations/consolidation/consolidator#previewOperationDuplicates', 'business-operations/consolidation/targeted#reconsolidateRecurringDocuments'],
  chain: ['T1', 'T3'],
  triggers: [OPERATION_CHANGED, 'SOURCE_ANALYZED'],
  frequency: 'campagne exhaustive quotidienne (toutes les Opérations, y compris inchangées) + contrôle ciblé à chaque écriture d’Opération',
  criticality: 'HIGH',
  tests: ['L83B-U-OPS', 'L83B-E2E-07', 'L83B-E2E-10', 'L86C-E2E-04', 'L86C-E2E-05', 'L86C-E2E-11'],

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
    // Lot 86C : doublons ENTRE Opérations (simulation du réexamen rétroactif T3, sans IA).
    const possibles = actives.length ? idsOf(await rows(ctx.sql, `
      SELECT o.id FROM business_operations o WHERE ${OPERATIONS_ACTIVES_SQL} AND o.id = ANY($2::bigint[]) AND ${DOUBLON_POSSIBLE_SQL}`,
    [accountId, intArray(actives)])) : [];
    const { previewOperationDuplicates } = await import('@/services/business-operations/consolidation/consolidator');
    const doublons = possibles.length ? await previewOperationDuplicates(accountId, possibles) : new Map();
    for (const id of ids) {
      if (!vivantes.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const ms = membres.get(id) ?? [];
      const revues = ms.length < 2 ? [] : await reviewOperationMembers(ms, methodes);
      const doublon = doublons.get(id);
      if (doublon) {
        const certain = doublon.level === 'CERTAIN';
        const soumettre = doublon.level === 'M3_REQUIRED' && !doublon.retroPending;
        out.set(id, {
          verdict: certain || soumettre ? 'REPAIRABLE' : 'AMBIGUOUS',
          anomaly: certain ? 'DUPLICATE_OPERATIONS' : 'DUPLICATE_OPERATIONS_SUSPECTED', faultyLink: 'T3',
          expected: 'une seule Opération par relation contractuelle établie',
          observed: { operationId: id, targetOperationId: doublon.targetOperationId, plausible: doublon.plausibleOperationIds, level: doublon.level },
          detail: {
            fileId: doublon.fileId, why: doublon.why, retroPending: doublon.retroPending, designations: doublon.designations,
            identity78a: revues.slice(0, 5),
            repairChain: certain ? 'réexamen T3 ciblé (fusion existante : sources, composantes, historique, décisions conservés)'
              : soumettre ? 'réexamen T3 ciblé : rapprochement sémantique M3 existant (plafonds inchangés), puis carte « À traiter » si doute'
                : doublon.level === 'ARBITRATION' ? 'question déjà soumise à l’utilisateur (carte « À traiter » existante)' : 'réexamen T3 en cours (attente M3 ou utilisateur)',
          },
          inputHash: hashOf({ id, d: [doublon.level, doublon.targetOperationId, doublon.plausibleOperationIds, doublon.fileId, doublon.retroPending] }),
        });
        continue;
      }
      if (ms.length < 2) { out.set(id, { verdict: 'CONSISTENT', detail: { managedSources: ms.length } }); continue; }
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

  /**
   * Lot 86C : seuls les DOUBLONS entre Opérations sont réparés, par le réexamen
   * T3 ciblé (marque de réexamen + consolidation T3 + fusion existante) — jamais
   * une écriture du contrôle ; l'identité 78A interne reste un constat.
   */
  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { reconsolidateRecurringDocuments } = await import('@/services/business-operations/consolidation/targeted');
    for (const { id, inspection } of items) {
      if (!DUPLICATE_ANOMALIES.has(inspection.anomaly ?? '')) continue;
      const cible = (inspection.observed as { targetOperationId?: number | null } | undefined)?.targetOperationId ?? null;
      const r = await reconsolidateRecurringDocuments(accountId, { operationIds: cible ? [id, cible] : [id] }, {
        trigger: 'coherence-duplicates', correlationId: ctx.correlationId, today: ctx.today,
      });
      if (r.errors.length) throw new Error(r.errors.join(' ; ').slice(0, 400));
      out.set(id, {
        called: true, service: 'reconsolidateRecurringDocuments', aiCalls: r.aiCalls,
        result: { anomaly: inspection.anomaly, marked: r.marked.length, consolidated: r.consolidated, changes: r.changes, operations: r.operations, skipped: r.skipped ?? null },
        rollbackRef: `business_operation_history:correlation_id=${ctx.correlationId}`,
        // Doublon seulement plausible : le verdict M3 arrive au passage T3 suivant (file existante).
        ...(inspection.anomaly === 'DUPLICATE_OPERATIONS_SUSPECTED' ? { pending: true } : {}),
      });
    }
    return out;
  },
};
