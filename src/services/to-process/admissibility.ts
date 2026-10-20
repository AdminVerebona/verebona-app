/**
 * Lot 72 — ticket « [P1] À traiter — Corriger les écarts résiduels de
 * pertinence, de calcul et de réévaluation », écart C4 (contrôle de
 * pertinence commun avant la création des cartes) et C7 (traçabilité des
 * non-créations).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE INFORMATION ABSENTE N'EST PAS UNE ACTION À DEMANDER
 *
 * Constat : les producteurs « état de la base » (agenda, équipements,
 * fournisseurs) créaient une carte sur la seule condition « champ vide »
 * (ex. `produceAgendaActions` : tout événement actif sans date). Le pont
 * documentaire, lui, décide déjà (`assessDeadlinePertinence`) ; les autres
 * familles n'avaient aucune décision.
 *
 * Ce module n'est PAS un second moteur : il pose les six questions du ticket
 * sur des FAITS que chaque producteur établit lui-même (déterministes, aucun
 * appel IA), et rend la même issue que le pont documentaire :
 *
 *   ERROR          lecture impossible : aucune carte créée ni fermée ;
 *   NO_ACTION      l'utilisateur a tranché · aucun problème réel · donnée
 *                  inutile à toute utilisation identifiable · aucune action
 *                  de l'utilisateur n'y peut rien ;
 *   AUTO_RESOLVED  la donnée se retrouve ou se calcule (le producteur
 *                  l'écrit, vérifie, et ferme) ;
 *   DEFER          pas maintenant (qualification en cours, cible absente) —
 *                  réévaluée au balayage suivant, sans carte ;
 *   CREATE_ACTION  problème réel, nécessaire, non résoluble, actionnable,
 *                  pertinent maintenant : la carte est justifiée.
 *
 * Chaque décision — y compris SANS carte — est tracée (`to_process_decisions`,
 * migration 0516) : règle, cible, déclencheur, issue, nature, motif, faits
 * utilisés, cartes créées / maintenues / fermées, prochaine réévaluation.
 * Une évaluation identique à la précédente ne crée pas de ligne (date du
 * dernier constat et compteur seulement).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import { pgClient } from '@/db';
import type { RelevanceOutcome } from './document-field-evidence';

export const ADMISSIBILITY_VERSION = 'atp-admissibility-v1';

export type AdmissibilityOutcome = RelevanceOutcome | 'ERROR';

/**
 * Les six questions du ticket, posées AVANT toute nouvelle carte. `null` :
 * question sans objet pour la famille (ne bloque pas).
 */
export interface AdmissibilityChecks {
  /** Le problème métier est-il réel ? */
  realProblem: boolean | null;
  /** L'information est-elle nécessaire à une utilisation ou intervention identifiable ? */
  neededForUse: boolean | null;
  /** Peut-elle être retrouvée, calculée ou résolue automatiquement ? */
  autoResolvable: boolean | null;
  /** Une action de l'utilisateur est-elle réellement nécessaire (et possible) ? */
  userActionNeeded: boolean | null;
  /** Est-elle pertinente maintenant ? */
  timely: boolean | null;
  /** L'utilisateur a-t-il déjà tranché la question ? */
  userDecided: boolean | null;
}

export interface AdmissibilityInput {
  ruleCode: string;
  checks: AdmissibilityChecks;
  /** Motif par question (codes stables), pour le diagnostic. */
  motives?: Partial<Record<keyof AdmissibilityChecks, string>>;
  /** Échec technique de lecture : jamais une décision. */
  error?: string | null;
}

export interface AdmissibilityDecision {
  outcome: AdmissibilityOutcome;
  /** Code stable du motif (NOT_NEEDED, INFORMATIONAL_EVENT…). */
  reason: string;
  /** Question décisive. */
  decisive: keyof AdmissibilityChecks | 'error' | null;
  checks: AdmissibilityChecks;
}

/** Décision d'admissibilité (pure) — ordre des questions fixé par le ticket. */
export function decideAdmissibility(i: AdmissibilityInput): AdmissibilityDecision {
  const m = i.motives ?? {};
  const d = (outcome: AdmissibilityOutcome, decisive: AdmissibilityDecision['decisive'], fallback: string): AdmissibilityDecision =>
    ({ outcome, decisive, checks: i.checks, reason: (decisive && decisive !== 'error' ? m[decisive] : null) ?? fallback });
  if (i.error) return { outcome: 'ERROR', decisive: 'error', checks: i.checks, reason: `READ_FAILED:${i.error}`.slice(0, 200) };
  const c = i.checks;
  if (c.userDecided === true) return d('NO_ACTION', 'userDecided', 'USER_DECISION_RESPECTED');
  if (c.realProblem === false) return d('NO_ACTION', 'realProblem', 'NO_REAL_PROBLEM');
  if (c.neededForUse === false) return d('NO_ACTION', 'neededForUse', 'NOT_NEEDED');
  if (c.autoResolvable === true) return d('AUTO_RESOLVED', 'autoResolvable', 'AUTO_RESOLVABLE');
  if (c.userActionNeeded === false) return d('NO_ACTION', 'userActionNeeded', 'NO_USER_ACTION_NEEDED');
  if (c.timely === false) return d('DEFER', 'timely', 'NOT_NOW');
  return d('CREATE_ACTION', null, 'ACTION_JUSTIFIED');
}

// ══════════════════════════════════════════════════════════════════════════
// TRACE (0516) — jamais bloquante
// ══════════════════════════════════════════════════════════════════════════

export type DecisionTrigger = 'SWEEP' | 'BACKFILL' | 'USER' | 'ANALYSIS';

export interface FamilyDecisionRecord {
  accountId: number;
  targetType: string;
  targetId: number;
  ruleCode: string;
  dataKey: string;
  trigger: DecisionTrigger;
  runRef?: string | null;
  decision: AdmissibilityDecision;
  /** Faits utilisés (identifiants, codes, dates — jamais un texte intégral). */
  evidence?: Record<string, unknown>;
  /** Effet constaté : carte créée / maintenue / fermée, écriture. */
  effect: 'CREATED' | 'KEPT' | 'CLOSED' | 'WRITTEN' | 'NONE' | 'ERROR';
  actionIds?: { created?: number[]; kept?: number[]; closed?: number[] } | null;
  reevaluateAt?: string | null;
  error?: string | null;
}

/** Nature de la décision (mêmes valeurs que le pont documentaire, `decisionKindOf`). Pure. */
export function familyDecisionKind(r: Pick<FamilyDecisionRecord, 'decision' | 'effect'>): string {
  if (r.decision.outcome === 'ERROR' || r.effect === 'ERROR') return 'TECHNICAL_FAILURE';
  if (r.decision.outcome === 'AUTO_RESOLVED') return 'AUTO_RESOLVED';
  if (r.decision.decisive === 'userDecided') return 'USER_REFUSED';
  if (r.decision.outcome === 'DEFER') return 'DEFERRED';
  if (r.effect === 'CREATED') return 'CARD_CREATED';
  if (r.effect === 'KEPT') return 'CARD_KEPT';
  if (r.decision.outcome === 'NO_ACTION' && r.decision.decisive === 'neededForUse') return 'MISSING_INFO_NOT_REQUIRED';
  if (r.effect === 'CLOSED') return 'CARD_CLOSED';
  return 'NOT_RELEVANT';
}

const sha = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 24);

/** Signature d'une décision (hors déclencheur, référence, date). Pure. */
export function familyDecisionSignature(r: FamilyDecisionRecord): string {
  return sha([r.ruleCode, r.dataKey, r.decision.outcome, r.decision.reason, r.decision.checks, r.effect, r.actionIds ?? null, r.evidence ?? null, r.error ?? null]);
}

let pret: { at: number; ok: boolean } | null = null;

export async function familyDecisionsReady(): Promise<boolean> {
  if (pret && Date.now() - pret.at < 300_000) return pret.ok;
  try {
    const [r] = (await pgClient.unsafe(`SELECT to_regclass('to_process_decisions') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    pret = { at: Date.now(), ok: r?.ok === true };
  } catch { pret = { at: Date.now(), ok: false }; }
  return pret.ok;
}

/** Passages conservés sur une décision dédupliquée. */
const PASSAGES_MAX = 20;

/**
 * Trace une décision d'une famille « état de la base ». Une décision
 * identique à la dernière de la même cible et règle ne fait que dater le
 * constat (dédupliquée). Ne lève jamais.
 */
export async function recordFamilyDecision(r: FamilyDecisionRecord): Promise<void> {
  if (!(await familyDecisionsReady())) return;
  const signature = familyDecisionSignature(r);
  const passage = JSON.stringify([{ at: new Date().toISOString(), trigger: r.trigger, runRef: r.runRef ?? null }]);
  try {
    const maj = (await pgClient.unsafe(
      `UPDATE to_process_decisions SET last_seen_at = now(), seen_count = seen_count + 1, trigger_code = $6, reevaluate_at = $7::timestamptz,
              passages = (SELECT COALESCE(jsonb_agg(z.p ORDER BY z.n), '[]'::jsonb) FROM (
                SELECT p, n FROM jsonb_array_elements($8::jsonb || COALESCE(passages, '[]'::jsonb)) WITH ORDINALITY AS t(p, n)
                 ORDER BY n LIMIT ${PASSAGES_MAX}) z)
        WHERE id = (SELECT id FROM to_process_decisions WHERE account_id = $1 AND target_type = $2 AND target_id = $3 AND rule_code = $4 ORDER BY id DESC LIMIT 1)
          AND signature = $5
        RETURNING id`,
      [r.accountId, r.targetType, r.targetId, r.ruleCode, signature, r.trigger, r.reevaluateAt ?? null, passage] as never[],
    )) as unknown as Array<{ id: number }>;
    if (maj.length) return;
    await pgClient.unsafe(
      `INSERT INTO to_process_decisions (account_id, target_type, target_id, rule_code, data_key, trigger_code, run_ref, engine_version,
                                         outcome, decision_kind, reason_code, decisive_check, checks, evidence, effect, action_ids,
                                         reevaluate_at, error, signature, passages)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16::jsonb, $17::timestamptz, $18, $19, $20::jsonb)`,
      [r.accountId, r.targetType, r.targetId, r.ruleCode, r.dataKey, r.trigger, r.runRef ?? null, ADMISSIBILITY_VERSION,
        r.decision.outcome, familyDecisionKind(r), r.decision.reason.slice(0, 200), r.decision.decisive, JSON.stringify(r.decision.checks),
        JSON.stringify(r.evidence ?? {}), r.effect, r.actionIds ? JSON.stringify(r.actionIds) : null, r.reevaluateAt ?? null,
        r.error ? String(r.error).slice(0, 300) : null, signature, passage] as never[],
    );
  } catch (e) {
    console.error(`[to-process] décision ${r.ruleCode} (${r.targetType} ${r.targetId}) non tracée :`, (e as Error).message);
  }
}

/** Décisions récentes d'une famille (diagnostic BO), filtrées. */
export async function listFamilyDecisions(f: { accountId?: number | null; targetType?: string | null; targetId?: number | null; ruleCode?: string | null; result?: string | null; limit?: number }) {
  if (!(await familyDecisionsReady())) return [];
  const rows = (await pgClient.unsafe(
    `SELECT * FROM to_process_decisions
      WHERE ($1::int IS NULL OR account_id = $1) AND ($2::text IS NULL OR target_type = $2) AND ($3::int IS NULL OR target_id = $3)
        AND ($4::text IS NULL OR rule_code = $4)
        AND ($5::text IS NULL OR outcome = $5 OR decision_kind = $5 OR reason_code = $5)
      ORDER BY id DESC LIMIT $6`,
    [f.accountId ?? null, f.targetType ?? null, f.targetId ?? null, f.ruleCode ?? null, f.result ?? null, Math.max(1, Math.min(200, f.limit ?? 50))] as never[],
  ).catch(() => [])) as unknown as Array<Record<string, unknown>>;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const obj = <T>(v: unknown): T | null => (v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v) as T);
  return rows.map((r) => ({
    id: Number(r.id), accountId: Number(r.account_id), targetType: String(r.target_type), targetId: Number(r.target_id), ruleCode: String(r.rule_code),
    dataKey: (r.data_key as string) ?? null, trigger: String(r.trigger_code), runRef: (r.run_ref as string) ?? null, outcome: String(r.outcome),
    decisionKind: (r.decision_kind as string) ?? null, reasonCode: (r.reason_code as string) ?? null, decisiveCheck: (r.decisive_check as string) ?? null,
    checks: obj<AdmissibilityChecks>(r.checks), evidence: obj<Record<string, unknown>>(r.evidence), effect: String(r.effect),
    actionIds: obj<Record<string, number[]>>(r.action_ids), reevaluateAt: iso(r.reevaluate_at), error: (r.error as string) ?? null,
    seenCount: Number(r.seen_count ?? 1), createdAt: iso(r.created_at), lastSeenAt: iso(r.last_seen_at), passages: obj<unknown[]>(r.passages),
  }));
}

/** Rétention (lot 72, C7) : jours de conservation des décisions REMPLACÉES (la dernière de chaque cible est toujours gardée). */
export const DECISION_TRACE_RETENTION_DAYS = 400;

/**
 * Purge des traces REMPLACÉES plus anciennes que la rétention — jamais la
 * dernière décision d'une cible et d'une règle, jamais une carte ni un
 * événement de carte (historique des décisions de l'utilisateur intact).
 * Bornée par passage. Ne lève jamais ; rend le nombre de lignes retirées.
 */
export async function purgeSupersededDecisionTraces(p: { retentionDays?: number; limit?: number } = {}): Promise<{ familyDecisions: number; documentRuleEvaluations: number }> {
  const jours = Math.max(90, p.retentionDays ?? DECISION_TRACE_RETENTION_DAYS);
  const limite = Math.max(1, Math.min(20_000, p.limit ?? 5_000));
  const out = { familyDecisions: 0, documentRuleEvaluations: 0 };
  const purge = async (table: string, cle: string): Promise<number> => {
    const [t] = (await pgClient.unsafe(`SELECT to_regclass('${table}') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    if (!t?.ok) return 0;
    const r = (await pgClient.unsafe(
      `DELETE FROM ${table} WHERE id IN (
         SELECT d.id FROM ${table} d
          WHERE d.last_seen_at < now() - ($1::int * interval '1 day')
            AND EXISTS (SELECT 1 FROM ${table} n WHERE ${cle} AND n.id > d.id)
          ORDER BY d.id LIMIT $2)
       RETURNING id`,
      [jours, limite] as never[],
    )) as unknown as unknown[];
    return r.length;
  };
  try {
    out.familyDecisions = await purge('to_process_decisions', 'n.account_id = d.account_id AND n.target_type = d.target_type AND n.target_id = d.target_id AND n.rule_code = d.rule_code');
    out.documentRuleEvaluations = await purge('document_rule_evaluations', 'n.account_id = d.account_id AND n.file_id = d.file_id AND n.rule_code = d.rule_code');
  } catch (e) {
    console.error('[to-process] rétention des traces de décision impossible :', (e as Error).message);
  }
  return out;
}
