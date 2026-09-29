/**
 * Revue lot 12, CDC 15 D-04 — /admin/ai-flags signale une version effective
 * T1 en « master » alors que AI_T1_ANALYSIS_MODE n'est pas `enabled`.
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth-guards', () => ({ requireAdmin: async () => ({ id: 1 }) }));
const warnings = vi.fn(async () => [] as unknown[]);
vi.mock('@/services/ai/config/prompt-architecture', () => ({ promptArchitectureWarnings: () => warnings() }));

const { GET } = await import('../route');
const req = () => new NextRequest('http://localhost/api/admin/ai/flags');

describe('GET /api/admin/ai/flags — alerte d’architecture', () => {
  it('ajoute les écarts au snapshot', async () => {
    warnings.mockResolvedValueOnce([{ treatment: 'T1', code: 'MASTER_NOT_APPLIED', switchName: 'AI_T1_ANALYSIS_MODE', switchMode: 'legacy', message: 'm' }]);
    const body = await (await GET(req())).json();
    expect(body.rollout).toBeDefined();
    expect(body.promptArchitectureWarnings).toEqual([expect.objectContaining({ treatment: 'T1', switchMode: 'legacy' })]);
  });

  it('aucun écart, ou lecture en échec : liste vide, la route répond', async () => {
    expect((await (await GET(req())).json()).promptArchitectureWarnings).toEqual([]);
    warnings.mockRejectedValueOnce(new Error('base'));
    expect((await (await GET(req())).json()).promptArchitectureWarnings).toEqual([]);
  });
});
