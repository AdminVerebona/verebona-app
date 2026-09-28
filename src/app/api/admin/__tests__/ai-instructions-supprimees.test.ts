/**
 * Ancienne « Gestion IA » — CDC BO §14 (« Gestion IA supprimé »), audit lot4
 * §4 point 3.
 *
 * `GET/POST/PATCH /api/admin/ai-instructions` (aucun écran, table créée à la
 * volée) et `POST /api/admin/ai-instructions/apply` (410) sont SUPPRIMÉES. Le
 * remplaçant est Prompt Control (T5) dans la Configuration IA, adossé à
 * `/api/admin/ai/prompt-control`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSources(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('routes ai-instructions supprimées', () => {
  it('le dossier de routes n’existe plus', () => {
    expect(existsSync(join(root, 'src/app/api/admin/ai-instructions'))).toBe(false);
  });

  it('aucun code applicatif n’appelle encore /api/admin/ai-instructions', () => {
    const callers = listSources(join(root, 'src'))
      .filter((f) => /['"`]\/api\/admin\/ai-instructions/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1));
    expect(callers).toEqual([]);
  });

  it('le remplaçant existe : route prompt-control et ancre de la Configuration IA', () => {
    expect(existsSync(join(root, 'src/app/api/admin/ai/prompt-control/route.ts'))).toBe(true);
    const page = readFileSync(join(root, 'src/app/admin/ai-config/page.tsx'), 'utf8');
    expect(page).toMatch(/id="prompt-control"/);
  });
});

describe('anciennes entrées « Gestion IA » et « Suivi IA »', () => {
  it('les pages redirigent vers le Tableau de bord IA', () => {
    for (const p of ['src/app/admin/document-ai/page.tsx', 'src/app/admin/ai-usage/page.tsx']) {
      expect(readFileSync(join(root, p), 'utf8')).toMatch(/redirect\('\/admin\/ai-dashboard'\)/);
    }
  });
});
