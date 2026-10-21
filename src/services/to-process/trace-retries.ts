/**
 * Lot 76C — ticket « [P1] À traiter — Corriger les défauts résiduels du lot
 * 72C et sécuriser la réévaluation », C8 (échecs de traçabilité visibles et
 * récupérables).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE DÉCISION EST SOIT DIAGNOSTIQUABLE, SOIT SIGNALÉE NON TRACÉE AVEC UNE
 * REPRISE IDENTIFIABLE
 *
 * Constat : `recordRuleEvaluation` / `recordFamilyDecision` absorbaient
 * l'erreur de journalisation ; le lot 75I la remontait au bilan du balayage,
 * mais la décision déjà appliquée (carte créée, fermée, valeur écrite)
 * restait sans diagnostic consultable, sans reprise.
 *
 * Désormais (migration 0582) :
 *   · l'échec est RENDU à l'appelant (`TraceFailure` : cause + n° de reprise),
 *     remonté au bilan du balayage et au BO — jamais un faux succès tracé ;
 *   · l'enregistrement COMPLET de la décision est conservé
 *     (`to_process_trace_retries`) : il reste consultable même si la trace ne
 *     peut jamais être réécrite ;
 *   · une reprise automatique BORNÉE (tâche planifiée interne
 *     `to-process-relevance-reevaluation`) le rejoue : REPLAYED (trace écrite
 *     après coup), SUPERSEDED (une évaluation plus récente de la même cible a
 *     été tracée — jamais réinsérée par-dessus), ABANDONED (reprises
 *     épuisées : visible, relançable depuis le BO) ;
 *   · table de reprise elle-même indisponible : la cause dit « reprise
 *     impossible » (l'échec reste au bilan du balayage, statut « partial »).
 * Aucune décision métier n'est rejouée : seule sa TRACE l'est.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

export type TraceSource = 'DOCUMENT_RULE' | 'FAMILY';

/** Échec de journalisation d'une décision appliquée : cause et reprise identifiable (null : reprise impossible). */
export interface TraceFailure { cause: string; retryId: number | null }

/** Reprises au plus par élément avant abandon (visible, relançable). */
export const TRACE_RETRY_MAX_ATTEMPTS = 8;
/** Délai entre deux reprises (minutes × rang de la tentative). */
const TRACE_RETRY_BACKOFF_MIN = 15;

let pret: { at: number; ok: boolean } | null = null;

/** Table 0582 présente ? (relue au plus toutes les 5 minutes) */
export async function traceRetriesReady(): Promise<boolean> {
  if (pret && Date.now() - pret.at < 300_000) return pret.ok;
  try {
    const [r] = (await pgClient.unsafe(`SELECT to_regclass('to_process_trace_retries') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    pret = { at: Date.now(), ok: r?.ok === true };
  } catch { pret = { at: Date.now(), ok: false }; }
  return pret.ok;
}

/** Réservé aux tests : oublie la sonde de présence. */
export function __resetTraceRetryProbeForTests(): void { pret = null; }

/**
 * Conserve une décision non tracée pour reprise. Ne lève jamais : rend le
 * `TraceFailure` à remonter (cause complétée du n° de reprise, ou de
 * l'impossibilité de la reprise).
 */
export async function enqueueTraceRetry(p: {
  source: TraceSource; accountId: number; ruleCode: string; targetType: string | null; targetId: number | null;
  payload: unknown; cause: string; originalAt?: string;
}): Promise<TraceFailure> {
  const cause = p.cause.slice(0, 260);
  try {
    if (!(await traceRetriesReady())) return { cause: `${cause} — reprise impossible : migration 0582 absente`.slice(0, 300), retryId: null };
    const [r] = (await pgClient.unsafe(
      `INSERT INTO to_process_trace_retries (account_id, source, rule_code, target_type, target_id, payload, original_at, error, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8, now() + interval '${TRACE_RETRY_BACKOFF_MIN} minutes')
       RETURNING id`,
      [p.accountId, p.source, p.ruleCode, p.targetType, p.targetId, JSON.stringify(p.payload), p.originalAt ?? new Date().toISOString(), cause] as never[],
    )) as unknown as Array<{ id: number }>;
    const id = r ? Number(r.id) : null;
    return { cause: `${cause} — reprise n° ${id}`.slice(0, 300), retryId: id };
  } catch (e) {
    return { cause: `${cause} — reprise impossible : ${String((e as Error).message).slice(0, 120)}`.slice(0, 300), retryId: null };
  }
}

export interface TraceReplayReport { examined: number; replayed: number; superseded: number; failed: number; abandoned: number }

/**
 * Rejoue les traces en attente (bornée, reprise après redémarrage : l'état est
 * en base). Une évaluation plus récente déjà tracée pour la même cible et
 * règle → SUPERSEDED (jamais réinsérée par-dessus : elle deviendrait la
 * « dernière décision » à tort). Ne lève jamais.
 */
export async function replayPendingTraces(p: { limit?: number; deadline?: number } = {}): Promise<TraceReplayReport> {
  const out: TraceReplayReport = { examined: 0, replayed: 0, superseded: 0, failed: 0, abandoned: 0 };
  if (!(await traceRetriesReady())) return out;
  const limite = Math.max(1, Math.min(500, p.limit ?? 100));
  let lot: Array<{ id: number; account_id: number; source: TraceSource; rule_code: string; target_type: string | null; target_id: number | null; payload: unknown; original_at: string; attempts: number }>;
  try {
    // Réservation atomique (deux exécutions concurrentes ne rejouent jamais le même élément).
    lot = (await pgClient.unsafe(
      `UPDATE to_process_trace_retries SET attempts = attempts + 1,
              next_attempt_at = now() + ((attempts + 1) * interval '${TRACE_RETRY_BACKOFF_MIN} minutes')
        WHERE id IN (SELECT id FROM to_process_trace_retries WHERE status = 'PENDING' AND next_attempt_at <= now()
                      ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, account_id, source, rule_code, target_type, target_id, payload, original_at, attempts`,
      [limite] as never[],
    )) as unknown as typeof lot;
  } catch (e) {
    console.error('[to-process] reprise des traces illisible :', (e as Error).message);
    return out;
  }
  for (const t of lot.sort((a, b) => Number(a.id) - Number(b.id))) {
    if (p.deadline && Date.now() > p.deadline) break;
    out.examined += 1;
    const payload = (typeof t.payload === 'string' ? JSON.parse(t.payload) : t.payload) as Record<string, unknown>;
    const originalAt = new Date(t.original_at).toISOString();
    let statut: 'REPLAYED' | 'SUPERSEDED' | 'PENDING' | 'ABANDONED' = 'PENDING';
    let erreur: string | null = null;
    try {
      const plusRecente = t.source === 'DOCUMENT_RULE'
        ? (await pgClient.unsafe(
          `SELECT EXISTS (SELECT 1 FROM document_rule_evaluations WHERE account_id = $1 AND file_id = $2 AND rule_code = $3
                            AND (created_at > $4::timestamptz OR last_seen_at > $4::timestamptz)) AS x`,
          [t.account_id, t.target_id, t.rule_code, originalAt] as never[],
        )) as unknown as Array<{ x: boolean }>
        : (await pgClient.unsafe(
          `SELECT EXISTS (SELECT 1 FROM to_process_decisions WHERE account_id = $1 AND target_type = $2 AND target_id = $3 AND rule_code = $4
                            AND (created_at > $5::timestamptz OR last_seen_at > $5::timestamptz)) AS x`,
          [t.account_id, t.target_type, t.target_id, t.rule_code, originalAt] as never[],
        )) as unknown as Array<{ x: boolean }>;
      if (plusRecente[0]?.x) statut = 'SUPERSEDED';
      else {
        const echec = t.source === 'DOCUMENT_RULE'
          ? await (await import('./document-field-evidence')).recordRuleEvaluation(payload as never, { replay: true, originalAt })
          : await (await import('./admissibility')).recordFamilyDecision(payload as never, { replay: true, originalAt });
        if (echec) erreur = echec.cause; else statut = 'REPLAYED';
      }
    } catch (e) { erreur = String((e as Error).message).slice(0, 300); }
    if (statut === 'PENDING' && Number(t.attempts) >= TRACE_RETRY_MAX_ATTEMPTS) statut = 'ABANDONED';
    if (statut === 'REPLAYED') out.replayed += 1;
    else if (statut === 'SUPERSEDED') out.superseded += 1;
    else if (statut === 'ABANDONED') out.abandoned += 1;
    else out.failed += 1;
    await pgClient.unsafe(
      `UPDATE to_process_trace_retries SET status = $2, error = COALESCE($3, error),
              resolved_at = CASE WHEN $2 IN ('REPLAYED', 'SUPERSEDED') THEN now() ELSE NULL END
        WHERE id = $1`,
      [t.id, statut, erreur] as never[],
    ).catch((e: Error) => console.error('[to-process] état de reprise de trace non écrit :', e.message));
  }
  return out;
}

/** Relance (BO) des traces abandonnées : nouvelles reprises bornées. Rend le nombre relancé. */
export async function requeueAbandonedTraces(accountId?: number | null): Promise<number> {
  if (!(await traceRetriesReady())) return 0;
  const r = (await pgClient.unsafe(
    `UPDATE to_process_trace_retries SET status = 'PENDING', attempts = 0, next_attempt_at = now()
      WHERE status = 'ABANDONED' AND ($1::int IS NULL OR account_id = $1) RETURNING id`,
    [accountId ?? null] as never[],
  )) as unknown as unknown[];
  return r.length;
}

export interface TraceRetryView {
  id: number; accountId: number; source: TraceSource; ruleCode: string; targetType: string | null; targetId: number | null;
  status: string; attempts: number; error: string | null; originalAt: string; resolvedAt: string | null;
  /** Décision appliquée non tracée (issue, motif, cartes) — extrait. */
  decision: { outcome: unknown; reason: unknown; effect: unknown; actionIds: unknown };
}

/** Bilan et éléments récents (BO, diagnostic « À traiter »). Ne lève jamais. */
export async function traceRetryOverview(f: { accountId?: number | null; limit?: number } = {}): Promise<{
  available: boolean; counts: Record<string, number>; items: TraceRetryView[];
}> {
  if (!(await traceRetriesReady())) return { available: false, counts: {}, items: [] };
  try {
    const counts = (await pgClient.unsafe(
      `SELECT status, count(*)::int AS n FROM to_process_trace_retries WHERE ($1::int IS NULL OR account_id = $1) GROUP BY status`,
      [f.accountId ?? null] as never[],
    )) as unknown as Array<{ status: string; n: number }>;
    const rows = (await pgClient.unsafe(
      `SELECT * FROM to_process_trace_retries WHERE ($1::int IS NULL OR account_id = $1)
        ORDER BY (status IN ('PENDING', 'ABANDONED')) DESC, id DESC LIMIT $2`,
      [f.accountId ?? null, Math.max(1, Math.min(200, f.limit ?? 50))] as never[],
    )) as unknown as Array<Record<string, unknown>>;
    return {
      available: true,
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      items: rows.map((r) => {
        const pl = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<string, any>;
        return {
          id: Number(r.id), accountId: Number(r.account_id), source: r.source as TraceSource, ruleCode: String(r.rule_code),
          targetType: (r.target_type as string) ?? null, targetId: r.target_id == null ? null : Number(r.target_id), status: String(r.status),
          attempts: Number(r.attempts), error: (r.error as string) ?? null, originalAt: new Date(r.original_at as string).toISOString(),
          resolvedAt: r.resolved_at ? new Date(r.resolved_at as string).toISOString() : null,
          decision: {
            outcome: pl?.outcome ?? pl?.decision?.outcome ?? null, reason: pl?.reasonCode ?? pl?.decision?.reason ?? null,
            effect: pl?.decision && typeof pl.decision === 'string' ? pl.decision : pl?.effect ?? null, actionIds: pl?.actionIds ?? null,
          },
        };
      }),
    };
  } catch (e) {
    // Lecture impossible : signalée (jamais un « aucun échec »).
    console.error('[to-process] reprises de traces illisibles :', (e as Error).message);
    return { available: false, counts: { READ_FAILED: 1 }, items: [] };
  }
}

/** Rétention : reprises RÉSOLUES purgées après `jours` (bornée). Ne lève jamais. */
export async function purgeResolvedTraceRetries(jours: number, limite: number): Promise<number> {
  try {
    if (!(await traceRetriesReady())) return 0;
    const r = (await pgClient.unsafe(
      `DELETE FROM to_process_trace_retries WHERE id IN (
         SELECT id FROM to_process_trace_retries WHERE resolved_at IS NOT NULL AND resolved_at < now() - ($1::int * interval '1 day') ORDER BY id LIMIT $2)
       RETURNING id`,
      [jours, limite] as never[],
    )) as unknown as unknown[];
    return r.length;
  } catch { return 0; }
}
