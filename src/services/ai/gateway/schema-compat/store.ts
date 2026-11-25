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
 *
 * Carte #863 (P1-A1) — FENCING DES RÉSULTATS : une issue d'appel n'est
 * appliquée à l'état courant que si elle est OPPOSABLE, vérifié dans la même
 * instruction que l'écriture :
 *   · issue d'un essai RÉSERVÉ (premier essai, requalification, réexamen) :
 *     le jeton du bail doit être celui de la ligne ET le bail encore valide —
 *     un ancien détenteur (bail expiré, repris par une autre instance) ne
 *     modifie plus ni l'état, ni le cache, ni les alertes ;
 *   · issue d'un appel ordinaire (sans bail) : la génération de l'état
 *     (`state_generation`, migration 2000) doit être celle observée à la
 *     décision — un constat tardif n'écrase pas une transition écrite
 *     entre-temps par une autre instance.
 * Une issue écartée n'est jamais perdue : elle est journalisée dans
 * `ai_schema_compat_observations` avec la cause de son écartement.
 */
import { pgClient } from '@/db';
import {
  SCHEMA_COMPAT_POLICY, coupleKeyId,
  type SchemaCompatReason, type SchemaCompatState, type SchemaCoupleKey, type SchemaCoupleState,
} from './policy';

type Row = Record<string, unknown>;

const COLS_BASE = `key_id, provider, model, operation_code, contract_id, contract_version, schema_hash, provider_schema_hash, adapter_version,
  state, reason_code, accepted_count, rejection_count, consecutive_rejections, retest_count,
  first_rejected_at, last_rejected_at, last_accepted_at, next_retest_at, retest_claimed_until, last_http_status, last_provider_code,
  policy_version, app_version, created_at, updated_at,
  generation_profile_hash, served_model_version, served_version_at_state, version_uncertain`;

/**
 * Carte #863 (A1) — colonne de génération (migration 2000) : sondée à la première lecture. Absente (retour
 * arrière) : lectures et écritures reviennent, de façon signalée, au fencing par le seul jeton de bail (#838).
 */
let generationColumn: boolean | null = null;
const COLS_SQL = (): string => (generationColumn === false ? COLS_BASE : `${COLS_BASE}, state_generation`);
/** Réservé aux tests : oublie la sonde de la colonne de génération. */
export function __resetStoreProbesForTests(): void { generationColumn = null; observationsTable = null; }

/** Exécute une lecture/écriture ; une colonne de génération absente (42703) bascule une fois sur le schéma antérieur. */
async function withGeneration<T>(run: (gen: boolean) => Promise<T>): Promise<T> {
  const avec = generationColumn !== false;
  try {
    const r = await run(avec);
    if (avec && generationColumn === null) generationColumn = true;
    return r;
  } catch (e) {
    if (avec && (e as { code?: string } | null)?.code === '42703' && /state_generation/.test(String((e as Error)?.message ?? ''))) {
      generationColumn = false;
      console.warn('[schema-compat] migration 2000 absente : génération d\'état non disponible — fencing par jeton de bail seulement (comportement #838).');
      return run(false);
    }
    throw e;
  }
}

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
    // Carte #863 (A1) : génération de l'état (migration 2000) ; absente : `null` (fencing par jeton seulement).
    generation: r.state_generation == null ? null : Number(r.state_generation),
  };
}

const identity = (k: SchemaCoupleKey): unknown[] => [
  coupleKeyId(k), k.provider, k.model, k.operationCode, k.contractId, k.contractVersion, k.schemaHash, k.providerSchemaHash ?? '-', k.adapterVersion,
  k.generationProfileHash ?? '-',
];

const iso = (t: number): string => new Date(t).toISOString();

/** Paramètres positionnels construits au fil de la requête (aucun paramètre inutilisé). */
function params(): { vals: unknown[]; p: (v: unknown, cast?: string) => string } {
  const vals: unknown[] = [];
  return { vals, p: (v, cast = '') => { vals.push(v); return `$${vals.length}${cast}`; } };
}

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
    const rows = await withGeneration(() => pgClient.unsafe(
      `SELECT ${COLS_SQL()} FROM ai_schema_compatibility
        WHERE state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK') ORDER BY updated_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 20_000)] as never[],
    ));
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
    const rows = await withGeneration(() => pgClient.unsafe(
      `SELECT ${COLS_SQL()} FROM ai_schema_compatibility
        WHERE state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK', 'QUALIFIED') ORDER BY updated_at DESC LIMIT $1`,
      [borne] as never[],
    ));
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
    const rows = await withGeneration(() => pgClient.unsafe(
      `SELECT ${COLS_SQL()} FROM ai_schema_compatibility
        WHERE ($1::text[] IS NULL OR state = ANY($1::text[]))
          AND ($2::text IS NULL OR key_id > $2)
        ORDER BY key_id LIMIT $3`,
      [f.states && f.states.length > 0 ? [...f.states] : null, f.afterKeyId ?? null, Math.min(Math.max(f.limit ?? SCAN_PAGE, 1), 2000)] as never[],
    ));
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
    const rows = await withGeneration(() => pgClient.unsafe(
      `SELECT ${COLS_SQL()} FROM ai_schema_compatibility
        WHERE ($1::text IS NULL OR operation_code = $1) AND ($2::text IS NULL OR model = $2)
        ORDER BY updated_at DESC LIMIT $3`,
      [f.operationCode ?? null, f.model ?? null, Math.min(Math.max(f.limit ?? 200, 1), 500)] as never[],
    ));
    return (rows as unknown as Row[]).map(toState);
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/** Un couple par sa clé ; `null` : inconnu ou table absente. */
export async function getCouple(keyId: string): Promise<SchemaCoupleRow | null> {
  try {
    const rows = await withGeneration(() => pgClient.unsafe(`SELECT ${COLS_SQL()} FROM ai_schema_compatibility WHERE key_id = $1`, [keyId] as never[]));
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
 * Carte #863 (A1) — CONDITION D'OPPOSABILITÉ d'une issue d'appel portant le
 * schéma, vérifiée dans la même instruction que l'écriture :
 *   · `token`      issue d'un essai RÉSERVÉ : le jeton doit être celui de la
 *                  ligne et le bail encore valide à l'instant de l'issue ;
 *   · `generation` issue d'un appel ORDINAIRE : génération observée à la
 *                  décision (`null` : inconnue — seule une écriture sans
 *                  transition reste alors opposable) ;
 *   · `qualificationKind` (`FIRST`, `REQUALIFY`, `RETEST`) : tracé avec
 *                  l'observation.
 * Sans `fence` (appelants antérieurs, recette) : écriture inconditionnelle,
 * comportement #838.
 */
export interface OutcomeFence {
  token?: string | null;
  generation?: number | null;
  qualificationKind?: string | null;
}

/** Cause d'écartement d'une issue non opposable (codes stables). */
export type FenceCause = 'LEASE_TOKEN_MISMATCH' | 'LEASE_EXPIRED' | 'STALE_GENERATION' | 'STATE_CHANGED' | 'COUPLE_ABSENT';

/** Issue d'une écriture fencée : appliquée, ou écartée (état courant inchangé, observation conservée). */
export type FencedOutcome<T extends object> =
  | AppliedOutcome<T>
  | { applied: false; cause: FenceCause; state: SchemaCoupleRow | null; transition: false; previous: null };
/** Issue appliquée (`applied` absent : magasin antérieur à la carte #863 — toujours appliquée). */
export type AppliedOutcome<T extends object> = T & { applied?: true; state: SchemaCoupleRow };
type RejectionWrite = { transition: boolean; previous?: SchemaCompatState | null };
type AcceptanceWrite = { previous: SchemaCompatState | null; transition?: boolean };

/** Lecture de la ligne de bail d'un couple (cause d'un écartement). */
async function fenceCauseOf(keyId: string, fence: OutcomeFence, _now: number): Promise<{ cause: FenceCause; state: SchemaCoupleRow | null }> {
  const state = await getCouple(keyId).catch(() => null);
  if (!state) return { cause: 'COUPLE_ABSENT', state: null };
  if (fence.token) {
    const r = ((await pgClient.unsafe(
      `SELECT qualification_claim_token, qualification_claimed_until FROM ai_schema_compatibility WHERE key_id = $1`, [keyId] as never[],
    ).catch(() => [])) as unknown as Row[])[0];
    const tok = r?.qualification_claim_token == null ? null : String(r.qualification_claim_token);
    // Jeton identique : la condition n'a pu échouer que sur la validité du bail (échu à l'instant de l'issue).
    return { cause: tok !== fence.token ? 'LEASE_TOKEN_MISMATCH' : 'LEASE_EXPIRED', state };
  }
  if (fence.generation != null && state.generation != null && state.generation !== fence.generation) return { cause: 'STALE_GENERATION', state };
  return { cause: 'STATE_CHANGED', state };
}

/** Clause d'opposabilité SQL (sur l'alias `t`). `kind` : issue à écrire. */
function fenceClause(fence: OutcomeFence, kind: 'ACCEPTED' | 'REJECTED', nowParam: string, p: (v: unknown, cast?: string) => string, gen: boolean): string {
  if (fence.token) {
    return `(t.qualification_claim_token = ${p(fence.token, '::text')} AND t.qualification_claimed_until > ${nowParam})`;
  }
  if (kind === 'ACCEPTED') {
    // Une acceptation SANS bail n'est jamais une transition : elle renouvelle seulement un couple déjà qualifié.
    return `(t.state = 'QUALIFIED')`;
  }
  // Un refus SANS bail : couple déjà refusé (constat idempotent), ou état inchangé depuis la décision.
  if (gen && fence.generation != null) return `(t.state = 'REJECTED_CONFIRMED' OR t.state_generation = ${p(fence.generation, '::bigint')})`;
  return `(t.state IN ('REJECTED_CONFIRMED', 'QUALIFIED'))`;
}

/** Carte #863 (A1) — journal des issues (opposables ou non). Table 2000 absente : rien (signalé une fois). */
let observationsTable: boolean | null = null;
export async function recordObservation(o: {
  keyId: string; outcome: 'ACCEPTED' | 'REJECTED' | 'INCONCLUSIVE'; reason?: string | null; httpStatus?: number | null; providerCode?: string | null;
  servedModelVersion?: string | null; qualificationKind?: string | null; opposable: boolean; fenceCause?: string | null;
  generation?: number | null; appVersion?: string | null; now: number;
}): Promise<boolean> {
  if (observationsTable === false) return false;
  try {
    await pgClient.unsafe(
      `INSERT INTO ai_schema_compat_observations (key_id, outcome, reason_code, http_status, provider_code, served_model_version,
         qualification_kind, opposable, fence_cause, decision_generation, app_version, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)`,
      [o.keyId, o.outcome, o.reason ?? null, o.httpStatus ?? null, o.providerCode ?? null, o.servedModelVersion ?? null,
        o.qualificationKind ?? null, o.opposable, o.fenceCause ?? null, o.generation ?? null, o.appVersion ?? null, iso(o.now)] as never[],
    );
    observationsTable = true;
    return true;
  } catch (e) {
    if (absent(e)) { observationsTable = false; return false; }
    throw e;
  }
}

/**
 * Refus constaté — IDEMPOTENT : un refus déjà mémorisé et non échu n'allonge
 * pas le délai (requêtes concurrentes parties avant la mémorisation). Rend
 * l'état écrit et `transition` (le couple vient de passer en refus).
 *
 * Carte #863 (A1) : avec `fence`, le refus n'est écrit que s'il est
 * OPPOSABLE (`OutcomeFence`) ; sinon `applied: false`, l'état courant est
 * rendu tel quel et le refus est journalisé comme observation non opposable.
 */
export async function recordRejection(key: SchemaCoupleKey, ev: RejectionEvidence, now: number): Promise<AppliedOutcome<RejectionWrite> | null>;
export async function recordRejection(key: SchemaCoupleKey, ev: RejectionEvidence, now: number, fence: OutcomeFence | null | undefined): Promise<FencedOutcome<RejectionWrite> | null>;
export async function recordRejection(
  key: SchemaCoupleKey, ev: RejectionEvidence, now: number, fence?: OutcomeFence | null,
): Promise<FencedOutcome<RejectionWrite> | null> {
  const P = SCHEMA_COMPAT_POLICY;
  const keyId = coupleKeyId(key);
  try {
    const rows = await withGeneration((gen) => {
      const { vals, p } = params();
      // Issue fencée : UPDATE par clé seulement (aucun paramètre d'identité inutilisé).
      const id = fence ? [p(coupleKeyId(key))] : identity(key).map((v) => p(v));
      const N = p(iso(now), '::timestamptz');
      const R = p(ev.reason); const H = p(ev.httpStatus); const PC = p(ev.providerCode); const PV = p(P.version); const AV = p(ev.appVersion);
      const SV = p(ev.servedModelVersion ?? null, '::text');
      const F = p(P.firstRetestMs, '::bigint'); const AQ = p(P.retestAfterQualifiedMs, '::bigint'); const MX = p(P.maxRetestMs, '::bigint');
      const deja = `t.state = 'REJECTED_CONFIRMED' AND t.next_retest_at > ${N}`;
      const set = `
         state = 'REJECTED_CONFIRMED', reason_code = ${R},
         rejection_count = t.rejection_count + 1,
         consecutive_rejections = CASE WHEN ${deja} THEN t.consecutive_rejections ELSE t.consecutive_rejections + 1 END,
         first_rejected_at = COALESCE(t.first_rejected_at, ${N}),
         last_rejected_at = ${N},
         next_retest_at = CASE
           WHEN ${deja} THEN t.next_retest_at
           WHEN t.consecutive_rejections = 0 AND t.last_accepted_at IS NOT NULL THEN ${N} + (${AQ} * interval '1 millisecond')
           ELSE ${N} + (LEAST(${MX}, ${F} * power(2, LEAST(t.consecutive_rejections, 20))::bigint) * interval '1 millisecond') END,
         retest_claimed_until = CASE WHEN ${deja} THEN t.retest_claimed_until ELSE NULL END,
         last_http_status = ${H}, last_provider_code = ${PC},
         policy_version = ${PV}, app_version = ${AV}, updated_at = ${N},
         -- Lot 115 (#784, A3) : version servie du constat ; absente → incertitude marquée, ancienne valeur conservée.
         served_model_version = COALESCE(${SV}, t.served_model_version),
         served_version_at_state = ${SV},
         version_uncertain = (${SV} IS NULL)
         ${gen ? `, state_generation = t.state_generation + CASE WHEN t.state <> 'REJECTED_CONFIRMED' THEN 1 ELSE 0 END` : ''}`;
      if (fence) {
        // Carte #863 (A1) : UPDATE conditionnel — aucune création de ligne par une issue fencée, et la
        // condition d'opposabilité est évaluée sur la version VERROUILLÉE de la ligne.
        const cond = fenceClause(fence, 'REJECTED', N, p, gen);
        return pgClient.unsafe(
          `WITH prev AS (SELECT state, next_retest_at FROM ai_schema_compatibility WHERE key_id = ${id[0]})
           UPDATE ai_schema_compatibility AS t SET ${set}
            WHERE t.key_id = ${id[0]} AND ${cond}
           RETURNING ${COLS_SQL()}, (SELECT state FROM prev) AS previous_state, (SELECT next_retest_at FROM prev) AS previous_next_retest_at`,
          vals as never[],
        );
      }
      return pgClient.unsafe(
        `WITH prev AS (SELECT state, next_retest_at FROM ai_schema_compatibility WHERE key_id = ${id[0]})
         INSERT INTO ai_schema_compatibility AS t
           (key_id, provider, model, operation_code, contract_id, contract_version, schema_hash, provider_schema_hash, adapter_version,
            generation_profile_hash,
            state, reason_code, rejection_count, consecutive_rejections, first_rejected_at, last_rejected_at, next_retest_at,
            last_http_status, last_provider_code, policy_version, app_version, updated_at,
            served_model_version, served_version_at_state, version_uncertain${gen ? ', state_generation' : ''})
         VALUES (${id.join(', ')},
                 'REJECTED_CONFIRMED', ${R}, 1, 1, ${N}, ${N}, ${N} + (${F} * interval '1 millisecond'),
                 ${H}, ${PC}, ${PV}, ${AV}, ${N},
                 ${SV}, ${SV}, ${SV} IS NULL${gen ? ', 1' : ''})
         ON CONFLICT (key_id) DO UPDATE SET ${set}
         RETURNING ${COLS_SQL()},
           (SELECT state FROM prev) AS previous_state, (SELECT next_retest_at FROM prev) AS previous_next_retest_at`,
        vals as never[],
      );
    });
    const r = (rows as unknown as Row[])[0];
    if (!r) {
      if (!fence) return null;
      const why = await fenceCauseOf(keyId, fence, now);
      await recordObservation({
        keyId, outcome: 'REJECTED', reason: ev.reason, httpStatus: ev.httpStatus, providerCode: ev.providerCode, servedModelVersion: ev.servedModelVersion ?? null,
        qualificationKind: fence.qualificationKind ?? null, opposable: false, fenceCause: why.cause, generation: fence.generation ?? null, appVersion: ev.appVersion, now,
      }).catch(() => false);
      return { applied: false, cause: why.cause, state: why.state, transition: false, previous: null };
    }
    const dejaMemorise = r.previous_state === 'REJECTED_CONFIRMED' && (ms(r.previous_next_retest_at) ?? 0) > now;
    if (fence) {
      await recordObservation({
        keyId, outcome: 'REJECTED', reason: ev.reason, httpStatus: ev.httpStatus, providerCode: ev.providerCode, servedModelVersion: ev.servedModelVersion ?? null,
        qualificationKind: fence.qualificationKind ?? null, opposable: true, generation: fence.generation ?? null, appVersion: ev.appVersion, now,
      }).catch(() => false);
    }
    return {
      applied: true, state: toState(r), transition: !dejaMemorise,
      previous: r.previous_state == null ? null : (String(r.previous_state) as SchemaCompatState),
    };
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/**
 * Acceptation d'un appel réel portant le schéma. `previous` : état antérieur (`null` : couple nouveau).
 * Carte #863 (A1) : avec `fence`, écrite seulement si OPPOSABLE (voir `recordRejection`).
 */
export async function recordAcceptance(key: SchemaCoupleKey, appVersion: string | null, now: number, servedModelVersion?: string | null): Promise<AppliedOutcome<AcceptanceWrite> | null>;
export async function recordAcceptance(
  key: SchemaCoupleKey, appVersion: string | null, now: number, servedModelVersion: string | null | undefined, fence: OutcomeFence | null | undefined,
): Promise<FencedOutcome<AcceptanceWrite> | null>;
export async function recordAcceptance(
  key: SchemaCoupleKey, appVersion: string | null, now: number, servedModelVersion: string | null = null, fence?: OutcomeFence | null,
): Promise<FencedOutcome<AcceptanceWrite> | null> {
  const keyId = coupleKeyId(key);
  try {
    const rows = await withGeneration((gen) => {
      const { vals, p } = params();
      // Issue fencée : UPDATE par clé seulement (aucun paramètre d'identité inutilisé).
      const id = fence ? [p(coupleKeyId(key))] : identity(key).map((v) => p(v));
      const N = p(iso(now), '::timestamptz');
      const PV = p(SCHEMA_COMPAT_POLICY.version); const AV = p(appVersion); const SV = p(servedModelVersion, '::text');
      const set = `
         state = 'QUALIFIED', reason_code = 'ACCEPTED_ON_REAL_CALL', accepted_count = t.accepted_count + 1,
         consecutive_rejections = 0, last_accepted_at = ${N}, next_retest_at = NULL, retest_claimed_until = NULL,
         policy_version = ${PV}, app_version = ${AV}, updated_at = ${N},
         served_model_version = COALESCE(${SV}, t.served_model_version),
         served_version_at_state = ${SV},
         version_uncertain = (${SV} IS NULL)
         ${gen ? `, state_generation = t.state_generation + CASE WHEN t.state <> 'QUALIFIED' THEN 1 ELSE 0 END` : ''}`;
      if (fence) {
        const cond = fenceClause(fence, 'ACCEPTED', N, p, gen);
        return pgClient.unsafe(
          `WITH prev AS (SELECT state FROM ai_schema_compatibility WHERE key_id = ${id[0]})
           UPDATE ai_schema_compatibility AS t SET ${set}
            WHERE t.key_id = ${id[0]} AND ${cond}
           RETURNING ${COLS_SQL()}, (SELECT state FROM prev) AS previous_state`,
          vals as never[],
        );
      }
      return pgClient.unsafe(
        `WITH prev AS (SELECT state FROM ai_schema_compatibility WHERE key_id = ${id[0]})
         INSERT INTO ai_schema_compatibility AS t
           (key_id, provider, model, operation_code, contract_id, contract_version, schema_hash, provider_schema_hash, adapter_version,
            generation_profile_hash,
            state, reason_code, accepted_count, last_accepted_at, policy_version, app_version, updated_at,
            served_model_version, served_version_at_state, version_uncertain${gen ? ', state_generation' : ''})
         VALUES (${id.join(', ')}, 'QUALIFIED', 'ACCEPTED_ON_REAL_CALL', 1, ${N}, ${PV}, ${AV}, ${N},
                 ${SV}, ${SV}, ${SV} IS NULL${gen ? ', 1' : ''})
         ON CONFLICT (key_id) DO UPDATE SET ${set}
         RETURNING ${COLS_SQL()}, (SELECT state FROM prev) AS previous_state`,
        vals as never[],
      );
    });
    const r = (rows as unknown as Row[])[0];
    if (!r) {
      if (!fence) return null;
      const why = await fenceCauseOf(keyId, fence, now);
      await recordObservation({
        keyId, outcome: 'ACCEPTED', servedModelVersion, qualificationKind: fence.qualificationKind ?? null, opposable: false,
        fenceCause: why.cause, generation: fence.generation ?? null, appVersion, now,
      }).catch(() => false);
      return { applied: false, cause: why.cause, state: why.state, transition: false, previous: null };
    }
    if (fence) {
      await recordObservation({
        keyId, outcome: 'ACCEPTED', servedModelVersion, qualificationKind: fence.qualificationKind ?? null, opposable: true,
        generation: fence.generation ?? null, appVersion, now,
      }).catch(() => false);
    }
    const previous = r.previous_state == null ? null : (String(r.previous_state) as SchemaCompatState);
    return { applied: true, state: toState(r), previous, transition: previous !== 'QUALIFIED' };
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
 *
 * Carte #863 (A1) : avec `token`, le réexamen porte aussi un JETON de bail
 * (colonnes de la 1980) : son issue n'est écrite que par ce détenteur, tant
 * que la réservation est valide — un réexamen concurrent plus ancien ne peut
 * plus écraser l'issue du nouveau.
 */
export async function claimRetest(keyId: string, now: number, token?: string | null): Promise<SchemaCoupleRow | null> {
  try {
    const rows = await withGeneration((gen) => {
      const { vals, p } = params();
      const K = p(keyId); const N = p(iso(now), '::timestamptz'); const L = p(SCHEMA_COMPAT_POLICY.retestLeaseMs, '::bigint');
      const jeton = token ? `, qualification_claim_token = ${p(token, '::text')}, qualification_claimed_until = ${N} + (${L} * interval '1 millisecond'),
              qualification_attempts = qualification_attempts + 1` : '';
      return pgClient.unsafe(
        `UPDATE ai_schema_compatibility
            SET state = 'NEEDS_RECHECK', retest_claimed_until = ${N} + (${L} * interval '1 millisecond'),
                retest_count = retest_count + 1, updated_at = ${N}${jeton}
                ${gen ? `, state_generation = state_generation + CASE WHEN state <> 'NEEDS_RECHECK' THEN 1 ELSE 0 END` : ''}
          WHERE key_id = ${K} AND state IN ('REJECTED_CONFIRMED', 'NEEDS_RECHECK')
            AND (next_retest_at IS NULL OR next_retest_at <= ${N})
            AND (retest_claimed_until IS NULL OR retest_claimed_until <= ${N})
          RETURNING ${COLS_SQL()}`,
        vals as never[],
      );
    });
    const r = (rows as unknown as Row[])[0];
    return r ? toState(r) : null;
  } catch (e) {
    if (absent(e) && token) return claimRetest(keyId, now, null);
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
 *
 * Carte #863 (A3) — cette version est relevée sur une réponse SANS schéma :
 * elle ne prouve rien sur la compatibilité. Sur un couple QUALIFIÉ, elle est
 * mémorisée mais ne lève JAMAIS l'incertitude de la qualification (ni
 * `version_uncertain`, ni `served_version_at_state` : seule une acceptation
 * avec schéma le peut) ; une version connue n'est pas invalidée pour autant
 * (lot 115, #784 : aucune requalification forcée).
 */
export async function noteServedModelVersion(keyId: string, servedModelVersion: string | null, now: number): Promise<SchemaCoupleRow | null> {
  try {
    const rows = await withGeneration(() => pgClient.unsafe(
      `UPDATE ai_schema_compatibility SET
          served_model_version = COALESCE($2::text, served_model_version),
          -- Version inconnue au moment du constat : celle observée dans le MÊME appel devient la référence (refus seulement).
          served_version_at_state = CASE WHEN state = 'QUALIFIED' THEN served_version_at_state ELSE COALESCE(served_version_at_state, $2::text) END,
          version_uncertain = CASE WHEN state = 'QUALIFIED' AND $2::text IS NOT NULL THEN version_uncertain ELSE ($2::text IS NULL) END,
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
          AND (COALESCE(served_model_version, '') <> COALESCE($2::text, '')
               OR (version_uncertain = false AND $2::text IS NULL)
               OR (state <> 'QUALIFIED' AND (version_uncertain <> ($2::text IS NULL) OR (served_version_at_state IS NULL AND $2::text IS NOT NULL))))
        RETURNING ${COLS_SQL()}`,
      [keyId, servedModelVersion, iso(now)] as never[],
    ));
    const r = (rows as unknown as Row[])[0];
    return r ? toState(r) : null;
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/**
 * Réexamen sans conclusion : réservation rendue, court report ; rien n'est déduit.
 * Carte #863 (A1) : avec `token`, seul le détenteur VALIDE du réexamen le rend.
 */
export async function releaseRetest(keyId: string, now: number, token?: string | null): Promise<boolean> {
  try {
    const rows = await withGeneration((gen) => {
      const { vals, p } = params();
      const K = p(keyId); const N = p(iso(now), '::timestamptz'); const I = p(SCHEMA_COMPAT_POLICY.inconclusiveRetestMs, '::bigint');
      const garde = token ? ` AND qualification_claim_token = ${p(token, '::text')} AND qualification_claimed_until > ${N}` : '';
      return pgClient.unsafe(
        `UPDATE ai_schema_compatibility
            SET state = 'REJECTED_CONFIRMED', reason_code = 'RETEST_INCONCLUSIVE', retest_claimed_until = NULL,
                next_retest_at = ${N} + (${I} * interval '1 millisecond'), updated_at = ${N}
                ${token ? ', qualification_claim_token = NULL, qualification_claimed_until = NULL' : ''}
                ${gen ? ', state_generation = state_generation + 1' : ''}
          WHERE key_id = ${K} AND state = 'NEEDS_RECHECK'${garde} RETURNING key_id`,
        vals as never[],
      );
    });
    return (rows as unknown as Row[]).length > 0;
  } catch (e) {
    if (absent(e) && token) return releaseRetest(keyId, now, null);
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
 *                   l'appelant ne peut pas réserver — carte #863 (A2) : il
 *                   part en JSON sans schéma (jamais d'essai non réservé).
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
 * Carte #863 (A1) : `leaseMs` borne la durée TOTALE de l'essai (requêtes et
 * nouvel essai compris) — l'appelant la calcule d'après son délai d'appel.
 */
export async function claimQualification(
  key: SchemaCoupleKey, kind: QualificationKind, now: number,
  opts: { leaseMs?: number; uncertainTtlMs?: number; token?: string } = {},
): Promise<QualificationClaim> {
  const P = SCHEMA_COMPAT_POLICY;
  const token = opts.token ?? (await import('crypto')).randomUUID();
  const leaseMs = Math.max(1, Math.floor(opts.leaseMs ?? P.qualificationLeaseMs));
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
  return (await releaseQualificationState(keyId, token, now, inconclusive)).released;
}

/**
 * Carte #863 (A3) — même chose, en rendant l'ÉTAT écrit : l'appelant
 * synchronise son cache avec le report (`next_retest_at`) écrit en base.
 */
export async function releaseQualificationState(
  keyId: string, token: string, now: number, inconclusive: boolean,
): Promise<{ released: boolean; state: SchemaCoupleRow | null }> {
  try {
    const rows = await withGeneration(() => pgClient.unsafe(
      `UPDATE ai_schema_compatibility SET
          qualification_claim_token = NULL, qualification_claimed_until = NULL, updated_at = $3::timestamptz,
          next_retest_at = CASE WHEN $4::boolean AND state = 'QUALIFIED'
                                THEN $3::timestamptz + ($5::bigint * interval '1 millisecond') ELSE next_retest_at END
        WHERE key_id = $1 AND qualification_claim_token = $2
        RETURNING ${COLS_SQL()}`,
      [keyId, token, iso(now), inconclusive, SCHEMA_COMPAT_POLICY.inconclusiveRetestMs] as never[],
    ));
    const r = (rows as unknown as Row[])[0];
    return { released: Boolean(r), state: r ? toState(r) : null };
  } catch (e) {
    if (absent(e)) return { released: false, state: null };
    throw e;
  }
}
