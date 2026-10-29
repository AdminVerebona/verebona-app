/**
 * App Links Android générés depuis la liste UNIQUE du serveur — lot 95
 * (CDC 12 §19 ; source : src/lib/mobile/app-links.ts, lot 97).
 *
 *   node scripts/app-links.mjs          → réécrit le bloc du manifeste
 *   node scripts/app-links.mjs --check  → échoue si le manifeste n'est pas à jour (CI)
 *
 * iOS n'a rien à générer : les chemins sont lus par le système dans
 * /.well-known/apple-app-site-association, servi par le serveur.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const MANIFEST = resolve(here, '../android/app/src/main/AndroidManifest.xml');
const BEGIN = /<!-- VEREBONA:APP_LINKS:BEGIN[^>]*-->/;
const END = '<!-- VEREBONA:APP_LINKS:END -->';

/** Motif AASA → attribut de chemin Android (pur). */
export function androidPathAttribute(pattern) {
  if (pattern.includes('?') || pattern.slice(0, -1).includes('*')) throw new Error(`Motif non convertible : ${pattern}`);
  if (pattern.endsWith('*')) return `android:pathPrefix="${pattern.slice(0, -1)}"`;
  return `android:path="${pattern}"`;
}

/** Bloc `<intent-filter>` (pur, testé). Les exclusions n'ont pas d'équivalent Android : aucun chemin inclus ne les recouvre (contrôlé). */
export function appLinksBlock(routes, exclusions, indent = '            ') {
  for (const ex of exclusions) {
    const prefix = ex.replace(/\*$/, '');
    for (const r of routes) {
      const rp = r.path.replace(/\*$/, '');
      const overlaps = r.path.endsWith('*') ? prefix.startsWith(rp) : rp.startsWith(prefix) && ex.endsWith('*');
      if (overlaps) throw new Error(`Le chemin ${r.path} recouvre l'exclusion ${ex} : non exprimable en App Link Android.`);
    }
  }
  const lines = [
    `<intent-filter android:autoVerify="true">`,
    `    <action android:name="android.intent.action.VIEW" />`,
    `    <category android:name="android.intent.category.DEFAULT" />`,
    `    <category android:name="android.intent.category.BROWSABLE" />`,
    `    <data android:scheme="https" android:host="\${appHost}" />`,
    ...routes.map((r) => `    <data ${androidPathAttribute(r.path)} />`),
    `</intent-filter>`,
  ];
  return lines.map((l) => indent + l).join('\n');
}

export async function loadServerRoutes() {
  const m = await import('../../src/lib/mobile/app-links.ts');
  return { routes: m.APP_LINK_ROUTES, exclusions: m.APP_LINK_EXCLUSIONS };
}

export function applyBlock(manifest, block) {
  const b = BEGIN.exec(manifest);
  const e = manifest.indexOf(END);
  if (!b || e < 0 || e < b.index) throw new Error('Marqueurs VEREBONA:APP_LINKS introuvables dans le manifeste.');
  const head = manifest.slice(0, b.index + b[0].length);
  const tail = manifest.slice(e);
  const indent = /([ \t]*)$/.exec(manifest.slice(0, b.index))?.[1] ?? '';
  return `${head}\n${block}\n${indent}${tail}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { routes, exclusions } = await loadServerRoutes();
  const current = readFileSync(MANIFEST, 'utf8');
  const next = applyBlock(current, appLinksBlock(routes, exclusions));
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error('AndroidManifest.xml n’est pas à jour avec src/lib/mobile/app-links.ts : lancer `npm run sync:links` dans mobile/.');
      process.exit(1);
    }
    console.log('App Links Android à jour.');
  } else {
    writeFileSync(MANIFEST, next);
    console.log(`App Links Android : ${routes.length} chemins écrits.`);
  }
}
