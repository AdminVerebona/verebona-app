/**
 * Inventaire des destinations du site public (vitrine) — lot 72 (ticket
 * « liens obsolètes app ↔ vitrine », §3.5).
 *
 * `link-inventory.json` est une COPIE de l'inventaire GÉNÉRÉ par le dépôt
 * verebona-public à partir de son code (routeur, `id` des sections de
 * l'accueil, pages publiées en production du Centre d'aide et des
 * Ressources, anciennes URL, liens vers l'application). Rien n'y est saisi
 * à la main ici.
 *
 * Synchronisation (deux dépôts séparés, aucune CI commune) :
 *   1. la vitrine régénère et commite son inventaire ; son test
 *      `tests/l72p-liens-routes.test.ts` échoue tant qu'il dérive du code ;
 *   2. ici : `node scripts/sync-public-link-inventory.mjs <dépôt vitrine>`
 *      recopie le fichier (schéma vérifié) ;
 *   3. `l72e-liens-vitrine.test.ts` valide chaque lien de l'application vers
 *      la vitrine contre cette copie, et — si `VEREBONA_PUBLIC_REPO` désigne
 *      un clone de la vitrine — vérifie que la copie est identique.
 *
 * Choix (plutôt qu'un test d'intégration contre un site déployé) : le
 * contrôle reste déterministe, hors réseau, exécuté à chaque `vitest`, et
 * dérivé du code ; la conformité du site DÉPLOYÉ (301, 404, ancres dans le
 * HTML servi) est contrôlée côté vitrine (`scripts/check-site-routes.mjs` à
 * chaque build, tests de `server.cjs`) et en recette préprod.
 */
import inventory from './link-inventory.json';

export const LINK_INVENTORY_SCHEMA = 'verebona-public-links-v1';

interface PublicLinkInventory {
  schema: string;
  routes: { static: string[]; dynamic: string[] };
  homeAnchors: string[];
  pages: { help: string[]; ressources: string[] };
  legacyRedirects: Record<string, string>;
  retired: string[];
  appLinks: string[];
  /** Fichiers de données publiés (catalogue d'aide, corpus T2). */
  dataFiles: string[];
}

export const PUBLIC_LINK_INVENTORY: PublicLinkInventory = inventory as PublicLinkInventory;

type PublicHrefVerdict =
  | { status: 'ok' }
  | { status: 'redirect'; target: string }
  | { status: 'retired' }
  | { status: 'missing-page' }
  | { status: 'missing-anchor'; anchor: string };

/**
 * Verdict sur un chemin de la vitrine (`/chemin?query#ancre`) — même règle
 * que `checkPublicHref` de la vitrine (`src/config/link-inventory.rules.ts`) :
 * ancienne URL → `redirect` (lier la destination finale), page retirée →
 * `retired`, route ou page du corpus inconnue → `missing-page`, ancre
 * absente de l'accueil → `missing-anchor`.
 */
export function checkPublicHref(href: string, inv: PublicLinkInventory = PUBLIC_LINK_INVENTORY): PublicHrefVerdict {
  const hashAt = href.indexOf('#');
  const anchor = hashAt === -1 ? '' : href.slice(hashAt + 1);
  const beforeHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const rawPath = beforeHash.split('?')[0] || '/';
  const path = rawPath.length > 1 ? rawPath.toLowerCase().replace(/\/+$/, '') : rawPath;
  // Fichier (extension) : seuls les fichiers de données publiés sont des destinations.
  if (/\/[^/]*\.[a-z0-9]+$/i.test(path)) return inv.dataFiles.includes(path) ? { status: 'ok' } : { status: 'missing-page' };
  if (inv.legacyRedirects[path]) return { status: 'redirect', target: inv.legacyRedirects[path] };
  if (inv.retired.includes(path)) return { status: 'retired' };
  const known = inv.routes.static.includes(path) || inv.pages.help.includes(path) || inv.pages.ressources.includes(path);
  if (!known) return { status: 'missing-page' };
  if (anchor && (path !== '/' || !inv.homeAnchors.includes(anchor))) return { status: 'missing-anchor', anchor };
  return { status: 'ok' };
}
