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
  policy_version, app_version, created_at, updated_at,
  generation_profile_hash, served_model_version, served_version_at_state, version_uncertain`;

/**
 * Lot 115 (carte #784, §B1) — BORNE du cache partagé relu par chaque instance.
 * Elle ne décide plus de rien : la décision d'un couple absent du cache est
 * prise par une lecture par `key_id` (`getCouple`), et les réévaluations
 * parcourent la table en entier (`scanCouples`). Un refus ancien n'est donc
 * jamais omis parce qu'il est sorti du cache.
 */
export const SHARED_CACHE_LIMIT = 2000;
/** Taille d'une page de parcours exhaustif (par `key_id`, ordre stable). */
export const SCAN_PAGE = 500;

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
      // Lot 115 (#784, A3) : lignes écrites avant ce lot → profil `'-'` (identité historique conservée).
      generationProfileHash: r.generation_profile_hash == null ? '-' : String(r.generation_profile_hash),
    },
    state: String(r.state) as SchemaCompatState,
    reason: r.reason_code == null ? null : (String(r.reason_code) as SchemaCompatReason),
    acceptedCount: Number(r.accepted_count), rejectionCount: Number(r.rejection_count), consecutiveRejections: Number(r.consecutive_rejections),
    retestCount: Number(r.retest_count), lastAcceptedAt: ms(r.last_accepted_at), lastRejectedAt: ms(r.last_rejected_at),
    nextRetestAt: ms(r.next_retest_at), retestClaimedUntil: ms(r.retest_claimed_until), policyVersion: Number(r.policy_version),
    firstRejectedAt: ms(r.first_rejected_at), lastHttpStatus: r.last_http_status == null ? null : Number(r.last_http_status),
    lastProviderCode: r.last_provider_code == null ? null : String(r.last_provider_code), appVersion: r.app_version == null ? null : String(r.app_version),
    createdAt: ms(r.created_at), updatedAt: ms(r.updated_at),
    servedModelVersion: r.served_model_version == null ? null : String(r.served_model_version),
    servedVersionAtState: r.served_version_at_state == null ? null : String(r.served_version_at_state),
    versionUncertain: r.version_uncertain === true,
  };
}

const identity = (k: SchemaCoupleKey): unknown[] => [
  coupleKeyId(k), k.provider, k.model, k.operationCode, k.contractId, k.contractVersion, k.schemaHash, k.providerSchemaHash ?? '-', k.adapterVersion,
  k.generationProfileHash ?? '-',
];

const iso = (t: number): string => new Date(t).toISOString();

/**
 * Couples actuellement REFUSÉS (refus mémorisés, réexamens en cours) —
 * réévaluation des alertes. `null` : illisible.
 *
 * Lot 115 (carte #784, §B1) : la lecture bornée d'origine (2 000 lignes les
 * plus récentes) pouvait OMETTRE un refus ancien. Elle est conservée pour les
 * usages d'affichage, mais la réévaluation passe par `scanCouples`, qui
 * parcourt la table en entier, page par page, sans trou ni doublon.
 */
export async function loadRejectedCouples(limit = SHARED_CACHE_LIMIT): Promise<SchemaCoupleRow[] | null> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT ${COLS} FROM ai_schema_compatibility
        WHERE state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK') ORDER BY updated_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 20_000)] as never[],
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
 *
 * Lot 115 (carte #784, §B1) : `truncated` dit que la table contient PLUS de
 * couples que le cache n'en porte. La passerelle ne conclut alors rien d'une
 * absence : elle lit le couple par `key_id` (`getCouple`) avant de décider.
 */
export async function loadKnownCouples(limit = SHARED_CACHE_LIMIT): Promise<{ rows: SchemaCoupleRow[]; truncated: boolean } | null> {
  const borne = Math.min(Math.max(limit, 1), 20_000);
  try {
    const rows = await pgClient.unsafe(
      `SELECT ${COLS} FROM ai_schema_compatibility
        WHERE state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK', 'QUALIFIED') ORDER BY updated_at DESC LIMIT $1`,
      [borne] as never[],
    );
    const list = (rows as unknown as Row[]).map(toState);
    return { rows: list, truncated: list.length >= borne };
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/** États retenus par un parcours exhaustif. */
export type ScanState = SchemaCompatState;

/**
 * Lot 115 (carte #784, §B1) — PARCOURS EXHAUSTIF, page par page, ordonné par
 * `key_id` (ordre stable, insensible aux mises à jour concurrentes : une
 * actualisation d'`updated_at` ne déplace pas une ligne et ne la fait ni
 * sauter ni compter deux fois). Reprenable : `afterKeyId` est le dernier
 * `key_id` traité. `null` : illisible.
 */
export async function scanCouples(
  f: { states?: readonly ScanState[]; afterKeyId?: string | null; limit?: number } = {},
): Promise<SchemaCoupleRow[] | null> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT ${COLS} FROM ai_schema_compatibility
        WHERE ($1::text[] IS NULL OR state = ANY($1::text[]))
          AND ($2::text IS NULL OR key_id > $2)
        ORDER BY key_id LIMIT $3`,
      [f.states && f.states.length > 0 ? [...f.states] : null, f.afterKeyId ?? null, Math.min(Math.max(f.limit ?? SCAN_PAGE, 1), 2000)] as never[],
    );
    return (rows as unknown as Row[]).map(toState);
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/** Nombre de couples par état (bilan avant / après d'un rattrapage). `null` : illisible. */
export async function countCouples(states?: readonly ScanState[]): Promise<Record<string, number> | null> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT state, COUNT(*)::int AS n FROM ai_schema_compatibility
        WHERE ($1::text[] IS NULL OR state = ANY($1::text[])) GROUP BY state`,
      [states && states.length > 0 ? [...states] : null] as never[],
    );
    return Object.fromEntries((rows as unknown as Row[]).map((r) => [String(r.state), Number(r.n)]));
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

export interface RejectionEvidence {
  reason: 'EXPLICIT_SCHEMA_REJECTION' | 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA';
  httpStatus: number | null;
  providerCode: string | null;
  appVersion: string | null;
  /** Lot 115 (#784, A3) : version de modèle réellement servie, si le fournisseur l'indique. */
  servedModelVersion?: string | null;
}

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
          generation_profile_hash,
          state, reason_code, rejection_count, consecutive_rejections, first_rejected_at, last_rejected_at, next_retest_at,
          last_http_status, last_provider_code, policy_version, app_version, updated_at,
          served_model_version, served_version_at_state, version_uncertain)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               'REJECTED_CONFIRMED', $11, 1, 1, $12::timestamptz, $12::timestamptz, $12::timestamptz + ($13::bigint * interval '1 millisecond'),
               $14, $15, $16, $17, $12::timestamptz,
               $20::text, $20::text, $20::text IS NULL)
       ON CONFLICT (key_id) DO UPDATE SET
         state = 'REJECTED_CONFIRMED', reason_code = EXCLUDED.reason_code,
         rejection_count = t.rejection_count + 1,
         consecutive_rejections = CASE WHEN t.state = 'REJECTED_CONFIRMED' AND t.next_retest_at > $12::timestamptz
                                       THEN t.consecutive_rejections ELSE t.consecutive_rejections + 1 END,
         first_rejected_at = COALESCE(t.first_rejected_at, EXCLUDED.first_rejected_at),
         last_rejected_at = EXCLUDED.last_rejected_at,
         next_retest_at = CASE
           WHEN t.state = 'REJECTED_CONFIRMED' AND t.next_retest_at > $12::timestamptz THEN t.next_retest_at
           WHEN t.consecutive_rejections = 0 AND t.last_accepted_at IS NOT NULL
             THEN $12::timestamptz + ($18::bigint * interval '1 millisecond')
           ELSE $12::timestamptz + (LEAST($19::bigint, $13::bigint * power(2, LEAST(t.consecutive_rejections, 20))::bigint) * interval '1 millisecond') END,
         retest_claimed_until = CASE WHEN t.state = 'REJECTED_CONFIRMED' AND t.next_retest_at > $12::timestamptz THEN t.retest_claimed_until ELSE NULL END,
         last_http_status = EXCLUDED.last_http_status, last_provider_code = EXCLUDED.last_provider_code,
         policy_version = EXCLUDED.policy_version, app_version = EXCLUDED.app_version, updated_at = EXCLUDED.updated_at,
         -- Lot 115 (#784, A3) : version servie du constat ; absente → incertitude marquée, ancienne valeur conservée.
         served_model_version = COALESCE(EXCLUDED.served_model_version, t.served_model_version),
         served_version_at_state = EXCLUDED.served_version_at_state,
         version_uncertain = EXCLUDED.version_uncertain
       RETURNING ${COLS},
         (SELECT state FROM prev) AS previous_state, (SELECT next_retest_at FROM prev) AS previous_next_retest_at`,
      [...identity(key), ev.reason, iso(now), P.firstRetestMs, ev.httpStatus, ev.providerCode, P.version, ev.appVersion,
        P.retestAfterQualifiedMs, P.maxRetestMs, ev.servedModelVersion ?? null] as never[],
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
export async function recordAcceptance(
  key: SchemaCoupleKey, appVersion: string | null, now: number, servedModelVersion: string | null = null,
): Promise<{ state: SchemaCoupleRow; previous: SchemaCompatState | null } | null> {
  try {
    const rows = await pgClient.unsafe(
      `WITH prev AS (SELECT state FROM ai_schema_compatibility WHERE key_id = $1)
       INSERT INTO ai_schema_compatibility AS t
         (key_id, provider, model, operation_code, contract_id, contract_version, schema_hash, provider_schema_hash, adapter_version,
          generation_profile_hash,
          state, reason_code, accepted_count, last_accepted_at, policy_version, app_version, updated_at,
          served_model_version, served_version_at_state, version_uncertain)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'QUALIFIED', 'ACCEPTED_ON_REAL_CALL', 1, $11::timestamptz, $12, $13, $11::timestamptz,
               $14::text, $14::text, $14::text IS NULL)
       ON CONFLICT (key_id) DO UPDATE SET
         state = 'QUALIFIED', reason_code = 'ACCEPTED_ON_REAL_CALL', accepted_count = t.accepted_count + 1,
         consecutive_rejections = 0, last_accepted_at = EXCLUDED.last_accepted_at, next_retest_at = NULL, retest_claimed_until = NULL,
         policy_version = EXCLUDED.policy_version, app_version = EXCLUDED.app_version, updated_at = EXCLUDED.updated_at,
         served_model_version = COALESCE(EXCLUDED.served_model_version, t.served_model_version),
         served_version_at_state = EXCLUDED.served_version_at_state,
         version_uncertain = EXCLUDED.version_uncertain
       RETURNING ${COLS}, (SELECT state FROM prev) AS previous_state`,
      [...identity(key), iso(now), SCHEMA_COMPAT_POLICY.version, appVersion, servedModelVersion] as never[],
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
          generation_profile_hash, state, reason_code, policy_version, app_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'UNSUPPORTED_BY_CONTRACT', $11, $12, $13, $14::timestamptz)
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

/**
 * Lot 115 (carte #784, §A3) — VERSION SERVIE observée pour un couple déjà
 * connu (instruction unique, atomique) :
 *   · version absente → `version_uncertain` seulement (rien n'est déduit) ;
 *   · version DIFFÉRENTE de celle du dernier constat, sur un couple refusé →
 *     le refus ne concerne plus la version servie : le prochain essai avec
 *     schéma devient dû (`SERVED_VERSION_CHANGED`), un seul et réservé comme
 *     les autres. L'état reste « refusé » : aucune compatibilité déclarée.
 * Un couple inconnu n'est PAS créé ici. Rend l'état écrit, ou `null`.
 */
export async function noteServedModelVersion(keyId: string, servedModelVersion: string | null, now: number): Promise<SchemaCoupleRow | null> {
  try {
    const rows = await pgClient.unsafe(
      `UPDATE ai_schema_compatibility SET
          served_model_version = COALESCE($2::text, served_model_version),
          -- Version inconnue au moment du constat : celle observée dans le MÊME appel devient la référence.
          served_version_at_state = COALESCE(served_version_at_state, $2::text),
          version_uncertain = ($2::text IS NULL),
          reason_code = CASE WHEN $2::text IS NOT NULL AND served_version_at_state IS NOT NULL AND served_version_at_state <> $2::text
                               AND state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK')
                             THEN 'SERVED_VERSION_CHANGED' ELSE reason_code END,
          next_retest_at = CASE WHEN $2::text IS NOT NULL AND served_version_at_state IS NOT NULL AND served_version_at_state <> $2::text
                                  AND state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK')
                                THEN $3::timestamptz ELSE next_retest_at END,
          retest_claimed_until = CASE WHEN $2::text IS NOT NULL AND served_version_at_state IS NOT NULL AND served_version_at_state <> $2::text
                                        AND state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK')
                                      THEN NULL ELSE retest_claimed_until END,
          updated_at = $3::timestamptz
        WHERE key_id = $1
          AND (version_uncertain <> ($2::text IS NULL) OR COALESCE(served_model_version, '') <> COALESCE($2::text, '')
               OR (served_version_at_state IS NULL AND $2::text IS NOT NULL))
        RETURNING ${COLS}`,
      [keyId, servedModelVersion, iso(now)] as never[],
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

// ── Carte #838 (A1, A3) — BAIL DE QUALIFICATION d'un couple ─────────────────

/** Nature d'un essai de qualification réservé. */
export type QualificationKind = 'FIRST' | 'REQUALIFY';

/**
 * Issue d'une demande de bail :
 *   · `claimed`     cette instance tient le bail (`token`) jusqu'à `until` ;
 *   · `busy`        une autre instance le tient (ou l'essai n'est plus dû) ;
 *   · `unsupported` colonnes de la migration 1980 absentes (retour arrière) :
 *                   l'appelant revient au comportement antérieur, signalé.
 * Une panne de lecture/écriture LÈVE : l'appelant la distingue d'un refus.
 */
export type QualificationClaim =
  | { status: 'claimed'; token: string; until: number; attempts: number }
  | { status: 'busy'; until: number | null }
  | { status: 'unsupported' };

/**
 * Réserve ATOMIQUEMENT l'essai de qualification d'un couple (instruction
 * unique, à l'échelle de la clé exacte du couple — aucun verrou global) :
 *   · `FIRST`     couple jamais testé (absent, `NOT_TESTED` ou statique) :
 *                 la ligne est créée `NOT_TESTED` si besoin, bail posé ;
 *   · `REQUALIFY` couple `QUALIFIED` dont la requalification est DUE
 *                 (`next_retest_at` échu, ou qualification à version servie
 *                 incertaine plus ancienne que `uncertainTtlMs`).
 * Un bail échu (instance arrêtée) est reprenable ; un bail vivant ne l'est pas.
 */
export async function claimQualification(
  key: SchemaCoupleKey, kind: QualificationKind, now: number,
  opts: { leaseMs?: number; uncertainTtlMs?: number; token?: string } = {},
): Promise<QualificationClaim> {
  const P = SCHEMA_COMPAT_POLICY;
  const token = opts.token ?? (await import('crypto')).randomUUID();
  const leaseMs = opts.leaseMs ?? P.qualificationLeaseMs;
  try {
    const rows = await pgClient.unsafe(
      `INSERT INTO ai_schema_compatibility AS t
         (key_id, provider, model, operation_code, contract_id, contract_version, schema_hash, provider_schema_hash, adapter_version,
          generation_profile_hash, state, policy_version, updated_at,
          qualification_claim_token, qualification_claimed_until, qualification_attempts)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'NOT_TESTED', $14, $12::timestamptz,
              $11, $12::timestamptz + ($13::bigint * interval '1 millisecond'), 1
        WHERE $15::text = 'FIRST'
       ON CONFLICT (key_id) DO UPDATE SET
         qualification_claim_token = EXCLUDED.qualification_claim_token,
         qualification_claimed_until = EXCLUDED.qualification_claimed_until,
         qualification_attempts = t.qualification_attempts + 1,
         updated_at = EXCLUDED.updated_at
        WHERE (t.qualification_claimed_until IS NULL OR t.qualification_claimed_until <= $12::timestamptz)
          AND t.state IN ('NOT_TESTED', 'UNSUPPORTED_BY_CONTRACT')
       RETURNING qualification_claim_token, qualification_claimed_until, qualification_attempts`,
      [...identity(key), token, iso(now), leaseMs, P.version, kind] as never[],
    );
    let r = (rows as unknown as Row[])[0];
    if (!r && kind === 'REQUALIFY') {
      const up = await pgClient.unsafe(
        `UPDATE ai_schema_compatibility AS t SET
            qualification_claim_token = $2, qualification_claimed_until = $3::timestamptz + ($4::bigint * interval '1 millisecond'),
            qualification_attempts = t.qualification_attempts + 1, updated_at = $3::timestamptz
          WHERE t.key_id = $1 AND t.state = 'QUALIFIED'
            AND (t.qualification_claimed_until IS NULL OR t.qualification_claimed_until <= $3::timestamptz)
            AND ((t.next_retest_at IS NOT NULL AND t.next_retest_at <= $3::timestamptz)
                 OR (t.next_retest_at IS NULL AND t.version_uncertain AND t.last_accepted_at IS NOT NULL
                     AND t.last_accepted_at <= $3::timestamptz - ($5::bigint * interval '1 millisecond')))
          RETURNING qualification_claim_token, qualification_claimed_until, qualification_attempts`,
        [coupleKeyId(key), token, iso(now), leaseMs, opts.uncertainTtlMs ?? P.uncertainQualificationTtlMs] as never[],
      );
      r = (up as unknown as Row[])[0];
    }
    if (r && String(r.qualification_claim_token) === token) {
      return { status: 'claimed', token, until: ms(r.qualification_claimed_until) ?? now + leaseMs, attempts: Number(r.qualification_attempts) };
    }
    const cur = (await pgClient.unsafe(
      `SELECT qualification_claimed_until FROM ai_schema_compatibility WHERE key_id = $1`, [coupleKeyId(key)] as never[],
    )) as unknown as Row[];
    return { status: 'busy', until: ms(cur[0]?.qualification_claimed_until) };
  } catch (e) {
    if (absent(e)) return { status: 'unsupported' };
    throw e;
  }
}

/**
 * Rend le bail de qualification (FENCING : seul le détenteur du jeton le
 * rend). `inconclusive` : l'essai n'a rien établi (délai, réseau, quota) —
 * une requalification est alors reportée de `inconclusiveRetestMs` (jamais à
 * chaque requête) ; un premier essai redevient simplement prenable.
 * Rend `true` si le bail était encore tenu par ce jeton.
 */
export async function releaseQualification(keyId: string, token: string, now: number, inconclusive: boolean): Promise<boolean> {
  try {
    const rows = await pgClient.unsafe(
      `UPDATE ai_schema_compatibility SET
          qualification_claim_token = NULL, qualification_claimed_until = NULL, updated_at = $3::timestamptz,
          next_retest_at = CASE WHEN $4::boolean AND state = 'QUALIFIED'
                                THEN $3::timestamptz + ($5::bigint * interval '1 millisecond') ELSE next_retest_at END
        WHERE key_id = $1 AND qualification_claim_token = $2
        RETURNING key_id`,
      [keyId, token, iso(now), inconclusive, SCHEMA_COMPAT_POLICY.inconclusiveRetestMs] as never[],
    );
    return (rows as unknown as Row[]).length > 0;
  } catch (e) {
    if (absent(e)) return false;
    throw e;
  }
}
