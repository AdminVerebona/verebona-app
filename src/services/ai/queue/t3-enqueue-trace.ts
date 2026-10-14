/**
 * Trace des demandes T3 — PHASE A (création du job) — lot 54A, ticket
 * « [P1] T3 — Aucun job créé dans la File IA en lancement manuel ni en
 * planification » (§10, §11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Une demande T3 (lancement manuel, passage planifié échu, événement) peut ne
 * produire AUCUNE ligne dans `ai_job_queue` : déduplication, contrôle de
 * périmètre, planification non échue ou coupée, échec d'écriture. Avant ce
 * lot, ces issues étaient muettes (`{ decision: 'skip', jobId: null }`) ou
 * même annoncées comme un succès (« passage planifié mis en file » alors que
 * la demande avait été absorbée). Rien ne permettait au PO, sans accès à la
 * base, de distinguer « aucun job créé » de « job créé mais pas affiché ».
 *
 * Chaque demande T3 laisse donc :
 *   · une ligne de journal `[t3-enqueue] clé=valeur …` (toujours) ;
 *   · une ligne `ai_t3_enqueue_events` (migration 0370, best effort : table
 *     absente → journal seul, jamais bloquant), lue par la carte
 *     « Supervision T3 » du BO.
 *
 * La PHASE B (prélèvement, exécution) n'est jamais tracée ici : les deux
 * phases restent distinguées dans les journaux (`[t3-enqueue]` vs `[queue]`
 * / `[t3]`).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Motif d'une demande T3 qui n'a pas créé de job (ou issue particulière). */
export const T3_ENQUEUE_REASONS = [
  'CROSS_ACCOUNT_SCOPE',
  'DUPLICATE_PENDING',
  'DUPLICATE_RUNNING',
  'ALREADY_QUEUED',
  'NO_ELIGIBLE_ACCOUNT',
  'SCHEDULE_NOT_DUE',
  'TRIGGER_DISABLED',
  'INSERT_FAILED',
  'PERSISTENCE_NOT_CONFIRMED',
  'EMERGENCY_STOP',
] as const;
export type T3EnqueueReason = (typeof T3_ENQUEUE_REASONS)[number];

/** Décision tracée : celle de la file, ou un refus / une erreur avant elle. */
export type T3EnqueueDecision = 'create' | 'skip' | 'coalesce' | 'refused' | 'error';

/** Libellés lisibles des motifs (BO, messages d'erreur). */
export const T3_ENQUEUE_REASON_LABEL: Readonly<Record<T3EnqueueReason, string>> = {
  CROSS_ACCOUNT_SCOPE: 'refusée par le contrôle de périmètre (référence d’un autre compte)',
  DUPLICATE_PENDING: 'absorbée par un job automatique équivalent déjà en attente',
  DUPLICATE_RUNNING: 'fusionnée avec un job automatique équivalent en cours (passage supplémentaire demandé)',
  ALREADY_QUEUED: 'déjà mise en file auparavant (continuation idempotente)',
  NO_ELIGIBLE_ACCOUNT: 'compte hors périmètre (ni bien actif ni « À traiter » ouvert, ou inexistant)',
  SCHEDULE_NOT_DUE: 'planification non échue',
  TRIGGER_DISABLED: 'aucune planification T3 active dans la configuration effective',
  INSERT_FAILED: 'écriture en base impossible (erreur technique)',
  PERSISTENCE_NOT_CONFIRMED: 'job introuvable à la relecture après création',
  EMERGENCY_STOP: 'arrêt d’urgence engagé',
};

export interface T3EnqueueTrace {
  origin: 'manual' | 'automatic';
  triggerCode?: string | null;
  accountId?: number | null;
  targetType?: string | null;
  targetId?: string | number | null;
  decision: T3EnqueueDecision;
  reason?: T3EnqueueReason | null;
  jobId?: number | null;
  persisted?: boolean | null;
  /** Étapes du chemin (manuel : requested, scopeEligible, scopeAllowed ; planifié : due). */
  steps?: Record<string, boolean | number | string | null>;
  /** Message technique (erreur), borné. */
  error?: string | null;
}

/** Ligne de journal `[t3-enqueue] clé=valeur …` (pure, testée). */
export function formatT3EnqueueTrace(t: T3EnqueueTrace): string {
  const parts: string[] = [`origin=${t.origin}`];
  if (t.triggerCode) parts.push(`trigger=${t.triggerCode}`);
  if (t.accountId != null) parts.push(`accountId=${t.accountId}`);
  if (t.targetType) parts.push(`target=${t.targetType}:${t.targetId ?? ''}`);
  for (const [k, v] of Object.entries(t.steps ?? {})) parts.push(`${k}=${v}`);
  parts.push(`decision=${t.decision}`);
  if (t.reason) parts.push(`reason=${t.reason}`);
  parts.push(`jobId=${t.jobId ?? 'null'}`);
  if (t.persisted != null) parts.push(`persisted=${t.persisted}`);
  if (t.error) parts.push(`error=${JSON.stringify(t.error.slice(0, 300))}`);
  return `[t3-enqueue] ${parts.join(' ')}`;
}

/** Instance et commit de ce processus (lus paresseusement, jamais bloquants). */
async function identite(): Promise<{ workerId: string | null; commit: string | null }> {
  let workerId: string | null = null;
  let commit: string | null = null;
  try { workerId = (await import('./queue-worker')).WORKER_ID; } catch { /* module indisponible */ }
  try { commit = (await import('@/lib/runtime-identity')).getBuildIdentity().commit; } catch { /* idem */ }
  return { workerId, commit };
}

type Writer = (t: T3EnqueueTrace) => Promise<void>;

const defaultWriter: Writer = async (t) => {
  const { pgClient } = await import('@/db');
  const { workerId, commit } = await identite();
  await pgClient.unsafe(
    `INSERT INTO ai_t3_enqueue_events
       (origin, trigger_code, account_id, target_type, target_id, decision, reason_code, job_id, persisted, worker_id, build_commit, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [
      t.origin, t.triggerCode ?? null, t.accountId ?? null, t.targetType ?? null,
      t.targetId == null ? null : String(t.targetId), t.decision, t.reason ?? null, t.jobId ?? null,
      t.persisted ?? null, workerId, commit,
      JSON.stringify({ ...(t.steps ? { steps: t.steps } : {}), ...(t.error ? { error: t.error.slice(0, 500) } : {}) }),
    ] as never[],
  );
};

let writer: Writer | null = defaultWriter;

/**
 * TESTS UNITAIRES SEULEMENT (`src/test/setup.ts`) : aucune connexion à la
 * base. `undefined` rétablit l'écriture réelle, `null` la coupe.
 */
export function __setT3EnqueueTraceWriterForTests(w: Writer | null | undefined): void {
  writer = w === undefined ? defaultWriter : w;
}

/**
 * Trace une demande T3. Ne lève JAMAIS : la trace ne doit pas faire échouer
 * la demande qu'elle décrit. Journal toujours ; ligne en base si possible.
 */
export async function traceT3Enqueue(t: T3EnqueueTrace): Promise<void> {
  const ligne = formatT3EnqueueTrace(t);
  if (t.decision === 'error' || t.reason === 'PERSISTENCE_NOT_CONFIRMED' || t.reason === 'CROSS_ACCOUNT_SCOPE') console.error(ligne);
  else console.info(ligne);
  if (!writer) return;
  try {
    await writer(t);
  } catch {
    // Table absente (migration 0370 non appliquée), base indisponible : le
    // journal suffit, la supervision le signale.
  }
}

/** Purge des traces de plus de 30 jours (boucleur, au plus une fois par heure). Ne lève jamais. */
export async function purgeT3EnqueueEvents(): Promise<number> {
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `DELETE FROM ai_t3_enqueue_events WHERE created_at < now() - interval '30 days' RETURNING id`, [] as never[],
    )) as unknown as unknown[];
    return rows.length;
  } catch {
    return 0;
  }
}

export interface T3EnqueueEventRow {
  id: number;
  createdAt: string;
  origin: string;
  triggerCode: string | null;
  accountId: number | null;
  targetType: string | null;
  targetId: string | null;
  decision: string;
  reasonCode: string | null;
  reasonLabel: string | null;
  jobId: number | null;
  persisted: boolean | null;
  workerId: string | null;
  buildCommit: string | null;
  error: string | null;
}

/** Dernières demandes T3 (plus récentes d'abord), ou `null` si la table est absente. */
export async function listT3EnqueueEvents(limit = 15): Promise<T3EnqueueEventRow[] | null> {
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT id, created_at, origin, trigger_code, account_id, target_type, target_id, decision, reason_code,
              job_id, persisted, worker_id, build_commit, detail
         FROM ai_t3_enqueue_events ORDER BY id DESC LIMIT $1`,
      [Math.max(1, Math.min(limit, 100))] as never[],
    )) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const reason = r.reason_code == null ? null : String(r.reason_code);
      const detail = (r.detail ?? {}) as { error?: unknown };
      return {
        id: Number(r.id),
        createdAt: new Date(String(r.created_at)).toISOString(),
        origin: String(r.origin),
        triggerCode: r.trigger_code == null ? null : String(r.trigger_code),
        accountId: r.account_id == null ? null : Number(r.account_id),
        targetType: r.target_type == null ? null : String(r.target_type),
        targetId: r.target_id == null ? null : String(r.target_id),
        decision: String(r.decision),
        reasonCode: reason,
        reasonLabel: reason && reason in T3_ENQUEUE_REASON_LABEL ? T3_ENQUEUE_REASON_LABEL[reason as T3EnqueueReason] : null,
        jobId: r.job_id == null ? null : Number(r.job_id),
        persisted: r.persisted == null ? null : Boolean(r.persisted),
        workerId: r.worker_id == null ? null : String(r.worker_id),
        buildCommit: r.build_commit == null ? null : String(r.build_commit),
        error: typeof detail.error === 'string' ? detail.error : null,
      };
    });
  } catch {
    return null;
  }
}
