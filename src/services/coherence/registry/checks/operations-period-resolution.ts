/**
 * COH-OPS-PERIOD-RESOLUTION — résolution contextuelle des périodes de
 * couverture d'un événement de référence (lot 113AA, Trello #725 §2 B,
 * décision D11 de #724, R13 / R14). Ajouté EN FIN de registre, après
 * COH-DOC-DESCRIPTION-T1 (113Z).
 *
 * Objet : événement de référence actif dont au moins deux documents membres
 * portent une période de couverture (`document_business_periods`).
 *   · inspection (lecture seule, sans IA) : résolution PURE
 *     (`documents/business-periods/resolution.ts`) des périodes enregistrées,
 *     des relations déclarées par T1 et des décisions de l'utilisateur ;
 *       REPAIRABLE PERIOD_CONFLICT_CARD_MISSING  divergence que les preuves
 *                  n'expliquent pas (documents qualifiés) sans question ouverte ;
 *       REPAIRABLE PERIOD_CONFLICT_CARD_OBSOLETE question ouverte devenue sans
 *                  objet (correction, réanalyse, avenant reçu, décision) ;
 *       REPAIRABLE PERIOD_RELATION_REVIEW_MISSING (lot 113AD, version 2)
 *                  divergence jamais soumise au réexamen T3 alors que le prompt
 *                  T3 effectif porte la branche PERIOD_RELATION (bloc 29) : la
 *                  réparation DEMANDE le réexamen (aucun appel IA ici — passage
 *                  T3 du compte), la question est différée ;
 *       FINDING    PERIOD_DIVERGENCE_UNQUALIFIED divergence entre documents dont
 *                  l'un n'a PAS été qualifié sous le contrat T1 v2 (bloc 28
 *                  absent, ou document antérieur) : aucune fausse résolution,
 *                  aucune question prématurée — signalée (Supervision) ; elle
 *                  se résout par la requalification T1 du document (analyse
 *                  suivante, ou réanalyse ciblée décidée par le PO) ;
 *   · réparation : `syncPeriodConflictCards` (pose / ferme les cartes
 *     PERIOD-CONFLICT ; idempotent).
 * Interdits : appeler l'IA, modifier une période d'un document (encore moins
 * une période corrigée par l'utilisateur), trancher une divergence à la place
 * de l'utilisateur, « le dernier document gagne », écrire une date
 * contractuelle, une dépense ou le TCO.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';

export const OPERATIONS_PERIOD_RESOLUTION_CHECK_ID = 'COH-OPS-PERIOD-RESOLUTION';
const RULE = 'PERIOD-CONFLICT';

/** Événements actifs du compte dont au moins deux documents membres portent une couverture. */
const OBJETS_SQL = `o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
  AND (SELECT count(DISTINCT p.file_id) FROM business_operation_documents d
         JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
         JOIN document_business_periods p ON p.file_id = f.id AND p.account_id = d.account_id AND p.status = 'ACTIVE' AND p.period_kind = 'COVERAGE'
        WHERE d.operation_id = o.id AND d.account_id = o.account_id AND d.active) >= 2`;

export const operationsPeriodResolutionCheck: CoherenceCheck = {
  id: OPERATIONS_PERIOD_RESOLUTION_CHECK_ID,
  // Lot 113AD : version 2 (réexamen T3 demandé pour le stock quand le bloc 29 est actif).
  version: 2,
  status: 'ACTIVE',
  title: 'Événements de référence : périodes de couverture des justificatifs résolues (succession, avenant, rectificatif, divergence)',
  domain: 'operations',
  level: 'N2',
  objectType: 'business_operation',
  scope: 'événements de référence actifs dont au moins deux justificatifs portent une période de couverture',
  sources: ['business_operations', 'business_operation_documents', 'document_business_periods', 'business_period_decisions', 'business_period_relation_reviews', 'to_process_actions'],
  applicability: 'compte éligible (actif et modifiable)',
  invariant: 'une divergence de périodes que les preuves n’expliquent pas (documents qualifiés par T1) fait l’objet d’une seule question ouverte, jamais redemandée une fois tranchée ; aucune question ne reste ouverte sans divergence ; aucune résolution n’est inventée',
  anomalies: ['PERIOD_CONFLICT_CARD_MISSING', 'PERIOD_CONFLICT_CARD_OBSOLETE', 'PERIOD_RELATION_REVIEW_MISSING', 'PERIOD_DIVERGENCE_UNQUALIFIED'],
  autoRepairWhen: 'les questions ouvertes diffèrent des divergences que la résolution (lecture seule, sans IA) laisse à l’utilisateur, ou une divergence jamais examinée attend le réexamen T3 (bloc 29 actif)',
  forbiddenRepairs: [
    'appeler l’IA', 'modifier une période d’un document', 'trancher une divergence à la place de l’utilisateur',
    'retenir le dernier document reçu', 'écrire une date contractuelle, une dépense ou le TCO',
  ],
  services: ['documents/business-periods/service#operationPeriodResolution', 'documents/business-periods/conflict-cards#syncPeriodConflictCards'],
  chain: ['T1', 'T3', 'PERSISTENCE', 'TO_PROCESS'],
  triggers: ['SOURCE_ANALYZED', 'BUSINESS_OPERATION_CHANGED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé après analyse ou écriture d’un événement de référence',
  criticality: 'MEDIUM',
  tests: ['L113AA-U-RESOLUTION', 'L113AA-E2E-D11', 'L113AD-E2E-STOCK'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${OBJETS_SQL} AND o.id > $2 ORDER BY o.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === 'BUSINESS_OPERATION_CHANGED') {
      return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${OBJETS_SQL} AND o.id = $2`, [accountId, e.entityId]));
    }
    return idsOf(await rows(ctx.sql, `
      SELECT DISTINCT o.id FROM business_operations o
        JOIN business_operation_documents d ON d.operation_id = o.id AND d.account_id = o.account_id AND d.active AND d.file_id = $2
       WHERE ${OBJETS_SQL} ORDER BY o.id`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const vivantes = new Set(idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${OBJETS_SQL} AND o.id = ANY($2::bigint[])`, [accountId, intArray(ids)])));
    const [{ operationPeriodResolution }, { periodConflictRelationKey }] = await Promise.all([
      import('@/services/documents/business-periods/service'), import('@/services/documents/business-periods/conflict-cards'),
    ]);
    const ouvertes = await rows(ctx.sql, `
      SELECT (trigger_context->>'operationId')::bigint AS op, relation_key FROM to_process_actions
       WHERE account_id = $1 AND rule_code = $2 AND resolved_at IS NULL AND (trigger_context->>'operationId')::bigint = ANY($3::bigint[])`,
    [accountId, RULE, intArray(ids)]);
    let capacite: boolean | null = null;
    const reexamen = async () => {
      if (capacite === null) {
        try { capacite = (await (await import('@/services/documents/business-periods/relation-decider')).relationDecider().capability()).available; } catch { capacite = false; }
      }
      return capacite;
    };
    for (const id of ids) {
      if (!vivantes.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const r = await operationPeriodResolution(ctx.sql, accountId, id);
      // Lot 113AD : divergence jamais examinée, bloc 29 actif → demande de réexamen (réparation sans IA).
      const aDemander = r.conflicts.filter((c) => c.review === 'NONE');
      if (aDemander.length && await reexamen()) {
        const fps = aDemander.map((c) => c.fingerprint).sort();
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: 'PERIOD_RELATION_REVIEW_MISSING', faultyLink: 'T3', expected: fps, observed: [],
          detail: { operationId: id, divergences: aDemander.length }, inputHash: hashOf({ id, review: fps }),
        });
        continue;
      }
      const attendues = new Set(r.conflicts.filter((c) => c.needsUser).map((c) => periodConflictRelationKey(id, c.fingerprint)));
      const presentes = new Set(ouvertes.filter((o) => Number(o.op) === id).map((o) => String(o.relation_key)));
      const manquantes = [...attendues].filter((k) => !presentes.has(k));
      const obsoletes = [...presentes].filter((k) => !attendues.has(k));
      if (manquantes.length || obsoletes.length) {
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: manquantes.length ? 'PERIOD_CONFLICT_CARD_MISSING' : 'PERIOD_CONFLICT_CARD_OBSOLETE', faultyLink: 'TO_PROCESS',
          expected: [...attendues].sort(), observed: [...presentes].sort(),
          detail: { operationId: id, missing: manquantes.length, obsolete: obsoletes.length },
          inputHash: hashOf({ id, attendues: [...attendues].sort(), presentes: [...presentes].sort() }),
        });
        continue;
      }
      // Lot 113AD : une divergence dont le réexamen T3 est en attente n'est pas un constat (question différée, bornée).
      const nonQualifiees = r.conflicts.filter((c) => !c.needsUser && c.review !== 'AWAITING');
      if (nonQualifiees.length) {
        out.set(id, {
          verdict: 'FINDING', anomaly: 'PERIOD_DIVERGENCE_UNQUALIFIED', faultyLink: 'T1',
          detail: { operationId: id, divergences: nonQualifiees.length, fileIds: [...new Set(nonQualifiees.flatMap((c) => c.fileIds))].slice(0, 10),
            remedy: 'requalification T1 des documents (contrat t1-business-periods-v2, bloc 28 du guide)' },
        });
        continue;
      }
      const enAttente = r.conflicts.filter((c) => c.review === 'AWAITING').length;
      out.set(id, { verdict: 'CONSISTENT', detail: { operationId: id, coverages: r.coverages.length, ...(enAttente ? { awaitingReview: enAttente } : {}) } });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { syncPeriodConflictCards } = await import('@/services/documents/business-periods/conflict-cards');
    for (const { id } of items) {
      const r = await syncPeriodConflictCards(accountId, { operationIds: [id] });
      out.set(id, {
        called: true, service: 'syncPeriodConflictCards', aiCalls: 0,
        result: { created: r.created, updated: r.updated, closed: r.closed, ...(r.reviewsRequested ? { reviewsRequested: r.reviewsRequested } : {}), ...(r.error ? { error: r.error } : {}) },
        rollbackRef: `to_process_action_events:rule_code=${RULE}`,
      });
    }
    return out;
  },
};
