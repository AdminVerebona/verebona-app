/**
 * Lot 102C — décision PO « Pas de Web Push / PWA ; push mobile natif
 * uniquement » : aucun reste côté web qui la contredise.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(join(ROOT, dir))) {
    const p = join(dir, f);
    if (f === '__tests__' || f === 'node_modules') continue;
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js)$/.test(f)) out.push(p);
  }
  return out;
}

describe('L102C-WP-01 — aucun Web Push', () => {
  it('le service worker ne gère aucune notification push', () => {
    const sw = read('public/sw.js');
    expect(sw).not.toMatch(/addEventListener\(\s*['"](push|notificationclick|pushsubscriptionchange)['"]/);
    expect(sw).not.toMatch(/showNotification\(|pushManager\.subscribe\(/);
  });
  it('aucune demande de permission de notification navigateur ni clé VAPID dans le code web', () => {
    const offenders = walk('src').filter((p) => !p.startsWith('src/lib/native/'))
      .filter((p) => /Notification\.requestPermission|pushManager\.subscribe|applicationServerKey|from ['"]web-push['"]/.test(read(p)));
    expect(offenders).toEqual([]);
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('web-push');
  });
  it('aucun SDK d’analyse Firebase / Google côté web', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /^firebase$|@firebase\/analytics|gtag|google-analytics/.test(d))).toEqual([]);
  });
});
