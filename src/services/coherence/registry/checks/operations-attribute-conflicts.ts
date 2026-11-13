/**
 * COH-OPS-ATTRIBUTE-CONFLICTS — contradictions d'attributs d'un événement de
 * référence requalifiées selon les règles 113AQ (Trello #750, anomalie BO
 * #12). Ajouté EN FIN de registre, après COH-DOC-FACT-PROVENANCE (113AK).
 *
 * Objet : événement de référence actif dont la provenance (78A,
 * `business_operations.attribute_provenance`) porte des contradictions
 * relevées sous l'ANCIENNE règle (version 1 : toute différence entre sources,
 * quel que soit le rôle des valeurs) — elles alimentent l'anomalie
 * IDENTITY_ATTRIBUTE_CONFLICT sans qualification.
 *   · inspection (lecture seule, sans IA) :
 *       REPAIRABLE ATTRIBUTE_CONFLICT_UNQUALIFIED  relevé version 1 encore
 *                  persisté : la reconsolidation ciblée le requalifie ;
 *       CONSISTENT relevé qualifié (version 2) — les conflits encore actifs
 *                  restent signalés par l'anomalie dure (aucun doublon) ;
 *   · réparation : reconsolidation T3 CIBLÉE de l'événement (moteur existant,
 *     sans IA, idempotente, sous le verrou du compte). Les valeurs retenues
 *     suivent les règles existantes (113AQ ne change aucune règle de
 *     rétention) : seule la provenance est requalifiée. Le résultat dit ce
 *     qui a été écrit (`requalified`) : jamais un faux « réparé » (113AJ) —
 *     le recontrôle lit la provenance réellement persistée.
 * Interdits : appeler l'IA, écraser une valeur de l'utilisateur, détacher une
 * source, trancher une contradiction, réparer un compte non éligible.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { idsOf, intArray, rows } from '../util';

export const OPERATIONS_ATTRIBUTE_CONFLICTS_CHECK_ID = 'COH-OPS-ATTRIBUTE-CONFLICTS';

/** Relevé non qualifié (version 1) avec au moins une contradiction. */
const LEGACY_SQL = `o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
  AND o.attribute_provenance IS NOT NULL AND coalesce((o.attribute_provenance->>'version')::int, 1) < 2
  AND jsonb_typeof(o.attribute_provenance->'conflicts') = 'array' AND jsonb_array_length(o.attribute_provenance->'conflicts') > 0`;

export const operationsAttributeConflictsCheck: CoherenceCheck = {
  id: OPERATIONS_ATTRIBUTE_CONFLICTS_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Événements de référence : contradictions d’attributs qualifiées (même attribut, même rôle, même fait)',
  domain: 'operations',
  level: 'N2',
  objectType: 'business_operation',
  scope: 'événements de référence actifs dont la provenance porte des contradictions relevées avant les règles 113AQ',
  sources: ['business_operations', 'business_operation_sources', 'business_operation_identity_reviews'],
  applicability: 'compte éligible (actif et modifiable)',
  invariant: 'toute contradiction d’attribut persistée est qualifiée (divergence légitime, conflit réel tranché ou non, preuves insuffisantes, rattachement douteux) ; aucune valeur n’est écrasée ni inventée',
  anomalies: ['ATTRIBUTE_CONFLICT_UNQUALIFIED'],
  autoRepairWhen: 'un relevé de contradictions antérieur aux règles 113AQ est encore persisté',
  forbiddenRepairs: [
    'appeler l’IA', 'écraser une valeur saisie ou corrigée par l’utilisateur', 'détacher une source sans preuve',
    'trancher une contradiction', 'déclarer réparé sans requalification persistée',
  ],
  services: ['business-operations/consolidation/consolidator#reconsolidateOperations', 'business-operations/consolidation/attribute-conflicts#qualifyAttributeConflicts'],
  chain: ['T3', 'PERSISTENCE'],
  triggers: ['BUSINESS_OPERATION_CHANGED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé après écriture d’un événement de référence',
  criticality: 'MEDIUM',
  tests: ['L113AQ-U-QUALIF', 'L113AQ-E2E-REPRISE'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${LEGACY_SQL} AND o.id > $2 ORDER BY o.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null || e.type !== 'BUSINESS_OPERATION_CHANGED') return [];
    return idsOf(await rows(ctx.sql, `SELECT o.id FROM business_operations o WHERE ${LEGACY_SQL} AND o.id = $2`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const r = await rows(ctx.sql, `
      SELECT o.id, coalesce((o.attribute_provenance->>'version')::int, 1) AS version,
             (SELECT array_agg(DISTINCT c->>'field') FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(o.attribute_provenance->'conflicts') = 'array' THEN o.attribute_provenance->'conflicts' ELSE '[]'::jsonb END) c) AS fields
        FROM business_operations o
       WHERE o.account_id = $1 AND o.id = ANY($2::bigint[]) AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`,
    [accountId, intArray(ids)]);
    for (const id of ids) {
      const x = r.find((y) => Number(y.id) === id);
      if (!x) { out.set(id, { verdict: 'GONE' }); continue; }
      const fields = ((x.fields as string[] | null) ?? []).filter(Boolean).sort();
      if (Number(x.version) < 2 && fields.length) {
        out.set(id, {
          verdict: 'REPAIRABLE', anomaly: 'ATTRIBUTE_CONFLICT_UNQUALIFIED', faultyLink: 'T3',
          expected: ['qualified'], observed: fields,
          detail: { operationId: id, fields, rulesVersion: 1 },
        });
        continue;
      }
      out.set(id, { verdict: 'CONSISTENT', detail: { operationId: id, rulesVersion: Number(x.version) } });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    const lire = async (id: number) => (await rows(ctx.sql, `
      SELECT coalesce((attribute_provenance->>'version')::int, 1) AS version,
             CASE WHEN jsonb_typeof(attribute_provenance->'conflicts') = 'array' THEN jsonb_array_length(attribute_provenance->'conflicts') ELSE 0 END AS conflicts,
             CASE WHEN jsonb_typeof(attribute_provenance->'divergences') = 'array' THEN jsonb_array_length(attribute_provenance->'divergences') ELSE 0 END AS divergences
        FROM business_operations WHERE id = $1 AND account_id = $2`, [id, accountId]))[0];
    for (const { id } of items) {
      const avant = await lire(id);
      let error: string | null = null;
      try {
        await reconsolidateOperations(accountId, [id], { correlationId: `coh-attr-conflicts:${id}` });
      } catch (e) {
        error = String((e as Error)?.message ?? e).slice(0, 300);
      }
      const apres = await lire(id);
      const requalified = !!apres && Number(apres.version) >= 2;
      out.set(id, {
        called: true, service: 'reconsolidateOperations', aiCalls: 0,
        result: {
          requalified,
          ...(requalified ? { written: ['attribute_provenance'] } : {}),
          before: avant ? { rulesVersion: Number(avant.version), conflicts: Number(avant.conflicts) } : null,
          after: apres ? { rulesVersion: Number(apres.version), conflicts: Number(apres.conflicts), divergences: Number(apres.divergences) } : null,
          ...(error ? { error } : {}),
        },
        rollbackRef: `business_operation_history:correlation_id=coh-attr-conflicts:${id}`,
      });
    }
    return out;
  },
};
