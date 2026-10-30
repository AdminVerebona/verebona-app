/**
 * Lot 101 — garde-fou de structure (incident du 30/10/2026 : dossier `app/`
 * copié à la racine, build Next.js vide sur Scalingo alors que la CI était verte).
 */
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRepoStructure } from '../../../scripts/check-repo-structure.mjs';

const ROOT = resolve(__dirname, '../../..');

describe('L101 — structure du dépôt', () => {
  it('le dépôt lui-même est conforme : aucun app/ ni pages/ à la racine, src/app présent', () => {
    expect(checkRepoStructure(ROOT)).toEqual([]);
  });

  it('un dossier app/ à la racine est refusé avec la marche à suivre', () => {
    const d = mkdtempSync(join(tmpdir(), 'l101-structure-'));
    mkdirSync(join(d, 'src', 'app'), { recursive: true });
    mkdirSync(join(d, 'app', '.github', 'workflows'), { recursive: true });
    const p = checkRepoStructure(d);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/« app\/ ».*git rm -r app/);
  });

  it('pages/ à la racine ou src/app absent : refusés', () => {
    const d = mkdtempSync(join(tmpdir(), 'l101-structure-'));
    mkdirSync(join(d, 'pages'), { recursive: true });
    expect(checkRepoStructure(d)).toHaveLength(2);
  });

  it('le contrôle tourne avant chaque build (prebuild)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.prebuild).toMatch(/^node scripts\/check-repo-structure\.mjs && /);
  });
});
