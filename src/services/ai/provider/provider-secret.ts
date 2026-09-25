/**
 * Clé fournisseur réellement utilisée au runtime — CDC BO IA PROV-UI-05, WF-21.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI MANQUAIT
 *
 * La rotation de clé depuis le BO (candidate → test → activation) était
 * stockée, mais `resolveSecret()` n'était appelée nulle part : l'adaptateur
 * Gemini lisait `process.env.GEMINI_API_KEY`. Activer une nouvelle clé ne
 * changeait donc rien — et révoquer l'ancienne chez le fournisseur coupait
 * toute l'IA.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CACHE DE SOIXANTE SECONDES, VIDÉ À L'ACTIVATION
 *
 * La clé sert à chaque appel modèle ; la relire en base à chaque fois
 * ajouterait une requête sur le chemin chaud pour une valeur qui change
 * quelques fois par an. Soixante secondes bornent la propagation aux AUTRES
 * instances après une rotation ; sur l'instance qui active, le cache est
 * vidé immédiatement (`activateCandidate`).
 *
 * Ordre de résolution inchangé (credential.repository) : clé ACTIVE en base,
 * puis `GEMINI_API_KEY` / `GOOGLE_AI_API_KEY` — l'environnement reste
 * l'amorçage d'un déploiement neuf.
 */

const CACHE_TTL_MS = 60_000;

type Resolver = (provider: string) => Promise<string | null>;

const cache = new Map<string, { value: string | null; expiresAt: number }>();
let injectedResolver: Resolver | null = null;

async function defaultResolver(provider: string): Promise<string | null> {
  // Import différé : l'adaptateur fournisseur est chargé par le harnais de
  // test ; il ne doit pas ouvrir de module base de données à l'import.
  const { resolveSecret } = await import('./credential.repository');
  return resolveSecret(provider);
}

function envSecret(): string | null {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || null;
}

/** Remplace la source — réservé aux tests. */
export function setProviderSecretResolver(resolver: Resolver | null): void {
  injectedResolver = resolver;
  cache.clear();
}

/** Appelé à l'activation d'une clé : la nouvelle sert dès l'appel suivant. */
export function invalidateProviderSecretCache(): void {
  cache.clear();
}

/**
 * Clé à utiliser pour appeler le fournisseur, ou `null` si aucune.
 *
 * Ne lève jamais : une base indisponible retombe sur l'environnement (déjà
 * garanti par `resolveSecret`, redoublé ici pour un résolveur injecté).
 */
export async function getProviderSecret(provider = 'gemini'): Promise<string | null> {
  const hit = cache.get(provider);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value: string | null;
  try {
    value = await (injectedResolver ?? defaultResolver)(provider);
  } catch {
    value = envSecret();
  }
  cache.set(provider, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}
