/**
 * CDC 15 D-01 — page « Drapeaux et commutateurs » : valeurs effectives par
 * environnement, interprétation réelle du code, accès administrateur seul.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { buildFlagsSnapshot } from '../flags-snapshot.service';
import { AI_FLAGS } from '../ai-feature-flags';

afterEach(() => {
  vi.doUnmock('@/lib/auth-guards');
  vi.resetModules();
});

describe('instantané des drapeaux', () => {
  it('environnement, drapeaux AI_*, file durable et commutateurs', () => {
    const snap = buildFlagsSnapshot({
      NEXT_PUBLIC_APP_ENV: 'staging',
      AI_UNIFIED_SOURCE_ANALYSIS: 'enabled',
      AI_RECONCILIATION_ENGINE: 'shadow',
      AI_AGENDA_ENGINE: 'enabeld',
      AI_DURABLE_QUEUE: 'true',
      CANONICAL_WRITE_MODE: 'shadow',
    }, new Date('2026-09-29T08:00:00Z'));

    expect(snap.environment).toEqual({ appEnv: 'staging', aiEnvironment: 'preprod' });
    expect(snap.aiFlags.map((f) => f.name)).toEqual([...AI_FLAGS]);
    const par = Object.fromEntries(snap.aiFlags.map((f) => [f.name, f]));
    expect(par.AI_UNIFIED_SOURCE_ANALYSIS).toMatchObject({ mode: 'enabled', raw: 'enabled', invalid: false });
    expect(par.AI_RECONCILIATION_ENGINE.mode).toBe('shadow');
    // Faute de frappe : visible, et appliquée comme legacy.
    expect(par.AI_AGENDA_ENGINE).toMatchObject({ mode: 'legacy', raw: 'enabeld', invalid: true });
    // Absente : défaut du code.
    expect(par.AI_HOME_MASCOT).toMatchObject({ mode: 'legacy', raw: null, invalid: false });

    expect(snap.technical).toEqual([expect.objectContaining({ name: 'AI_DURABLE_QUEUE', mode: 'enabled' })]);
    const cw = snap.rollout.find((r) => r.env === 'CANONICAL_WRITE_MODE');
    expect(cw).toMatchObject({ mode: 'shadow' });
    expect(snap.rollout.map((r) => r.env)).toEqual(expect.arrayContaining([
      'CANONICAL_WRITE_MODE', 'AI_T1_ANALYSIS_MODE', 'T3_NEGATIVE_RECONCILIATION',
      'AI_T4_EFFECTS', 'ASSISTANT_CANONICAL_READ', 'EXPORTS_CANONICAL_SOURCE',
    ]));
    expect(snap.generatedAt).toBe('2026-09-29T08:00:00.000Z');
  });

  it('file durable : « shadow » n’existe pas, lu legacy', () => {
    expect(buildFlagsSnapshot({ AI_DURABLE_QUEUE: 'shadow' }).technical[0].mode).toBe('legacy');
  });

  it('environnement illisible : signalé, sans lever', () => {
    expect(buildFlagsSnapshot({}).environment).toEqual({ appEnv: null, aiEnvironment: null });
  });
});

describe('route /api/admin/ai/flags', () => {
  it('refusée sans droits administrateur', async () => {
    vi.doMock('@/lib/auth-guards', () => ({
      requireAdmin: async () => { throw new Error('INSUFFICIENT_PERMISSIONS'); },
    }));
    const { GET } = await import('@/app/api/admin/ai/flags/route');
    const res = await GET(new NextRequest('http://x/api/admin/ai/flags'));
    expect(res.status).toBe(403);
  });

  it('administrateur : instantané de ce processus, non mis en cache', async () => {
    vi.doMock('@/lib/auth-guards', () => ({ requireAdmin: async () => 1 }));
    const { GET } = await import('@/app/api/admin/ai/flags/route');
    const res = await GET(new NextRequest('http://x/api/admin/ai/flags'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    // setup.ts : tous les nouveaux moteurs actifs en test.
    expect(body.aiFlags.find((f: { name: string }) => f.name === 'AI_INTELLIGENT_ASSISTANT').mode).toBe('enabled');
  });
});
