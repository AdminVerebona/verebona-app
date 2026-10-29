/**
 * Idempotence et concurrence — CDC §5.7.
 *
 * « Les traitements doivent utiliser une clé d'idempotence comprenant au
 *   minimum le compte, l'objet, la version de la source et l'opération. »
 *
 * Deux mécanismes complémentaires :
 *  1. dédoublonnage en mémoire — une seule exécution simultanée par clé et
 *     par processus, sans retenir de connexion (voir `withIdempotency`) ;
 *  2. table `ai_operation_idempotency` — rejoue le résultat au lieu de
 *     réappeler le modèle ; lot 99A : réservation conditionnelle (une seule
 *     instance appelle le fournisseur), entrée expirée renouvelée.
 *
 * Ce module est le cache TEMPORAIRE des réponses modèle. La mémoire DURABLE
 * des décisions métier T3 est ailleurs (`reconciliation/decision-memory`) :
 * elle ne s'expire pas et est consultée avant même la passerelle.
 */
import { createHash, randomUUID } from 'crypto';
import { pgClient } from '@/db';

/**
 * Clés RÉSERVÉES de `ai_operation_idempotency` — à ne jamais purger.
 *
 * La table sert aussi de stockage durable à des valeurs qui ne sont PAS des
 * résultats rejouables :
 *   · `help-corpus:last-valid:<env>` — dernier corpus d'aide valide de
 *     l'environnement (CDC Centre d'aide PUB-01,
 *     `verebona-assistant/core/help-corpus.service.ts`), `expires_at =
 *     'infinity'`, remplacé à chaque nouvelle version valide.
 *
 * Toute purge de cette table (expiration, purge globale, outil de
 * maintenance) DOIT exclure ces clés : `NOT_RESERVED_IDEMPOTENCY_KEY_SQL`, ou
 * `purgeExpiredIdempotency` ci-dessous. Les purges ciblées existantes ne
 * peuvent pas les atteindre (préfixes `assistant:c…` / `assistant:<id>:` —
 * `events/handlers.ts`, `conversation.service.ts`).
 */
const RESERVED_IDEMPOTENCY_KEY_PREFIXES = ['help-corpus:last-valid:'] as const;

/** Prédicat SQL à ajouter à toute purge de `ai_operation_idempotency`. */
export const NOT_RESERVED_IDEMPOTENCY_KEY_SQL =
  RESERVED_IDEMPOTENCY_KEY_PREFIXES.map((p) => `key_hash NOT LIKE '${p.replace(/'/g, "''")}%'`).join(' AND ');

export function isReservedIdempotencyKey(key: string): boolean {
  return RESERVED_IDEMPOTENCY_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/** Taille d'un lot de suppression et borne de temps totale de la purge. */
const PURGE_BATCH_SIZE = 5000;
const PURGE_MAX_DURATION_MS = 60_000;

/**
 * Purge des résultats expirés — SANS JAMAIS toucher aux clés réservées
 * (garde-fou PUB-01 : une purge globale ne doit pas faire perdre le dernier
 * corpus d'aide valide). Rend le nombre de lignes supprimées.
 *
 * Lot 22 : PAR LOTS (`PURGE_BATCH_SIZE` lignes, chacun sa propre instruction
 * donc sa transaction implicite, comptés par `.count`, sans `RETURNING`),
 * jusqu'à épuisement ou `maxDurationMs`. La première exécution sur une table
 * jamais purgée ne fait ni transaction longue ni résultat massif en mémoire ;
 * le reliquat éventuel part au passage suivant.
 */
export async function purgeExpiredIdempotency(
  opts: { batchSize?: number; maxDurationMs?: number } = {},
): Promise<number> {
  const lot = opts.batchSize ?? PURGE_BATCH_SIZE;
  const fin = Date.now() + (opts.maxDurationMs ?? PURGE_MAX_DURATION_MS);
  let total = 0;
  for (;;) {
    const r = (await pgClient.unsafe(
      `DELETE FROM ai_operation_idempotency
        WHERE ctid IN (SELECT ctid FROM ai_operation_idempotency
                        WHERE expires_at <= now() AND ${NOT_RESERVED_IDEMPOTENCY_KEY_SQL}
                        LIMIT ${Math.max(1, Math.floor(lot))})`,
    )) as unknown as { count?: number };
    const n = r.count ?? 0;
    total += n;
    if (n < lot || Date.now() >= fin) return total;
  }
}

const DEFAULT_TTL_SECONDS = 3600;

/**
 * Bail d'une réservation PENDING (`AI_IDEMPOTENCY_LEASE_SECONDS`, 180 s par
 * défaut, 10 à 1800) : durée maximale d'un appel fournisseur, cascade de
 * repli comprise. Au-delà, la réservation d'une instance arrêtée est reprise.
 */
function leaseSeconds(): number {
  const v = Number(process.env.AI_IDEMPOTENCY_LEASE_SECONDS);
  return Number.isFinite(v) && v > 0 ? Math.min(1800, Math.max(10, Math.floor(v))) : 180;
}
/** Intervalle de relecture d'une réservation tenue par une autre instance. */
const POLL_MS = 200;

interface IdempotencyKeyParts {
  accountId: number;
  operationCode: string;
  sourceIds: number[];
  variables: Record<string, unknown>;
  /** Version de l'objet source, si connue (CDC §6.3). */
  sourceVersion?: number;
}

export function buildIdempotencyKey(p: IdempotencyKeyParts): string {
  const payload = JSON.stringify({
    a: p.accountId,
    o: p.operationCode,
    s: [...p.sourceIds].sort((x, y) => x - y),
    v: p.sourceVersion ?? null,
    h: stableHash(p.variables),
  });
  return createHash('sha256').update(payload).digest('hex');
}

function stableHash(v: unknown): string {
  const canonical = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(canonical);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, canonical(val)]),
      );
    }
    return x;
  };
  return createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
}

/** Rattachement d'une clé (compteurs de réutilisation, lot 99A) — jamais dans la clé elle-même. */
export interface IdempotencyMeta {
  accountId?: number | null;
  treatment?: string | null;
  operationCode?: string | null;
}

/** Comment une réponse a été obtenue (lot 99A). */
export type CacheOutcome =
  /** Appel réel au fournisseur, entrée créée. */
  | 'CALLED'
  /** Appel réel au fournisseur, entrée EXPIRÉE remplacée. */
  | 'RENEWED'
  /** Réponse valide du cache : aucun appel. */
  | 'CACHE_HIT'
  /** Demande identique simultanée (même instance ou autre instance) : réponse partagée. */
  | 'SHARED';

/**
 * Exécutions en cours dans CE processus, par empreinte de clé : un second
 * appel concurrent sur la même clé attend la première exécution au lieu d'en
 * lancer une autre.
 */
const enVol = new Map<string, Promise<unknown>>();

/**
 * Exécute `fn` une seule fois par clé. Un second appel concurrent attend, puis
 * réutilise le résultat déjà produit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 99A — RENOUVELLEMENT ET CONCURRENCE MULTI-INSTANCES
 *
 * Avant : `INSERT … ON CONFLICT DO NOTHING`. Une entrée EXPIRÉE restée en base
 * (purge quotidienne) n'était jamais remplacée : chaque appel suivant
 * repartait au fournisseur (T3 horaire, cache d'une heure = 1 appel par heure).
 * Et deux instances pouvaient appeler le fournisseur pour la même clé.
 *
 * Désormais, sans verrou de session ni connexion retenue pendant l'appel :
 *   1. entrée READY non expirée → servie (compteur `hit_count`), aucun appel ;
 *   2. sinon RÉSERVATION par insertion conditionnelle : ligne absente, expirée
 *      ou bail PENDING échu → elle devient PENDING au nom de ce processus
 *      (`owner_token`, bail `AI_IDEMPOTENCY_LEASE_SECONDS`). Une seule instance
 *      gagne : un seul appel fournisseur ;
 *   3. réservation tenue ailleurs → relecture toutes les 200 ms jusqu'à la
 *      réponse (partagée, sans appel) ou la fin du bail (reprise) ;
 *   4. réponse écrite READY (TTL), entrée expirée comptée « renouvelée » ;
 *      échec → réservation libérée (une autre demande pourra réessayer).
 * Une entrée valide n'est jamais réécrite. Colonnes 0857 absentes : ancien
 * fonctionnement (dédoublonnage par processus), mais l'entrée expirée est
 * désormais remplacée.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function withIdempotency<T>(
  key: string,
  fn: () => Promise<T>,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  meta: IdempotencyMeta = {},
): Promise<T> {
  // Échappatoire explicite pour les tests et les environnements sans base.
  if (process.env.AI_IDEMPOTENCY_DISABLED === 'true') return fn();

  const cached = await readCached<T>(key);
  if (cached) {
    void noteHit(key);
    void compter('PROVIDER_CACHE_HIT', meta);
    return marquer(cached, 'CACHE_HIT');
  }

  const id = lockIdFromKey(key);
  const existant = enVol.get(id) as Promise<{ value: T; outcome: CacheOutcome }> | undefined;
  if (existant) {
    // Même clé déjà en cours ici : on partage son résultat (servi « du cache »).
    const r = await existant;
    void compter('CONCURRENT_SHARED', meta);
    return marquer(r.value, 'SHARED');
  }

  const execution = executerUneFois(key, fn, ttlSeconds, meta);
  enVol.set(id, execution);
  try {
    const r = await execution;
    return r.outcome === 'CALLED' || r.outcome === 'RENEWED' ? r.value : marquer(r.value, r.outcome);
  } finally {
    if (enVol.get(id) === execution) enVol.delete(id);
  }
}

function marquer<T>(v: T, outcome: CacheOutcome): T {
  return (v && typeof v === 'object' ? { ...v, fromCache: true, cacheOutcome: outcome } : v) as T;
}

async function compter(kind: import('../reuse/reuse-counters').ReuseKind, meta: IdempotencyMeta): Promise<void> {
  try {
    const { noteReuse } = await import('../reuse/reuse-counters');
    await noteReuse({ kind, accountId: meta.accountId ?? null, treatment: meta.treatment ?? null, operationCode: meta.operationCode ?? null });
  } catch { /* jamais bloquant */ }
}

/** Colonnes 0857 absentes : fonctionnement historique (mémorisé pour le processus, revérifié toutes les 5 min). */
let sansReservation: { at: number } | null = null;
const colonneAbsente = (e: unknown) => (e as { code?: string })?.code === '42703';

async function executerUneFois<T>(
  key: string, fn: () => Promise<T>, ttlSeconds: number, meta: IdempotencyMeta,
): Promise<{ value: T; outcome: CacheOutcome }> {
  if (sansReservation && Date.now() - sansReservation.at < 300_000) return executerSansReservation(key, fn, ttlSeconds);
  const token = randomUUID();
  const bail = leaseSeconds();
  let vides = 0;
  for (;;) {
    let r: Reservation;
    try {
      r = await reserver(key, token, bail);
    } catch (e) {
      if (colonneAbsente(e)) {
        sansReservation = { at: Date.now() };
        return executerSansReservation(key, fn, ttlSeconds);
      }
      // Base indisponible : on dégrade sans bloquer (un appel, pas de partage).
      console.error('[ai-idempotency] réservation impossible (non bloquant) :', (e as Error).message);
      return { value: await fn(), outcome: 'CALLED' };
    }
    if (r.kind === 'RESERVED') {
      let value: T;
      try {
        value = await fn();
      } catch (e) {
        await liberer(key, token);
        throw e;
      }
      await ecrire(key, token, value, ttlSeconds);
      if (r.renewed) void compter('CACHE_RENEWED', meta);
      return { value, outcome: r.renewed ? 'RENEWED' : 'CALLED' };
    }
    if (r.kind === 'READY') {
      void noteHit(key);
      void compter('PROVIDER_CACHE_HIT', meta);
      return { value: r.value as T, outcome: 'CACHE_HIT' };
    }
    if (r.kind === 'BUSY') {
      // Une autre instance appelle le fournisseur pour cette clé : on attend sa réponse.
      const fin = Date.now() + Math.max(1, r.remainingMs) + POLL_MS;
      while (Date.now() < fin) {
        await new Promise((res) => setTimeout(res, POLL_MS));
        const v = await readCached<T>(key);
        if (v) {
          void compter('CONCURRENT_SHARED', meta);
          return { value: v, outcome: 'SHARED' };
        }
        const etat = await lireEtat(key);
        if (etat !== 'PENDING') break; // libérée (échec) ou supprimée : nouvelle réservation
      }
      continue;
    }
    // Aucune ligne visible après une réservation refusée (suppression concurrente) : on réessaie, puis on dégrade.
    if (++vides >= 3) return { value: await fn(), outcome: 'CALLED' };
  }
}

type Reservation =
  | { kind: 'RESERVED'; renewed: boolean }
  | { kind: 'READY'; value: unknown }
  | { kind: 'BUSY'; remainingMs: number }
  | { kind: 'NONE' };

/**
 * Insertion CONDITIONNELLE : la ligne devient PENDING au nom de `token` si
 * elle est absente, expirée (READY périmée) ou si le bail d'une réservation
 * est échu. Une entrée valide ou une réservation vivante n'est jamais touchée.
 */
async function reserver(key: string, token: string, bail: number): Promise<Reservation> {
  const rows = (await pgClient.unsafe(
    `INSERT INTO ai_operation_idempotency (key_hash, result_json, created_at, expires_at, state, owner_token)
     VALUES ($1, '{}'::jsonb, now(), now() + ($3 || ' seconds')::interval, 'PENDING', $2)
     ON CONFLICT (key_hash) DO UPDATE
       SET state = 'PENDING', owner_token = EXCLUDED.owner_token, expires_at = EXCLUDED.expires_at,
           renewed_count = ai_operation_idempotency.renewed_count + CASE WHEN ai_operation_idempotency.state = 'READY' THEN 1 ELSE 0 END,
           renewed_at = CASE WHEN ai_operation_idempotency.state = 'READY' THEN now() ELSE ai_operation_idempotency.renewed_at END
       WHERE ai_operation_idempotency.expires_at <= now()
     RETURNING (xmax <> 0) AS replaced, (renewed_at IS NOT DISTINCT FROM now()) AS renewed`,
    [key, token, String(bail)] as never[],
  )) as unknown as Array<{ replaced: boolean; renewed: boolean }>;
  if (rows[0]) return { kind: 'RESERVED', renewed: rows[0].replaced === true && rows[0].renewed === true };
  const [etat] = (await pgClient.unsafe(
    `SELECT state, result_json, GREATEST(0, EXTRACT(EPOCH FROM (expires_at - now())) * 1000)::bigint AS remaining_ms
       FROM ai_operation_idempotency WHERE key_hash = $1`,
    [key] as never[],
  )) as unknown as Array<{ state: string; result_json: unknown; remaining_ms: number | string }>;
  if (!etat) return { kind: 'NONE' };
  const restant = Number(etat.remaining_ms) || 0;
  if (etat.state === 'READY' && restant > 0) return { kind: 'READY', value: etat.result_json };
  if (etat.state === 'PENDING' && restant > 0) return { kind: 'BUSY', remainingMs: restant };
  return { kind: 'NONE' };
}

async function lireEtat(key: string): Promise<string | null> {
  try {
    const [r] = (await pgClient.unsafe(
      `SELECT state FROM ai_operation_idempotency WHERE key_hash = $1 AND expires_at > now()`, [key] as never[],
    )) as unknown as Array<{ state: string }>;
    return r?.state ?? null;
  } catch { return null; }
}

/** Réponse écrite READY. Une réservation reprise entre-temps par une autre instance n'est pas écrasée si elle a déjà répondu. */
async function ecrire(key: string, token: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await pgClient.unsafe(
      `INSERT INTO ai_operation_idempotency (key_hash, result_json, created_at, expires_at, state, owner_token)
       VALUES ($1, $2::jsonb, now(), now() + ($3 || ' seconds')::interval, 'READY', NULL)
       ON CONFLICT (key_hash) DO UPDATE
         SET result_json = EXCLUDED.result_json, created_at = now(), expires_at = EXCLUDED.expires_at,
             state = 'READY', owner_token = NULL
         WHERE ai_operation_idempotency.owner_token = $4
            OR ai_operation_idempotency.state = 'PENDING' AND ai_operation_idempotency.expires_at <= now()
            OR ai_operation_idempotency.state = 'READY' AND ai_operation_idempotency.expires_at <= now()`,
      [key, JSON.stringify(value), String(ttlSeconds), token] as never[],
    );
  } catch (e) {
    console.error('[ai-idempotency] écriture impossible (non bloquant) :', (e as Error).message);
  }
}

/** Échec de l'appel : la réservation est rendue (une demande suivante pourra réessayer). */
async function liberer(key: string, token: string): Promise<void> {
  try {
    await pgClient.unsafe(
      `DELETE FROM ai_operation_idempotency WHERE key_hash = $1 AND owner_token = $2 AND state = 'PENDING'`,
      [key, token] as never[],
    );
  } catch { /* le bail expirera de lui-même */ }
}

async function noteHit(key: string): Promise<void> {
  try {
    await pgClient.unsafe(
      `UPDATE ai_operation_idempotency SET hit_count = hit_count + 1, last_hit_at = now() WHERE key_hash = $1`,
      [key] as never[],
    );
  } catch { /* colonnes 0857 absentes : compteur ignoré */ }
}

/** Fonctionnement sans les colonnes 0857 : dédoublonnage par processus, entrée expirée REMPLACÉE. */
async function executerSansReservation<T>(key: string, fn: () => Promise<T>, ttlSeconds: number): Promise<{ value: T; outcome: CacheOutcome }> {
  const value = await fn();
  try {
    await pgClient.unsafe(
      `INSERT INTO ai_operation_idempotency (key_hash, result_json, expires_at)
       VALUES ($1, $2::jsonb, now() + ($3 || ' seconds')::interval)
       ON CONFLICT (key_hash) DO UPDATE
         SET result_json = EXCLUDED.result_json, created_at = now(), expires_at = EXCLUDED.expires_at
         WHERE ai_operation_idempotency.expires_at <= now()`,
      [key, JSON.stringify(value), String(ttlSeconds)] as never[],
    );
  } catch (e) {
    console.error('[ai-idempotency] écriture impossible (non bloquant) :', (e as Error).message);
  }
  return { value, outcome: 'CALLED' };
}

/**
 * Empreinte d'une clé (SHA-256 de la clé ENTIÈRE, 16 caractères hexadécimaux
 * = 64 bits) : deux clés de même préfixe ont des empreintes distinctes.
 */
export function lockIdFromKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Nombre d'exécutions en cours (tests, diagnostic). */
export function inFlightCount(): number {
  return enVol.size;
}

/** Réinitialise le repli « colonnes 0857 absentes » (tests). */
export function __resetIdempotencyModeForTests(): void { sansReservation = null; }

async function readCached<T>(key: string): Promise<T | null> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT result_json FROM ai_operation_idempotency
        WHERE key_hash = $1 AND expires_at > now() AND state = 'READY' LIMIT 1`,
      [key] as never[],
    );
    const row = (rows as unknown as Array<{ result_json: unknown }>)[0];
    return row ? (row.result_json as T) : null;
  } catch (e) {
    if (colonneAbsente(e)) {
      // Colonne `state` absente (0857 non appliquée) : lecture historique.
      try {
        const rows = await pgClient.unsafe(
          `SELECT result_json FROM ai_operation_idempotency WHERE key_hash = $1 AND expires_at > now() LIMIT 1`,
          [key] as never[],
        );
        const row = (rows as unknown as Array<{ result_json: unknown }>)[0];
        return row ? (row.result_json as T) : null;
      } catch { return null; }
    }
    // Table absente (migration non appliquée) : on dégrade sans bloquer.
    return null;
  }
}
