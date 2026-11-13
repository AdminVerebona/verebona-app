/**
 * Lot 114A (Trello #753, CDC T2 §5.3, §10.2, D01 / D19 / D20, exemples A-B,
 * tests U14-F02-F03) — QUESTION LARGE SUR LE COÛT, SELON L'OFFRE.
 *
 *   O01  Standard, bien unique : prix d'achat + coût de possession réservé —
 *        lecture TCO JAMAIS exécutée, aucune somme de dépenses à la place ;
 *   O02  Premium : prix d'achat ET coût de possession canonique, à part ;
 *   O03  « Quel est son prix d'achat ? » / thème / année : inchangés ;
 *   O04  prix d'achat inconnu : traitement historique (dépenses documentées) ;
 *   O05  deux vélos, « mon vélo » : clarification, aucun montant.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { tryCanonicalStructured } = await import('../../../canonical/structured-answers');
const { TCO_PREMIUM_MESSAGE } = await import('@/services/business-operations/tco/dto');

const VELO = { id: 1, name: 'Vélo cargo' };
const Q = 'Combien m’a coûté mon vélo ?';
const depenses = { theme: null, byTheme: [{ theme: 'maintenance', label: 'entretien', sumCents: 43000, count: 2, fileIds: [1, 2] }], qualifiedSumCents: 43000, qualifiedCount: 2,
  unqualified: { count: 0, sumCents: 0, fileIds: [], undatedCount: 0 }, duplicates: { count: 0, fileIds: [] }, excluded: { count: 0, byType: {} }, complete: true };
const tco = {
  breakdown: [{ label: 'Acquisition', costsCents: 202300 }, { label: 'Entretien', costsCents: 95153 }], reductionsCents: 0, refundsCents: 0, indemnitiesCents: 0,
  summary: { cumulativeCostCents: 297453, netFinalCents: null, currentValue: null, netEstimatedCents: null }, period: { start: '2024-03-02', startStatus: 'KNOWN' },
  indicators: null, disposed: false, disposal: {}, status: 'COMPLETE', usage: { annualEstimateCents: 0 },
  reliability: { unconverted: [], unallocated: { count: 0 }, operationsCounted: 3, documentsCounted: 0, documents: [] },
};

function port(o: { allowed: boolean; prix?: number | null }) {
  const readOwnershipCost = vi.fn(async () => tco);
  const sumQualifiedExpenses = vi.fn(async () => depenses);
  const readAcquisition = vi.fn(async () => (o.prix === null ? null
    : { priceCents: o.prix ?? 202300, date: '2024-03-02', foreign: [], source: { id: 'operation_9', type: 'operation', title: 'Achat', content: '', relevanceScore: 1 }, documentPrices: [], fees: [] }));
  return {
    readOwnershipCost, sumQualifiedExpenses, readAcquisition,
    p: { today: () => '2026-11-13', readOwnershipCost, sumQualifiedExpenses, readAcquisition, ownershipCostAllowed: vi.fn(async () => o.allowed),
      readAssetField: vi.fn(async () => null), listAssets: async () => [VELO] } as never,
  };
}
const scope = (assets = [VELO], cardinality = 'SINGLE') => async () =>
  ({ assets, ambiguous: assets.length > 1, unresolved: false, label: assets.length === 1 ? assets[0].name : null, cardinality }) as never;
type Rep = { strategy: string; answer: string; claims: Array<{ claimKey: string; text: string }>; sources: Array<{ id: string }> };

describe('L114A-O01 — Standard : prix d’achat, coût de possession réservé, aucun TCO déguisé', () => {
  it('prix d’achat donné, rappel Premium, ni lecture TCO ni somme de dépenses', async () => {
    const x = port({ allowed: false });
    const r = await tryCanonicalStructured({ port: x.p, accountId: 1, message: Q, resolveScope: scope() }) as Rep;
    expect(r.strategy).toBe('structured.acquisition_price');
    expect(r.answer).toMatch(/^Prix d’achat de Vélo cargo : 2[\s  ]?023,00[\s  ]?€/);
    expect(r.answer.endsWith(TCO_PREMIUM_MESSAGE)).toBe(true);
    expect(r.answer).not.toMatch(/430|2[\s  ]?974/);
    expect(x.readOwnershipCost).not.toHaveBeenCalled();
    expect(x.sumQualifiedExpenses).not.toHaveBeenCalled();
    // Preuve par composante (§7.3) : deux affirmations distinctes.
    expect(r.claims.map((c) => c.claimKey)).toEqual(['acquisition', 'ownership_cost_locked']);
    expect(r.sources.map((s) => s.id)).toContain('product_rule:tco_premium');
  });
});

describe('L114A-O02 — Premium : achat et possession, présentés à part', () => {
  it('deux montants, deux affirmations, jamais additionnés', async () => {
    const x = port({ allowed: true });
    const r = await tryCanonicalStructured({ port: x.p, accountId: 1, message: Q, resolveScope: scope() }) as Rep;
    expect(r.strategy).toBe('structured.ownership_cost');
    expect(r.answer).toMatch(/Prix d’achat de Vélo cargo : 2[\s  ]?023,00/);
    expect(r.answer).toMatch(/Coût de possession de Vélo cargo : coût cumulé documenté 2[\s  ]?974,53/);
    expect(r.answer).not.toMatch(/4[\s  ]?997/); // 2 023 + 2 974,53 : jamais additionnés
    expect(x.readOwnershipCost).toHaveBeenCalledWith(1, 1);
    expect(x.sumQualifiedExpenses).not.toHaveBeenCalled();
    expect(r.claims.map((c) => c.claimKey)).toEqual(['acquisition', 'ownership_cost']);
  });
});

describe('L114A-O03 / O04 — ce qui ne change pas', () => {
  it('dépenses par thème ou par année : total documenté, ouvert à tous', async () => {
    for (const q of ['Combien m’a coûté l’entretien de mon vélo ?', 'Combien m’a coûté mon vélo en 2025 ?']) {
      const x = port({ allowed: false });
      const r = await tryCanonicalStructured({ port: x.p, accountId: 1, message: q, resolveScope: scope() }) as Rep;
      expect(r.strategy).toBe('structured.sum_qualified');
      expect(x.readOwnershipCost).not.toHaveBeenCalled();
    }
  });

  it('prix d’achat inconnu : dépenses documentées (comportement historique)', async () => {
    const x = port({ allowed: false, prix: null });
    const r = await tryCanonicalStructured({ port: x.p, accountId: 1, message: Q, resolveScope: scope() }) as Rep;
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(x.readOwnershipCost).not.toHaveBeenCalled();
  });
});

describe('L114A-O05 — deux vélos, question au singulier', () => {
  it.each([true, false])('offre avec coût de possession = %s : clarification, aucun montant, aucune lecture', async (allowed) => {
    const x = port({ allowed });
    const r = await tryCanonicalStructured({ port: x.p, accountId: 1, message: Q, resolveScope: scope([VELO, { id: 2, name: 'Vélo de route' }]) });
    expect(r).toMatchObject({ reason: 'SUM_MULTIPLE_ASSETS' });
    expect(x.readOwnershipCost).not.toHaveBeenCalled();
    expect(x.sumQualifiedExpenses).not.toHaveBeenCalled();
    expect(x.readAcquisition).not.toHaveBeenCalled();
  });
});
