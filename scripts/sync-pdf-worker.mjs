#!/usr/bin/env node
/**
 * Copie le worker pdf.js de la version INSTALLÉE dans public/.
 *
 * Les vignettes PDF chargent `/pdf.worker.min.mjs`. Ce fichier avait été
 * copié à la main (5.6.205) alors que le verrou installe pdfjs-dist 5.7.284 :
 * pdf.js refuse un worker d'une autre version (« The API version … does not
 * match the Worker version … »), chaque vignette tombait en erreur et
 * affichait le logo PDF. Lancé avant `dev` et `build`, ce script garantit
 * que les deux versions sont toujours identiques.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(racine, 'package.json'));

let source;
try {
  source = join(dirname(require.resolve('pdfjs-dist/package.json')), 'build', 'pdf.worker.min.mjs');
} catch {
  console.warn('[sync-pdf-worker] pdfjs-dist absent : rien à copier.');
  process.exit(0);
}
const cible = join(racine, 'public', 'pdf.worker.min.mjs');

if (!existsSync(source)) {
  console.warn(`[sync-pdf-worker] worker introuvable : ${source}`);
  process.exit(0);
}
if (existsSync(cible) && readFileSync(cible).equals(readFileSync(source))) process.exit(0);

copyFileSync(source, cible);
const { version } = require('pdfjs-dist/package.json');
console.log(`[sync-pdf-worker] public/pdf.worker.min.mjs mis à jour (pdfjs-dist ${version}).`);
