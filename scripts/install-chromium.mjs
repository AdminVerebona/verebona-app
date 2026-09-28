#!/usr/bin/env node
/**
 * Installation du « chromium-headless-shell » de Playwright pour le moteur de
 * dossiers V12 (CDC Exports V12 DEC-003, MIG-03). Lancé par `postinstall`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUAND INSTALLER
 *
 *   · EXPORTS_INSTALL_CHROMIUM=1        → toujours (à définir sur Scalingo) ;
 *   · build Scalingo détecté (STACK=scalingo-*) → oui ;
 *   · sinon (poste local, CI)           → non : rien n'est téléchargé, les
 *     tests d'intégration Chromium sont alors ignorés proprement.
 *
 * Jamais : EXPORTS_INSTALL_CHROMIUM=0, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, ou
 * CHROMIUM_EXECUTABLE_PATH défini (binaire fourni par l'image).
 *
 * OÙ : dans le paquet (`PLAYWRIGHT_BROWSERS_PATH=0` →
 * node_modules/playwright-core/.local-browsers), donc DANS l'image déployée —
 * le cache utilisateur d'un build n'est pas conservé. À l'exécution, le
 * moteur détecte ce répertoire tout seul (render/browser.ts). Un
 * PLAYWRIGHT_BROWSERS_PATH explicite est respecté.
 *
 * Les bibliothèques système de Chromium viennent de l'`Aptfile`
 * (apt-buildpack, voir `.buildpacks` et src/services/exports/v12/README.md).
 *
 * Un échec est BLOQUANT dès que l'installation est demandée
 * (EXPORTS_INSTALL_CHROMIUM=1) OU que le build est un build Scalingo
 * (STACK=scalingo-*), même sans la variable : un build de production sans
 * moteur PDF doit échouer tôt, pas au premier dossier généré.
 *
 * STACK SCALINGO : l'`Aptfile` utilise les noms de paquets d'Ubuntu 24.04
 * (suffixe t64 : libasound2t64, libgtk-3-0t64), absents de scalingo-22. Le
 * build échoue donc sur une stack antérieure à scalingo-24 (voir
 * src/services/exports/v12/README.md, « Déploiement Scalingo »).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const env = process.env;
const flag = (v) => (v ?? '').trim().toLowerCase();
const explicit = ['1', 'true', 'on', 'yes'].includes(flag(env.EXPORTS_INSTALL_CHROMIUM));
const refused = ['0', 'false', 'off', 'no'].includes(flag(env.EXPORTS_INSTALL_CHROMIUM));
const onScalingo = /^scalingo/i.test(env.STACK ?? '');

function log(msg) { console.log(`[install-chromium] ${msg}`); }
/** Échec : bloquant si l'installation est demandée ou si le build est un build Scalingo. */
const mandatory = explicit || onScalingo;
function fail(msg) {
  log(msg);
  process.exit(mandatory ? 1 : 0);
}

if (refused || ['1', 'true'].includes(flag(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD))) {
  log('ignoré (EXPORTS_INSTALL_CHROMIUM=0 ou PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).');
  process.exit(0);
}
if (env.CHROMIUM_EXECUTABLE_PATH) {
  log(`ignoré : CHROMIUM_EXECUTABLE_PATH=${env.CHROMIUM_EXECUTABLE_PATH}.`);
  process.exit(0);
}
if (!explicit && !onScalingo) {
  log('ignoré hors Scalingo (EXPORTS_INSTALL_CHROMIUM=1 pour forcer).');
  process.exit(0);
}

// Stack Scalingo : scalingo-24 minimum (paquets *t64 de l'Aptfile).
const stackMatch = /^scalingo-(\d+)/i.exec(env.STACK ?? '');
if (onScalingo && (!stackMatch || Number(stackMatch[1]) < 24)) {
  log(`stack ${env.STACK} non prise en charge : l'Aptfile (paquets *t64) exige scalingo-24 ou ultérieure.`);
  log('Changez la stack de l\'application (scalingo --app <app> stacks-set scalingo-24), puis relancez le déploiement.');
  process.exit(1);
}

let cli;
try {
  const require = createRequire(import.meta.url);
  cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
} catch {
  fail('playwright-core absent : rien à installer.');
}
if (!existsSync(cli)) {
  fail(`CLI Playwright introuvable (${cli}).`);
}

const childEnv = { ...env, PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH || '0' };
log(`installation du chromium-headless-shell (PLAYWRIGHT_BROWSERS_PATH=${childEnv.PLAYWRIGHT_BROWSERS_PATH})…`);
const r = spawnSync(process.execPath, [cli, 'install', '--only-shell', 'chromium'], { stdio: 'inherit', env: childEnv });
if (r.status !== 0) {
  fail(`échec de l'installation (code ${r.status}).`);
}
log('terminé.');
