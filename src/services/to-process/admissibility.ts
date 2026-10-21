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
import type { TraceFailure } from './trace-retries';

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
  /**
   * Lot 76 (C5) — critères SANS INCIDENCE pour la règle (déclarés par la
   * famille) : leur valeur inconnue ne bloque pas. Tout autre critère inconnu
   * (`null`) est BLOQUANT : jamais assimilé à une validation.
   */
  notApplicable?: ReadonlyArray<keyof AdmissibilityChecks>;
  /** Lot 76 (C5) — justification POSITIVE de chaque critère vérifié (codes stables, diagnostic). */
  justifications?: Partial<Record<keyof AdmissibilityChecks, string>>;
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
  /** Lot 76 (C5) : CREATE_ACTION — justifications positives des critères nécessaires (« critère=motif », séparés par « ; »). */
  justification?: string | null;
  /** Lot 76 (C5) : critères inconnus qui ont empêché la conclusion. */
  unknown?: Array<keyof AdmissibilityChecks>;
}

/** Ordre des critères (ticket lot 72, C4). */
const CRITERES: ReadonlyArray<keyof AdmissibilityChecks> = ['userDecided', 'realProblem', 'neededForUse', 'autoResolvable', 'userActionNeeded', 'timely'];

/**
 * Décision d'admissibilité (pure) — ordre des questions fixé par le ticket.
 * Lot 76 (C5) : CREATE_ACTION exige une réponse POSITIVE (ou « sans
 * incidence » déclarée) à CHAQUE critère ; un critère inconnu → DEFER
 * (`UNKNOWN_CRITERIA:…`), jamais une carte présumée.
 */
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
  const sansObjet = new Set(i.notApplicable ?? []);
  const inconnus = CRITERES.filter((k) => c[k] === null && !sansObjet.has(k));
  if (inconnus.length) {
    // Le premier critère inconnu porte le motif propre de la famille, s'il existe (« CATEGORY_UNKNOWN »…).
    const propre = m[inconnus[0]];
    return { outcome: 'DEFER', decisive: inconnus[0], checks: c, unknown: inconnus,
      reason: `${propre && /UNKNOWN|PENDING/.test(propre) ? `${propre}|` : ''}UNKNOWN_CRITERIA:${inconnus.join(',')}`.slice(0, 200) };
  }
  const j = i.justifications ?? {};
  const justification = CRITERES.filter((k) => !sansObjet.has(k) && j[k]).map((k) => `${k}=${j[k]}`).join('; ') || null;
  return { ...d('CREATE_ACTION', null, 'ACTION_JUSTIFIED'), justification };
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

let passagesPrets: { at: number; ok: boolean } | null = null;

/** Table des passages durables (lot 75I, 0560) présente ? (relue au plus toutes les 5 minutes) */
export async function durablePassagesReady(): Promise<boolean> {
  if (passagesPrets && Date.now() - passagesPrets.at < 300_000) return passagesPrets.ok;
  try {
    const [r] = (await pgClient.unsafe(`SELECT to_regclass('to_process_evaluation_passages') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    passagesPrets = { at: Date.now(), ok: r?.ok === true };
  } catch { passagesPrets = { at: Date.now(), ok: false }; }
  return passagesPrets.ok;
}

/** Réservé aux tests : oublie les sondes de présence des tables. */
export function __resetTraceProbesForTests(): void { pret = null; passagesPrets = null; }

/**
 * Lot 75I (E) — insertion du passage DURABLE dans la MÊME instruction SQL que
 * l'écriture de l'évaluation (CTE) : atomique, jamais une évaluation sans son
 * passage ni l'inverse. `ecriture` : instruction UPDATE / INSERT … RETURNING
 * id, account_id. Pure (texte SQL).
 */
export function withDurablePassage(ecriture: string, p: { source: 'DOCUMENT_RULE' | 'FAMILY'; kind: 'INSERTED' | 'REPEATED'; triggerParam: string; runRefParam: string }): string {
  const col = p.source === 'DOCUMENT_RULE' ? 'rule_evaluation_id' : 'family_decision_id';
  return `WITH ecrite AS (${ecriture}),
          passage AS (INSERT INTO to_process_evaluation_passages (account_id, source, ${col}, kind, trigger_code, run_ref)
                      SELECT account_id, '${p.source}', id, '${p.kind}', ${p.triggerParam}, ${p.runRefParam} FROM ecrite RETURNING id)
     SELECT id FROM ecrite`;
}

/** Passages conservés dans l'aperçu `passages` d'une décision dédupliquée (tous : table 0560). */
const PASSAGES_MAX = 20;

/**
 * Trace une décision d'une famille « état de la base ». Une décision
 * identique à la dernière de la même cible et règle ne fait que dater le
 * constat (dédupliquée). Ne lève jamais.
 *
 * Lot 75I (E) : chaque passage est AUSSI conservé durablement
 * (`to_process_evaluation_passages`, sans limite de nombre), dans la même
 * instruction. Rend l'ERREUR de journalisation (null : tracée) — l'appelant
 * la remonte au diagnostic technique, jamais en console seule.
 */
export async function recordFamilyDecision(r: FamilyDecisionRecord, opts: { replay?: boolean; originalAt?: string } = {}): Promise<TraceFailure | null> {
  const echec = async (cause: string): Promise<TraceFailure> => {
    console.error(`[to-process] ${cause}`);
    // Lot 76 (C8) : décision appliquée NON tracée — conservée pour reprise (jamais lors d'une reprise : pas de doublon).
    if (opts.replay) return { cause, retryId: null };
    const { enqueueTraceRetry } = await import('./trace-retries');
    return enqueueTraceRetry({ source: 'FAMILY', accountId: r.accountId, ruleCode: r.ruleCode, targetType: r.targetType, targetId: r.targetId, payload: r, cause });
  };
  // Lot 76 (C8) : table de diagnostic indisponible — échec VISIBLE, jamais un succès silencieux.
  if (!(await familyDecisionsReady())) return echec(`décision ${r.ruleCode} (${r.targetType} ${r.targetId}) non tracée : table to_process_decisions indisponible`);
  const signature = familyDecisionSignature(r);
  const passage = JSON.stringify([{ at: opts.originalAt ?? new Date().toISOString(), trigger: r.trigger, runRef: r.runRef ?? null, ...(opts.replay ? { replayed: true } : {}) }]);
  const durable = await durablePassagesReady();
  try {
    const maj = `UPDATE to_process_decisions SET last_seen_at = now(), seen_count = seen_count + 1, trigger_code = $6, reevaluate_at = $7::timestamptz,
              passages = (SELECT COALESCE(jsonb_agg(z.p ORDER BY z.n), '[]'::jsonb) FROM (
                SELECT p, n FROM jsonb_array_elements($8::jsonb || COALESCE(passages, '[]'::jsonb)) WITH ORDINALITY AS t(p, n)
                 ORDER BY n LIMIT ${PASSAGES_MAX}) z)
        WHERE id = (SELECT id FROM to_process_decisions WHERE account_id = $1 AND target_type = $2 AND target_id = $3 AND rule_code = $4 ORDER BY id DESC LIMIT 1)
          AND signature = $5
        RETURNING id, account_id`;
    const majRows = (await pgClient.unsafe(
      durable ? withDurablePassage(maj, { source: 'FAMILY', kind: 'REPEATED', triggerParam: '$6', runRefParam: '$9' }) : maj,
      [r.accountId, r.targetType, r.targetId, r.ruleCode, signature, r.trigger, r.reevaluateAt ?? null, passage, ...(durable ? [r.runRef ?? null] : [])] as never[],
    )) as unknown as Array<{ id: number }>;
    if (majRows.length) return null;
    const ins = `INSERT INTO to_process_decisions (account_id, target_type, target_id, rule_code, data_key, trigger_code, run_ref, engine_version,
                                         outcome, decision_kind, reason_code, decisive_check, checks, evidence, effect, action_ids,
                                         reevaluate_at, error, signature, passages)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16::jsonb, $17::timestamptz, $18, $19, $20::jsonb)
       RETURNING id, account_id`;
    await pgClient.unsafe(
      durable ? withDurablePassage(ins, { source: 'FAMILY', kind: 'INSERTED', triggerParam: '$6', runRefParam: '$7' }) : ins,
      [r.accountId, r.targetType, r.targetId, r.ruleCode, r.dataKey, r.trigger, r.runRef ?? null, ADMISSIBILITY_VERSION,
        r.decision.outcome, familyDecisionKind(r), r.decision.reason.slice(0, 200), r.decision.decisive, JSON.stringify(r.decision.checks),
        JSON.stringify(r.evidence ?? {}), r.effect, r.actionIds ? JSON.stringify(r.actionIds) : null, r.reevaluateAt ?? null,
        r.error ? String(r.error).slice(0, 300) : null, signature, passage] as never[],
    );
    return null;
  } catch (e) {
    return echec(`décision ${r.ruleCode} (${r.targetType} ${r.targetId}) non tracée : ${(e as Error).message}`.slice(0, 260));
  }
}

/**
 * Lot 75I (E) — passages DURABLES d'une évaluation (diagnostic BO), du plus
 * récent au plus ancien, et leur nombre total.
 */
export async function listDurablePassages(p: { source: 'DOCUMENT_RULE' | 'FAMILY'; evaluationId: number; limit?: number }): Promise<{ total: number; passages: Array<{ at: string; trigger: string; runRef: string | null; kind: string }> }> {
  if (!(await durablePassagesReady())) return { total: 0, passages: [] };
  const col = p.source === 'DOCUMENT_RULE' ? 'rule_evaluation_id' : 'family_decision_id';
  const rows = (await pgClient.unsafe(
    `SELECT seen_at, trigger_code, run_ref, kind, count(*) OVER () AS total FROM to_process_evaluation_passages
      WHERE ${col} = $1 ORDER BY id DESC LIMIT $2`,
    [p.evaluationId, Math.max(1, Math.min(500, p.limit ?? 100))] as never[],
  )) as unknown as Array<{ seen_at: string; trigger_code: string; run_ref: string | null; kind: string; total: number }>;
  return {
    total: Number(rows[0]?.total ?? 0),
    passages: rows.map((x) => ({ at: new Date(x.seen_at).toISOString(), trigger: x.trigger_code, runRef: x.run_ref, kind: x.kind })),
  };
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
export async function purgeSupersededDecisionTraces(p: { retentionDays?: number; limit?: number } = {}): Promise<{ familyDecisions: number; documentRuleEvaluations: number; passages?: number; traceRetries?: number }> {
  const jours = Math.max(90, p.retentionDays ?? DECISION_TRACE_RETENTION_DAYS);
  const limite = Math.max(1, Math.min(20_000, p.limit ?? 5_000));
  const out = { familyDecisions: 0, documentRuleEvaluations: 0, passages: 0, traceRetries: 0 };
  // Lot 75I (E) : rétention EXPLICITE des passages durables (même durée) ; une évaluation purgée emporte les siens (cascade).
  try {
    if (await durablePassagesReady()) {
      const r = (await pgClient.unsafe(
        `DELETE FROM to_process_evaluation_passages WHERE id IN (
           SELECT id FROM to_process_evaluation_passages WHERE seen_at < now() - ($1::int * interval '1 day') ORDER BY id LIMIT $2)
         RETURNING id`,
        [jours, limite] as never[],
      )) as unknown as unknown[];
      out.passages = r.length;
    }
  } catch (e) {
    console.error('[to-process] rétention des passages impossible :', (e as Error).message);
  }
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
  // Lot 76 (C8) : reprises de traces RÉSOLUES (rejouées ou remplacées) — même rétention.
  out.traceRetries = await (await import('./trace-retries')).purgeResolvedTraceRetries(jours, limite);
  try {
    out.familyDecisions = await purge('to_process_decisions', 'n.account_id = d.account_id AND n.target_type = d.target_type AND n.target_id = d.target_id AND n.rule_code = d.rule_code');
    out.documentRuleEvaluations = await purge('document_rule_evaluations', 'n.account_id = d.account_id AND n.file_id = d.file_id AND n.rule_code = d.rule_code');
  } catch (e) {
    console.error('[to-process] rétention des traces de décision impossible :', (e as Error).message);
  }
  return out;
}
