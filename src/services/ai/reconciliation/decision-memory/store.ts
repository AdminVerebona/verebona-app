/**
 * Mémoire durable des décisions T3 assistées par l'IA — accès base
 * (`t3_decision_memory`, migration 0856), lot 99A.
 *
 * Une entrée ACTIVE par (compte, objet, champ). Une nouvelle décision (contexte
 * changé, relance forcée, nouvelle tentative après échec) remplace l'entrée
 * active dans la MÊME transaction : l'ancienne passe SUPERSEDED avec son motif
 * et le lien vers la nouvelle (traçabilité des invalidations).
 *
 * Tolérant : table absente → `memoryReady()` faux, le moteur fonctionne comme
 * avant le lot 99A (appel IA à chaque ambiguïté).
 */
import { pgClient } from '@/db';
import type { ReconciliationDecision } from '../types';
import type { FingerprintParts } from './fingerprint';

type Row = Record<string, unknown>;

export type MemoryOutcome = 'APPLY' | 'UPDATE' | 'CONFLICT' | 'ABSTAIN' | 'KEEP' | 'AI_FAILED';
export type MemoryAiSource = 'PROVIDER' | 'CACHE' | 'UNAVAILABLE';

export interface MemoryKey {
  accountId: number;
  assetId: number;
  objectType: 'ASSET' | 'EQUIPMENT' | 'ROOM';
  objectId: number;
  fieldKey: string;
}

export interface MemoryEntry {
  id: number;
  fingerprint: string;
  parts: Partial<FingerprintParts>;
  outcome: MemoryOutcome;
  decision: ReconciliationDecision;
  aiSource: MemoryAiSource;
  aiTraceId: string | null;
  retryAfter: Date | null;
  reuseCount: number;
  createdAt: Date;
}

let etat: { ok: boolean; at: number } | null = null;

/** Table 0856 présente et mémoire activée (`T3_DECISION_MEMORY_ENABLED`, défaut 1) ? Ne lève jamais. */
export async function memoryReady(): Promise<boolean> {
  if (process.env.T3_DECISION_MEMORY_ENABLED?.trim() === '0') return false;
  if (etat && (etat.ok || Date.now() - etat.at < 300_000)) return etat.ok;
  let ok = false;
  try {
    const [r] = (await pgClient.unsafe(`SELECT to_regclass('t3_decision_memory') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    ok = r?.ok === true;
  } catch { ok = false; }
  etat = { ok, at: Date.now() };
  return ok;
}

/** Réinitialise la détection de la table (tests). */
export function __resetDecisionMemoryForTests(): void { etat = null; }

const json = <T>(v: unknown, def: T): T => {
  if (v === null || v === undefined) return def;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return def; } }
  return v as T;
};

/** Entrée ACTIVE du champ, ou null. Lève sur une lecture en échec. */
export async function findActiveDecision(k: MemoryKey): Promise<MemoryEntry | null> {
  const [r] = (await pgClient.unsafe(
    `SELECT id, fingerprint, fingerprint_parts, outcome, decision, ai_source, ai_trace_id, retry_after, reuse_count, created_at
       FROM t3_decision_memory
      WHERE account_id = $1 AND object_type = $2 AND object_id = $3 AND field_key = $4 AND status = 'ACTIVE'`,
    [k.accountId, k.objectType, k.objectId, k.fieldKey] as never[],
  )) as unknown as Row[];
  if (!r) return null;
  return {
    id: Number(r.id), fingerprint: String(r.fingerprint), parts: json<Partial<FingerprintParts>>(r.fingerprint_parts, {}),
    outcome: r.outcome as MemoryOutcome, decision: json<ReconciliationDecision>(r.decision, {} as ReconciliationDecision),
    aiSource: r.ai_source as MemoryAiSource, aiTraceId: (r.ai_trace_id as string | null) ?? null,
    retryAfter: r.retry_after ? new Date(r.retry_after as string) : null, reuseCount: Number(r.reuse_count ?? 0),
    createdAt: new Date(r.created_at as string),
  };
}

/** Réutilisation tracée (compteur, date) — l'entrée n'est jamais réécrite. Ne lève jamais. */
export async function noteDecisionReused(id: number): Promise<void> {
  try {
    await pgClient.unsafe(
      `UPDATE t3_decision_memory SET reuse_count = reuse_count + 1, last_reused_at = now() WHERE id = $1`,
      [id] as never[],
    );
  } catch (e) {
    console.error('[t3-decision-memory] réutilisation non tracée (non bloquant) :', (e as Error).message);
  }
}

export interface NewDecision {
  fingerprint: string;
  parts: FingerprintParts;
  operationCode: string;
  aiConfigSignature: string;
  outcome: MemoryOutcome;
  decision: ReconciliationDecision;
  aiSource: MemoryAiSource;
  aiTraceId: string | null;
  forced: boolean;
  forcedReason: string | null;
  retryAfter: Date | null;
  /** Motif d'invalidation de l'entrée active remplacée (codes `REEVALUATION_REASONS`, séparés par des virgules). */
  supersedeReason: string;
}

/**
 * Enregistre une décision : l'entrée active du champ (s'il y en a une) passe
 * SUPERSEDED avec son motif, la nouvelle devient ACTIVE — même transaction.
 * Rend l'identifiant, ou null si une autre exécution a écrit la même entrée
 * entre-temps (index unique partiel). Lève sur une écriture en échec.
 */
export async function recordDecision(k: MemoryKey, d: NewDecision): Promise<number | null> {
  let id: number | null = null;
  await pgClient.begin(async (tx) => {
    const prev = (await tx.unsafe(
      `UPDATE t3_decision_memory SET status = 'SUPERSEDED', superseded_at = now(), superseded_reason = $5
        WHERE account_id = $1 AND object_type = $2 AND object_id = $3 AND field_key = $4 AND status = 'ACTIVE'
        RETURNING id`,
      [k.accountId, k.objectType, k.objectId, k.fieldKey, d.supersedeReason] as never[],
    )) as unknown as Array<{ id: number }>;
    const rows = (await tx.unsafe(
      `INSERT INTO t3_decision_memory (account_id, asset_id, object_type, object_id, field_key, fingerprint, fingerprint_parts,
         operation_code, ai_config_signature, outcome, decision, ai_source, ai_trace_id, forced, forced_reason, retry_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::timestamptz)
       ON CONFLICT (account_id, object_type, object_id, field_key) WHERE status = 'ACTIVE' DO NOTHING
       RETURNING id`,
      [k.accountId, k.assetId, k.objectType, k.objectId, k.fieldKey, d.fingerprint, JSON.stringify(d.parts),
        d.operationCode, d.aiConfigSignature, d.outcome, JSON.stringify(d.decision), d.aiSource, d.aiTraceId,
        d.forced, d.forcedReason, d.retryAfter ? d.retryAfter.toISOString() : null] as never[],
    )) as unknown as Array<{ id: number }>;
    id = rows[0]?.id != null ? Number(rows[0].id) : null;
    if (id != null && prev.length > 0) {
      await tx.unsafe(`UPDATE t3_decision_memory SET superseded_by = $1 WHERE id = ANY($2::bigint[])`,
        [id, prev.map((p) => Number(p.id))] as never[]);
    }
  });
  return id;
}

/**
 * Marqueur de la dernière résolution d'une carte du champ PAR L'UTILISATEUR
 * (arbitrée, complétée ailleurs, déclarée sans objet) — composante `user` de
 * l'empreinte. Les fermetures automatiques (OBSOLETE, objet supprimé) n'en
 * sont pas : elles ne doivent jamais relancer l'IA. Lève sur une lecture en échec.
 */
export async function lastUserResolution(accountId: number, assetId: number, fieldKeys: readonly string[]): Promise<string | null> {
  const [r] = (await pgClient.unsafe(
    `SELECT max(resolved_at) AS at, count(*)::int AS n FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'ASSET' AND target_id = $2 AND field_key = ANY($3::text[])
        AND resolved_at IS NOT NULL AND resolution_reason IN ('USER_ARBITRATED', 'USER_COMPLETED', 'NOT_APPLICABLE')`,
    [accountId, assetId, [...new Set(fieldKeys)]] as never[],
  )) as unknown as Array<{ at: Date | string | null; n: number }>;
  return r?.at ? `${new Date(r.at).toISOString()}#${r.n}` : null;
}

/** Synthèse de la mémoire d'un compte (diagnostic, BO). Table absente → null. */
export async function decisionMemorySummary(accountId: number | null): Promise<{
  active: number; superseded: number; reused: number; byOutcome: Record<string, number>;
} | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT status, outcome, count(*)::int AS n, coalesce(sum(reuse_count), 0)::bigint AS reused
         FROM t3_decision_memory WHERE ($1::int IS NULL OR account_id = $1) GROUP BY status, outcome`,
      [accountId] as never[],
    )) as unknown as Array<{ status: string; outcome: string; n: number; reused: string }>;
    const out = { active: 0, superseded: 0, reused: 0, byOutcome: {} as Record<string, number> };
    for (const r of rows) {
      if (r.status === 'ACTIVE') { out.active += r.n; out.byOutcome[r.outcome] = (out.byOutcome[r.outcome] ?? 0) + r.n; } else out.superseded += r.n;
      out.reused += Number(r.reused) || 0;
    }
    return out;
  } catch (e) {
    if ((e as { code?: string })?.code === '42P01') return null;
    throw e;
  }
}
