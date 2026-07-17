/**
 * URLs des applications Verebona externes (cross-repo).
 *
 * app.verebona.fr (ce repo)  <->  verebona.fr (vitrine, repo verebona-public)
 *
 * Les URLs viennent de variables d'environnement NEXT_PUBLIC_* (injectees au
 * build), jamais codees en dur, pour rester correctes par environnement
 * (local / preprod / prod).
 */

// URL du site vitrine (repo verebona-public). Fallback = prod.
export const PUBLIC_SITE_URL =
  process.env.NEXT_PUBLIC_PUBLIC_SITE_URL ?? "https://verebona.fr";

/** Construit une URL absolue vers le site vitrine. */
export function publicSiteUrl(path: string = "/"): string {
  const base = PUBLIC_SITE_URL.replace(/\/+$/, ""); // retire slash final
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
