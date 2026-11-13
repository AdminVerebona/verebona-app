/**
 * Lot 113AO (Trello #748, C) — RÉSERVATION DURABLE d'une génération T6
 * FORMULATE, partagée par toutes les instances.
 *
 * Cause démontrée des appels 15150 / 15151 (même `PROC-DOC-ANALYSIS:386`, même
 * entrée, deux traces, ~52 ms d'écart) : la seule protection contre deux
 * générations équivalentes était la table `inflight` EN MÉMOIRE de
 * `t6-runner.ts` — propre à un processus. La prise en charge durable des
 * demandes (`home_mascot_pregen_requests`, bail) n'exclut que deux
 * PRÉ-GÉNÉRATIONS ; un affichage (génération lancée en arrière-plan) sur une
 * instance et la pré-génération (chemin rapide ou tâche planifiée) sur une
 * autre — ou deux affichages servis par deux conteneurs — demandaient chacun la
 * même génération : cache vide pour les deux, deux appels fournisseur.
 *
 * Même convention que les autres baux de la plateforme (`claimed_until` des
 * demandes de pré-génération, `lease_until` des évaluations T6) :
 *   · clé = compte + clé du cache T6 (sujets et faits, langue, version
 *     effective du prompt et de la configuration, contrats) : deux demandes
 *     DIFFÉRENTES n'ont jamais la même clé, rien n'est fusionné à tort ;
 *   · prise atomique (INSERT … ON CONFLICT … WHERE bail expiré / terminé) ;
 *   · le détenteur RELIT le cache sous réservation avant d'appeler ;
 *   · bail expirant (arrêt brutal, instance perdue) : reprise par la demande
 *     suivante, `attempts` compté ; libération conditionnée au détenteur ;
 *   · jamais bloquant pour l'affichage : une demande refusée sert le texte
 *     déterministe (affichage) ou attend un temps borné le cache (pré-génération).
 * Table absente (migration 1670 non appliquée) : aucune réservation, comportement
 * antérieur. Ne lève jamais.
 */
import { pgClient } from '@/db';

type Row = Record<string, unknown>;
const q = async (sql: string, params: unknown[]): Promise<Row[]> => (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];

/** Bail d'une génération FORMULATE (au-delà : réputée interrompue, reprise possible). */
export const T6_FORMULATE_LEASE_MS = 2 * 60_000;
/** Pré-génération refusée : attente bornée du cache écrit par le détenteur. */
export const T6_FORMULATE_WAIT_MS = 20_000;
const T6_FORMULATE_POLL_MS = 250;

export type T6ReservationResult =
  | { ok: true; ownerId: string; attempts: number; takenOver: boolean }
  | { ok: false; reason: 'held_elsewhere' | 'recent_failure'; leaseUntil: string | null }
  | { ok: null; reason: 'unavailable' };

export interface T6ReservationStore {
  reserve(p: { accountId: number; cacheKey: string; ownerId: string; mode: string; leaseMs?: number; failureCooldownMs?: number; sourceCodes?: string[]; subjects?: number }): Promise<T6ReservationResult>;
  finish(p: { accountId: number; cacheKey: string; ownerId: string; status: 'DONE' | 'FAILED'; traceId?: string | null; error?: string | null }): Promise<boolean>;
  /** Clé DÉTERMINISTE servie sans appel (mesure des appels évités). */
  noteDeterministic(p: { accountId: number; cacheKey: string; sourceCodes: string[]; subjects: number }): Promise<void>;
}

let pret: boolean | null = null;
async function ready(): Promise<boolean> {
  if (pret) return true;
  try {
    const [r] = await q(`SELECT to_regclass('t6_formulate_reservations') IS NOT NULL AS ok`, []);
    pret = r?.ok === true;
  } catch {
    pret = false;
  }
  return pret;
}
/** Réservé aux tests. */
export function resetT6ReservationProbe(): void { pret = null; deterministes.clear(); }

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** Clés déterministes déjà notées par cette instance (au plus une écriture par clé et par 10 min). */
const deterministes = new Map<string, number>();
const DETERMINISTIC_NOTE_EVERY_MS = 10 * 60_000;

export const t6ReservationDbStore: T6ReservationStore = {
  async reserve(p) {
    if (!(await ready())) return { ok: null, reason: 'unavailable' };
    const lease = Math.max(1_000, Math.round(p.leaseMs ?? T6_FORMULATE_LEASE_MS));
    const cooldown = Math.max(0, Math.round(p.failureCooldownMs ?? 0));
    try {
      // Prise ATOMIQUE : ligne nouvelle, ou génération terminée, ou bail expiré
      // (détenteur arrêté) ; un échec récent n'est repris à l'affichage qu'après
      // le délai de refroidissement (la pré-génération peut réessayer).
      const r = await q(
        `INSERT INTO t6_formulate_reservations AS t (account_id, cache_key, status, owner_id, lease_until, mode, attempts, source_codes, subjects)
         VALUES ($1, $2, 'RUNNING', $3::uuid, clock_timestamp() + ($4::int * INTERVAL '1 millisecond'), $5, 1, $7::text[], $8)
         ON CONFLICT (account_id, cache_key) DO UPDATE
           SET status = 'RUNNING', owner_id = EXCLUDED.owner_id, lease_until = EXCLUDED.lease_until, mode = EXCLUDED.mode,
               attempts = t.attempts + 1, updated_at = clock_timestamp(), finished_at = NULL, last_error = NULL,
               source_codes = coalesce(EXCLUDED.source_codes, t.source_codes), subjects = coalesce(EXCLUDED.subjects, t.subjects)
         WHERE t.status IN ('DONE', 'DETERMINISTIC')
            OR (t.status = 'RUNNING' AND (t.lease_until IS NULL OR t.lease_until < clock_timestamp()))
            OR (t.status = 'FAILED' AND (t.finished_at IS NULL OR t.finished_at < clock_timestamp() - ($6::int * INTERVAL '1 millisecond')))
         RETURNING t.attempts, (t.attempts > 1) AS repris`,
        [p.accountId, p.cacheKey, p.ownerId, lease, p.mode, cooldown, p.sourceCodes ?? null, p.subjects ?? null],
      );
      if (r[0]) return { ok: true, ownerId: p.ownerId, attempts: Number(r[0].attempts), takenOver: r[0].repris === true };
      // Refus : demande ÉQUIVALENTE déjà en cours (ou échec récent) — comptée (doublon évité).
      const [x] = await q(
        `UPDATE t6_formulate_reservations SET contended = contended + 1, updated_at = clock_timestamp()
          WHERE account_id = $1 AND cache_key = $2 RETURNING status, lease_until`,
        [p.accountId, p.cacheKey],
      );
      return { ok: false, reason: x?.status === 'FAILED' ? 'recent_failure' : 'held_elsewhere', leaseUntil: iso(x?.lease_until) };
    } catch (e) {
      console.error('[mascotte] réservation T6 impossible (génération sans réservation) :', (e as Error).message);
      return { ok: null, reason: 'unavailable' };
    }
  },
  async finish(p) {
    if (!(await ready())) return false;
    try {
      const r = await q(
        `UPDATE t6_formulate_reservations
            SET status = $4, lease_until = NULL, finished_at = clock_timestamp(), updated_at = clock_timestamp(),
                trace_id = coalesce($5, trace_id), last_error = left($6, 300)
          WHERE account_id = $1 AND cache_key = $2 AND owner_id = $3::uuid AND status = 'RUNNING'
          RETURNING 1`,
        [p.accountId, p.cacheKey, p.ownerId, p.status, p.traceId ?? null, p.error ?? null],
      );
      // Purge légère : comme le cache T6, une clé de plus de 30 jours ne revient pas.
      if (Math.random() < 0.02) await q(`DELETE FROM t6_formulate_reservations WHERE updated_at < now() - INTERVAL '30 days'`, []);
      return r.length > 0;
    } catch (e) {
      console.error('[mascotte] libération de la réservation T6 non écrite (expiration du bail) :', (e as Error).message);
      return false;
    }
  },
  async noteDeterministic(p) {
    const k = `${p.accountId}:${p.cacheKey}`;
    const t = deterministes.get(k);
    if (t != null && Date.now() - t < DETERMINISTIC_NOTE_EVERY_MS) return;
    deterministes.set(k, Date.now());
    if (deterministes.size > 5_000) deterministes.clear();
    if (!(await ready())) return;
    try {
      await q(
        `INSERT INTO t6_formulate_reservations AS t (account_id, cache_key, status, attempts, hits, source_codes, subjects, finished_at)
         VALUES ($1, $2, 'DETERMINISTIC', 0, 1, $3::text[], $4, clock_timestamp())
         ON CONFLICT (account_id, cache_key) DO UPDATE SET hits = t.hits + 1, updated_at = clock_timestamp()`,
        [p.accountId, p.cacheKey, p.sourceCodes, p.subjects],
      );
    } catch (e) {
      console.warn('[mascotte] mesure des formulations évitées non écrite :', (e as Error).message);
    }
  },
};

/** Attente BORNÉE du cache écrit par le détenteur d'une réservation (pré-génération seulement). */
export async function waitForT6Cache<T>(read: () => Promise<T | null>, opts: { maxMs?: number; pollMs?: number } = {}): Promise<T | null> {
  const fin = Date.now() + Math.max(0, opts.maxMs ?? T6_FORMULATE_WAIT_MS);
  const pas = Math.max(20, opts.pollMs ?? T6_FORMULATE_POLL_MS);
  for (;;) {
    const v = await read().catch(() => null);
    if (v != null) return v;
    if (Date.now() + pas > fin) return null;
    await new Promise((r) => setTimeout(r, pas));
  }
}
