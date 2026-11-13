/**
 * Lot 114A (Trello #753, CDC T2 P0 / M08 / D18, tests U02-U03-U13) — CARDINALITÉ.
 *
 *   C01  grammaire : « mon vélo » = SINGLE, « mes vélos » = COLLECTION, rien = GLOBAL ;
 *   C02  P0 reproduit : deux vélos, « Combien ai-je dépensé pour mon vélo ? » —
 *        AUCUN total calculé sur les deux (le service de somme n'est pas appelé),
 *        une clarification est demandée ;
 *   C03  « mes vélos » : l'ensemble demandé est sommé (collection explicite) ;
 *   C04  un seul vélo : réponse directe inchangée ;
 *   C05  COLLECTION n'est jamais déduit d'un échec de résolution.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { tryCanonicalStructured } = await import('../../../canonical/structured-answers');
const { detectScopeCardinality, aggregateAllowed } = await import('../../scope-cardinality');

const A = { id: 1, name: 'Vélo cargo' };
const B = { id: 2, name: 'Vélo de route' };

const somme = () => vi.fn(async () => ({
  theme: null, byTheme: [{ theme: 'maintenance', label: 'entretien', sumCents: 43000, count: 2, fileIds: [1, 2] }],
  qualifiedSumCents: 43000, qualifiedCount: 2,
  unqualified: { count: 0, sumCents: 0, fileIds: [], undatedCount: 0 }, duplicates: { count: 0, fileIds: [] },
  excluded: { count: 0, byType: {} }, complete: true,
}));
const port = (sum: ReturnType<typeof somme>) => ({ today: () => '2026-11-13', sumQualifiedExpenses: sum, listAssets: async () => [A, B] }) as never;
const scope = (assets: Array<{ id: number; name: string }>, cardinality: string) => async () =>
  ({ assets, ambiguous: assets.length > 1, unresolved: assets.length === 0, label: assets.length === 1 ? assets[0].name : null, cardinality }) as never;

describe('L114A-C01 — la grammaire dit le nombre, pas le résultat de la recherche', () => {
  it.each([
    ['Combien m’a coûté mon vélo ?', ['velo'], 'SINGLE'],
    ['Combien m’ont coûté mes vélos ?', ['velos'], 'COLLECTION'],
    ['Combien ont coûté mes deux vélos ?', ['velos'], 'COLLECTION'],
    ['Total des dépenses de tous mes vélos', ['velos'], 'COLLECTION'],
    ['Dépenses pour chaque voiture', ['voiture'], 'COLLECTION'],
    ['Quel est l’entretien du vélo ?', ['velo'], 'SINGLE'],
    ['Combien ai-je dépensé pour cette voiture ?', ['voiture'], 'SINGLE'],
    ['Combien ai-je dépensé en entretien ?', [], 'GLOBAL'],
    ['dépenses Clio', ['clio'], 'UNKNOWN'],
  ])('%s → %s', (message, designations, attendu) => {
    expect(detectScopeCardinality(message as string, designations as string[])).toBe(attendu);
  });

  it('le pluriel des DÉPENSES ne rend pas pluriel le bien (« les dépenses de mon vélo »)', () => {
    expect(detectScopeCardinality('Quelles sont les dépenses de mon vélo ?', ['velo'])).toBe('SINGLE');
  });
});

describe('L114A-C02 — P0 : jamais de total sur des biens concurrents pour une demande au singulier', () => {
  it.each(['SINGLE', 'UNKNOWN', undefined])('cardinalité %s : clarification, somme non calculée', async (c) => {
    const sum = somme();
    const r = await tryCanonicalStructured({ port: port(sum), accountId: 1, message: 'Combien ai-je dépensé pour mon vélo ?', resolveScope: scope([A, B], c as string) });
    expect(r).toEqual({ ambiguous: [A, B], reason: 'SUM_MULTIPLE_ASSETS' });
    expect(sum).not.toHaveBeenCalled();
  });
});

describe('L114A-C03 / C04 — ensemble explicite et bien unique', () => {
  it('« mes vélos » : la collection demandée est sommée', async () => {
    const sum = somme();
    const r = await tryCanonicalStructured({ port: port(sum), accountId: 1, message: 'Combien ai-je dépensé pour mes vélos ?', resolveScope: scope([A, B], 'COLLECTION') }) as { strategy: string };
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(sum).toHaveBeenCalledWith(1, expect.objectContaining({ assetIds: [1, 2] }));
  });

  it('un seul vélo : réponse directe (inchangé)', async () => {
    const sum = somme();
    const r = await tryCanonicalStructured({ port: port(sum), accountId: 1, message: 'Combien ai-je dépensé pour mon vélo ?', resolveScope: scope([A], 'SINGLE') }) as { strategy: string };
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(sum).toHaveBeenCalledWith(1, expect.objectContaining({ assetIds: [1] }));
  });
});

describe('L114A-C05 — garde commune', () => {
  it('seul COLLECTION autorise un agrégat sur plusieurs biens', () => {
    expect(aggregateAllowed({ ambiguous: true, cardinality: 'COLLECTION' })).toBe(true);
    for (const c of ['SINGLE', 'GLOBAL', 'UNKNOWN', undefined] as const) expect(aggregateAllowed({ ambiguous: true, cardinality: c })).toBe(false);
    expect(aggregateAllowed({ ambiguous: false, cardinality: 'SINGLE' })).toBe(true);
  });
});
