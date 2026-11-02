/**
 * COH-DOC-PRIMARY-LINK — rattachement PRINCIPAL récupérable d'un document
 * (lot 105D, ticket « T3 / Cohérence / À traiter — Rattachement rétroactif
 * après création d'un bien », §G).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT (compte de test 10, 02/11/2026) : COH-DOC-LINKS rendait
 * CONSISTENT pour des documents SANS bien principal — il ne contrôle que la
 * partie équipement et le bien supprimé. Ce contrôle UNIQUE spécialisé
 * (aucune double réparation : COH-DOC-LINKS ne touche pas au bien principal)
 * examine CHAQUE document visible et rend un état DISTINCT :
 *
 *   CONSISTENT  PRIMARY_PRESENT (bien principal posé) · ORPHAN_NORMAL
 *               (décision de l'utilisateur « sans bien »)
 *   REPAIRABLE  PRIMARY_LINK_RECOVERABLE (T3 rattacherait aujourd'hui sans IA :
 *               identifiant d'un seul bien, référence partagée, nom distinctif,
 *               identité de groupe démontrée / attestée / confirmée) ·
 *               PRIMARY_LINK_NOT_EXAMINED (jamais évalué, version du moteur
 *               ou contexte pertinent changés depuis la dernière évaluation)
 *   AMBIGUOUS   PRIMARY_LINK_IDENTITY_TO_CONFIRM (carte groupée) ·
 *               PRIMARY_LINK_AWAITING_USER (carte individuelle) ·
 *               PRIMARY_LINK_NO_CANDIDATE (examiné, aucun bien compatible) ·
 *               PRIMARY_LINK_REFUSED_BY_USER (biens refusés)
 *   FINDING     PRIMARY_LINK_PENDING (traitement T3 / T1 en file ou en cours)
 *               · PRIMARY_LINK_TREATMENT_FAILED (échec technique : Supervision,
 *               jamais une question métier) · PRIMARY_LINK_NO_KNOWLEDGE
 *               (aucune connaissance T1 persistée)
 *
 * JUGER / RÉPARER = T3 : l'inspection reconstruit le contexte DOCUMENT_ASSET
 * (connaissance persistée, Candidate Builder, graphe d'identité) et rejoue
 * les SEULES règles déterministes — jamais d'appel IA à la lecture. La
 * réparation remet le document dans la file durable T3 DOCUMENT_ASSET
 * (`requestDocumentAssetResolution`, réparation « en attente » close au
 * contrôle suivant) : aucun rapprochement parallèle, aucune écriture directe.
 * Déclencheurs : création / modification / suppression d'un bien (TOUS les
 * documents sans bien du compte, y compris sans aucun lien avec lui),
 * analyse, modification ou dépôt d'un document ; campagne quotidienne
 * exhaustive (comptes éligibles seulement, preuve par objet, aucun plafond).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows } from '../util';
import { OPEN_DOCUMENT_SQL } from './document-links';

/** Événements qui rendent TOUS les documents sans bien du compte potentiellement rattachables. */
const ACCOUNT_WIDE_EVENTS = new Set(['ASSET_CREATED', 'ASSET_UPDATED', 'ASSET_DELETED']);

/** Document sans bien principal (même définition que le balayage T3, alias `f`). */
const ORPHAN_SQL = `f.asset_id IS NULL AND f.linked_asset_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL
                    AND (l.link_role = 'PRIMARY' OR l.origin = 'USER'))`;

interface DocState {
  id: number; orphan: boolean; userDecided: boolean; draft: boolean; analysisState: string | null; hasExtraction: boolean;
  status: string | null; reasonCode: string | null; version: number | null; fingerprint: string | null; aiStatus: string | null;
  jobStatus: string | null; jobError: boolean; linkCard: boolean; groupCard: boolean;
}

async function states(sql: Parameters<NonNullable<CoherenceCheck['inspect']>>[0]['sql'], accountId: number, ids: readonly number[]): Promise<Map<number, DocState>> {
  const r = await rows(sql, `
    SELECT f.id, (${ORPHAN_SQL}) AS orphan,
           COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) AS user_decided,
           (COALESCE(f.is_draft, false) OR COALESCE(f.is_ignored, false)) AS draft, f.analysis_state,
           EXISTS (SELECT 1 FROM document_extractions e WHERE e.file_id = f.id AND e.account_id = f.account_id) AS has_extraction,
           r.status, r.reason_code, r.resolution_version, r.context_fingerprint, r.last_evaluation -> 'ai' ->> 'status' AS ai_status,
           (SELECT q.status FROM ai_job_queue q WHERE q.treatment = 'T3' AND q.target_type = 'document' AND q.target_id = f.id::text
             ORDER BY q.id DESC LIMIT 1) AS job_status,
           EXISTS (SELECT 1 FROM ai_job_queue q WHERE q.treatment = 'T3' AND q.target_type = 'document' AND q.target_id = f.id::text
                     AND q.status = 'FAILED' AND COALESCE(q.finished_at, q.created_at) > now() - interval '7 days'
                     AND NOT EXISTS (SELECT 1 FROM ai_job_queue q2 WHERE q2.treatment = 'T3' AND q2.target_type = 'document'
                                       AND q2.target_id = q.target_id AND q2.id > q.id)) AS job_error,
           EXISTS (SELECT 1 FROM to_process_actions a WHERE a.account_id = f.account_id AND a.target_type = 'DOCUMENT' AND a.target_id = f.id
                     AND a.rule_code = 'LINK-ASSET' AND a.resolved_at IS NULL) AS link_card,
           EXISTS (SELECT 1 FROM to_process_actions a WHERE a.account_id = f.account_id AND a.rule_code = 'LINK-ASSET-GROUP' AND a.resolved_at IS NULL
                     AND a.trigger_context -> 'memberFileIds' @> to_jsonb(f.id)) AS group_card
      FROM asset_files f
      LEFT JOIN document_asset_resolutions r ON r.file_id = f.id
     WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND ${OPEN_DOCUMENT_SQL}`, [accountId, intArray(ids)]);
  return new Map(r.map((x) => [Number(x.id), {
    id: Number(x.id), orphan: x.orphan === true, userDecided: x.user_decided === true, draft: x.draft === true,
    analysisState: (x.analysis_state as string | null) ?? null, hasExtraction: x.has_extraction === true,
    status: (x.status as string | null) ?? null, reasonCode: (x.reason_code as string | null) ?? null,
    version: x.resolution_version == null ? null : Number(x.resolution_version), fingerprint: (x.context_fingerprint as string | null) ?? null,
    aiStatus: (x.ai_status as string | null) ?? null, jobStatus: (x.job_status as string | null) ?? null, jobError: x.job_error === true,
    linkCard: x.link_card === true, groupCard: x.group_card === true,
  }]));
}

export const documentPrimaryLinkCheck: CoherenceCheck = {
  id: 'COH-DOC-PRIMARY-LINK',
  version: 1,
  status: 'ACTIVE',
  title: 'Rattachement principal récupérable des documents',
  domain: 'documents-liens',
  level: 'N3',
  objectType: 'document',
  scope: 'tous les documents visibles du compte ; examen détaillé des documents sans bien principal',
  sources: ['asset_files', 'document_asset_links', 'document_asset_resolutions', 'document_extractions', 'document_facts', 'ai_job_queue',
    'to_process_actions', 'document_identity_groups', 'document_identity_decisions', 'assets'],
  applicability: 'compte éligible (actif et modifiable) ; document visible, analysé, non brouillon / ignoré',
  invariant: 'un document sans bien principal a été examiné par T3 dans le contexte ACTUEL du compte, et rien de démontrable sans IA ne reste non rattaché ; sinon son état (identité à confirmer, décision utilisateur attendue, aucun candidat, traitement en attente ou en échec) est explicite',
  anomalies: ['PRIMARY_LINK_RECOVERABLE', 'PRIMARY_LINK_NOT_EXAMINED', 'PRIMARY_LINK_IDENTITY_TO_CONFIRM', 'PRIMARY_LINK_AWAITING_USER',
    'PRIMARY_LINK_NO_CANDIDATE', 'PRIMARY_LINK_REFUSED_BY_USER', 'PRIMARY_LINK_PENDING', 'PRIMARY_LINK_TREATMENT_FAILED', 'PRIMARY_LINK_NO_KNOWLEDGE'],
  autoRepairWhen: 'T3 rattacherait le document SANS IA dans le contexte actuel, ou le document n’a pas été examiné dans ce contexte : remise dans la file durable T3 DOCUMENT_ASSET (déterministe d’abord)',
  forbiddenRepairs: ['appeler l’IA depuis le contrôle', 'écrire un lien directement', 'attribuer un document au seul bien du compte, à un nom générique, à une catégorie ou à un fournisseur',
    'remplacer un rattachement de l’utilisateur', 'créer une question métier pour une panne technique'],
  services: ['ai/reconciliation/document-asset/queue#requestDocumentAssetResolution', 'ai/reconciliation/document-asset/context#computeDocumentAssetContext'],
  chain: ['T1', 'T3', 'LINK', 'TO_PROCESS'],
  triggers: ['ASSET_CREATED', 'ASSET_UPDATED', 'ASSET_DELETED', 'SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque création / modification de bien et de document',
  criticality: 'HIGH',
  tests: ['L105D-U-COH', 'L105D-E2E-G1', 'L105D-E2E-G2'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `
      SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id > $2 AND ${OPEN_DOCUMENT_SQL} ORDER BY f.id LIMIT $3`,
    [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (ACCOUNT_WIDE_EVENTS.has(e.type) || e.type === 'SOURCE_ANALYZED') {
      // Nouveau bien (ou bien modifié / supprimé, nouvelle analyse) : TOUS les documents historiquement sans bien
      // du compte, y compris ceux qui n'ont encore aucun lien avec ce bien — plus le document analysé lui-même.
      return idsOf(await rows(ctx.sql, `
        SELECT f.id FROM asset_files f
         WHERE f.account_id = $1 AND ${OPEN_DOCUMENT_SQL}
           AND (${ORPHAN_SQL} OR f.id = $2)
         ORDER BY f.id`, [accountId, e.entityId ?? 0]));
    }
    if (e.entityId == null) return [];
    return idsOf(await rows(ctx.sql, `SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id = $2`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const etats = await states(ctx.sql, accountId, ids);
    const orphelins = [...etats.values()].filter((s) => s.orphan && !s.userDecided && !s.draft);
    // Contexte T3 reconstruit (lecture seule, aucune IA) : un index et un graphe pour tout le lot.
    let index: import('@/services/ai/reconciliation/document-asset/matching-index').AccountMatchingIndex | null = null;
    let graph: import('@/services/ai/reconciliation/document-asset/identity/graph').AccountIdentityGraph | null = null;
    if (orphelins.length) {
      const [{ loadAccountMatchingIndex }, { identityGraphFor }] = await Promise.all([
        import('@/services/ai/reconciliation/document-asset/matching-index'), import('@/services/ai/reconciliation/document-asset/identity/load'),
      ]);
      index = await loadAccountMatchingIndex(accountId);
      graph = await identityGraphFor(accountId, index);
    }
    const { DOCUMENT_ASSET_RESOLUTION_VERSION } = await import('@/services/ai/reconciliation/document-asset/version');
    for (const id of ids) {
      const s = etats.get(id);
      if (!s) { out.set(id, { verdict: 'GONE' }); continue; }
      if (!s.orphan) { out.set(id, { verdict: 'CONSISTENT', detail: { state: 'PRIMARY_PRESENT' } }); continue; }
      if (s.userDecided || s.draft || s.status === 'USER_DECIDED') {
        out.set(id, { verdict: 'CONSISTENT', detail: { state: 'ORPHAN_NORMAL', reason: s.draft ? 'DRAFT_OR_IGNORED' : 'USER_DECISION' } });
        continue;
      }
      const constat = (verdict: Inspection['verdict'], anomaly: string, detail: Record<string, unknown> = {}): Inspection => ({
        verdict, anomaly, faultyLink: anomaly === 'PRIMARY_LINK_NO_KNOWLEDGE' ? 'T1' : anomaly.includes('AWAITING') || anomaly.includes('TO_CONFIRM') ? 'TO_PROCESS' : 'T3',
        detail: { state: anomaly, resolution: s.status, reasonCode: s.reasonCode, ...detail },
        inputHash: hashOf({ id, anomaly, status: s.status, fp: s.fingerprint, v: s.version, ...detail }),
      });
      if (!s.hasExtraction) {
        out.set(id, constat('FINDING', s.analysisState && !['ANALYZED', 'FAILED', 'VALIDATION_REQUIRED'].includes(s.analysisState) ? 'PRIMARY_LINK_PENDING' : 'PRIMARY_LINK_NO_KNOWLEDGE', { analysisState: s.analysisState }));
        continue;
      }
      if (s.jobStatus === 'PENDING' || s.jobStatus === 'RUNNING' || s.status === 'PENDING') {
        out.set(id, constat('FINDING', 'PRIMARY_LINK_PENDING', { jobStatus: s.jobStatus }));
        continue;
      }
      if (s.jobError || s.reasonCode === 'AI_UNAVAILABLE' || s.aiStatus === 'ERROR') {
        out.set(id, constat('FINDING', 'PRIMARY_LINK_TREATMENT_FAILED', { jobStatus: s.jobStatus, aiStatus: s.aiStatus }));
        continue;
      }
      // Contexte ACTUEL : règles déterministes de T3 rejouées (aucune IA).
      const [{ readAttachmentState }, { computeDocumentAssetContext }, { getResolution }, dec, idd] = await Promise.all([
        import('@/services/ai/reconciliation/document-asset/attachment-state'),
        import('@/services/ai/reconciliation/document-asset/context'),
        import('@/services/ai/reconciliation/document-asset/resolution.repository'),
        import('@/services/ai/reconciliation/document-asset/decision'),
        import('@/services/ai/reconciliation/document-asset/identity/decision'),
      ]);
      const etat = await readAttachmentState(accountId, id);
      const resolution = await getResolution(id);
      const c = await computeDocumentAssetContext({ accountId, fileId: id, state: etat, resolution, index: index!, identityGraph: graph });
      const d = dec.decideDeterministic(c.identification, { multiAssetDeclared: c.multiAssetDeclared })
        ?? dec.decideContextualDeterministic(c.candidates, c.identification, { multiAssetDeclared: c.multiAssetDeclared })
        ?? idd.decideFromIdentity(c.identity ?? null, c.candidates, { multiAssetDeclared: c.multiAssetDeclared, identifiedAssetIds: c.identification.assetIds });
      const groupe = c.identity?.group ? { groupKey: c.identity.group.groupKey, groupStatus: c.identity.group.status, via: c.identity.member?.via ?? null } : {};
      if (d && d.kind !== 'ABSTAIN') {
        out.set(id, constat('REPAIRABLE', 'PRIMARY_LINK_RECOVERABLE', {
          expectedAssetIds: d.kind === 'APPLY' ? [d.assetId] : d.assetIds, rule: d.reason.slice(0, 80), ...groupe,
        }));
        continue;
      }
      if (!resolution || resolution.resolutionVersion !== DOCUMENT_ASSET_RESOLUTION_VERSION || resolution.contextFingerprint !== c.fingerprint) {
        out.set(id, constat('REPAIRABLE', 'PRIMARY_LINK_NOT_EXAMINED', {
          lastVersion: resolution?.resolutionVersion ?? null, currentVersion: DOCUMENT_ASSET_RESOLUTION_VERSION, contextChanged: !!resolution?.contextFingerprint, ...groupe,
        }));
        continue;
      }
      if (c.identity?.group?.status === 'TO_CONFIRM' && c.identity.member) {
        out.set(id, constat('AMBIGUOUS', 'PRIMARY_LINK_IDENTITY_TO_CONFIRM', { cardOpen: s.groupCard, cardEligible: c.identity.group.cardEligible, ...groupe }));
        continue;
      }
      if (s.reasonCode === 'GROUP_REFUSED') { out.set(id, constat('AMBIGUOUS', 'PRIMARY_LINK_REFUSED_BY_USER', groupe)); continue; }
      if (s.linkCard) { out.set(id, constat('AMBIGUOUS', 'PRIMARY_LINK_AWAITING_USER', { candidates: c.candidates.length, ...groupe })); continue; }
      out.set(id, constat('AMBIGUOUS', 'PRIMARY_LINK_NO_CANDIDATE', { candidates: c.candidates.length, ...groupe }));
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { requestDocumentAssetResolution } = await import('@/services/ai/reconciliation/document-asset/queue');
    for (const { id, inspection } of items) {
      const jobId = await requestDocumentAssetResolution({
        accountId, userId: null, fileId: id, triggerCode: 'coherence', reprocessReason: inspection.anomaly === 'PRIMARY_LINK_RECOVERABLE' ? 'COHERENCE_RECOVERABLE' : 'COHERENCE_NOT_EXAMINED',
      });
      out.set(id, {
        called: true, service: 'requestDocumentAssetResolution', aiCalls: 0, pending: true, reevaluation: 'TECHNICAL_REBUILD',
        result: { jobId, anomaly: inspection.anomaly ?? null, correlationId: ctx.correlationId },
        rollbackRef: `document_asset_links:file=${id}:origin=AI`,
      });
    }
    return out;
  },
};
