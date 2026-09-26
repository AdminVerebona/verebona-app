/**
 * Route retirée `/api/admin/ai-instructions/apply` (410) : son lien de
 * remplacement doit mener quelque part.
 *
 * Il désignait `/api/admin/ai/prompt-changes`, supprimée depuis : suivre le
 * lien donnait un 404. Le remplaçant est l'écran Prompt Control de la
 * Configuration IA et sa route `/api/admin/ai/prompt-control`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/admin/ai-instructions/apply/route';

const root = process.cwd();

describe('ai-instructions/apply : remplacement', () => {
  it('répond 410 et désigne l’écran Prompt Control et sa route', async () => {
    const res = await POST();
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.replacement).toBe('/admin/ai-config#prompt-control');
    expect(body.replacementApi).toBe('/api/admin/ai/prompt-control');
    expect(res.headers.get('link')).toBe('</api/admin/ai/prompt-control>; rel="successor-version"');
    expect(JSON.stringify(body)).not.toMatch(/prompt-changes/);
  });

  it('les cibles existent : route prompt-control, page et ancre de la Configuration IA', () => {
    expect(existsSync(join(root, 'src/app/api/admin/ai/prompt-control/route.ts'))).toBe(true);
    expect(existsSync(join(root, 'src/app/api/admin/ai/prompt-changes'))).toBe(false);
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
