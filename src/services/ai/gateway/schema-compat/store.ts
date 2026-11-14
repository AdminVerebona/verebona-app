/**
 * Lot 114 (carte #776, §5) — mémoire PARTAGÉE et DURABLE de la compatibilité
 * des schémas (`ai_schema_compatibility`, migration 1710).
 *
 * Chaque écriture est UNE instruction atomique : deux instances qui
 * constatent le même refus n'écrivent qu'un état (pas de délai doublé), et
 * un réexamen dû n'est réservé que par UNE instance (`claimRetest`). Mêmes
 * transitions que `policy.ts` (`applySchemaOutcome`, `claimRetestOf`).
 *
 * Migration absente (42P01 / 42703) : `null` — l'appelant garde sa mémoire
 * locale ; aucune erreur ne remonte à un appel IA.
 */
import { pgClient } from '@/db';
import {
  SCHEMA_COMPAT_POLICY, coupleKeyId,
  type SchemaCompatReason, type SchemaCompatState, type SchemaCoupleKey, type SchemaCoupleState,
} from './policy';

type Row = Record<string, unknown>;

const COLS = `key_id, provider, model, operation_code, contract_id, contract_version, schema_hash, provider_schema_hash, adapter_version,
  state, reason_code, accepted_count, rejection_count, consecutive_rejections, retest_count,
  first_rejected_at, last_rejected_at, last_accepted_at, next_retest_at, retest_claimed_until, last_http_status, last_provider_code,
  policy_version, app_version, created_at, updated_at`;

function absent(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === '42P01' || code === '42703';
}

const ms = (v: unknown): number | null => (v == null ? null : new Date(String(v)).getTime());

export interface SchemaCoupleRow extends SchemaCoupleState {
  firstRejectedAt: number | null;
  lastHttpStatus: number | null;
  lastProviderCode: string | null;
  appVersion: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

function toState(r: Row): SchemaCoupleRow {
  const psh = String(r.provider_schema_hash);
  return {
    keyId: String(r.key_id),
    key: {
      provider: String(r.provider), model: String(r.model), operationCode: String(r.operation_code), contractId: String(r.contract_id),
      contractVersion: Number(r.contract_version), schemaHash: String(r.schema_hash), providerSchemaHash: psh === '-' ? null : psh,
      adapterVersion: String(r.adapter_version),
    },
    state: String(r.state) as SchemaCompatState,
    reason: r.reason_code == null ? null : (String(r.reason_code) as SchemaCompatReason),
    acceptedCount: Number(r.accepted_count), rejectionCount: Number(r.rejection_count), consecutiveRejections: Number(r.consecutive_rejections),
    retestCount: Number(r.retest_count), lastAcceptedAt: ms(r.last_accepted_at), lastRejectedAt: ms(r.last_rejected_at),
    nextRetestAt: ms(r.next_retest_at), retestClaimedUntil: ms(r.retest_claimed_until), policyVersion: Number(r.policy_version),
    firstRejectedAt: ms(r.first_rejected_at), lastHttpStatus: r.last_http_status == null ? null : Number(r.last_http_status),
    lastProviderCode: r.last_provider_code == null ? null : String(r.last_provider_code), appVersion: r.app_version == null ? null : String(r.app_version),
    createdAt: ms(r.created_at), updatedAt: ms(r.updated_at),
  };
}

const identity = (k: SchemaCoupleKey): unknown[] => [
  coupleKeyId(k), k.provider, k.model, k.operationCode, k.contractId, k.contractVersion, k.schemaHash, k.providerSchemaHash ?? '-', k.adapterVersion,
];

const iso = (t: number): string => new Date(t).toISOString();

/** Couples actuellement REFUSÉS (refus mémorisés, réexamens en cours) — réévaluation des alertes. `null` : illisible. */
export async function loadRejectedCouples(): Promise<SchemaCoupleRow[] | null> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT ${COLS} FROM ai_schema_compatibility
        WHERE state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK') ORDER BY updated_at DESC LIMIT 2000`,
    );
    return (rows as unknown as Row[]).map(toState);
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/**
 * États OBSERVÉS que la passerelle doit connaître (refus mémorisés, réexamens, couples qualifiés) — lecture
 * bornée, relue par chaque instance (`SHARED_TTL_MS`). `null` : illisible.
 */
export async function loadKnownCouples(): Promise<SchemaCoupleRow[] | null> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT ${COLS} FROM ai_schema_compatibility
        WHERE state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK', 'QUALIFIED') ORDER BY updated_at DESC LIMIT 2000`,
    );
    return (rows as unknown as Row[]).map(toState);
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/** Matrice de compatibilité (BO) : couples les plus récemment observés, filtres facultatifs. */
export async function listCouples(f: { operationCode?: string | null; model?: string | null; limit?: number } = {}): Promise<SchemaCoupleRow[] | null> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT ${COLS} FROM ai_schema_compatibility
        WHERE ($1::text IS NULL OR operation_code = $1) AND ($2::text IS NULL OR model = $2)
        ORDER BY updated_at DESC LIMIT $3`,
      [f.operationCode ?? null, f.model ?? null, Math.min(Math.max(f.limit ?? 200, 1), 500)] as never[],
    );
    return (rows as unknown as Row[]).map(toState);
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/** Un couple par sa clé ; `null` : inconnu ou table absente. */
export async function getCouple(keyId: string): Promise<SchemaCoupleRow | null> {
  try {
    const rows = await pgClient.unsafe(`SELECT ${COLS} FROM ai_schema_compatibility WHERE key_id = $1`, [keyId] as never[]);
    const r = (rows as unknown as Row[])[0];
    return r ? toState(r) : null;
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

export interface RejectionEvidence { reason: 'EXPLICIT_SCHEMA_REJECTION' | 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA'; httpStatus: number | null; providerCode: string | null; appVersion: string | null }

/**
 * Refus constaté — IDEMPOTENT : un refus déjà mémorisé et non échu n'allonge
 * pas le délai (requêtes concurrentes parties avant la mémorisation). Rend
 * l'état écrit et `transition` (le couple vient de passer en refus).
 */
export async function recordRejection(key: SchemaCoupleKey, ev: RejectionEvidence, now: number): Promise<{ state: SchemaCoupleRow; transition: boolean } | null> {
  const P = SCHEMA_COMPAT_POLICY;
  try {
    const rows = await pgClient.unsafe(
      `WITH prev AS (SELECT state, next_retest_at FROM ai_schema_compatibility WHERE key_id = $1)
       INSERT INTO ai_schema_compatibility AS t
         (key_id, provider, model, operation_code, contract_id, contract_version, schema_hash, provider_schema_hash, adapter_version,
          state, reason_code, rejection_count, consecutive_rejections, first_rejected_at, last_rejected_at, next_retest_at,
          last_http_status, last_provider_code, policy_version, app_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               'REJECTED_CONFIRMED', $10, 1, 1, $11::timestamptz, $11::timestamptz, $11::timestamptz + ($12::bigint * interval '1 millisecond'),
               $13, $14, $15, $16, $11::timestamptz)
       ON CONFLICT (key_id) DO UPDATE SET
         state = 'REJECTED_CONFIRMED', reason_code = EXCLUDED.reason_code,
         rejection_count = t.rejection_count + 1,
         consecutive_rejections = CASE WHEN t.state = 'REJECTED_CONFIRMED' AND t.next_retest_at > $11::timestamptz
                                       THEN t.consecutive_rejections ELSE t.consecutive_rejections + 1 END,
         first_rejected_at = COALESCE(t.first_rejected_at, EXCLUDED.first_rejected_at),
         last_rejected_at = EXCLUDED.last_rejected_at,
         next_retest_at = CASE
           WHEN t.state = 'REJECTED_CONFIRMED' AND t.next_retest_at > $11::timestamptz THEN t.next_retest_at
           WHEN t.consecutive_rejections = 0 AND t.last_accepted_at IS NOT NULL
             THEN $11::timestamptz + ($17::bigint * interval '1 millisecond')
           ELSE $11::timestamptz + (LEAST($18::bigint, $12::bigint * power(2, LEAST(t.consecutive_rejections, 20))::bigint) * interval '1 millisecond') END,
         retest_claimed_until = CASE WHEN t.state = 'REJECTED_CONFIRMED' AND t.next_retest_at > $11::timestamptz THEN t.retest_claimed_until ELSE NULL END,
         last_http_status = EXCLUDED.last_http_status, last_provider_code = EXCLUDED.last_provider_code,
         policy_version = EXCLUDED.policy_version, app_version = EXCLUDED.app_version, updated_at = EXCLUDED.updated_at
       RETURNING ${COLS},
         (SELECT state FROM prev) AS previous_state, (SELECT next_retest_at FROM prev) AS previous_next_retest_at`,
      [...identity(key), ev.reason, iso(now), P.firstRetestMs, ev.httpStatus, ev.providerCode, P.version, ev.appVersion, P.retestAfterQualifiedMs, P.maxRetestMs] as never[],
    );
    const r = (rows as unknown as Row[])[0];
    if (!r) return null;
    const dejaMemorise = r.previous_state === 'REJECTED_CONFIRMED' && (ms(r.previous_next_retest_at) ?? 0) > now;
    return { state: toState(r), transition: !dejaMemorise };
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/** Acceptation d'un appel réel portant le schéma. `previous` : état antérieur (`null` : couple nouveau). */
export async function recordAcceptance(key: SchemaCoupleKey, appVersion: string | null, now: number): Promise<{ state: SchemaCoupleRow; previous: SchemaCompatState | null } | null> {
  try {
    const rows = await pgClient.unsafe(
      `WITH prev AS (SELECT state FROM ai_schema_compatibility WHERE key_id = $1)
       INSERT INTO ai_schema_compatibility AS t
         (key_id, provider, model, operation_code, contract_id, contract_version, schema_hash, provider_schema_hash, adapter_version,
          state, reason_code, accepted_count, last_accepted_at, policy_version, app_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'QUALIFIED', 'ACCEPTED_ON_REAL_CALL', 1, $10::timestamptz, $11, $12, $10::timestamptz)
       ON CONFLICT (key_id) DO UPDATE SET
         state = 'QUALIFIED', reason_code = 'ACCEPTED_ON_REAL_CALL', accepted_count = t.accepted_count + 1,
         consecutive_rejections = 0, last_accepted_at = EXCLUDED.last_accepted_at, next_retest_at = NULL, retest_claimed_until = NULL,
         policy_version = EXCLUDED.policy_version, app_version = EXCLUDED.app_version, updated_at = EXCLUDED.updated_at
       RETURNING ${COLS}, (SELECT state FROM prev) AS previous_state`,
      [...identity(key), iso(now), SCHEMA_COMPAT_POLICY.version, appVersion] as never[],
    );
    const r = (rows as unknown as Row[])[0];
    return r ? { state: toState(r), previous: r.previous_state == null ? null : (String(r.previous_state) as SchemaCompatState) } : null;
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/** Schéma non transmissible (contrôle statique) : état tracé une fois ; jamais d'écrasement d'un état observé. */
export async function recordUnsupported(key: SchemaCoupleKey, staticReason: string, appVersion: string | null, now: number): Promise<boolean> {
  try {
    const rows = await pgClient.unsafe(
      `INSERT INTO ai_schema_compatibility AS t
         (key_id, provider, model, operation_code, contract_id, contract_version, schema_hash, provider_schema_hash, adapter_version,
          state, reason_code, policy_version, app_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'UNSUPPORTED_BY_CONTRACT', $10, $11, $12, $13::timestamptz)
       ON CONFLICT (key_id) DO NOTHING RETURNING key_id`,
      [...identity(key), `STATIC_${staticReason}`.slice(0, 80), SCHEMA_COMPAT_POLICY.version, appVersion, iso(now)] as never[],
    );
    return (rows as unknown as Row[]).length > 0;
  } catch (e) {
    if (absent(e)) return false;
    throw e;
  }
}

/**
 * Réserve le réexamen DÛ d'un couple refusé : UNE instance l'obtient (les
 * autres continuent sans schéma jusqu'à son issue — aucune rafale). Une
 * réservation caduque (instance arrêtée) redevient prenable.
 */
export async function claimRetest(keyId: string, now: number): Promise<SchemaCoupleRow | null> {
  try {
    const rows = await pgClient.unsafe(
      `UPDATE ai_schema_compatibility
          SET state = 'NEEDS_RECHECK', retest_claimed_until = $2::timestamptz + ($3::bigint * interval '1 millisecond'),
              retest_count = retest_count + 1, updated_at = $2::timestamptz
        WHERE key_id = $1 AND state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK')
          AND (next_retest_at IS NULL OR next_retest_at <= $2::timestamptz)
          AND (retest_claimed_until IS NULL OR retest_claimed_until <= $2::timestamptz)
        RETURNING ${COLS}`,
      [keyId, iso(now), SCHEMA_COMPAT_POLICY.retestLeaseMs] as never[],
    );
    const r = (rows as unknown as Row[])[0];
    return r ? toState(r) : null;
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/** Réexamen sans conclusion : réservation rendue, court report ; rien n'est déduit. */
export async function releaseRetest(keyId: string, now: number): Promise<boolean> {
  try {
    const rows = await pgClient.unsafe(
      `UPDATE ai_schema_compatibility
          SET state = 'REJECTED_CONFIRMED', reason_code = 'RETEST_INCONCLUSIVE', retest_claimed_until = NULL,
              next_retest_at = $2::timestamptz + ($3::bigint * interval '1 millisecond'), updated_at = $2::timestamptz
        WHERE key_id = $1 AND state = 'NEEDS_RECHECK' RETURNING key_id`,
      [keyId, iso(now), SCHEMA_COMPAT_POLICY.inconclusiveRetestMs] as never[],
    );
    return (rows as unknown as Row[]).length > 0;
  } catch (e) {
    if (absent(e)) return false;
    throw e;
  }
}
