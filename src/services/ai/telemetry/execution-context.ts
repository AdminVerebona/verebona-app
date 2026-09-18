/**
 * Contexte d'exécution — CDC BO IA §9.1, GEN-008.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI LE COMMIT COMPTE AUTANT QUE LA VERSION IA
 *
 * Le GEN-008 le dit sans détour : « une partie du comportement reste définie
 * dans le code ». Deux exécutions sous la même version de configuration peuvent
 * donc différer si un déploiement les sépare — et sans le commit, l'écart est
 * inexplicable.
 *
 * Nous en avons eu l'illustration le 18 septembre : la classification de
 * l'assistant échouait pour une raison qui ne tenait ni au modèle ni à la
 * configuration, mais à un désaccord entre un prompt stocké et un schéma défini
 * dans le code. Sans trace du commit, un tel écart ne se rattache à rien.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA VERSION EFFECTIVE EST MISE EN CACHE
 *
 * Chaque appel modèle interrogerait sinon la base pour savoir sous quelle
 * configuration il tourne. Le cache est court — une bascule doit être prise en
 * compte rapidement — et se vide explicitement à chaque changement d'Active.
 */
import type { AiEnvironment } from '../config/environment';

export interface ExecutionContext {
  /** Version IA effective au moment de l'appel. */
  configVersionId: number | null;
  /** Commit applicatif déployé (GEN-008). */
  appVersion: string | null;
  environment: AiEnvironment | null;
}

/**
 * Commit déployé, lu dans l'environnement.
 *
 * Scalingo expose `SOURCE_VERSION`, Vercel `VERCEL_GIT_COMMIT_SHA`. On accepte
 * aussi une variable explicite, pour les déploiements qui n'en posent aucune.
 * Absence = `null` : inventer une valeur rendrait la trace trompeuse.
 */
export function getAppVersion(): string | null {
  const raw = process.env.APP_COMMIT
    ?? process.env.SOURCE_VERSION
    ?? process.env.VERCEL_GIT_COMMIT_SHA
    ?? null;
  return raw ? raw.slice(0, 40) : null;
}

const CACHE_TTL_MS = 30_000;

/**
 * Délai maximal accordé à la lecture de version.
 *
 * ⚠️ Cette borne n'est pas une précaution de confort. Sans elle, la télémétrie
 * attend la base sur le chemin d'appel : une base lente ou injoignable ajoute
 * son propre délai de connexion à CHAQUE appel modèle. Un test l'a révélé en
 * dépassant les cinq secondes là où il n'attendait rien du tout.
 *
 * Au-delà, la trace part sans version. Une trace incomplète vaut mieux qu'un
 * traitement ralenti par sa propre journalisation.
 */
const LOOKUP_TIMEOUT_MS = 1_500;

let cache: { versionId: number | null; expiresAt: number } | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.()),
  ]);
}

/** Vidé à chaque bascule d'Active, pour qu'une activation soit prise tout de suite. */
export function invalidateConfigVersionCache(): void {
  cache = null;
}

async function currentConfigVersionId(): Promise<number | null> {
  // Les tests unitaires n'ouvrent aucune connexion : attendre la borne à chaque
  // trace y ajouterait des secondes pour une valeur qui n'existe pas. Même
  // convention que `db/index.ts`, qui tait déjà l'absence de DATABASE_URL en test.
  if (process.env.NODE_ENV === 'test') return null;

  if (cache && cache.expiresAt > Date.now()) return cache.versionId;

  try {
    const { getEffectiveVersion } = await import('../config/config-version.repository');
    const version = await withTimeout(getEffectiveVersion(), LOOKUP_TIMEOUT_MS, null);
    cache = { versionId: version?.id ?? null, expiresAt: Date.now() + CACHE_TTL_MS };
    return cache.versionId;
  } catch {
    // Tables absentes avant la migration, ou base indisponible : la trace part
    // sans version plutôt que l'appel échoue. La télémétrie ne doit jamais
    // faire tomber un traitement métier.
    cache = { versionId: null, expiresAt: Date.now() + CACHE_TTL_MS };
    return null;
  }
}

export async function getExecutionContext(): Promise<ExecutionContext> {
  let environment: AiEnvironment | null = null;
  try {
    const { getAiEnvironment } = await import('../config/environment');
    environment = getAiEnvironment();
  } catch {
    // Variable absente : le contrôle de démarrage l'aura déjà signalé, et la
    // trace n'est pas le bon endroit pour lever une seconde fois.
    environment = null;
  }

  return {
    configVersionId: await currentConfigVersionId(),
    appVersion: getAppVersion(),
    environment,
  };
}

/**
 * Rang du modèle réellement utilisé (§9.1).
 *
 * `is_fallback` ne distingue pas les deux replis. Un traitement qui bascule
 * systématiquement sur le second — parce que le premier est lui aussi en panne
 * — ressemble pourtant à un traitement qui replie normalement, alors que
 * l'incident est bien plus sérieux.
 */
export type ModelRank = 'primary' | 'fallback_1' | 'fallback_2';

export function rankOf(model: string, primary: string, fallbacks: string[]): ModelRank | null {
  if (model === primary) return 'primary';
  const i = fallbacks.indexOf(model);
  if (i === 0) return 'fallback_1';
  if (i === 1) return 'fallback_2';
  // Modèle hors de la chaîne configurée : rien à affirmer. Le classer
  // arbitrairement ferait passer pour un repli normal un appel qui n'aurait pas
  // dû avoir lieu.
  return null;
}
