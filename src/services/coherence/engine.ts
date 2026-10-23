/**
 * Moteur de contrôle d'un lot d'objets — lot 82B (arbitrages C-Q2, C-Q4).
 *
 * Pour chaque objet d'un contrôle du registre :
 *   1. preuve « contrôle LANCÉ » posée AVANT l'inspection (une interruption
 *      laisse une trace : lancé sans être achevé) ;
 *   2. inspection en LECTURE SEULE (`check.inspect`) — une erreur technique
 *      n'est jamais assimilée à un résultat cohérent (résultat ERROR, aucune
 *      date de succès) ;
 *   3. mode correctif seulement, diagnostic FIABLE (REPAIRABLE), compte
 *      ÉLIGIBLE (lot 83E : un compte lu pour son seul état d'abonnement n'est
 *      jamais réparé — constat FINDING) : éligibilité
 *      du compte revérifiée, réparation DÉLÉGUÉE au service métier
 *      (`check.repair`), puis RECONTRÔLE immédiat — l'anomalie n'est close
 *      (REPAIRED) que si le recontrôle confirme la cohérence ; sinon
 *      REPAIR_INEFFECTIVE (constat conservé). Mode à blanc : WOULD_REPAIR,
 *      aucune écriture métier ;
 *   4. anti-boucle : une réparation déjà tentée sur les MÊMES entrées
 *      (`inputHash`) sans succès n'est pas rejouée (REPAIR_SUPPRESSED) tant
 *      que les entrées n'ont pas changé ; un échec technique de réparation
 *      est repris au plus `MAX_REPAIR_RETRIES` fois ;
 *   5. preuve « contrôle ACHEVÉ » (et « RÉUSSI » si pas d'erreur) avec le
 *      résultat, la version des règles, le constat courant (une ligne par
 *      objet × contrôle : jamais de doublon), la série de constats ;
 *   6. chaque tentative de réparation est journalisée (`coherence_repairs`) :
 *      origine, service, état avant, résultat, recontrôle, erreur, référence
 *      de retour arrière vers le journal du domaine.
 *
 * Lot 83B :
 *   · RELANCE ASYNCHRONE (`RepairResult.pending`, C-Q7) : une relance
 *     acceptée par une file existante (nouvelle extraction source) n'a pas
 *     de recontrôle immédiat ; l'objet est REPAIR_PENDING (journal PENDING)
 *     et n'est JAMAIS relancé tant que le diagnostic est le même. Le contrôle
 *     suivant de l'objet clôt la tentative : REPAIRED si l'objet est devenu
 *     cohérent, INEFFECTIVE si un autre diagnostic subsiste ;
 *   · RECONTRÔLE À PLUSIEURS CONSTATS : quand l'anomalie réparée a disparu
 *     mais qu'un AUTRE constat de l'objet subsiste (ex. maillon aval réparé,
 *     omission T1 en attente d'un contrat IA), la réparation est REPAIRED au
 *     journal et la preuve porte le constat restant — jamais un faux
 *     « inefficace », jamais un faux « cohérent » ;
 *   · COÛT IA MESURÉ (C-Q1) : appels modèle du compte pendant la réparation
 *     (`ai_usage_event`, écrit à chaque appel par la passerelle), en plus de
 *     ce que le service déclare.
 */
import type {
  CheckContext, CoherenceCheck, ControlResult, ControlTrigger, Inspection, RepairResult, Sql,
} from './registry/types';
import { RESOLVED_RESULTS } from './registry/types';
import { registryVersion } from './registry';
import { exec, intArray, rows, type Row } from './registry/util';

/** Réparations reprises au plus après un échec technique sur les mêmes entrées. */
export const MAX_REPAIR_RETRIES = 3;
/** Délai de reprise d'un contrôle en erreur (minutes × rang de l'erreur). */
export const ERROR_RETRY_MINUTES = 30;

/** Le compte n'est plus éligible au moment de réparer (C-Q10) : le parcours du compte s'arrête. */
export class AccountNoLongerEligibleError extends Error {
  constructor(readonly accountId: number, readonly reason: string) {
    super(`compte ${accountId} non éligible (${reason}) : aucun traitement`);
    this.name = 'AccountNoLongerEligibleError';
  }
}

export interface ProofState {
  last_result: string | null;
  last_repair_hash: string | null;
  repair_attempts: number;
  finding_streak: number;
  consecutive_errors: number;
  first_detected_at: Date | null;
}

export interface ObjectOutcome {
  id: number;
  result: ControlResult;
  inspection?: Inspection;
  error?: string;
  repairAttempted: boolean;
  aiCalls: number;
}

export interface BatchSummary {
  results: Partial<Record<ControlResult, number>>;
  aiCalls: number;
  repairsAttempted: number;
  durationMs: number;
  outcomes: ObjectOutcome[];
}

// ── Décisions pures ─────────────────────────────────────────────────────────

/** Résultat d'une inspection hors réparation (pure). */
export function resultOfVerdict(i: Inspection, mode: CheckContext['mode'], repairable: boolean): ControlResult | 'TRY_REPAIR' {
  switch (i.verdict) {
    case 'CONSISTENT': return 'CONSISTENT';
    case 'GONE': return 'GONE';
    case 'AMBIGUOUS': return 'AMBIGUOUS';
    case 'FINDING': return 'FINDING';
    case 'REPAIRABLE':
      if (mode === 'DRY_RUN') return 'WOULD_REPAIR';
      return repairable ? 'TRY_REPAIR' : 'FINDING';
  }
}

/**
 * Anti-boucle (pure) : une réparation est-elle permise pour ces entrées ?
 * Inefficace ou supprimée sur les mêmes entrées : non. Échec technique sur
 * les mêmes entrées : au plus `MAX_REPAIR_RETRIES` tentatives.
 */
export function repairAllowed(prev: ProofState | undefined, inputHash: string | undefined): boolean {
  if (!prev || !inputHash || prev.last_repair_hash !== inputHash) return true;
  if (prev.last_result === 'REPAIR_INEFFECTIVE' || prev.last_result === 'REPAIR_SUPPRESSED' || prev.last_result === 'REPAIR_PENDING') return false;
  if (prev.last_result === 'REPAIR_FAILED') return prev.repair_attempts < MAX_REPAIR_RETRIES;
  return true;
}

/**
 * Lot 83B — relance asynchrone encore attendue (pure) : la preuve est
 * REPAIR_PENDING et l'inspection rend le MÊME diagnostic réparable.
 */
export function stillAwaitingRepair(prev: ProofState | undefined, i: Inspection): boolean {
  return !!prev && prev.last_result === 'REPAIR_PENDING' && i.verdict === 'REPAIRABLE' && !!i.inputHash && prev.last_repair_hash === i.inputHash;
}

/**
 * Lot 83B — issue d'un recontrôle après réparation (pure) : cohérent →
 * REPAIRED ; anomalie réparée disparue mais autre constat → réparation
 * effective, la preuve porte le constat restant ; même anomalie → inefficace.
 */
export function recheckOutcome(before: Inspection, recheck: Inspection): { journal: 'REPAIRED' | 'INEFFECTIVE'; result: ControlResult } {
  if (recheck.verdict === 'CONSISTENT' || recheck.verdict === 'GONE') return { journal: 'REPAIRED', result: 'REPAIRED' };
  if (recheck.anomaly && recheck.anomaly !== before.anomaly) {
    const r = resultOfVerdict(recheck, 'CORRECTIVE', false);
    return { journal: 'REPAIRED', result: r === 'TRY_REPAIR' ? 'FINDING' : r };
  }
  return { journal: 'INEFFECTIVE', result: 'REPAIR_INEFFECTIVE' };
}

/** Évolution de la preuve (pure) : série de constats, erreurs consécutives, première détection. */
export function nextProofCounters(prev: ProofState | undefined, result: ControlResult, now: Date): { findingStreak: number; consecutiveErrors: number; firstDetectedAt: Date | null } {
  if (result === 'ERROR') {
    return { findingStreak: prev?.finding_streak ?? 0, consecutiveErrors: (prev?.consecutive_errors ?? 0) + 1, firstDetectedAt: prev?.first_detected_at ?? null };
  }
  if (RESOLVED_RESULTS.has(result)) return { findingStreak: 0, consecutiveErrors: 0, firstDetectedAt: null };
  return { findingStreak: (prev?.finding_streak ?? 0) + 1, consecutiveErrors: 0, firstDetectedAt: prev?.first_detected_at ?? now };
}

// ── Persistance (preuve, journal) ───────────────────────────────────────────

async function markStarted(sql: Sql, p: { accountId: number; check: CoherenceCheck; ids: readonly number[]; campaignId: number | null; trigger: ControlTrigger; mode: string; at: Date }): Promise<void> {
  await exec(sql, 
    `INSERT INTO coherence_object_proofs (account_id, check_id, object_id, object_type, rules_version, registry_version, last_campaign_id, last_trigger, last_mode, last_started_at)
     SELECT $1::int, $2::text, x, $3::text, $4::int, $5::text, $6::bigint, $7::text, $8::text, $9::timestamptz FROM unnest($10::bigint[]) AS x
     ON CONFLICT (account_id, check_id, object_id) DO UPDATE
        SET last_started_at = EXCLUDED.last_started_at, last_campaign_id = EXCLUDED.last_campaign_id,
            last_trigger = EXCLUDED.last_trigger, last_mode = EXCLUDED.last_mode`,
    [p.accountId, p.check.id, p.check.objectType, p.check.version, registryVersion(), p.campaignId, p.trigger, p.mode, p.at, intArray(p.ids)],
  );
}

async function readProofs(sql: Sql, accountId: number, checkId: string, ids: readonly number[]): Promise<Map<number, ProofState>> {
  const r = await rows(sql, `
    SELECT object_id, last_result, last_repair_hash, repair_attempts, finding_streak, consecutive_errors, first_detected_at
      FROM coherence_object_proofs WHERE account_id = $1 AND check_id = $2 AND object_id = ANY($3::bigint[])`,
  [accountId, checkId, intArray(ids)]);
  return new Map(r.map((x: Row) => [Number(x.object_id), {
    last_result: (x.last_result as string | null) ?? null, last_repair_hash: (x.last_repair_hash as string | null) ?? null,
    repair_attempts: Number(x.repair_attempts ?? 0), finding_streak: Number(x.finding_streak ?? 0),
    consecutive_errors: Number(x.consecutive_errors ?? 0), first_detected_at: x.first_detected_at ? new Date(x.first_detected_at as string) : null,
  }]));
}

const borne = (v: unknown, n = 4000): unknown => {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  return s && s.length > n ? { truncated: true, excerpt: s.slice(0, n) } : v;
};

async function completeProof(sql: Sql, p: {
  accountId: number; check: CoherenceCheck; outcome: ObjectOutcome; prev?: ProofState; startedAt: Date; now: Date;
  repairHash?: string | null;
}): Promise<void> {
  const { outcome: o, check } = p;
  const c = nextProofCounters(p.prev, o.result, p.now);
  const erreur = o.result === 'ERROR';
  const resolu = RESOLVED_RESULTS.has(o.result);
  const finding = resolu || erreur ? null : {
    result: o.result, anomaly: o.inspection?.anomaly ?? null, faultyLink: o.inspection?.faultyLink ?? null,
    expected: borne(o.inspection?.expected, 1500), observed: borne(o.inspection?.observed, 1500), detail: borne(o.inspection?.detail, 1500),
  };
  const retry = erreur ? new Date(p.now.getTime() + ERROR_RETRY_MINUTES * 60_000 * Math.min(8, c.consecutiveErrors)) : null;
  await exec(sql, 
    `UPDATE coherence_object_proofs p
        SET rules_version = $4::int, registry_version = $5::text, last_completed_at = $6::timestamptz,
            last_success_at = CASE WHEN $7::boolean THEN p.last_success_at ELSE $6 END,
            last_result = $8::text,
            finding = CASE WHEN $7::boolean THEN p.finding ELSE $9::text::jsonb END,
            finding_hash = CASE WHEN $7::boolean THEN p.finding_hash WHEN $8::text IN ('CONSISTENT', 'GONE', 'REPAIRED') THEN NULL ELSE $10::text END,
            first_detected_at = $11::timestamptz, finding_streak = $12::int, consecutive_errors = $13::int, last_error = $14::text,
            last_repair_hash = CASE WHEN $15::boolean THEN $16::text ELSE p.last_repair_hash END,
            last_repair_at = CASE WHEN $15::boolean THEN $6 ELSE p.last_repair_at END,
            repair_attempts = CASE WHEN NOT $15::boolean THEN p.repair_attempts
                                   WHEN p.last_repair_hash IS NOT DISTINCT FROM $16::text THEN p.repair_attempts + 1 ELSE 1 END,
            -- Une demande de contrôle ciblé arrivée PENDANT le contrôle est conservée.
            requested_at = CASE WHEN p.requested_at > $17::timestamptz THEN p.requested_at ELSE NULL END,
            request_reason = CASE WHEN p.requested_at > $17::timestamptz THEN p.request_reason ELSE NULL END,
            next_retry_at = $18::timestamptz
      WHERE p.account_id = $1 AND p.check_id = $2 AND p.object_id = $3`,
    [p.accountId, check.id, o.id, check.version, registryVersion(), p.now, erreur, o.result, finding ? JSON.stringify(finding) : null,
      o.inspection?.inputHash ?? null, c.firstDetectedAt, c.findingStreak, c.consecutiveErrors, o.error?.slice(0, 500) ?? null,
      o.repairAttempted, p.repairHash ?? null, p.startedAt, retry],
  );
}

async function journalRepair(sql: Sql, p: {
  campaignId: number | null; accountId: number; check: CoherenceCheck; id: number; trigger: ControlTrigger; inspection: Inspection;
  repair: RepairResult | null; outcome: 'REPAIRED' | 'INEFFECTIVE' | 'FAILED' | 'PENDING'; recheck: string | null; error: string | null; durationMs: number;
  aiCalls?: number;
}): Promise<void> {
  await exec(sql, 
    `INSERT INTO coherence_repairs (campaign_id, account_id, check_id, check_version, object_type, object_id, trigger_code, anomaly, faulty_link,
                                    service, input_hash, before_state, result, outcome, recheck_verdict, rollback_ref, error, ai_calls, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text::jsonb, $13::text::jsonb, $14, $15, $16, $17, $18, $19)`,
    [p.campaignId, p.accountId, p.check.id, p.check.version, p.check.objectType, p.id, p.trigger, p.inspection.anomaly ?? 'UNSPECIFIED',
      p.inspection.faultyLink ?? null, p.repair?.service ?? p.check.services[0] ?? 'unknown', p.inspection.inputHash ?? null,
      JSON.stringify(borne({ expected: p.inspection.expected, observed: p.inspection.observed, detail: p.inspection.detail })),
      p.repair ? JSON.stringify(borne(p.repair.result ?? {})) : null, p.outcome, p.recheck, p.repair?.rollbackRef ?? null,
      p.error?.slice(0, 500) ?? null, p.aiCalls ?? p.repair?.aiCalls ?? 0, p.durationMs],
  );
}

/**
 * Lot 83B : clôture d'une relance asynchrone (journal PENDING) au contrôle
 * qui en observe le résultat — traçabilité diagnostic → relance → résultat.
 */
async function settlePendingRepairs(sql: Sql, p: { accountId: number; checkId: string; id: number; outcome: 'REPAIRED' | 'INEFFECTIVE'; verdict: string }): Promise<void> {
  await exec(sql,
    `UPDATE coherence_repairs SET outcome = $4, recheck_verdict = $5, settled_at = now()
      WHERE account_id = $1 AND check_id = $2 AND object_id = $3 AND outcome = 'PENDING'`,
    [p.accountId, p.checkId, p.id, p.outcome, p.verdict]);
}

/** Lot 83B (C-Q1) : repère du journal d'usage IA avant une réparation (null : journal illisible). */
async function aiUsageMark(sql: Sql): Promise<number | null> {
  try {
    const [r] = await rows(sql, `SELECT COALESCE(max(id), 0)::bigint AS m FROM ai_usage_event`);
    return Number(r?.m ?? 0);
  } catch { return null; }
}

/** Appels modèle du compte écrits depuis le repère (mesure, jamais bloquante). */
async function aiUsageSince(sql: Sql, accountId: number, mark: number | null): Promise<number> {
  if (mark === null) return 0;
  try {
    const [r] = await rows(sql, `SELECT count(*)::int AS n FROM ai_usage_event WHERE id > $1 AND account_id = $2`, [mark, accountId]);
    return Number(r?.n ?? 0);
  } catch { return 0; }
}

// ── Contrôle d'un lot ───────────────────────────────────────────────────────

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

async function inspectIsolated(ctx: CheckContext, check: CoherenceCheck, accountId: number, ids: readonly number[]): Promise<Map<number, Inspection | Error>> {
  const out = new Map<number, Inspection | Error>();
  try {
    const m = await check.inspect!(ctx, accountId, ids);
    for (const id of ids) out.set(id, m.get(id) ?? new Error('inspection sans résultat'));
    return out;
  } catch {
    // Lot en échec : chaque objet isolément (une erreur n'emporte pas les autres).
    for (const id of ids) {
      try {
        out.set(id, (await check.inspect!(ctx, accountId, [id])).get(id) ?? new Error('inspection sans résultat'));
      } catch (e) {
        out.set(id, e instanceof Error ? e : new Error(message(e)));
      }
    }
    return out;
  }
}

export interface ControlBatchInput {
  ctx: CheckContext;
  check: CoherenceCheck;
  accountId: number;
  ids: readonly number[];
  trigger: ControlTrigger;
  campaignId: number | null;
  /** Revérifie l'éligibilité juste avant la première réparation (C-Q10). */
  stillEligible: () => Promise<{ eligible: boolean; reason: string }>;
}

/** Contrôle un lot d'objets d'UN compte et d'UN contrôle (voir l'en-tête). */
export async function controlObjects(p: ControlBatchInput): Promise<BatchSummary> {
  const t0 = Date.now();
  const { ctx, check, accountId } = p;
  // Horloge du contrôle : référence du passage (`ctx.now`, injectable) + temps écoulé — monotone et cohérente avec
  // les dates de campagne (tests à date fixe compris).
  const clock = () => new Date(ctx.now.getTime() + (Date.now() - t0));
  const ids = intArray(p.ids);
  const summary: BatchSummary = { results: {}, aiCalls: 0, repairsAttempted: 0, durationMs: 0, outcomes: [] };
  if (!ids.length || !check.inspect) return summary;
  const startedAt = clock();
  await markStarted(ctx.sql, { accountId, check, ids, campaignId: p.campaignId, trigger: p.trigger, mode: ctx.mode, at: startedAt });
  const prev = await readProofs(ctx.sql, accountId, check.id, ids);
  const inspections = await inspectIsolated(ctx, check, accountId, ids);
  let eligibiliteVerifiee = false;

  for (const id of ids) {
    const insp = inspections.get(id)!;
    const avant = prev.get(id);
    let o: ObjectOutcome;
    let repairHash: string | null = null;
    if (insp instanceof Error) {
      o = { id, result: 'ERROR', error: insp.message, repairAttempted: false, aiCalls: 0 };
    } else if (stillAwaitingRepair(avant, insp)) {
      // Lot 83B : relance asynchrone en cours sur le MÊME diagnostic — on en attend le résultat, jamais de seconde relance.
      o = { id, result: 'REPAIR_PENDING', inspection: insp, repairAttempted: false, aiCalls: 0 };
    } else {
      // Lot 83E (C-Q10) : compte non éligible lu pour son seul état d'abonnement — jamais de réparation.
      const r = resultOfVerdict(insp, ctx.mode, !!check.repair && (ctx.accountScope ?? 'ELIGIBLE') === 'ELIGIBLE');
      if (r !== 'TRY_REPAIR') {
        o = { id, result: r, inspection: insp, repairAttempted: false, aiCalls: 0 };
      } else if (!repairAllowed(avant, insp.inputHash)) {
        o = { id, result: 'REPAIR_SUPPRESSED', inspection: insp, repairAttempted: false, aiCalls: 0 };
      } else {
        if (!eligibiliteVerifiee) {
          const e = await p.stillEligible();
          if (!e.eligible) throw new AccountNoLongerEligibleError(accountId, e.reason);
          eligibiliteVerifiee = true;
        }
        repairHash = insp.inputHash ?? null;
        const r0 = Date.now();
        const repere = await aiUsageMark(ctx.sql);
        let rep: RepairResult | null = null;
        try {
          rep = (await check.repair!(ctx, accountId, [{ id, inspection: insp }])).get(id) ?? null;
        } catch (e) {
          const aiEchec = await aiUsageSince(ctx.sql, accountId, repere);
          o = { id, result: 'REPAIR_FAILED', inspection: insp, error: message(e), repairAttempted: true, aiCalls: aiEchec };
          await journalRepair(ctx.sql, { campaignId: p.campaignId, accountId, check, id, trigger: p.trigger, inspection: insp, repair: rep, outcome: 'FAILED', recheck: null, error: message(e), durationMs: Date.now() - r0, aiCalls: aiEchec });
          summary.repairsAttempted++;
          summary.aiCalls += aiEchec;
          await completeProof(ctx.sql, { accountId, check, outcome: o, prev: avant, startedAt, now: clock(), repairHash });
          summary.outcomes.push(o);
          summary.results[o.result] = (summary.results[o.result] ?? 0) + 1;
          continue;
        }
        summary.repairsAttempted++;
        const ai = Math.max(rep?.aiCalls ?? 0, await aiUsageSince(ctx.sql, accountId, repere));
        if (rep?.pending) {
          // Lot 83B : relance acceptée par une file existante — résultat observé au prochain contrôle de l'objet.
          o = { id, result: 'REPAIR_PENDING', inspection: insp, repairAttempted: true, aiCalls: ai };
          await journalRepair(ctx.sql, {
            campaignId: p.campaignId, accountId, check, id, trigger: p.trigger, inspection: insp, repair: rep, outcome: 'PENDING', recheck: null,
            error: null, durationMs: Date.now() - r0, aiCalls: ai,
          });
        } else {
          // Recontrôle immédiat : l'anomalie n'est close que si la cohérence est confirmée.
          let recheck: Inspection | Error;
          try {
            recheck = (await check.inspect!(ctx, accountId, [id])).get(id) ?? new Error('recontrôle sans résultat');
          } catch (e) {
            recheck = e instanceof Error ? e : new Error(message(e));
          }
          let journal: 'REPAIRED' | 'INEFFECTIVE' = 'INEFFECTIVE';
          if (recheck instanceof Error) {
            o = { id, result: 'ERROR', inspection: insp, error: `recontrôle impossible : ${recheck.message}`, repairAttempted: true, aiCalls: ai };
          } else {
            const issue = recheckOutcome(insp, recheck);
            journal = issue.journal;
            o = { id, result: issue.result, inspection: issue.result === 'REPAIRED' ? insp : recheck, repairAttempted: true, aiCalls: ai };
          }
          await journalRepair(ctx.sql, {
            campaignId: p.campaignId, accountId, check, id, trigger: p.trigger, inspection: insp, repair: rep,
            outcome: journal, recheck: recheck instanceof Error ? 'ERROR' : recheck.verdict,
            error: o.error ?? null, durationMs: Date.now() - r0, aiCalls: ai,
          });
        }
      }
    }
    // Lot 83B : résultat d'une relance asynchrone observé à ce contrôle → tentative close (jamais sur une erreur de contrôle).
    if (avant?.last_result === 'REPAIR_PENDING' && !(insp instanceof Error) && o.result !== 'REPAIR_PENDING' && o.result !== 'ERROR') {
      const coherent = insp.verdict === 'CONSISTENT';
      await settlePendingRepairs(ctx.sql, { accountId, checkId: check.id, id, outcome: coherent ? 'REPAIRED' : 'INEFFECTIVE', verdict: insp.verdict });
      if (coherent) o = { ...o, result: 'REPAIRED' };
    }
    summary.aiCalls += o.aiCalls;
    await completeProof(ctx.sql, { accountId, check, outcome: o, prev: avant, startedAt, now: clock(), repairHash });
    summary.outcomes.push(o);
    summary.results[o.result] = (summary.results[o.result] ?? 0) + 1;
  }
  summary.durationMs = Date.now() - t0;
  return summary;
}
