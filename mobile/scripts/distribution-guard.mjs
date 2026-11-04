/**
 * Garde-fou de distribution sur l'ARTEFACT construit — lot 108G (CA02).
 *
 *   VEREBONA_ENV=… VEREBONA_APP_ORIGIN=… \
 *     node scripts/distribution-guard.mjs <capacitor.config.json du binaire> <dossier public/ du binaire>
 *
 * Lancé par mobile-ios.yml (dans l'archive Xcode, App.app) et mobile-android.yml
 * (dans l'AAB, base/assets) JUSTE AVANT l'envoi à TestFlight / Google Play.
 * Ce n'est pas la configuration demandée qui est contrôlée, mais celle que
 * contient réellement le binaire : une sonde technique (mode local), une
 * adresse d'un autre environnement ou un réglage de débogage en production
 * bloquent l'envoi (« build refusé », aucune valeur secrète affichée).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBuildConfig } from '../config/environments.mjs';

/**
 * Contrôle pur (testé).
 * @param {Record<string, unknown>} cap   contenu de capacitor.config.json du binaire
 * @param {string[]} publicEntries        noms présents à la racine de public/
 * @param {string | null} appConfigJs     contenu de public/app-config.js (ou null)
 * @param {ReturnType<typeof resolveBuildConfig>} b configuration attendue
 * @returns {string[]} problèmes (vide = envoi admis)
 */
export function inspectArtifact(cap, publicEntries, appConfigJs, b) {
  const p = [];
  const server = /** @type {Record<string, unknown>} */ (cap?.server ?? {});
  if (cap?.appId !== b.appId) p.push(`Identifiant de l'app inattendu dans le binaire (attendu ${b.appId}).`);
  if (server.url !== b.serverUrl) p.push(`Le binaire ne charge pas l'interface distante de l'environnement (server.url attendu : ${b.serverUrl}).`);
  if (server.cleartext === true) p.push('HTTP en clair autorisé dans le binaire.');
  if (Array.isArray(server.allowNavigation) && server.allowNavigation.length > 0) p.push('Domaines supplémentaires autorisés dans la vue (allowNavigation non vide).');
  if (/** @type {any} */ (cap?.plugins)?.CapacitorHttp?.enabled === true) p.push('Relais HTTP natif actif (réservé à la sonde technique).');
  if (publicEntries.some((n) => /^(probe|sonde)/i.test(n))) p.push('Sonde technique (mode local) présente dans le binaire.');
  if (!publicEntries.includes('offline.html')) p.push('Page « Connexion Internet indisponible » absente du binaire.');
  if (!appConfigJs || !appConfigJs.includes('"uiMode": "remote"') || !appConfigJs.includes(`"origin": "${b.origin}"`)) {
    p.push('Configuration publique du binaire absente ou d’un autre mode / environnement (app-config.js).');
  }
  if (b.env === 'prod') {
    if (/** @type {any} */ (cap?.ios)?.webContentsDebuggingEnabled === true || /** @type {any} */ (cap?.android)?.webContentsDebuggingEnabled === true) {
      p.push('Inspection de la vue (débogage) active dans un binaire de production.');
    }
    if (JSON.stringify(cap).includes('preprod')) p.push('Valeur de préproduction trouvée dans un binaire de production.');
  }
  return p;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [capPath, publicDir] = process.argv.slice(2);
  const problems = [];
  let b = null;
  try { b = resolveBuildConfig(process.env); } catch (e) { problems.push(...String(e.message).split('\n- ').slice(1)); }
  if (b) {
    if (!capPath || !existsSync(capPath)) problems.push('capacitor.config.json introuvable dans le binaire.');
    else if (!publicDir || !existsSync(publicDir)) problems.push('Dossier public/ introuvable dans le binaire.');
    else {
      const cap = JSON.parse(readFileSync(capPath, 'utf8'));
      const entries = readdirSync(publicDir);
      const appCfg = existsSync(join(publicDir, 'app-config.js')) ? readFileSync(join(publicDir, 'app-config.js'), 'utf8') : null;
      problems.push(...inspectArtifact(cap, entries, appCfg, b));
    }
  }
  if (problems.length > 0) {
    for (const m of problems) console.log(`::error::Envoi refusé — ${m}`);
    process.exit(1);
  }
  console.log(`Binaire contrôlé : ${b.appName} (${b.appId}), interface distante ${b.serverUrl}. Envoi autorisé.`);
}
