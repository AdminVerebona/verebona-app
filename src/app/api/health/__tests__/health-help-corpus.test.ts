/**
 * PUB-01 — /api/health lit l'état EN MÉMOIRE du corpus d'aide : aucun
 * chargement, aucun appel sortant. Corpus refusé : warning avec le corpus
 * servi et son âge ; jamais lu : « non chargé ». Statut global inchangé.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/db', () => ({ db: { execute: async () => [] }, getMigrationFailures: () => [] }));
vi.mock('@/services/ai/config/prompt-architecture', () => ({ promptArchitectureWarnings: async () => [] }));
const etat = vi.fn();
const charge = vi.fn(async () => null);
vi.mock('@/services/verebona-assistant/core/help-corpus.service', () => ({
  loadHelpCorpus: () => charge(), helpCorpusHealth: () => etat(),
}));

const { GET } = await import('../route');
const req = () => new NextRequest('http://localhost/api/health');
afterEach(() => vi.unstubAllGlobals());

describe('GET /api/health — corpus d’aide (PUB-01)', () => {
  it('corpus refusé : warning, corpus servi et son âge, statut global inchangé, AUCUN chargement ni appel sortant', async () => {
    const sortant = vi.fn();
    vi.stubGlobal('fetch', sortant);
    etat.mockReturnValueOnce({
      status: 'warning', source: 'last_valid_db', version: 'v1', environment: 'preprod',
      lastValidAt: '2026-09-01T00:00:00.000Z', lastValidAgeSeconds: 7200,
      alert: { code: 'HELP_CORPUS_INVALID', message: 'm', at: '2026-10-01T00:00:00.000Z' },
    });
    const body = await (await GET(req())).json();
    expect(body.checks.helpCorpus).toMatchObject({
      status: 'warning', source: 'last_valid_db', lastValidAt: '2026-09-01T00:00:00.000Z', lastValidAgeSeconds: 7200,
      alert: { code: 'HELP_CORPUS_INVALID' },
    });
    expect(body.status).toBe('ok');
    expect(charge).not.toHaveBeenCalled();
    expect(sortant).not.toHaveBeenCalled();
  });

  it('jamais lu sur l’instance : « non chargé »', async () => {
    etat.mockReturnValueOnce({ status: 'unknown', source: 'none', version: null, environment: null, lastValidAt: null, lastValidAgeSeconds: null, alert: null });
    const body = await (await GET(req())).json();
    expect(body.checks.helpCorpus).toMatchObject({ status: 'not_loaded', message: expect.stringMatching(/non chargé/) });
    expect(body.status).toBe('ok');
  });

  it('lecture impossible : la sonde répond quand même', async () => {
    etat.mockImplementationOnce(() => { throw new Error('x'); });
    expect((await GET(req())).status).toBe(200);
  });
});
