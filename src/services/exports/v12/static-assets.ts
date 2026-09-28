/**
 * Fichiers statiques des dossiers V12 : jetons, composants CSS, polices
 * auto-hébergées (OFL, voir `static/fonts/LICENSE*.txt`) et marque.
 *
 * Copie fidèle de `maquettes/_system/` (tokens.css, components.css, fonts/,
 * assets/brand/). Ils sont lus sur disque par le serveur et servis à Chromium
 * sous une ORIGINE VIRTUELLE (`RENDER_ORIGIN`, domaine `.invalid` jamais
 * résolu) : `/static/…` → ce répertoire, `/work/…` → répertoire de travail de
 * la génération (HTML, photos et images préparées). Toutes les requêtes de la
 * page sont interceptées (`render/render-pdf.ts`) : seules ces deux racines
 * sont servies, tout le reste est refusé ; les URL `file://` sont bloquées par
 * Chromium depuis une origine https — aucun fichier local arbitraire ni
 * aucune ressource réseau ne peut être chargé pendant le rendu.
 *
 * Le répertoire est résolu depuis la racine du projet (`process.cwd()`), comme
 * les migrations (`src/db/index.ts`) : le bundle Next.js ne relocalise pas ces
 * fichiers. `EXPORTS_V12_STATIC_DIR` permet de le déplacer (image Docker).
 */

import fs from 'node:fs';
import path from 'node:path';

export function staticDir(): string {
  const override = process.env.EXPORTS_V12_STATIC_DIR?.trim();
  return override ? path.resolve(override) : path.join(process.cwd(), 'src', 'services', 'exports', 'v12', 'static');
}

/** Origine virtuelle des ressources d'un dossier pendant le rendu. */
export const RENDER_ORIGIN = 'https://dossier.verebona.invalid';

/** URL du répertoire statique, terminée par « / » (`ctx.sys`). */
export function staticBaseUrl(): string {
  return `${RENDER_ORIGIN}/static/`;
}

/** URL virtuelle d'un fichier du répertoire de travail (`workDir`). */
export function workFileUrl(workDir: string, file: string): string {
  const rel = path.relative(path.resolve(workDir), path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`fichier hors du répertoire de travail : ${file}`);
  return `${RENDER_ORIGIN}/work/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
}

/**
 * Fichier sur disque servi pour une URL demandée par Chromium, ou `null` si
 * l'URL n'est pas autorisée : autre origine, autre racine, ou chemin qui sort
 * de sa racine après décodage (`..`, `%2F`…).
 */
export function renderUrlToPath(url: string, workDir: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.origin !== RENDER_ORIGIN) return null;
  const roots: Array<[string, string]> = [['/static/', staticDir()], ['/work/', workDir]];
  for (const [prefix, dir] of roots) {
    if (!u.pathname.startsWith(prefix)) continue;
    let rel: string;
    try { rel = decodeURIComponent(u.pathname.slice(prefix.length)); } catch { return null; }
    if (!rel || rel.includes('\0')) return null;
    const root = path.resolve(dir);
    const file = path.resolve(root, rel);
    return file.startsWith(root + path.sep) ? file : null;
  }
  return null;
}

/** Feuilles de style d'un dossier (ordre du design : jetons puis composants). */
export function stylesheetUrls(sys: string = staticBaseUrl()): string[] {
  return [`${sys}tokens.css`, `${sys}components.css`];
}

let markDataUri: string | null = null;

/**
 * Marque Verebona en data-URI : la boîte de marge `@top-left` de l'en-tête ne
 * rend pas `content: url()` dans Chromium ; la marque y est posée en
 * `background` (`maquettes/_system/README.md`, Pagination).
 */
export function markDataUriOnce(): string {
  if (!markDataUri) {
    const svg = fs.readFileSync(path.join(staticDir(), 'assets', 'brand', 'verebona-mark.svg'));
    markDataUri = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  }
  return markDataUri;
}

/** Contrôle de présence (démarrage, diagnostic) : liste des fichiers manquants. */
export function missingStaticFiles(): string[] {
  const dir = staticDir();
  const expected = [
    'tokens.css', 'components.css',
    'fonts/inter-400.woff2', 'fonts/inter-500.woff2', 'fonts/inter-600.woff2', 'fonts/inter-700.woff2',
    'fonts/bricolage-grotesque-latin-opsz-5.3.0.woff2', 'fonts/space-mono-400.woff2', 'fonts/space-mono-700.woff2',
    'assets/brand/verebona-mark.svg', 'assets/brand/verebona-mark-on-dark.svg', 'assets/brand/info-card.webp',
  ];
  return expected.filter((f) => !fs.existsSync(path.join(dir, f)));
}
