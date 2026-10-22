/**
 * Lot 79B — Icônes de l'application installée (PWA Android / Apple).
 *
 * SOURCE UNIQUE des chemins utilisés par le manifeste (`/api/manifest`),
 * les balises `<link>` du layout racine et, par recopie vérifiée par test,
 * `public/manifest.json` et `public/sw.js` (fichiers statiques qui ne peuvent
 * pas importer ce module).
 *
 * Symbole : planche validée par le PO au lot 71H (commit a179e11 — tuile
 * pétrole #17474D pleine, cases ivoire #F8F6F1, cube cuivre #D66B53, sans
 * relief ni reflet). Les fichiers de `public/pwa/` sont des COPIES OCTET POUR
 * OCTET de cette planche (aucune régénération) : 192/512 « any », 192/512
 * « maskable » (symbole entier dans le disque de sécurité de 80 % — rayon
 * mesuré 38,1 % — fond opaque plein cadre) et apple-touch-icon 180 opaque,
 * coins carrés (iOS applique son propre masque).
 *
 * NOMS VERSIONNÉS : les fichiers de `public/pwa/` sont servis avec
 * `Cache-Control: immutable` (next.config.mjs). Toute modification d'une
 * image impose un NOUVEAU nom (suffixe de lot), jamais un remplacement sur
 * place. L'identité de la PWA (absence d'`id`, `start_url`, `scope`) ne doit
 * pas être modifiée pour forcer un changement d'icône.
 */

export const PWA_ICONS_DIR = '/pwa';

export const PWA_ICON_ANY_192 = '/pwa/icon-any-192-l79.png';
export const PWA_ICON_ANY_512 = '/pwa/icon-any-512-l79.png';
export const PWA_ICON_MASKABLE_192 = '/pwa/icon-maskable-192-l79.png';
export const PWA_ICON_MASKABLE_512 = '/pwa/icon-maskable-512-l79.png';
export const PWA_APPLE_TOUCH_ICON_180 = '/pwa/apple-touch-icon-180-l79.png';

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: 'image/png';
  purpose: 'any' | 'maskable';
}

/**
 * Icônes du manifeste. « any » et « maskable » sont DISTINCTES (jamais
 * `purpose: "any maskable"`) : Chrome Android choisit la maskable pour
 * l'icône de l'écran d'accueil, les autres contextes prennent « any ».
 */
export const PWA_MANIFEST_ICONS: readonly ManifestIcon[] = [
  { src: PWA_ICON_ANY_192, sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: PWA_ICON_ANY_512, sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: PWA_ICON_MASKABLE_192, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: PWA_ICON_MASKABLE_512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/** Icône des raccourcis du manifeste (appui long sur l'icône Android). */
export const PWA_SHORTCUT_ICONS = [{ src: PWA_ICON_ANY_192, sizes: '192x192', type: 'image/png' }] as const;
