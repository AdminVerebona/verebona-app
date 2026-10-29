/**
 * COH-T1-KNOWLEDGE-CONSUMPTION — la connaissance T1 PERSISTÉE est-elle
 * réellement exploitée par T3 avant de conclure qu'une information manque ?
 * (lot 85F, ticket P1 §11, §12 ; arbitrages C-Q1, C-Q2, C-Q7).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ARTICULATION AVEC LES CONTRÔLES EXISTANTS (aucun doublon)
 *   · COH-DOC-EXTRACT-CHAIN (83B) : extract → T1 (valeur de l'extract absente
 *     de T1, relance du maillon T1). Ici : T1 → T3, la connaissance DÉJÀ
 *     persistée (faits, faits non intégrés, unités) — jamais l'extract brut,
 *     jamais une relance T1.
 *   · COH-TODO-DOCUMENT-FIELDS (82B) : carte dont la réponse est STRUCTURÉE
 *     dans T1, décision périmée. Ici : la connaissance NON structurée.
 *
 * Objet : un document du compte qui porte une carte documentaire ouverte
 * (règles du pont portant sur une donnée), une décision « interprétation en
 * attente », une interprétation T3 mémorisée, ou un candidat Opération
 * établi. Diagnostic (lecture seule, sans IA, mode à blanc compris) :
 *   · CARD_ASKS_KNOWN_INFORMATION   carte « À compléter » alors que T3 a
 *                                   compris la valeur dans la connaissance ;
 *   · KNOWLEDGE_NOT_EXPLOITED       interprétation mémorisée jamais prise en
 *                                   compte par la décision courante ;
 *   · FIELD_NOT_IN_T1_WITH_KNOWLEDGE  carte ouverte sur une donnée « absente »
 *                                   alors que de la connaissance non
 *                                   structurée n'a jamais été interprétée ;
 *   · KNOWLEDGE_NOT_INTERPRETED     décision « interprétation en attente » ;
 *   → RÉPARABLES quand la capacité IA est disponible : réexamen par la
 *     décision centrale (`resolveDocumentRuleFromKnowledge`) — compréhension,
 *     calcul déterministe, pertinence, fermeture des cartes devenues inutiles ;
 *   · INTERPRETATION_PENDING        capacité IA non livrée (constat, demande
 *                                   `85F-t3-comprehension-connaissance-t1`) ;
 *   · INTERPRETATION_INCOMPLETE / INTERPRETATION_FAILED  contexte au-delà
 *                                   des bornes, pannes répétées (constat) ;
 *   · PARTIALLY_STRUCTURED_UNIT     unité T1 COUVERTE dont une information a
 *                                   dû être comprise par T3 (constat T1,
 *                                   contrat `82B-t1-omissions-extract`) ;
 *   · OPERATION_CANDIDATE_WITHOUT_T1_EVIDENCE  candidat Opération établi
 *                                   dont une preuve n'est reliée à aucun fait
 *                                   T1 persisté actif (constat T1).
 *
 * Lot 98B (P0-D, version 2) — réponse T3 VALIDE mais INCOMPLÈTE : T3 a
 * analysé la connaissance et rendu des constituants (ex. une durée), mais
 * pas celui dont la DÉCISION de la carte déclare avoir besoin (trace
 * `missing_sources` « DECISION_GAP:<rôle> », ou, pour une décision
 * antérieure, la même règle pure `knowledgeGaps` appliquée à son calcul
 * tracé) — et la carte est maintenue. Aucune regex, aucune règle métier :
 * le code confronte le besoin DÉCLARÉ aux constituants RENDUS.
 *   · KNOWLEDGE_ANSWER_INCOMPLETE        RÉPARABLE : nouvelle demande T3
 *                                   ciblée (sémantique) par la décision
 *                                   centrale, budget et anti-boucle existants,
 *                                   au plus une fois par jour ;
 *   · KNOWLEDGE_ANSWER_STILL_INCOMPLETE  CONSTAT : demande ciblée déjà faite
 *                                   et exploitée, constituant toujours absent
 *                                   (texte du prompt T3, demande IA) — jamais
 *                                   CONSISTENT.
 *
 * Coût IA borné : budget du compte (`T3_KNOWLEDGE_QUERY_DAILY_MAX`), mémoire
 * des réponses (aucun rappel sur une entrée inchangée), empreinte des entrées
 * (anti-boucle du moteur) ; une connaissance non interprétée n'est réessayée
 * qu'une fois par jour (le jour entre dans l'empreinte).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ChainLink, CoherenceCheck, Inspection, RepairResult } from '../types';
import type { ConstituentRole } from '@/services/ai/reconciliation/knowledge-query/contract';
import type { SemanticResolution } from '@/services/ai/reconciliation/knowledge-query/service';
import { hashOf, idsOf, intArray, rows } from '../util';

const T1_KNOWLEDGE_CHECK_ID = 'COH-T1-KNOWLEDGE-CONSUMPTION';
/** Demandes de contrat IA dont dépendent les constats. */
const CONTRAT_T3 = '85F-t3-comprehension-connaissance-t1';
const CONTRAT_T1 = '82B-t1-omissions-extract';
/** Motifs de décision « interprétation en attente » (document-rule-bridge, lot 85F). */
const INTERPRETATION_PENDING_REASONS = ['INTERPRETATION_PENDING', 'INTERPRETATION_INCOMPLETE', 'KEPT_INTERPRETATION_PENDING', 'KEPT_INTERPRETATION_INCOMPLETE'];

const REPARABLES = new Set(['CARD_ASKS_KNOWN_INFORMATION', 'KNOWLEDGE_NOT_EXPLOITED', 'FIELD_NOT_IN_T1_WITH_KNOWLEDGE', 'KNOWLEDGE_NOT_INTERPRETED',
  'KNOWLEDGE_ANSWER_INCOMPLETE']);
const MAILLON: Record<string, ChainLink> = {
  CARD_ASKS_KNOWN_INFORMATION: 'TO_PROCESS', KNOWLEDGE_NOT_EXPLOITED: 'T3', FIELD_NOT_IN_T1_WITH_KNOWLEDGE: 'T3', KNOWLEDGE_NOT_INTERPRETED: 'T3',
  INTERPRETATION_PENDING: 'T3', INTERPRETATION_INCOMPLETE: 'T3', INTERPRETATION_FAILED: 'T3', PARTIALLY_STRUCTURED_UNIT: 'T1',
  OPERATION_CANDIDATE_WITHOUT_T1_EVIDENCE: 'T1', KNOWLEDGE_ANSWER_INCOMPLETE: 'T3', KNOWLEDGE_ANSWER_STILL_INCOMPLETE: 'T3',
};

/**
 * Lot 98B (P0-D) — besoins DÉCLARÉS par la dernière décision (pure) : motifs
 * `DECISION_GAP:<rôle>` de la trace, et — décision antérieure au lot 98B —
 * la même règle `knowledgeGaps` appliquée au calcul et aux propositions tracés.
 */
export function declaredDecisionGaps(ev: { missing_sources?: unknown; derivation?: unknown; proposals?: unknown } | null, knowledgeGaps: (p: {
  endDateNeed: { repaymentSchedule: boolean; endActions: readonly string[] } | null; readValue: boolean;
}) => string[], prefix: string): string[] {
  if (!ev) return [];
  const manquants = Array.isArray(ev.missing_sources) ? ev.missing_sources.map(String) : [];
  const declares = manquants.filter((m) => m.startsWith(prefix)).map((m) => m.slice(prefix.length));
  const d = (ev.derivation ?? null) as { endDateNeed?: { repaymentSchedule?: boolean; endActions?: string[] } | null } | null;
  const end = d?.endDateNeed && typeof d.endDateNeed.repaymentSchedule === 'boolean'
    ? { repaymentSchedule: d.endDateNeed.repaymentSchedule, endActions: Array.isArray(d.endDateNeed.endActions) ? d.endDateNeed.endActions : [] } : null;
  const lus = Array.isArray(ev.proposals) && ev.proposals.length > 0;
  return [...new Set([...declares, ...knowledgeGaps({ endDateNeed: end, readValue: lus })])].sort();
}

async function fieldRules(): Promise<Array<{ code: string; key: string; question: string }>> {
  const { documentBridgeRules } = await import('@/services/to-process/rules-catalog');
  return documentBridgeRules().filter((r) => !!r.fieldKey).map((r) => ({ code: r.code, key: r.fieldKey!, question: r.question }));
}

async function tableReady(sql: Parameters<typeof rows>[0], name: string): Promise<boolean> {
  const [r] = await rows(sql, `SELECT to_regclass($1) IS NOT NULL AS ok`, [name]);
  return r?.ok === true;
}

/** Candidats Opération établis dont une preuve n'est reliée à aucun fait T1 persisté actif (SQL partagé). */
const CANDIDAT_SANS_PREUVE_SQL = `
  c.status = 'ACTIVE' AND c.established AND c.payload ? 'evidenceFactIds'
  AND (jsonb_typeof(c.payload -> 'evidenceFactIds') <> 'array' OR jsonb_array_length(c.payload -> 'evidenceFactIds') = 0
       OR COALESCE((c.payload ->> 'unresolvedEvidence')::int, 0) > 0
       OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.payload -> 'evidenceFactIds') x(id)
                   WHERE NOT EXISTS (SELECT 1 FROM document_facts df WHERE df.id = x.id::bigint AND df.account_id = c.account_id AND df.status = 'active')))`;

/**
 * Documents CONCERNÉS du compte (SQL partagé : énumération et contrôle ciblé) — carte documentaire ouverte,
 * décision « interprétation en attente », interprétation mémorisée, candidat Opération sans preuve T1.
 * Paramètres : $1 compte, $2 borne (`filtre`), $3 règles, $4 motifs d'attente, $5 limite éventuelle.
 */
async function documentsConcernesSql(sql: Parameters<typeof rows>[0], filtre: string, limite: string): Promise<string> {
  const kq = await tableReady(sql, 't3_knowledge_queries');
  return `
    SELECT f.id FROM asset_files f
     WHERE f.account_id = $1 AND ${filtre} AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL AND (
       EXISTS (SELECT 1 FROM to_process_actions a WHERE a.account_id = f.account_id AND a.target_type = 'DOCUMENT' AND a.target_id = f.id
                AND a.resolved_at IS NULL AND a.rule_code = ANY($3::text[]))
       OR EXISTS (SELECT 1 FROM document_rule_evaluations e WHERE e.account_id = f.account_id AND e.file_id = f.id AND e.rule_code = ANY($3::text[])
                   AND e.reason_code = ANY($4::text[])
                   AND e.id = (SELECT max(x.id) FROM document_rule_evaluations x WHERE x.account_id = e.account_id AND x.file_id = e.file_id AND x.rule_code = e.rule_code))
       ${kq ? `OR EXISTS (SELECT 1 FROM t3_knowledge_queries k WHERE k.account_id = f.account_id AND k.file_id = f.id)` : ''}
       OR EXISTS (SELECT 1 FROM document_operation_candidates c WHERE c.account_id = f.account_id AND c.file_id = f.id AND ${CANDIDAT_SANS_PREUVE_SQL})
     )
     ORDER BY f.id ${limite}`;
}

interface RuleAnomaly { rule: string; code: string; memoId?: number | null; contextFingerprint?: string | null; detail?: Record<string, unknown> }

export const t1KnowledgeConsumptionCheck: CoherenceCheck = {
  id: T1_KNOWLEDGE_CHECK_ID,
  // Lot 98B (P0-D) : version 2 — réponse T3 valide mais incomplète détectée (réexamen du stock).
  version: 2,
  status: 'ACTIVE',
  title: 'Connaissance T1 persistée : exploitée par T3 avant de conclure qu’une information manque',
  domain: 'a-traiter',
  level: 'N3',
  objectType: 'document',
  scope: 'documents portant une carte documentaire ouverte, une décision « interprétation en attente », une interprétation T3 mémorisée ou un candidat Opération établi',
  sources: ['to_process_actions', 'document_rule_evaluations', 't3_knowledge_queries', 'document_facts', 'document_unresolved_facts', 'document_source_units',
    'business_operation_documents', 'document_operation_candidates'],
  applicability: 'compte éligible',
  invariant: 'une information n’est déclarée absente (FIELD_NOT_IN_T1) qu’après examen de toute la connaissance T1 persistée et interprétation sémantique de sa part non structurée ; une carte ne demande jamais une information comprise ou calculable',
  anomalies: ['CARD_ASKS_KNOWN_INFORMATION', 'KNOWLEDGE_NOT_EXPLOITED', 'FIELD_NOT_IN_T1_WITH_KNOWLEDGE', 'KNOWLEDGE_NOT_INTERPRETED', 'INTERPRETATION_PENDING',
    'INTERPRETATION_INCOMPLETE', 'INTERPRETATION_FAILED', 'PARTIALLY_STRUCTURED_UNIT', 'OPERATION_CANDIDATE_WITHOUT_T1_EVIDENCE',
    'KNOWLEDGE_ANSWER_INCOMPLETE', 'KNOWLEDGE_ANSWER_STILL_INCOMPLETE'],
  autoRepairWhen: 'capacité KNOWLEDGE_QUERY disponible : réexamen par la décision centrale existante (compréhension validée, calcul déterministe, pertinence, fermeture des cartes obsolètes), dans le budget IA du compte',
  forbiddenRepairs: ['écrire une valeur comprise sans le moteur de décision', 'conclure FIELD_NOT_IN_T1 sans interprétation de la connaissance non structurée',
    'relancer T1', 'écraser une valeur de l’utilisateur ou de l’administrateur', 'interpréter un texte par une règle lexicale'],
  services: ['to-process/document-rule-bridge#resolveDocumentRuleFromKnowledge', 'ai/reconciliation/knowledge-query/service#interpretT1Knowledge'],
  chain: ['T1', 'T3', 'PERSISTENCE', 'TO_PROCESS'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_DELETED'],
  frequency: 'campagne exhaustive quotidienne + contrôle ciblé à chaque changement',
  criticality: 'MEDIUM',
  tests: ['L85F-U-COH', 'L85F-E2E-COH-01', 'L85F-E2E-COH-02', 'L98B-U-GAPS', 'L98B-E2E-02'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, await documentsConcernesSql(ctx.sql, 'f.id > $2', 'LIMIT $5'),
      [accountId, afterId, (await fieldRules()).map((r) => r.code), INTERPRETATION_PENDING_REASONS, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    // Seulement un document concerné (même critère que l'énumération) : aucun contrôle ciblé inutile.
    return idsOf(await rows(ctx.sql, await documentsConcernesSql(ctx.sql, 'f.id = $2', ''),
      [accountId, e.entityId, (await fieldRules()).map((r) => r.code), INTERPRETATION_PENDING_REASONS]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const regles = await fieldRules();
    const { knowledgeQueryState, buildKnowledgeQuestion } = await import('@/services/ai/reconciliation/knowledge-query/service');
    const sk = await import('@/services/to-process/document-semantic-knowledge');
    const vivants = new Set(idsOf(await rows(ctx.sql, `
      SELECT id FROM asset_files WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL AND grouped_into_file_id IS NULL`, [accountId, intArray(ids)])));
    const cartes = await rows(ctx.sql, `
      SELECT id, target_id, rule_code, action_kind FROM to_process_actions
       WHERE account_id = $1 AND target_type = 'DOCUMENT' AND target_id = ANY($2::int[]) AND resolved_at IS NULL AND rule_code = ANY($3::text[])`,
    [accountId, intArray(ids), regles.map((r) => r.code)]);
    const evals = await rows(ctx.sql, `
      SELECT DISTINCT ON (file_id, rule_code) file_id, rule_code, reason_code, outcome, sources ->> 'T3_SEMANTIC_QUERY' AS query_id,
             sources ->> 'T3_SEMANTIC_FOLLOW_UP_QUERY' AS follow_up_id, missing_sources, derivation, proposals
        FROM document_rule_evaluations WHERE account_id = $1 AND file_id = ANY($2::int[]) AND rule_code = ANY($3::text[])
       ORDER BY file_id, rule_code, id DESC`, [accountId, intArray(ids), regles.map((r) => r.code)]);
    const candidats = await rows(ctx.sql, `
      SELECT c.file_id, count(*)::int AS n, array_agg(c.id ORDER BY c.id) AS ids FROM document_operation_candidates c
       WHERE c.account_id = $1 AND c.file_id = ANY($2::int[]) AND ${CANDIDAT_SANS_PREUVE_SQL} GROUP BY c.file_id`, [accountId, intArray(ids)]);
    for (const id of ids) {
      if (!vivants.has(id)) { out.set(id, { verdict: 'GONE' }); continue; }
      const anomalies: RuleAnomaly[] = [];
      let capacite: { available: boolean; version: string | null; reason: string } | null = null;
      for (const r of regles) {
        const carte = cartes.find((c) => Number(c.target_id) === id && c.rule_code === r.code) ?? null;
        const ev = evals.find((e) => Number(e.file_id) === id && e.rule_code === r.code) ?? null;
        const enAttente = !!ev && INTERPRETATION_PENDING_REASONS.includes(String(ev.reason_code));
        const s = await knowledgeQueryState(accountId, id, { code: r.code, question: r.question }, r.key);
        capacite = { available: s.capability.available, version: s.capability.version, reason: s.capability.reason };
        if (!s.hasExtraction || s.unstructured === 0) continue;
        const base = { rule: r.code, memoId: s.memo?.id ?? null, contextFingerprint: s.contextFingerprint };
        if (s.memo?.status === 'ANSWERED') {
          for (const u of s.citedCoveredUnits.slice(0, 5)) anomalies.push({ ...base, code: 'PARTIALLY_STRUCTURED_UNIT', detail: { unit: u.ref, sourceUnitId: u.sourceUnitId, fileId: u.fileId, pendingContract: CONTRAT_T1 } });
          if (!carte && !enAttente) continue;
          const exploitee = ev !== null && String(ev.query_id ?? '') === String(s.memo.id);
          if (s.memo.outcome === 'FOUND' && carte?.action_kind === 'COMPLETE') anomalies.push({ ...base, code: 'CARD_ASKS_KNOWN_INFORMATION', detail: { actionId: Number(carte.id) } });
          else if (!exploitee) anomalies.push({ ...base, code: 'KNOWLEDGE_NOT_EXPLOITED', detail: { actionId: carte ? Number(carte.id) : null, outcome: s.memo.outcome } });
          else if (s.memo.outcome === 'INCOMPLETE') anomalies.push({ ...base, code: 'INTERPRETATION_INCOMPLETE' });
          else if (carte) {
            // Lot 98B (P0-D) : réponse valide, exploitée, mais sans le constituant dont la décision a besoin.
            const besoins = declaredDecisionGaps(ev, sk.knowledgeGaps, sk.DECISION_GAP_PREFIX) as ConstituentRole[];
            const offerts = (await buildKnowledgeQuestion({ code: r.code, question: r.question }, r.key)).constituents.map((c) => c.role);
            const reponse = { status: 'ANSWERED', outcome: s.memo.outcome, findings: s.memo.findings } as unknown as SemanticResolution;
            const manque = sk.isKnowledgeAnswerIncompleteForCard({ answer: reponse, needs: besoins, offered: offerts }).missing;
            if (manque.length) {
              const suite = await knowledgeQueryState(accountId, id, { code: r.code, question: r.question }, r.key, {}, manque);
              const info = { actionId: Number(carte.id), missing: manque, rendered: sk.renderedRoles(reponse), lastReason: ev?.reason_code ?? null };
              const suiteExploitee = suite.memo?.status === 'ANSWERED' && String(ev?.follow_up_id ?? '') === String(suite.memo.id);
              if (suiteExploitee) {
                const encore = manque.filter((g) => !sk.renderedRoles({ findings: suite.memo!.findings }).includes(g));
                if (encore.length) {
                  anomalies.push({ ...base, code: 'KNOWLEDGE_ANSWER_STILL_INCOMPLETE', memoId: suite.memo!.id,
                    detail: { ...info, missing: encore, followUpQuery: suite.memo!.id, qualification: 'UNDETERMINED_DECISION', pendingContract: CONTRAT_T3 } });
                }
              } else if (suite.memo?.status === 'AI_FAILED' && suite.memo.attempts >= 3) {
                anomalies.push({ ...base, code: 'INTERPRETATION_FAILED', detail: { ...info, attempts: suite.memo.attempts, followUp: true } });
              } else if (!suite.capability.available) {
                anomalies.push({ ...base, code: 'INTERPRETATION_PENDING', detail: { ...info, capability: suite.capability.reason, pendingContract: CONTRAT_T3, followUp: true } });
              } else {
                anomalies.push({ ...base, code: 'KNOWLEDGE_ANSWER_INCOMPLETE', memoId: suite.memo?.id ?? s.memo.id, detail: info });
              }
            }
          }
          continue;
        }
        if (!carte && !enAttente) continue;
        if (s.memo?.status === 'AI_FAILED' && s.memo.attempts >= 3) { anomalies.push({ ...base, code: 'INTERPRETATION_FAILED', detail: { attempts: s.memo.attempts } }); continue; }
        if (!s.capability.available) {
          anomalies.push({ ...base, code: 'INTERPRETATION_PENDING', detail: { capability: s.capability.reason, pendingContract: CONTRAT_T3, actionId: carte ? Number(carte.id) : null } });
          continue;
        }
        anomalies.push({ ...base, code: carte ? 'FIELD_NOT_IN_T1_WITH_KNOWLEDGE' : 'KNOWLEDGE_NOT_INTERPRETED', detail: { actionId: carte ? Number(carte.id) : null, lastReason: ev?.reason_code ?? null } });
      }
      const cand = candidats.find((c) => Number(c.file_id) === id);
      if (cand) anomalies.push({ rule: '*', code: 'OPERATION_CANDIDATE_WITHOUT_T1_EVIDENCE', detail: { candidates: (cand.ids as unknown[]).slice(0, 10).map(Number), pendingContract: CONTRAT_T1 } });
      if (anomalies.length === 0) { out.set(id, { verdict: 'CONSISTENT', detail: { fileId: id } }); continue; }
      const reparables = anomalies.filter((a) => REPARABLES.has(a.code));
      const tete = reparables[0] ?? anomalies[0];
      // Une connaissance jamais interprétée n'est réessayée qu'une fois par jour (budget IA, anti-boucle).
      const jour = reparables.some((a) => a.code === 'KNOWLEDGE_NOT_INTERPRETED' || a.code === 'FIELD_NOT_IN_T1_WITH_KNOWLEDGE' || a.code === 'KNOWLEDGE_ANSWER_INCOMPLETE') ? ctx.today : null;
      out.set(id, {
        verdict: reparables.length ? 'REPAIRABLE' : 'FINDING',
        anomaly: tete.code, faultyLink: MAILLON[tete.code] ?? 'T3',
        detail: { fileId: id, anomalies: anomalies.slice(0, 20), capability: capacite, ...(reparables.length ? {} : { pendingContract: anomalies.some((a) => a.code.startsWith('INTERPRETATION')) ? CONTRAT_T3 : CONTRAT_T1 }) },
        inputHash: hashOf({ id, a: anomalies.map((a) => [a.rule, a.code, a.memoId ?? null, a.contextFingerprint ?? null]), cap: capacite, jour }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    const bridge = await import('@/services/to-process/document-rule-bridge');
    for (const { id, inspection } of items) {
      const anomalies = ((inspection.detail as { anomalies?: RuleAnomaly[] } | undefined)?.anomalies ?? []).filter((a) => REPARABLES.has(a.code));
      const regles = [...new Set(anomalies.map((a) => a.rule))];
      const resultats: Record<string, unknown> = {};
      let ia = 0;
      for (const rule of regles) {
        const r = await bridge.resolveDocumentRuleFromKnowledge(accountId, id, rule, { runRef: ctx.correlationId, today: ctx.today, trigger: 'BACKFILL' });
        ia += (r.knowledgeQuery?.calls ?? 0) + (r.aiCalled ? 1 : 0);
        resultats[rule] = { status: r.status, reasonCode: r.reasonCode, outcome: r.outcome ?? null, verified: r.verified, knowledgeQuery: r.knowledgeQuery?.outcome ?? r.knowledgeQuery?.pendingReason ?? null };
      }
      out.set(id, {
        called: regles.length > 0, service: 'resolveDocumentRuleFromKnowledge', aiCalls: ia, result: resultats,
        rollbackRef: `to_process_action_events:document=${id};document_field_values:file=${id};t3_knowledge_queries:file=${id}`,
      });
    }
    return out;
  },
};
