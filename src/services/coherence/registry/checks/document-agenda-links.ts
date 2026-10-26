/**
 * COH-DOC-AGENDA-LINKS — associations Document ↔ Agenda confrontées à leurs
 * PREUVES (lot 86D — ticket P1 « Documents / Agenda — associations erronées
 * et gestion bidirectionnelle », §3 à §7 ; CDC cohérence §4.3 et complément
 * du 23/10 ; CDC v5 §7 ; arbitrages C-Q2, C-Q6, C-Q10, C-Q11, V-Q5).
 *
 * Objet contrôlé : l'ASSOCIATION elle-même (`agenda_file_links.id`) — et non
 * la seule validité du document ou de l'élément (§6). Périmètre : liens du
 * compte portant au moins une provenance AUTOMATIQUE (AI_DIRECT,
 * OPERATION_PRINCIPAL) et aucune provenance MANUAL_DIRECT — un lien posé par
 * l'utilisateur n'est jamais examiné pour être retiré (§5). Stock historique
 * compris (campagne quotidienne exhaustive), futurs liens au fil de l'eau
 * (contrôle ciblé sur l'élément, l'ensemble ou le document).
 *
 *   · inspection (lecture seule, sans IA) : instantané des preuves du lien
 *     puis `evaluateLinkRelevance` (pur, `grouping/link-relevance.ts`) —
 *     appartenance du document à l'ensemble ACTIF de l'élément, rôle
 *     d'événement de référence, refus de propagation, détachement de
 *     l'utilisateur, traces de production propres au couple, origine de
 *     l'élément automatique, règle de projection. Jamais une preuve : même
 *     bien, proximité de dates, intitulé ;
 *   · REPAIRABLE (`AUTOMATIC_LINK_UNJUSTIFIED`) : provenance(s) automatique(s)
 *     démontrée(s) infondée(s) → `withdrawAutomaticLinkProvenances` (service
 *     unique de regroupement, écriture de regroupement du compte, constat
 *     RELU sous verrou) : provenance retirée, lien supprimé s'il ne reste
 *     aucune justification, propagation recalculée, document / élément /
 *     autres liens intacts, correction tracée (historique de l'ensemble +
 *     journal de cohérence, preuves comprises). Recontrôle par le moteur. La
 *     même erreur ne revient pas : une provenance automatique n'est reposée
 *     que par une NOUVELLE preuve (appartenance, trace, origine) ; un lien
 *     détaché par l'utilisateur ne la reçoit plus jamais (garde 0736) ;
 *   · AMBIGUOUS (`AUTOMATIC_LINK_UNPROVEN`) : aucune preuve propre ni règle —
 *     AUCUNE écriture, aucune sollicitation de l'utilisateur ; contrat IA de
 *     pertinence demandé (`86D-t4-pertinence-lien-document-agenda`, non
 *     disponible : constat qualifié dans le diagnostic) ;
 *   · FINDING (`CROSS_ACCOUNT_LINK`) : sécurité — règles et contrôle
 *     intercomptes existants, jamais une réparation ici.
 */
import { evaluateLinkRelevance, LINK_RELEVANCE_AI_CONTRACT, type LinkEvidenceSnapshot } from '@/services/business-operations/grouping/link-relevance';
import { intArray as pgIntArray, postgresRunner, type GroupingRunner } from '@/services/business-operations/grouping/runner';
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, rows, type Row } from '../util';

const OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';
const ITEM_EVENTS = new Set(['AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED']);
const FILE_EVENTS = new Set(['DOCUMENT_UPDATED', 'DOCUMENT_DELETED', 'DOCUMENT_UPLOADED', 'SOURCE_ANALYZED']);

/** Liens du périmètre : au moins une provenance automatique, aucune provenance de l'utilisateur. */
const PERIMETRE_SQL = `
  i.account_id = $1
  AND (l.provenances && ARRAY['AI_DIRECT', 'OPERATION_PRINCIPAL']::text[])
  AND NOT ('MANUAL_DIRECT' = ANY(l.provenances))`;

async function liens(ctx: CheckContext, accountId: number, extra: string, params: unknown[]): Promise<number[]> {
  return idsOf(await rows(ctx.sql, `
    SELECT l.id FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id
     WHERE ${PERIMETRE_SQL} ${extra}
     ORDER BY l.id`, [accountId, ...params]));
}

/** Instantanés de preuves des liens demandés (lecture seule ; liens absents du compte : non rendus). */
async function loadLinkEvidence(r: GroupingRunner, accountId: number, linkIds: readonly number[]): Promise<LinkEvidenceSnapshot[]> {
  if (!linkIds.length) return [];
  const x = await r.q<Row>(`
    SELECT l.id, l.agenda_item_id AS item_id, l.asset_file_id AS file_id, l.provenances,
           i.account_id AS item_account, f.account_id AS file_account, (f.deleted_at IS NOT NULL) AS file_deleted,
           (i.projection_origin IS NOT NULL) AS projected, i.operation_role AS role,
           CASE WHEN o.id IS NOT NULL AND o.account_id = i.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
                THEN o.id END AS op,
           EXISTS (SELECT 1 FROM business_operation_documents d
                    WHERE d.operation_id = i.business_operation_id AND d.account_id = i.account_id AND d.file_id = l.asset_file_id AND d.active) AS member,
           EXISTS (SELECT 1 FROM business_operation_match_decisions m
                    WHERE m.account_id = i.account_id AND m.candidate_operation_id = i.business_operation_id AND m.source_kind = 'PRINCIPAL_LINK'
                      AND m.source_entity_key = l.asset_file_id::text AND m.decision = 'REJECTED' AND m.active) AS propagation_refused,
           EXISTS (SELECT 1 FROM business_operation_match_decisions m
                    WHERE m.account_id = i.account_id AND m.candidate_operation_id IS NULL AND m.source_kind = 'AGENDA_FILE_LINK'
                      AND m.source_entity_key = l.agenda_item_id::text || ':' || l.asset_file_id::text AND m.decision = 'REJECTED' AND m.active) AS detached,
           COALESCE((SELECT array_agg(DISTINCT s.effect_type || ':' || COALESCE(s.source_role, '')) FROM agenda_item_sources s
                      WHERE s.agenda_item_id = l.agenda_item_id AND s.asset_file_id = l.asset_file_id
                        AND s.effect_type IN ('created', 'resolved_existing', 'linked')), '{}') AS traces,
           (i.is_automatic AND i.origin_ref_type = 'asset_file' AND i.origin_ref_id = l.asset_file_id) AS origin_ref
      FROM agenda_file_links l
      JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = $1
      LEFT JOIN asset_files f ON f.id = l.asset_file_id
      LEFT JOIN business_operations o ON o.id = i.business_operation_id
     WHERE l.id = ANY($2::int[])
     ORDER BY l.id`, [accountId, pgIntArray(linkIds)]);
  return x.map((y: Row) => ({
    linkId: Number(y.id), itemId: Number(y.item_id), fileId: Number(y.file_id), provenances: (y.provenances as string[] | null) ?? [],
    itemAccountId: Number(y.item_account), fileAccountId: y.file_account == null ? null : Number(y.file_account), fileDeleted: y.file_deleted === true,
    itemProjected: y.projected === true, operationId: y.op == null ? null : Number(y.op), role: (y.role as 'PRINCIPAL' | 'RELATED' | null) ?? null,
    fileMember: y.member === true, propagationRefused: y.propagation_refused === true, userDetached: y.detached === true,
    productionTraces: ((y.traces as string[] | null) ?? []).slice().sort(), originRef: y.origin_ref === true,
  }));
}

/** Inspection d'un instantané (pure : réutilisée par la réparation, relue sous verrou). */
export function inspectLink(s: LinkEvidenceSnapshot): Inspection {
  const r = evaluateLinkRelevance(s);
  const preuves = {
    itemId: s.itemId, fileId: s.fileId, provenances: [...s.provenances].sort(), operationId: s.operationId, role: s.role,
    fileMember: s.fileMember, productionTraces: s.productionTraces, originRef: s.originRef, projected: s.itemProjected,
    userDetached: s.userDetached, propagationRefused: s.propagationRefused,
  };
  if (r.verdict === 'CONSISTENT') return { verdict: 'CONSISTENT' };
  const inputHash = hashOf({ v: 1, preuves, r: [r.unjustified, r.unproven] });
  if (r.verdict === 'FINDING') {
    return { verdict: 'FINDING', anomaly: 'CROSS_ACCOUNT_LINK', faultyLink: 'LINK', observed: preuves,
      detail: { ...preuves, why: 'lien entre deux comptes : contrôle intercomptes et règles de sécurité existants' }, inputHash };
  }
  if (r.verdict === 'REPAIRABLE') {
    return {
      verdict: 'REPAIRABLE', anomaly: 'AUTOMATIC_LINK_UNJUSTIFIED', faultyLink: 'LINK',
      expected: { provenances: [...s.provenances].filter((p) => !r.unjustified.some((u) => u.provenance === p)).sort() },
      observed: preuves,
      detail: { ...preuves, unjustified: r.unjustified, justified: r.justified, unproven: r.unproven },
      inputHash,
    };
  }
  return {
    verdict: 'AMBIGUOUS', anomaly: 'AUTOMATIC_LINK_UNPROVEN', faultyLink: 'LINK', observed: preuves,
    detail: { ...preuves, unproven: r.unproven, justified: r.justified, aiContract: LINK_RELEVANCE_AI_CONTRACT,
      why: 'aucune preuve propre au couple (trace de production, origine, appartenance projetée) : absence de preuve ≠ preuve contraire' },
    inputHash,
  };
}

export const documentAgendaLinksCheck: CoherenceCheck = {
  id: 'COH-DOC-AGENDA-LINKS',
  version: 1,
  status: 'ACTIVE',
  title: 'Associations Document ↔ Agenda : chaque lien automatique est fondé sur une preuve',
  domain: 'documents-liens',
  level: 'N2',
  objectType: 'agenda_file_link',
  scope: 'liens Document ↔ Agenda du compte portant une provenance automatique (AI_DIRECT, OPERATION_PRINCIPAL) et aucune provenance MANUAL_DIRECT',
  sources: ['agenda_file_links', 'agenda_items', 'asset_files', 'business_operations', 'business_operation_documents', 'business_operation_match_decisions', 'agenda_item_sources'],
  applicability: 'compte éligible (actif et modifiable) ; stock historique et nouveaux liens',
  invariant: 'une provenance automatique d’un lien Document ↔ Agenda n’existe que tant que sa preuve existe : événement de référence d’un ensemble actif dont le document est membre (OPERATION_PRINCIPAL) ; trace de production propre au couple, origine de l’élément ou document membre de l’ensemble projeté (AI_DIRECT) ; jamais sur un lien détaché par l’utilisateur. Le même bien ou une date proche ne sont jamais des preuves.',
  anomalies: ['AUTOMATIC_LINK_UNJUSTIFIED', 'AUTOMATIC_LINK_UNPROVEN', 'CROSS_ACCOUNT_LINK'],
  autoRepairWhen: 'provenance automatique démontrée infondée par une preuve contraire déterministe (relue sous le verrou du compte)',
  forbiddenRepairs: ['retirer une provenance MANUAL_DIRECT ou un lien posé par l’utilisateur', 'retirer un lien sans preuve contraire (lien non prouvé : constat)',
    'supprimer un document, un élément d’agenda ou une appartenance', 'retirer les autres liens du document ou de l’élément',
    'juger la pertinence par mots-clés, intitulé, bien commun ou proximité de dates', 'appeler l’IA depuis le contrôle',
    'écrire hors du service unique de regroupement', 'réparer un lien intercomptes (sécurité : contrôle dédié)'],
  services: ['business-operations/grouping/link-relevance#evaluateLinkRelevance', 'business-operations/grouping/service#withdrawAutomaticLinkProvenances',
    'business-operations/grouping/service#withGroupingWrite'],
  chain: ['T3', 'T4', 'LINK', 'PROJECTION'],
  triggers: [OPERATION_CHANGED, 'AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED', 'DOCUMENT_UPDATED', 'DOCUMENT_DELETED', 'SOURCE_ANALYZED'],
  frequency: 'campagne exhaustive quotidienne (stock compris) + contrôle ciblé à chaque écriture d’ensemble, d’élément d’agenda ou de document',
  criticality: 'HIGH',
  tests: ['L86D-U-01', 'L86D-U-02', 'L86D-U-03', 'L86D-E2E-05', 'L86D-E2E-06', 'L86D-E2E-07'],

  async listObjects(ctx, accountId, afterId, limit) {
    return (await liens(ctx, accountId, `AND l.id > $2`, [afterId])).slice(0, limit);
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (ITEM_EVENTS.has(e.type)) return liens(ctx, accountId, `AND l.agenda_item_id = $2`, [e.entityId]);
    if (FILE_EVENTS.has(e.type)) return liens(ctx, accountId, `AND l.asset_file_id = $2`, [e.entityId]);
    if (e.type === OPERATION_CHANGED) {
      return liens(ctx, accountId, `AND (i.business_operation_id = $2
        OR l.asset_file_id IN (SELECT d.file_id FROM business_operation_documents d WHERE d.operation_id = $2 AND d.account_id = $1))`, [e.entityId]);
    }
    return [];
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const instantanes = new Map((await loadLinkEvidence(postgresRunner(ctx.sql), accountId, ids)).map((s) => [s.linkId, s]));
    for (const id of ids) {
      const s = instantanes.get(id);
      out.set(id, s ? inspectLink(s) : { verdict: 'GONE' });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const { withGroupingWrite, withdrawAutomaticLinkProvenances } = await import('@/services/business-operations/grouping/service');
    const { lockGroupingAccount } = await import('@/services/business-operations/grouping/runner');
    for (const { id } of items) {
      const bilan = await withGroupingWrite(accountId, async (g) => {
        await lockGroupingAccount(g.runner, accountId);
        // Constat RELU sous le verrou du compte (état courant, même transaction).
        const [s] = await loadLinkEvidence(g.runner, accountId, [id]);
        if (!s) return { state: 'GONE' as const };
        const r = evaluateLinkRelevance(s);
        if (r.verdict !== 'REPAIRABLE') return { state: 'NO_LONGER_REPAIRABLE' as const, verdict: r.verdict };
        const res = await withdrawAutomaticLinkProvenances(g, {
          itemId: s.itemId, fileId: s.fileId, provenances: r.unjustified.map((u) => u.provenance),
          reasonCode: 'COHERENCE_AUTOMATIC_LINK_UNJUSTIFIED',
          evidence: { unjustified: r.unjustified, justified: r.justified, productionTraces: s.productionTraces, fileMember: s.fileMember, role: s.role },
        });
        return { state: 'WITHDRAWN' as const, itemId: s.itemId, fileId: s.fileId, ...res, unjustified: r.unjustified };
      }, { correlationId: ctx.correlationId });
      out.set(id, {
        called: true, service: 'withdrawAutomaticLinkProvenances', aiCalls: 0, result: bilan as Record<string, unknown>,
        rollbackRef: `business_operation_history:correlation_id=${ctx.correlationId}`,
      });
    }
    return out;
  },
};
