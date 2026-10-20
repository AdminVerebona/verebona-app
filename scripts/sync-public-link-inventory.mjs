/**
 * Recopie l'inventaire des liens de la vitrine dans l'application — lot 72.
 *
 *   node scripts/sync-public-link-inventory.mjs <chemin du dépôt verebona-public>
 *
 * Source : `<vitrine>/link-inventory.json`, généré et commité par la vitrine
 * (dérivé de son routeur, de ses sections et de son corpus ; voir son README,
 * « Inventaire des liens »). Destination : `src/lib/public-site/link-inventory.json`.
 * Ensuite : `npx vitest run src/__tests__/lot72/l72e-liens-vitrine.test.ts`
 * signale tout lien de l'application devenu obsolète.
 *
 * Outil de développement (aucune exécution en exploitation).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'verebona-public-links-v1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src/lib/public-site/link-inventory.json');

const repo = process.argv[2] || process.env.VEREBONA_PUBLIC_REPO;
if (!repo) {
  console.error('Usage : node scripts/sync-public-link-inventory.mjs <chemin du dépôt verebona-public>');
  process.exit(2);
}
const source = path.resolve(repo, 'link-inventory.json');
let raw;
try {
  raw = readFileSync(source, 'utf8');
} catch {
  console.error(`Inventaire introuvable : ${source}`);
  process.exit(1);
}
const inv = JSON.parse(raw);
const ok = inv && inv.schema === SCHEMA && inv.routes && Array.isArray(inv.routes.static) && Array.isArray(inv.homeAnchors)
  && inv.pages && Array.isArray(inv.pages.help) && Array.isArray(inv.pages.ressources)
  && inv.legacyRedirects && Array.isArray(inv.retired) && Array.isArray(inv.appLinks);
if (!ok) {
  console.error(`Schéma inattendu (${inv && inv.schema}) : attendu ${SCHEMA}.`);
  process.exit(1);
}
let before = '';
try { before = readFileSync(target, 'utf8'); } catch { /* première copie */ }
writeFileSync(target, raw);
console.log(before === raw ? 'Inventaire déjà à jour.' : `Inventaire mis à jour depuis ${source}.`);
