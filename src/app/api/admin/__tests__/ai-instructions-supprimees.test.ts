/**
 * Ancienne « Gestion IA » — CDC BO §14 (« Gestion IA supprimé »), audit lot4
 * §4 point 3.
 *
 * `GET/POST/PATCH /api/admin/ai-instructions` (aucun écran, table créée à la
 * volée) et `POST /api/admin/ai-instructions/apply` (410) sont SUPPRIMÉES. Son
 * remplaçant, Prompt Control (T5), est à son tour SUPPRIMÉ au lot 49
 * (ticket 12) : `/api/admin/ai/prompt-control` rejette toute invocation (410).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const garde = vi.hoisted(() => ({ admin: true }));
vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => { if (!garde.admin) throw Object.assign(new Error('refus'), { session: true }); return 1; },
  isSessionError: (e: unknown) => Boolean((e as { session?: boolean })?.session),
  sessionErrorResponse: () => new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 }),
}));

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

  it('T12-AC02 / T12-AC03 — route prompt-control définitivement inopérante : 410 pour toute méthode, aucun service ni appel modèle', async () => {
    const src = readFileSync(join(root, 'src/app/api/admin/ai/prompt-control/route.ts'), 'utf8');
    expect(src).not.toMatch(/import .*(governance|gateway|master-prompts|@\/db)/);
    const route = await import('../ai/prompt-control/route');
    const { NextRequest } = await import('next/server');
    const req = () => new NextRequest('http://app.test/api/admin/ai/prompt-control', { method: 'POST' });
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const r = await route[m](req());
      expect(r.status, m).toBe(410);
      expect((await r.json()).error).toBe('T5_RETIRED');
    }
    // Garde administrateur conservée : un non-administrateur est refusé, sans rien apprendre.
    garde.admin = false;
    const refus = await route.POST(req());
    expect(refus.status).toBe(403);
    expect(JSON.stringify(await refus.json())).not.toMatch(/T5/);
    garde.admin = true;
    expect(existsSync(join(root, 'src/services/ai/governance/prompt-control.service.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/services/ai/prompts/governance/t5_master_v1.txt'))).toBe(false);
    const page = readFileSync(join(root, 'src/app/admin/ai-config/page.tsx'), 'utf8');
    expect(page).not.toMatch(/id="prompt-control"/);
  });
});

describe('anciennes entrées « Gestion IA » et « Suivi IA »', () => {
  it('les pages redirigent vers le Tableau de bord IA', () => {
    for (const p of ['src/app/admin/document-ai/page.tsx', 'src/app/admin/ai-usage/page.tsx']) {
      expect(readFileSync(join(root, p), 'utf8')).toMatch(/redirect\('\/admin\/ai-dashboard'\)/);
    }
  });
});
