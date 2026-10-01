#!/usr/bin/env node
/**
 * Allège l'image Scalingo après `next build` (limite : 2048 Mo).
 * Lancé par `postbuild`, UNIQUEMENT sur un build Scalingo (STACK=scalingo-*) ou
 * avec PRUNE_IMAGE=1 : en local, le cache de build est conservé.
 *
 * Supprime ce qui ne sert qu'à la compilation et n'est jamais lu à l'exécution :
 *   · .next/cache/webpack, .next/cache/swc, .next/cache/eslint (cache de build
 *     Next, plusieurs centaines de Mo) — .next/cache/images et fetch-cache sont
 *     conservés (utilisés à l'exécution) ;
 *   · .apt/usr/share/{doc,man,info,lintian,bug} (documentation des paquets apt) ;
 *   · ffmpeg de Playwright (inutile pour le rendu PDF).
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const env = process.env;
const onScalingo = /^scalingo/i.test(env.STACK ?? '');
const forced = ['1', 'true'].includes((env.PRUNE_IMAGE ?? '').trim().toLowerCase());
const log = (m) => console.log(`[prune-image] ${m}`);

if (!onScalingo && !forced) {
  log('ignoré hors Scalingo (PRUNE_IMAGE=1 pour forcer).');
  process.exit(0);
}

function size(p) {
  try {
    const s = statSync(p);
    if (!s.isDirectory()) return s.size;
    return readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0);
  } catch { return 0; }
}

const root = process.cwd();
const targets = [
  '.next/cache/webpack',
  '.next/cache/swc',
  '.next/cache/eslint',
  '.apt/usr/share/doc',
  '.apt/usr/share/man',
  '.apt/usr/share/info',
  '.apt/usr/share/lintian',
  '.apt/usr/share/bug',
];
const browsers = path.join(root, 'node_modules/playwright-core/.local-browsers');
if (existsSync(browsers)) {
  for (const d of readdirSync(browsers)) if (d.startsWith('ffmpeg')) targets.push(path.relative(root, path.join(browsers, d)));
}

let total = 0;
for (const t of targets) {
  const p = path.join(root, t);
  if (!existsSync(p)) continue;
  const n = size(p);
  try {
    rmSync(p, { recursive: true, force: true });
    total += n;
    log(`supprimé ${t} (${(n / 1048576).toFixed(0)} Mo)`);
  } catch (e) {
    log(`impossible de supprimer ${t} : ${e.message}`);
  }
}
log(`terminé : ${(total / 1048576).toFixed(0)} Mo libérés.`);
