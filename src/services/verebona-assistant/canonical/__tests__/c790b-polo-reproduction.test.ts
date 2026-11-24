/**
 * Carte #790, relance du 21/11/2026 (E03) — REPRODUCTION du défaut rapporté par le PO sur iPhone :
 * « Quel est le coût de possession de Polo ? » rendait UN paragraphe dense.
 *
 * Ce test a été écrit et exécuté AVANT le correctif : il échouait (un seul bloc `paragraph`).
 * Il passe par les fonctions de production : la stratégie `structured.ownership_cost`
 * (`ownershipCostAnswer`), puis ce que l'API transmet (`answerBlocksForApi`) et ce que l'écran
 * présente (`answerBlocksFor`, sans blocs reçus : cas de l'historique rechargé).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { ownershipCostAnswer } = await import('../structured-answers');
const { answerBlocksForApi } = await import('../../core/api-payload');
const { answerBlocksFor } = await import('@/lib/verebona/answer-blocks');
const { poloTco, POLO } = await import('./fixtures/c790b-polo');

describe('C790B-REPRO — coût de possession de Polo : la réponse n’est plus un paragraphe unique', () => {
  it('la stratégie déterministe alimente le rendu avec plusieurs blocs distincts (total, ventilation, réserves)', () => {
    const r = ownershipCostAnswer(POLO as never, poloTco()) as { answer: string };
    const api = answerBlocksForApi(r.answer);
    expect(api).not.toBeNull();
    // Défaut d'origine : `phrases.join(' ')` → une seule ligne → un seul bloc `paragraph`.
    expect(api!.length).toBeGreaterThanOrEqual(3);
    expect(api!.map((b) => b.kind)).not.toEqual(['paragraph']);
    // Historique rechargé : aucun bloc reçu du serveur, l'écran découpe le texte enregistré — même résultat.
    expect(answerBlocksFor(r.answer, undefined)).toEqual(api);
  });
});
