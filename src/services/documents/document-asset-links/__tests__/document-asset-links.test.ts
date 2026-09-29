/**
 * Relation N-N document ↔ bien — règles pures (CDC 15 X-01, T1-05).
 * Le comportement SQL (déclencheur, rattrapage, service) est vérifié sur base
 * réelle : `src/test/e2e/scenarios/x-01-document-asset-links.e2e.ts`.
 */
import { describe, it, expect } from 'vitest';
import { canRefresh } from '../types';
import { computeMasterDocumentLinks } from '@/services/ai/source-analysis/master/document-links';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';

describe('canRefresh — un lien ne se réécrit que par plus légitime', () => {
  it('LEGACY_COLUMN : jamais (tenu par le déclencheur)', () => {
    for (const o of ['USER', 'AI', 'MIGRATION'] as const) expect(canRefresh('LEGACY_COLUMN', o)).toBe(false);
  });
  it('USER : seulement par USER', () => {
    expect(canRefresh('USER', 'USER')).toBe(true);
    expect(canRefresh('USER', 'AI')).toBe(false);
    expect(canRefresh('USER', 'MIGRATION')).toBe(false);
  });
  it('AI / MIGRATION : par USER ou AI', () => {
    expect(canRefresh('AI', 'AI')).toBe(true);
    expect(canRefresh('MIGRATION', 'USER')).toBe(true);
    expect(canRefresh('AI', 'MIGRATION')).toBe(false);
  });
});

const fait = (assetId: number | null, confidence: 'certain' | 'probable' = 'certain') => ({
  target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: null, targetConfidence: confidence },
}) as unknown as ProjectedFact;
const candidat = (entityId: number, score: number, verified = true) =>
  ({ entityId, score, verified, confidence: 'certain' as const, reason: '', excerpt: '' });

describe('computeMasterDocumentLinks — P-T1-04', () => {
  it('bien du document PRIMARY, autres cibles SECONDARY, simples candidats MENTIONED', () => {
    const liens = computeMasterDocumentLinks({
      facts: [fait(12), fait(13, 'probable'), fait(null)],
      assetCandidates: [candidat(12, 0.97), candidat(13, 0.9), candidat(14, 0.7), candidat(15, 0.9, false)],
      documentAssetId: 12, knownAssetId: 12,
    });
    expect(liens).toEqual([
      { assetId: 12, role: 'PRIMARY', confidence: 1 },
      { assetId: 13, role: 'SECONDARY', confidence: 0.9 },
      { assetId: 14, role: 'MENTIONED', confidence: 0.7 },
    ]);
  });

  it('document mono-bien : aucun lien AI (les colonnes suffisent)', () => {
    expect(computeMasterDocumentLinks({
      facts: [fait(12)], assetCandidates: [candidat(12, 1)], documentAssetId: 12, knownAssetId: 12,
    })).toEqual([]);
  });

  it('sans bien du document : aucun PRIMARY inventé', () => {
    const liens = computeMasterDocumentLinks({
      facts: [fait(12), fait(13)], assetCandidates: [], documentAssetId: null, knownAssetId: null,
    });
    expect(liens.map((l) => l.role)).toEqual(['SECONDARY', 'SECONDARY']);
  });
});

describe('writeMasterDocumentLinks — liens indépendants', () => {
  it('un lien en échec n’empêche ni les autres ni le retrait des liens AI périmés', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    const link = vi.fn(async (i: { target: { assetId: number } }) => {
      if (i.target.assetId === 13) throw new Error('Bien 13 introuvable dans le compte 1.');
      return { outcome: 'created', link: { id: i.target.assetId } };
    });
    const unlink = vi.fn(async () => 2);
    vi.doMock('@/services/documents/document-asset-links', () => ({ linkDocumentToAsset: link, unlinkDocument: unlink }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { writeMasterDocumentLinks } = await import('@/services/ai/source-analysis/master/document-links');

    const r = await writeMasterDocumentLinks({ accountId: 1, fileId: 7, links: [
      { assetId: 12, role: 'PRIMARY', confidence: 1 },
      { assetId: 13, role: 'SECONDARY', confidence: 0.9 },
      { assetId: 14, role: 'MENTIONED', confidence: 0.7 },
    ] });
    expect(link).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ created: 2, removed: 2, failed: [13] });
    // Retrait par CIBLE : le lien AI déjà posé vers 13 (en échec) est conservé.
    expect(unlink).toHaveBeenCalledWith({ accountId: 1, fileId: 7, origins: ['AI'], keepAssetIds: [12, 13, 14] });
    expect(warn).toHaveBeenCalledTimes(1);
    vi.doUnmock('@/services/documents/document-asset-links');
  });
});
