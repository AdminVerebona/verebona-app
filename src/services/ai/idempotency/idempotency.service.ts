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
 *     réappeler le modèle.
 */
import { createHash } from 'crypto';
import { pgClient } from '@/db';

const DEFAULT_TTL_SECONDS = 3600;

export interface IdempotencyKeyParts {
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
 * PLUS DE VERROU CONSULTATIF POSTGRES DE SESSION
 *
 * L'ancienne version prenait `pg_advisory_lock(parseInt(clé[0..8], 16))` :
 *   · toutes les clés de l'assistant commencent par « assistant: » —
 *     `parseInt('assistan', 16)` vaut 10 : TOUS les appels modèle de
 *     l'assistant se sérialisaient sur le même verrou ;
 *   · verrou et déverrouillage passaient par le pool, donc pas forcément par
 *     la même connexion (verrou orphelin possible) ;
 *   · l'attente bloquait une connexion du pool (1 seule dans le serveur Next,
 *     8 ailleurs) pendant tout l'appel modèle — jusqu'à 12 s.
 *
 * Désormais : dédoublonnage EN MÉMOIRE (une exécution par empreinte de clé
 * et par processus), aucune connexion retenue pendant l'appel modèle. Entre
 * deux instances, deux appels simultanés sur la même clé peuvent encore
 * s'exécuter tous deux : c'est un surcoût borné, pas une incohérence — le
 * premier résultat écrit reste en cache (`ON CONFLICT DO NOTHING`).
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function withIdempotency<T>(
  key: string,
  fn: () => Promise<T>,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<T> {
  // Échappatoire explicite pour les tests et les environnements sans base.
  if (process.env.AI_IDEMPOTENCY_DISABLED === 'true') return fn();

  const cached = await readCached<T>(key);
  if (cached) return { ...cached, fromCache: true } as T;

  const id = lockIdFromKey(key);
  const existant = enVol.get(id) as Promise<T> | undefined;
  if (existant) {
    // Même clé déjà en cours ici : on partage son résultat (servi « du cache »).
    const r = await existant;
    return (r && typeof r === 'object' ? { ...r, fromCache: true } : r) as T;
  }

  const execution = (async () => {
    const result = await fn();
    await writeCached(key, result, ttlSeconds);
    return result;
  })();
  enVol.set(id, execution);
  try {
    return await execution;
  } finally {
    if (enVol.get(id) === execution) enVol.delete(id);
  }
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

async function readCached<T>(key: string): Promise<T | null> {
  try {
    const rows = await pgClient.unsafe(
      `SELECT result_json FROM ai_operation_idempotency
        WHERE key_hash = $1 AND expires_at > now() LIMIT 1`,
      [key] as never[],
    );
    const row = (rows as unknown as Array<{ result_json: unknown }>)[0];
    return row ? (row.result_json as T) : null;
  } catch {
    // Table absente (migration non appliquée) : on dégrade sans bloquer.
    return null;
  }
}

async function writeCached(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await pgClient.unsafe(
      `INSERT INTO ai_operation_idempotency (key_hash, result_json, expires_at)
       VALUES ($1, $2::jsonb, now() + ($3 || ' seconds')::interval)
       ON CONFLICT (key_hash) DO NOTHING`,
      [key, JSON.stringify(value), String(ttlSeconds)] as never[],
    );
  } catch (e) {
    console.error('[ai-idempotency] écriture impossible (non bloquant) :', (e as Error).message);
  }
}
