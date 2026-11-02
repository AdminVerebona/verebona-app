/**
 * COH-AGENDA-HISTORICAL-STATUS — faits historiques passés restés « Statut à
 * confirmer » alors qu'une preuve FIABLE de réalisation est liée (lot 103D,
 * ticket « Agenda — statut et rappels », cas « Contrôle réalisé — Maison » du
 * 22/12/2020 ; CA01 à CA03, CA08).
 *
 * Objet : élément d'agenda HISTORICAL, daté, passé, sans statut, automatique.
 *   · inspection (lecture seule, sans IA) : `diagnoseHistoricalStatus` —
 *     règle pure `historicalCompletionVerdict` (document lié, daté du jour du
 *     fait, type documentaire établissant la réalisation ; jamais l'intitulé,
 *     jamais la seule date dépassée) ;
 *   · REPAIRABLE (`HISTORICAL_COMPLETION_PROVEN_NOT_APPLIED`) : preuve
 *     MÉMORISÉE (0945 : `completion_proof_file_id`) — « Réalisé » calculé à la
 *     lecture, AUCUN statut manuel posé (l'élément reste automatique et
 *     intact : T4 et la consolidation 76H gardent la main) ; écriture gardée
 *     (un élément touché par l'utilisateur entre-temps n'est jamais réécrit) ;
 *     qualification de catégorie levée si aucun conflit n'est en attente ;
 *     trace COMPLETION_PROVEN avant / après ;
 *   · CONSISTENT : réalisation non démontrée (« Statut à confirmer » est
 *     l'état juste ; le champ incertain est consigné), élément protégé
 *     (saisi ou modifié par l'utilisateur), ou hors règle.
 * Idempotent (un élément réalisé sort du périmètre). Aucune occurrence future
 * n'est créée ici : la récurrence reste celle de T4 (#267).
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, intArray } from '../util';

export const HISTORICAL_STATUS_CHECK_ID = 'COH-AGENDA-HISTORICAL-STATUS';

export const agendaHistoricalStatusCheck: CoherenceCheck = {
  id: HISTORICAL_STATUS_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Agenda : fait passé prouvé par un document lié affiché « Réalisé » (jamais « À venir », jamais déduit du titre)',
  domain: 'agenda',
  level: 'N2',
  objectType: 'agenda_item',
  scope: 'éléments d’agenda historiques (fait passé), datés dans le passé, sans statut, créés automatiquement, réalisation pas encore prouvée',
  sources: ['agenda_items', 'agenda_items.completion_proof_file_id (0945)', 'agenda_file_links', 'asset_files', 'agenda_occurrence_events', 'agenda_data_conflicts'],
  applicability: 'compte éligible',
  invariant: 'un fait passé n’est « réalisé » que sur preuve fiable (document lié, daté du jour du fait, d’un type qui établit la réalisation) ; sans preuve il reste « statut à confirmer » ; une correction de l’utilisateur n’est jamais réécrite',
  anomalies: ['HISTORICAL_COMPLETION_PROVEN_NOT_APPLIED'],
  autoRepairWhen: 'élément automatique jamais modifié par l’utilisateur, document lié non supprimé daté du jour du fait et dont le type documentaire établit la réalisation de ce type d’événement',
  forbiddenRepairs: ['déduire la réalisation du titre ou de la seule date dépassée', 'réécrire un statut, une date ou un élément corrigé par l’utilisateur',
    'créer une occurrence ou une récurrence', 'trancher un conflit de données en attente',
    'poser un statut manuel (l’élément doit rester automatique : T4 et la consolidation 76H gardent la main)'],
  services: ['agenda/historical-completion#diagnoseHistoricalStatus', 'agenda/historical-completion#repairHistoricalStatus', 'agenda/agenda-write-primitive#upsertAgendaItem'],
  chain: ['T1', 'T4', 'PERSISTENCE'],
  triggers: ['AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'SOURCE_ANALYZED', 'DOCUMENT_UPDATED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque analyse ou modification',
  criticality: 'MEDIUM',
  tests: ['L103D-U-STATUT-HISTORIQUE', 'L103D-E2E-STATUT-HISTORIQUE'],

  async listObjects(ctx, accountId, afterId, limit) {
    const { historicalCandidates } = await import('@/services/agenda/historical-completion');
    return historicalCandidates(ctx.sql, accountId, 'AND i.id > $2', [afterId], limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    const { historicalCandidates } = await import('@/services/agenda/historical-completion');
    if (e.type === 'AGENDA_ITEM_CREATED' || e.type === 'AGENDA_ITEM_UPDATED') return historicalCandidates(ctx.sql, accountId, 'AND i.id = $2', [e.entityId]);
    if (e.type === 'SOURCE_ANALYZED' || e.type === 'DOCUMENT_UPDATED') {
      return historicalCandidates(ctx.sql, accountId, 'AND EXISTS (SELECT 1 FROM agenda_file_links l WHERE l.agenda_item_id = i.id AND l.asset_file_id = $2)', [e.entityId]);
    }
    return [];
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { historicalCandidates, diagnoseHistoricalStatus } = await import('@/services/agenda/historical-completion');
    const vivants = new Set(await historicalCandidates(ctx.sql, accountId, 'AND i.id = ANY($2::int[])', [intArray(ids)]));
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const d = await diagnoseHistoricalStatus(ctx.sql, accountId, id, ctx.now);
      if (!d) { out.set(id, { verdict: 'GONE' }); continue; }
      if (d.verdict.kind !== 'PROVEN') {
        // Réalisation non démontrée (ou élément protégé) : « Statut à confirmer » est l'état juste — champ incertain consigné.
        out.set(id, { verdict: 'CONSISTENT', detail: { verdict: d.verdict } });
        continue;
      }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: 'HISTORICAL_COMPLETION_PROVEN_NOT_APPLIED', faultyLink: 'T4',
        expected: { manualStatus: 'realise', requiresQualification: d.verdict.clearQualification ? false : d.before.requiresQualification },
        observed: d.before,
        detail: { proof: { fileId: d.verdict.fileId, documentTypeCode: d.verdict.documentTypeCode, proofCode: d.verdict.proofCode, documentDate: d.verdict.documentDate } },
        inputHash: hashOf({ id, verdict: d.verdict, before: d.before }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { diagnoseHistoricalStatus, repairHistoricalStatus } = await import('@/services/agenda/historical-completion');
    for (const { id } of items) {
      // Diagnostic relu au moment de réparer.
      const d = await diagnoseHistoricalStatus(ctx.sql, accountId, id, ctx.now);
      if (!d || d.verdict.kind !== 'PROVEN') {
        out.set(id, { called: false, service: 'repairHistoricalStatus', result: { skipped: 'NOTHING_TO_REPAIR' } });
        continue;
      }
      const r = await repairHistoricalStatus(ctx.sql, { ...d, verdict: d.verdict }, accountId, { correlationId: ctx.correlationId });
      out.set(id, {
        called: true, service: 'repairHistoricalStatus',
        result: { ...r, before: d.before, proofFileId: d.verdict.fileId, proofCode: d.verdict.proofCode },
        rollbackRef: `agenda_occurrence_events:event_type=COMPLETION_PROVEN;correlation_id=${ctx.correlationId}`,
        reevaluation: 'TECHNICAL_REBUILD',
      });
    }
    return out;
  },
};
