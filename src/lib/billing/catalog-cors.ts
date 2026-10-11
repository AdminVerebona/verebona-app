/**
 * Origines autorisées à LIRE le catalogue public `/api/billing/catalog`
 * depuis le navigateur — lot 36B.
 *
 * Avant : comparaison STRICTE de l'en-tête `Origin` avec
 * `NEXT_PUBLIC_PUBLIC_SITE_URL` (valeur figée au build par Next.js). Une
 * vitrine servie en `www.` alors que la variable vise l'apex (ou l'inverse),
 * une majuscule, un port explicite ou une variable modifiée après le build
 * suffisaient à faire bloquer la réponse par le navigateur : la vitrine
 * affichait « Tarif indisponible » sans aucune trace côté serveur.
 *
 * Désormais (lecture seule, données publiques, sans cookie) :
 *   - valeur figée au build ET valeur lue à l'exécution de
 *     `NEXT_PUBLIC_PUBLIC_SITE_URL` ;
 *   - liste facultative `PUBLIC_SITE_EXTRA_ORIGINS` (séparateur virgule,
 *     lue à l'exécution : ex. domaine `*.scalingo.io` de la préprod) ;
 *   - pour chacune : comparaison d'ORIGINE normalisée (schéma + hôte + port,
 *     casse et slash final ignorés), variante `www.` ↔ sans `www.`, et
 *     passage http → https (jamais l'inverse).
 * Jamais de joker : une origine non dérivée de ces valeurs est refusée (et
 * journalisée une fois par instance, visible dans le BO).
 *
 * Module pur (aucune dépendance Node) : utilisable aussi en middleware Edge.
 */

/** Origine normalisée (`https://hote[:port]`, minuscules) ou `null`. */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

function variants(origin: string): string[] {
  const u = new URL(origin);
  const hosts = [u.host];
  if (u.hostname.startsWith('www.')) hosts.push(u.host.slice(4));
  else if (u.hostname.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) hosts.push(`www.${u.host}`);
  const schemes = u.protocol === 'http:' ? ['http:', 'https:'] : ['https:'];
  return schemes.flatMap((s) => hosts.map((h) => `${s}//${h}`));
}

/** Valeur EXÉCUTION d'une variable (accès dynamique : jamais figé au build). */
function runtimeEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name];
}

/**
 * Origines autorisées. `buildValue` : valeur figée au build de
 * `NEXT_PUBLIC_PUBLIC_SITE_URL` (passée par l'appelant).
 */
export function allowedCatalogOrigins(buildValue: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const sources = [
    buildValue,
    runtimeEnv(env, ['NEXT_PUBLIC', 'PUBLIC_SITE_URL'].join('_')),
    ...(runtimeEnv(env, 'PUBLIC_SITE_EXTRA_ORIGINS') ?? '').split(','),
  ];
  const out = new Set<string>();
  for (const s of sources) {
    const o = normalizeOrigin(s);
    if (o) for (const v of variants(o)) out.add(v);
  }
  return [...out];
}

/** Origine à renvoyer dans `Access-Control-Allow-Origin` (l'origine EXACTE reçue), ou `null`. */
export function matchCatalogOrigin(requestOrigin: string | null | undefined, allowed: readonly string[]): string | null {
  if (!requestOrigin) return null;
  const o = normalizeOrigin(requestOrigin);
  return o && allowed.includes(o) ? requestOrigin.trim() : null;
}

// ─── Trace des refus (par instance, pour le BO) ─────────────────────────────

const refused = new Map<string, { count: number; lastAt: string }>();

/** Note une origine refusée ; vrai à la première occurrence (journaliser une fois). */
export function noteRefusedOrigin(origin: string, now: Date = new Date()): boolean {
  const key = origin.slice(0, 200);
  const cur = refused.get(key);
  if (cur) { cur.count++; cur.lastAt = now.toISOString(); return false; }
  if (refused.size >= 20) refused.delete(refused.keys().next().value as string);
  refused.set(key, { count: 1, lastAt: now.toISOString() });
  return true;
}

export function refusedOrigins(): Array<{ origin: string; count: number; lastAt: string }> {
  return [...refused.entries()].map(([origin, v]) => ({ origin, ...v }));
}

export function __resetRefusedOriginsForTests(): void {
  refused.clear();
}
