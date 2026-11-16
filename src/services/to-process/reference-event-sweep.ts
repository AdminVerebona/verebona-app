/**
 * BALAYAGE DES ÉVÉNEMENTS DE RÉFÉRENCE — le passage qui POSE les trois
 * questions du CDC §8 (carte Trello #744, CDC « Opérations / Agenda V2.0 » §6,
 * §7, §8, §16, §20 ; AC04, AC09 à AC12, AC16, AC17, AC20 ; décision du PO du
 * 16/11/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI MANQUAIT
 *
 * Les trois producteurs de cartes (« rattachement à confirmer », « doublon à
 * confirmer », « date à confirmer ») existaient et étaient prouvés, mais
 * AUCUN passage ne les appelait : les questions ne se posaient jamais toutes
 * seules. C'est ce passage. Il est branché comme la carte d'arbitrage d'une
 * association : SIXIÈME FAMILLE du balayage « À traiter » horaire
 * (`producers.service.ts › produceAccountActions`), un compte à la fois.
 *
 * IL NE DÉCIDE RIEN, IL N'ÉCRIT RIEN
 *   · il DÉTECTE des situations déjà en base, par les règles qui existent
 *     déjà (jamais une règle métier nouvelle, jamais un score) ;
 *   · il appelle les passerelles d'inférence
 *     (`graph/agenda-link-proposal.ts`, `graph/merge-proposal.ts`), qui ne
 *     savent que DEMANDER ;
 *   · la réponse de l'utilisateur est appliquée par la FAÇADE d'écriture
 *     seule. Ce fichier n'écrit aucune relation, aucun lien, aucune date.
 *
 * LES TROIS DÉTECTEURS, ET D'OÙ VIENT LEUR RÈGLE
 *   1. RATTACHEMENT (`AGENDA-LINK`) — `agendaLinkCandidates`, c'est-à-dire la
 *      règle de preuve du PO elle-même (un JUSTIFICATIF COMMUN), énumérée dans
 *      l'autre sens. Aucune heuristique de bien, de date, de fournisseur, de
 *      montant ni de score (contrôlé par un test).
 *   2. DOUBLON (`REFERENCE-EVENT-MERGE`) — le VERDICT que le rapprochement
 *      sémantique de T3 (M3) a DÉJÀ rendu et enregistré sur le candidat
 *      (`document_operation_candidates.t3_detail.m3`), lu avec la règle
 *      existante `m3Resolution`. Aucun appel d'IA n'est ajouté ici : ce
 *      passage lit une décision déjà prise. Le modèle dit « c'est la même
 *      réalité » et les deux événements de référence sont pourtant toujours
 *      vivants : la fusion automatique ne s'est pas faite (AC12), donc on
 *      DEMANDE.
 *   3. FAIT CONTRADICTOIRE (`REFERENCE-EVENT-FACT`) —
 *      `factContradictionCandidates` : deux événements de référence ASSOCIÉS
 *      portent deux valeurs différentes pour le même fait daté. Un constat,
 *      jamais un jugement.
 *
 * AC20 — ABSTENTION TRACÉE
 * Quand la trace M3 dit que l'IA était INDISPONIBLE (prompt absent, plafond de
 * coût, fournisseur bloqué), qu'elle a ÉCHOUÉ, ou qu'elle a REFUSÉ DE TRANCHER
 * (issue `ARBITRATE`), ce passage n'invente rien et ne pose AUCUNE carte : il
 * écrit une ligne d'abstention au journal du graphe
 * (`recordAiAbstention` : action `NO_CHANGE`, motif `ABSTAIN_…`), une seule
 * fois par situation, et le cas reste en attente d'une reprise.
 *
 * BORNES ET REPRISE : tout est borné au compte et à un nombre de situations
 * par passage ; l'ordre est stable ; un cas non servi revient au passage
 * suivant. Rejoué, le passage ne crée aucun doublon (une carte par couple,
 * jamais reposée après réponse : garanties des producteurs) et ne réécrit
 * aucune abstention.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { postgresRunner } from '@/services/business-operations/grouping/runner';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';
import type { StoredM3 } from '@/services/business-operations/consolidation/m3-context';
import { AGENDA_LINK_RULE, agendaLinkCandidates } from './operation-agenda-link-cards';
import {
  REFERENCE_EVENT_FACT_RULE, REFERENCE_EVENT_MERGE_RULE, factContradictionCandidates,
} from './operation-merge-cards';
import type { ScanErrorDetail } from './producers.service';

type Row = Record<string, unknown>;

/** Règles produites par ce passage (les trois questions du CDC §8 posées automatiquement). */
export const SWEEP_RULES = [AGENDA_LINK_RULE, REFERENCE_EVENT_MERGE_RULE, REFERENCE_EVENT_FACT_RULE] as const;

/** Candidats de doublon examinés au plus par passage et par compte. */
export const MERGE_CANDIDATES_PER_PASS = 20;

/**
 * Motif d'abstention selon le statut de la trace M3 enregistrée par T3
 * (vocabulaire de `StoredM3` : aucune valeur inventée ici).
 */
export const ABSTENTION_REASONS: Readonly<Record<string, string>> = {
  PROMPT_UNAVAILABLE: 'ABSTAIN_AI_PROMPT_UNAVAILABLE',
  ERROR: 'ABSTAIN_AI_FAILED',
  TOO_MANY_CANDIDATES: 'ABSTAIN_AI_CONTEXT_TRUNCATED',
};
/** L'IA a répondu, mais sans trancher (issue `ARBITRATE` de la règle existante `m3Resolution`). */
export const ABSTENTION_DECLINED = 'ABSTAIN_AI_DECLINED';
/** Le fournisseur d'IA n'était pas joignable pour ce compte (plafond de coût atteint, traitement arrêté). */
export const ABSTENTION_UNAVAILABLE = 'ABSTAIN_AI_UNAVAILABLE';
/**
 * Report qui vaut INDISPONIBILITÉ (motifs posés par la phase M3 : plafond de
 * coût du compte atteint, traitement IA arrêté). Un report de simple plafond
 * d'appels par passage ou par jour n'est PAS une abstention : aucune décision
 * n'était encore attendue, et la reprise est déjà datée sur le candidat.
 */
export const DEFERRED_UNAVAILABLE: ReadonlySet<string> = new Set(['COST_CAP_REACHED', 'AI_BLOCKED']);

export interface ReferenceEventSweepReport {
  created: number;
  updated: number;
  closed: number;
  /** Situations examinées (couples, paires, candidats) — diagnostic du passage. */
  examined: number;
  /** Lignes d'abstention écrites au journal du graphe (AC20). */
  abstentions: number;
  errorDetails?: ScanErrorDetail[];
}

const json = <T>(v: unknown): T | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return null; }
};

/**
 * Acteur du passage : une REPRISE DÉTERMINISTE (CDC §20). Ce n'est pas
 * l'utilisateur (son geste écrit directement) et ce n'est pas un appel d'IA :
 * ce passage ne fait que relire la base et poser des questions.
 */
const sweepContext = (accountId: number): OperationWriteContext => ({
  accountId, actor: { kind: 'SYSTEM', reason: 'TO_PROCESS_SCAN' }, correlationId: 'to-process-scan:reference-events',
});

/** Candidat de doublon, tel que la trace M3 de T3 le désigne (aucune relecture du modèle). */
interface MergeCandidateRow { candidateId: number; fileId: number; ownOperationId: number; m3: StoredM3 | null }

/**
 * Candidats de DOUBLON du compte : documents dont le candidat T1 porte un
 * verdict M3 enregistré, et l'événement de référence qui tient ce document
 * comme source active. Lecture seule, bornée au compte, ordre stable.
 */
async function mergeCandidates(accountId: number, limit = MERGE_CANDIDATES_PER_PASS): Promise<MergeCandidateRow[]> {
  const r = (await pgClient.unsafe(
    `SELECT c.id AS cid, c.file_id AS file, c.t3_detail->'m3' AS m3, s.operation_id AS own
       FROM document_operation_candidates c
       JOIN asset_files f ON f.id = c.file_id AND f.account_id = c.account_id AND f.deleted_at IS NULL
       JOIN business_operation_sources s ON s.account_id = c.account_id AND s.active AND s.source_kind = 'DOCUMENT'
        AND s.source_entity_key = c.file_id::text AND s.locator->>'candidateKey' = c.candidate_key
       JOIN business_operations o ON o.id = s.operation_id AND o.account_id = c.account_id
        AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
      WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND c.t3_detail ? 'm3'
      ORDER BY c.id, s.operation_id
      LIMIT $2`,
    [accountId, Math.max(1, Math.floor(limit))] as never[],
  )) as unknown as Row[];
  return r.map((x) => ({
    candidateId: Number(x.cid), fileId: Number(x.file), ownOperationId: Number(x.own), m3: json<StoredM3>(x.m3),
  }));
}

/**
 * Motif d'abstention d'une trace M3 (pure) : `null` quand il n'y a rien à
 * tracer (verdict rendu et tranché, ou report de simple plafond d'appels).
 */
export function abstentionReasonOf(m3: Pick<StoredM3, 'status' | 'detail'> | null, declined: boolean): string | null {
  if (!m3) return null;
  if (m3.status === 'DONE') return declined ? ABSTENTION_DECLINED : null;
  if (m3.status === 'DEFERRED') return m3.detail !== undefined && DEFERRED_UNAVAILABLE.has(m3.detail) ? ABSTENTION_UNAVAILABLE : null;
  return ABSTENTION_REASONS[m3.status] ?? null;
}

/** Empreinte de la situation tracée (pure, bornée) : une abstention par contexte évalué et par issue. */
export const abstentionSituation = (m3: Pick<StoredM3, 'status' | 'fingerprint' | 'detail'>, reason: string): string =>
  `m3:${(m3.fingerprint ?? '').slice(0, 64)}:${m3.status}:${(m3.detail ?? '').slice(0, 24)}:${reason}`.slice(0, 180);

/**
 * Balaye les trois questions des événements de référence pour UN compte.
 * Ne lève jamais pour un cas isolé : chaque situation manquée est comptée
 * (bilan du balayage, BO › Exploitation) et redemandée au passage suivant.
 */
export async function produceReferenceEventActions(accountId: number): Promise<ReferenceEventSweepReport> {
  const out: ReferenceEventSweepReport = { created: 0, updated: 0, closed: 0, examined: 0, abstentions: 0, errorDetails: [] };
  const noter = (ruleCode: string, cause: string, targetType?: string, targetId?: number) => {
    out.errorDetails!.push({
      accountId, fileId: null, ruleCode, step: 'PRODUCE', kind: 'EVALUATION_FAILED', cause: cause.slice(0, 300),
      ...(targetType ? { targetType } : {}), ...(targetId !== undefined ? { targetId } : {}),
    });
  };
  const compter = (status: string) => {
    if (status === 'POSTED') out.created += 1;
    else if (status === 'UPDATED') out.updated += 1;
  };

  // ── 1. Rattachement d'Agenda supplémentaire proposé sur un justificatif commun ──
  try {
    const { proposeExtraAgendaLink } = await import('@/services/business-operations/graph/agenda-link-proposal');
    for (const c of await agendaLinkCandidates(accountId)) {
      out.examined += 1;
      const r = await proposeExtraAgendaLink(sweepContext(accountId), {
        operationId: c.operationId, agendaItemId: c.agendaItemId,
        evidence: c.fileIds.map((f) => ({ kind: 'DOCUMENT' as const, ref: String(f) })),
      });
      if (r.proposal?.status === 'FAILED') noter(AGENDA_LINK_RULE, 'proposition non posée', 'AGENDA_ITEM', c.agendaItemId);
      else compter(r.proposal?.status ?? '');
    }
  } catch (e) {
    noter(AGENDA_LINK_RULE, (e as Error).message);
  }

  // ── 2. Doublon probable : le verdict M3 déjà rendu par T3, ou une ABSTENTION tracée (AC20) ──
  try {
    const [{ proposeReferenceEventMerge }, { m3Resolution }] = await Promise.all([
      import('@/services/business-operations/graph/merge-proposal'),
      import('@/services/ai/reconciliation/master/operation-match'),
    ]);
    const runner = postgresRunner(pgClient as unknown as { unsafe: (t: string, p?: never[]) => Promise<unknown> });
    const { recordAiAbstention } = await import('@/services/business-operations/graph/store');
    for (const c of await mergeCandidates(accountId)) {
      out.examined += 1;
      const m3 = c.m3;
      if (!m3 || typeof m3.status !== 'string') continue;
      const verdict = m3.status === 'DONE' ? m3.verdict : undefined;
      const issue = verdict ? m3Resolution(verdict) : null;
      const autre = issue === 'ATTACH' ? verdict?.matchedOperationId ?? null : null;
      const motif = abstentionReasonOf(m3, issue === 'ARBITRATE');
      if (motif) {
        // L'IA n'a pas tranché : RIEN n'est proposé, rien n'est inventé — une trace, une seule fois.
        const ecrite = await recordAiAbstention(runner, accountId, {
          relationKind: 'OPERATION', operationId: c.ownOperationId, fileId: c.fileId,
          reasonCode: motif, situationHash: abstentionSituation(m3, motif),
          evidence: [{ kind: 'DOCUMENT', ref: String(c.fileId) }],
          detail: { m3Status: m3.status, promptVersion: m3.promptVersion ?? null, ...(m3.detail ? { m3Detail: m3.detail } : {}) },
          correlationId: 'to-process-scan:reference-events',
        }).catch((e: Error) => { noter(REFERENCE_EVENT_MERGE_RULE, `abstention non tracée : ${e.message}`); return false; });
        if (ecrite) out.abstentions += 1;
        continue;
      }
      if (autre === null || autre === c.ownOperationId) continue;
      const r = await proposeReferenceEventMerge(sweepContext(accountId), {
        operationAId: c.ownOperationId, operationBId: autre,
        evidence: [{ kind: 'DOCUMENT', ref: String(c.fileId) }],
      });
      if (r.card?.status === 'FAILED') noter(REFERENCE_EVENT_MERGE_RULE, 'question de fusion non posée', 'DOCUMENT', c.fileId);
      else compter(r.card?.status ?? '');
    }
  } catch (e) {
    noter(REFERENCE_EVENT_MERGE_RULE, (e as Error).message);
  }

  // ── 3. Fait contradictoire entre deux événements de référence ASSOCIÉS ──
  try {
    const { proposeReferenceEventFact } = await import('@/services/business-operations/graph/merge-proposal');
    for (const c of await factContradictionCandidates(accountId)) {
      out.examined += 1;
      const r = await proposeReferenceEventFact(sweepContext(accountId), {
        operationAId: c.operationAId, operationBId: c.operationBId, field: c.field,
      });
      if (r.card?.status === 'FAILED') noter(REFERENCE_EVENT_FACT_RULE, 'question du fait non posée');
      else compter(r.card?.status ?? '');
    }
  } catch (e) {
    noter(REFERENCE_EVENT_FACT_RULE, (e as Error).message);
  }

  // ── 4. Cartes PÉRIMÉES : fermées « sans objet », rien n'est appliqué (AC18) ──
  try {
    out.closed += await closeStaleSweepCards(accountId);
  } catch (e) {
    noter('*', `fermeture des cartes sans objet : ${(e as Error).message}`);
  }
  return out;
}

/**
 * Ferme « sans objet » les cartes des trois règles dont la prémisse n'existe
 * plus (rattachement fait entre-temps, événement de référence retiré, fusion
 * déjà appliquée, contradiction levée) — MÊME service de fermeture que le
 * contrôle de publiabilité (`closeCardsNoLongerUseful`), jamais une règle
 * dupliquée : la prémisse de chaque règle est déclarée une seule fois
 * (`publishability.ts › noLongerUseful`).
 */
export async function closeStaleSweepCards(accountId: number): Promise<number> {
  const r = (await pgClient.unsafe(
    `SELECT id FROM to_process_actions
      WHERE account_id = $1 AND resolved_at IS NULL AND rule_code = ANY($2::text[]) ORDER BY id LIMIT 200`,
    [accountId, `{${SWEEP_RULES.join(',')}}`] as never[],
  )) as unknown as Row[];
  const ids = r.map((x) => Number(x.id));
  if (!ids.length) return 0;
  const { closeCardsNoLongerUseful } = await import('./publishability');
  return (await closeCardsNoLongerUseful(accountId, ids, { runRef: 'to-process-scan:reference-events' })).length;
}
