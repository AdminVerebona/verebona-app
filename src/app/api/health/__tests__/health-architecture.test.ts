/**
 * Revue lot 12, CDC 15 D-04 — /api/health signale une version effective T1
 * en « master » alors que AI_T1_ANALYSIS_MODE n'est pas `enabled`
 * (avertissement : le statut global n'est pas dégradé pour autant).
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/db', () => ({ db: { execute: async () => [] }, getMigrationFailures: () => [] }));
const warnings = vi.fn(async () => [] as unknown[]);
vi.mock('@/services/ai/config/prompt-architecture', () => ({ promptArchitectureWarnings: () => warnings() }));
vi.mock('@/services/verebona-assistant/core/help-corpus.service', () => ({
  loadHelpCorpus: async () => null, helpCorpusHealth: () => ({ status: 'ok', source: 'live' }),
}));

const { GET } = await import('../route');
const req = () => new NextRequest('http://localhost/api/health');

describe('GET /api/health — cohérence architecture / commutateur', () => {
  it('écart : check en warning, statut global inchangé', async () => {
    warnings.mockResolvedValueOnce([{ treatment: 'T3', code: 'MASTER_ENGINE_NOT_ENABLED', switchName: 'AI_RECONCILIATION_ENGINE', switchMode: 'shadow', message: 'm' }]);
    const body = await (await GET(req())).json();
    expect(body.checks.aiPromptArchitecture).toEqual({
      status: 'warning', warnings: [expect.objectContaining({ treatment: 'T3', switchMode: 'shadow' })],
    });
    expect(body.status).toBe('ok');
  });

  it('aucun écart ou lecture impossible : ok', async () => {
    expect((await (await GET(req())).json()).checks.aiPromptArchitecture).toEqual({ status: 'ok' });
    warnings.mockRejectedValueOnce(new Error('base'));
    expect((await (await GET(req())).json()).checks.aiPromptArchitecture).toEqual({ status: 'ok' });
  });
});
