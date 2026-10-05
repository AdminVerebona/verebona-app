/**
 * Cache PARTAGÉ des arbitrages TEMPORAL_AMBIGUITY de T4 (reliquat R5, lot 18 ;
 * lot 22, chantier B).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 *
 * Le cache était une `Map` par processus : avec plusieurs instances (ou après
 * un redémarrage), la réanalyse d'une même ambiguïté rappelait le modèle sur
 * une autre instance — surcoût, et réponse possiblement différente d'une
 * instance à l'autre pour la même source.
 *
 * Désormais : stockage dans `ai_operation_idempotency` (table existante,
 * migration 0101 : `key_hash` TEXT PK, `result_json`, `expires_at`), clé
 * préfixée `t4-temporal:a<compte>:<empreinte>` — aucune migration. Toutes les
 * instances lisent et écrivent la même ligne ; une entrée expirée n'est
 * jamais lue (`expires_at > now()`) et est REMPLACÉE à l'écriture suivante.
 *
 * PURGE : les lignes expirées sont supprimées par la purge quotidienne
 * existante (`purgeAssistantData` → `purgeExpiredIdempotency`, qui épargne
 * les clés réservées), et à l'écriture par le remplacement ci-dessus.
 *
 * Sans `DATABASE_URL` (tests unitaires, outils hors serveur) : cache mémoire
 * du processus, comme avant — aucune connexion n'est ouverte. Erreur SQL :
 * absence de cache (le modèle est appelé), jamais d'échec de T4.
 * ══════════════════════════════════════════════════════════════════════════
 */

export interface TemporalChoice {
  chosen: { candidateId: number; date: string; interpretation: string } | null;
  warning: string | null;
}

/** Préfixe des clés (constant : purge ciblée possible par `LIKE 't4-temporal:%'`). */
export const TEMPORAL_CACHE_PREFIX = 't4-temporal:';
export const TEMPORAL_CACHE_TTL_SECONDS = 24 * 3600;

/** Clé stockée : compte + empreinte (source, clé fonctionnelle, extrait). */
export function temporalCacheKey(accountId: number, fingerprint: string): string {
  return `${TEMPORAL_CACHE_PREFIX}a${accountId}:${fingerprint}`;
}

/* ── Repli mémoire (processus sans base) ─────────────────────────────────── */

const MEMOIRE = new Map<string, { at: number; r: TemporalChoice }>();
const MEMOIRE_MAX = 500;
const partage = (): boolean => Boolean(process.env.DATABASE_URL);

function valide(v: unknown): v is TemporalChoice {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (!('chosen' in o) || !('warning' in o)) return false;
  if (o.warning !== null && typeof o.warning !== 'string') return false;
  if (o.chosen === null) return true;
  const c = o.chosen as Record<string, unknown>;
  return typeof c === 'object' && typeof c.candidateId === 'number' && typeof c.date === 'string'
    && typeof c.interpretation === 'string';
}

/** Arbitrage en cache et non expiré, sinon null. Ne lève jamais. */
export async function readTemporalChoice(key: string): Promise<TemporalChoice | null> {
  if (!partage()) {
    const e = MEMOIRE.get(key);
    return e && Date.now() - e.at < TEMPORAL_CACHE_TTL_SECONDS * 1000 ? e.r : null;
  }
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT result_json FROM ai_operation_idempotency WHERE key_hash = $1 AND expires_at > now() LIMIT 1`,
      [key] as never[],
    )) as unknown as Array<{ result_json: unknown }>;
    const v = rows[0]?.result_json;
    return valide(v) ? v : null;
  } catch (e) {
    console.warn('[t4_temporal_ambiguity] cache illisible (non bloquant) :', (e as Error).message);
    return null;
  }
}

/**
 * Enregistre un arbitrage. Une entrée VALIDE déjà présente (autre instance
 * plus rapide) est conservée — même réponse pour toutes les instances ; une
 * entrée expirée est remplacée. Ne lève jamais.
 */
export async function writeTemporalChoice(key: string, r: TemporalChoice): Promise<void> {
  if (!partage()) {
    if (MEMOIRE.size >= MEMOIRE_MAX) MEMOIRE.delete(MEMOIRE.keys().next().value as string);
    MEMOIRE.set(key, { at: Date.now(), r });
    return;
  }
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO ai_operation_idempotency (key_hash, result_json, expires_at)
       VALUES ($1, $2::jsonb, now() + ($3 || ' seconds')::interval)
       ON CONFLICT (key_hash) DO UPDATE
         SET result_json = EXCLUDED.result_json, created_at = now(), expires_at = EXCLUDED.expires_at
         WHERE ai_operation_idempotency.expires_at <= now()`,
      [key, JSON.stringify(r), String(TEMPORAL_CACHE_TTL_SECONDS)] as never[],
    );
  } catch (e) {
    console.warn('[t4_temporal_ambiguity] cache non écrit (non bloquant) :', (e as Error).message);
  }
}

/** Réservé aux tests : vide le cache (mémoire, et lignes partagées si une base est configurée). */
export async function clearTemporalChoicesForTests(): Promise<void> {
  MEMOIRE.clear();
  if (!partage()) return;
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(`DELETE FROM ai_operation_idempotency WHERE key_hash LIKE '${TEMPORAL_CACHE_PREFIX}%'`);
  } catch { /* base absente : rien à vider */ }
}
