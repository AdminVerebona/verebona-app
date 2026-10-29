/**
 * COH-AGENDA-RECURRENCE-END — séries d'échéances arrêtées À TORT par
 * l'ancienne règle « mot-clé » de fin de récurrence (lot 99D, ticket P1
 * « Agenda — Corriger la détection abusive de fin de récurrence à partir des
 * clauses de résiliation »).
 *
 * Objet : document source d'une série dont T4 a accepté la récurrence.
 *   · inspection (lecture seule, sans IA) : `diagnoseRecurrenceEnd` —
 *     candidats reconstruits depuis les faits T1 persistés (fin qualifiée
 *     comprise), occurrences À VENIR attendues comparées à la série :
 *     prévision annulée sans trace par l'ancienne règle (RECURRENCE_FORECAST_WRONGLY_RETIRED)
 *     ou occurrence jamais générée (RECURRENCE_OCCURRENCE_MISSING) ;
 *   · réparation : `repairRecurrenceEnd` — prévision rétablie (tracée
 *     FORECAST_RESTORED), puis, si une occurrence manque, candidats du
 *     document remis dans la file T4 (aucun nouvel envoi, aucun retrait).
 * Le passé réel n'est jamais touché : seules des prévisions automatiques
 * intactes À VENIR sont rétablies ; une fin confirmée et datée reste appliquée.
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, intArray } from '../util';

export const agendaRecurrenceEndCheck: CoherenceCheck = {
  id: 'COH-AGENDA-RECURRENCE-END',
  version: 1,
  status: 'ACTIVE',
  title: 'Agenda : échéances récurrentes d’un contrat actif présentes (aucune fin déduite d’un simple mot)',
  domain: 'agenda',
  level: 'N2',
  objectType: 'document',
  scope: 'documents sources d’une série d’échéances dont T4 a accepté la récurrence, et dont l’extrait portait l’empreinte de l’ancienne règle « mot-clé »',
  sources: ['agenda_items', 'agenda_asset_links', 'agenda_occurrence_events', 'document_extractions', 'document_facts'],
  applicability: 'compte éligible ; document non supprimé, faits T1 persistés',
  invariant: 'une clause de résiliation, de préavis ou une mention de fin non établie n’arrête jamais une série ; seule une fin contractuelle qualifiée et datée borne la série (aucune occurrence après sa date d’effet) ; les occurrences passées et réelles sont conservées',
  anomalies: ['RECURRENCE_FORECAST_WRONGLY_RETIRED', 'RECURRENCE_OCCURRENCE_MISSING'],
  autoRepairWhen: 'prévision automatique intacte À VENIR annulée sans trace utilisateur dans la fenêtre d’une occurrence attendue (rétablie, tracée) ; occurrence attendue jamais générée (relance de la file T4 du document)',
  forbiddenRepairs: ['rétablir une prévision annulée par l’utilisateur', 'toucher une occurrence confirmée ou passée', 'générer au-delà d’une fin confirmée et datée',
    'décider une fin de récurrence sur un mot-clé', 'relancer T4 hors des documents concernés'],
  services: ['agenda/recurrence-end-reprise#diagnoseRecurrenceEnd', 'agenda/recurrence-end-reprise#repairRecurrenceEnd', 'ai/agenda#enqueueT4Candidates'],
  chain: ['T1', 'T4', 'PERSISTENCE'],
  triggers: ['SOURCE_ANALYZED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque analyse',
  criticality: 'MEDIUM',
  tests: ['L99D-U-RECURRENCE-END', 'L99D-E2E-REPRISE'],
  semanticReevaluation: ['T4'],

  async listObjects(ctx, accountId, afterId, limit) {
    const { documentsWithAcceptedSeries } = await import('@/services/agenda/recurrence-end-reprise');
    return (await documentsWithAcceptedSeries(ctx.sql, accountId, 'AND i.origin_ref_id > $2', [afterId])).slice(0, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null || e.type !== 'SOURCE_ANALYZED') return [];
    const { documentsWithAcceptedSeries } = await import('@/services/agenda/recurrence-end-reprise');
    return documentsWithAcceptedSeries(ctx.sql, accountId, 'AND i.origin_ref_id = $2', [e.entityId]);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { documentsWithAcceptedSeries, diagnoseRecurrenceEnd } = await import('@/services/agenda/recurrence-end-reprise');
    const vivants = new Set(await documentsWithAcceptedSeries(ctx.sql, accountId, 'AND i.origin_ref_id = ANY($2::int[])', [intArray(ids)]));
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const d = await diagnoseRecurrenceEnd(ctx.sql, accountId, id, ctx.today);
      if (!d || d.series.length === 0) { out.set(id, { verdict: 'CONSISTENT' }); continue; }
      const retires = d.series.some((s) => s.retiredIds.length > 0);
      const resume = d.series.map((s) => ({
        originFieldKey: s.originFieldKey, seriesKey: s.seriesKey, expected: s.expected, retiredIds: s.retiredIds, missing: s.missing, bound: s.bound,
        // Traçabilité de l'arrêt éventuel : raison, date d'effet, source (sans extrait).
        end: s.end ? { status: s.end.status, reason: s.end.reason, effectiveDate: s.end.effectiveDate, sourceKind: s.end.source.kind, fieldKey: s.end.source.fieldKey ?? null } : null,
      }));
      out.set(id, {
        verdict: 'REPAIRABLE',
        anomaly: retires ? 'RECURRENCE_FORECAST_WRONGLY_RETIRED' : 'RECURRENCE_OCCURRENCE_MISSING',
        faultyLink: 'T4',
        expected: resume.map((s) => ({ seriesKey: s.seriesKey, dates: s.expected, bound: s.bound, end: s.end })),
        observed: resume.map((s) => ({ seriesKey: s.seriesKey, retiredIds: s.retiredIds, missing: s.missing })),
        detail: { assetId: d.assetId, series: resume, repairChain: 'prévisions rétablies (FORECAST_RESTORED) puis file T4 du document si une occurrence manque' },
        inputHash: hashOf({ id, resume }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { diagnoseRecurrenceEnd, repairRecurrenceEnd } = await import('@/services/agenda/recurrence-end-reprise');
    for (const { id } of items) {
      // Diagnostic relu au moment de réparer (aucune décision sur un état périmé).
      const d = await diagnoseRecurrenceEnd(ctx.sql, accountId, id, ctx.today);
      if (!d || d.series.length === 0) {
        out.set(id, { called: false, service: 'repairRecurrenceEnd', result: { skipped: 'NOTHING_TO_REPAIR' } });
        continue;
      }
      const r = await repairRecurrenceEnd(ctx.sql, accountId, d, { correlationId: ctx.correlationId });
      out.set(id, {
        called: true, service: 'repairRecurrenceEnd',
        result: { restored: r.restored, t4Requested: r.t4Requested, t4JobId: r.t4JobId },
        rollbackRef: `agenda_occurrence_events:event_type=FORECAST_RESTORED;correlation_id=${ctx.correlationId}`,
        // Relance T4 acceptée par la file : résultat différé, recontrôlé au passage suivant.
        ...(r.t4Requested && r.t4JobId != null ? { pending: true, reevaluation: 'SEMANTIC_REEVALUATION_T4' as const } : { reevaluation: 'TECHNICAL_REBUILD' as const }),
      });
    }
    return out;
  },
};
