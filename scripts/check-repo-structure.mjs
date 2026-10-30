/**
 * Garde-fou de structure du dépôt — lot 101 (incident du 30/10/2026).
 *
 * Un dossier `app/` (ou `pages/`) à la RACINE du dépôt — typiquement un zip de
 * livraison copié avec son dossier `app` au lieu de son contenu — fait ignorer
 * `src/app` par Next.js : le build « réussit » avec une seule page /404 et la
 * préproduction ne sert plus aucun écran. Ce contrôle fait échouer le build
 * (prebuild) et la CI (test unitaire) avec un message explicite.
 *
 *   node scripts/check-repo-structure.mjs
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Dossiers interdits à la racine (Next.js les préfère à src/app et src/pages). */
export const FORBIDDEN_ROOT_DIRS = Object.freeze(['app', 'pages']);

/** @param {string} root @returns {string[]} problèmes (vide = conforme) */
export function checkRepoStructure(root) {
  const problems = [];
  for (const d of FORBIDDEN_ROOT_DIRS) {
    const p = join(root, d);
    if (existsSync(p) && statSync(p).isDirectory()) {
      problems.push(`Dossier « ${d}/ » présent à la racine du dépôt : Next.js l'utiliserait à la place de « src/${d} » (build vide, site en 404). `
        + `C'est en général un zip de livraison copié avec son dossier « app » : copier le CONTENU (robocopy <zip>\\app . /E), puis supprimer ce dossier (git rm -r ${d}).`);
    }
  }
  if (!existsSync(join(root, 'src', 'app'))) problems.push('Dossier « src/app » introuvable : les écrans de l\'application sont absents.');
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = checkRepoStructure(root);
  if (problems.length > 0) {
    for (const p of problems) console.error(`[structure] ${p}`);
    process.exit(1);
  }
  console.log('[structure] dépôt conforme (aucun dossier app/ ou pages/ à la racine).');
}
