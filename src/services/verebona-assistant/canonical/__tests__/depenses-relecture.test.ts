/**
 * Relecture lot 15 — dépenses qualifiées (CDC 15 T2-24) : documents sans
 * date avec une année demandée (non qualifiés, total incomplet) et doublons
 * « fusion possible » comptés une seule fois.
 */
import { describe, it, expect } from 'vitest';
import { aggregateExpenses, dedupePossibleMerges, expenseSumSource, type ExpenseRow } from '../expenses';

const row = (id: number, o: Partial<ExpenseRow> = {}): ExpenseRow => ({
  id, v2: 'MAINTENANCE_INVOICE', legacy: null, date: '2025-03-01', hash: null, title: null, assetId: 1,
  supplier: null, state: 'ANALYZED', ignored: null, ...o,
});

describe('année demandée, date absente', () => {
  it('non qualifié (date absente), total incomplet, montant non sommé', () => {
    const q = aggregateExpenses([
      { fileId: 1, amountCents: 10000, cls: { kind: 'theme', theme: 'maintenance' } },
      { fileId: 2, amountCents: 5000, cls: { kind: 'theme', theme: 'maintenance' }, undated: true },
      { fileId: 3, amountCents: 900, cls: { kind: 'excluded', reason: 'MAINTENANCE_QUOTE' }, undated: true },
    ], 'maintenance');
    expect(q.qualifiedSumCents).toBe(10000);
    expect(q.unqualified).toEqual({ count: 1, sumCents: 5000, fileIds: [2], undatedCount: 1 });
    expect(q.excluded.count).toBe(1);
    expect(q.complete).toBe(false);
    const src = expenseSumSource(q, { assetIds: [], scopeLabel: null, year: 2025 });
    expect(src.content).toContain('1 document non qualifié (date absente)');
    expect(src.meta?.undatedCount).toBe(1);
  });
  it('sans date mais sans année demandée : compté normalement', () => {
    const q = aggregateExpenses([{ fileId: 2, amountCents: 5000, cls: { kind: 'theme', theme: 'maintenance' }, undated: false }], null);
    expect(q.qualifiedSumCents).toBe(5000);
    expect(q.complete).toBe(true);
  });
});

describe('doublons « fusion possible »', () => {
  it('même empreinte : un seul compté, le plus informé gardé', () => {
    const { kept, removed } = dedupePossibleMerges([
      row(10, { hash: 'h1' }),
      row(11, { hash: 'h1', state: 'FUSION_SUGGESTED', supplier: 'Garage Martin' }),
      row(12, { hash: 'h2' }),
    ]);
    expect(kept.map((r) => r.id)).toEqual([11, 12]);
    expect(removed).toEqual([10]);
  });
  it('à information égale, le plus ancien', () => {
    const { kept, removed } = dedupePossibleMerges([
      row(21, { hash: 'h', state: 'FUSION_SUGGESTED' }), row(20, { hash: 'h' }),
    ]);
    expect(kept.map((r) => r.id)).toEqual([20]);
    expect(removed).toEqual([21]);
  });
  it('doublon probable : même titre, même bien, même date ; groupes transitifs', () => {
    const { kept, removed } = dedupePossibleMerges([
      row(1, { title: 'Révision 2025', hash: 'a' }),
      row(2, { title: 'Révision 2025', hash: 'b', state: 'FUSION_SUGGESTED' }),
      row(3, { title: 'Autre', hash: 'b', state: 'FUSION_SUGGESTED' }),
      row(4, { title: 'Révision 2025', hash: 'c', date: '2025-04-01' }),
    ]);
    expect(kept.map((r) => r.id)).toEqual([1, 4]);
    expect(removed).toEqual([2, 3]);
  });
  it('non signalé, ou fusion ignorée par l’utilisateur : rien d’écarté', () => {
    expect(dedupePossibleMerges([row(1, { hash: 'h' }), row(2, { hash: 'h' })]).removed).toEqual([]);
    expect(dedupePossibleMerges([
      row(1, { hash: 'h' }), row(2, { hash: 'h', state: 'FUSION_SUGGESTED', ignored: [1] }),
    ]).removed).toEqual([]);
  });
  it('agrégat : doublons déclarés dans le résultat et la source', () => {
    const q = aggregateExpenses([{ fileId: 11, amountCents: 8000, cls: { kind: 'theme', theme: 'maintenance' } }], 'maintenance', [10]);
    expect(q.qualifiedSumCents).toBe(8000);
    expect(q.duplicates).toEqual({ count: 1, fileIds: [10] });
    expect(expenseSumSource(q, { assetIds: [], scopeLabel: null }).content).toContain('doublons (fusion possible) comptés une fois : 1 écarté');
  });
});
