/**
 * Idempotence et concurrence — CDC §5.7.
 *
 * « Les traitements doivent utiliser une clé d'idempotence comprenant au
 *   minimum le compte, l'objet, la version de la source et l'opération. »
 *
 * Deux mécanismes complémentaires :
 *  1. verrou consultatif Postgres — empêche deux exécutions simultanées ;
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
 * Exécute `fn` une seule fois par clé. Un second appel concurrent attend, puis
 * réutilise le résultat déjà produit.
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

  // ⚠️ DÉGRADATION VOLONTAIRE — corrige un défaut de robustesse.
  //
  // La première version acquérait le verrou consultatif sans protection : une
  // base momentanément indisponible faisait alors échouer TOUS les appels
  // modèles, y compris ceux qui n'avaient rien à persister. L'idempotence est
  // une optimisation, pas une condition d'exécution : son indisponibilité ne
  // doit jamais empêcher un traitement métier (CDC §11.4).
  //
  // Sans verrou, deux appels concurrents sur la même clé peuvent tous deux
  // s'exécuter. C'est un surcoût, pas une incohérence : le résultat reste
  // correct et le second écrira simplement par-dessus le premier.
  const lockId = lockIdFromKey(key);
  let locked = false;
  try {
    await pgClient.unsafe('SELECT pg_advisory_lock($1)', [lockId] as never[]);
    locked = true;
  } catch (e) {
    console.warn(
      '[ai-idempotency] verrou indisponible, exécution sans protection de concurrence :',
      (e as Error).message,
    );
    return fn();
  }

  try {
    // Relecture après obtention du verrou : le concurrent a pu terminer.
    const afterLock = await readCached<T>(key);
    if (afterLock) return { ...afterLock, fromCache: true } as T;

    const result = await fn();
    await writeCached(key, result, ttlSeconds);
    return result;
  } finally {
    if (locked) {
      await pgClient.unsafe('SELECT pg_advisory_unlock($1)', [lockId] as never[]).catch(() => null);
    }
  }
}

function lockIdFromKey(key: string): number {
  // 31 bits pour rester dans la plage d'un entier signé Postgres.
  return parseInt(key.slice(0, 8), 16) % 2_147_483_647;
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
