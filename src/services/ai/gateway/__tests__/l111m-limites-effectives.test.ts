/**
 * Lot 111M (ticket « budgets IA », §5) — limites applicatives effectives
 * affichées au BO : valeur lue par la MÊME fonction que le traitement, origine
 * (défaut / surcharge explicite / résolue / fixe), aucune nouvelle source.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { effectiveApplicationLimits } = await import('../application-limits');
const { __resetBudgetSnapshotsForTests } = await import('../budget-resolution');

const trouver = (l: ReturnType<typeof effectiveApplicationLimits>, op: string, nom: string) => l.find((x) => x.operation === op && x.name.startsWith(nom));

describe('L111M-BO-01 — limites applicatives effectives', () => {
  it('défauts : T1 part du plafond transmis, T2 12 000 / 4 000 / 8, T3 600 / 5 / 15, T4 1 000 / 2, T6 8 / 8 / 5 / 420', () => {
    __resetBudgetSnapshotsForTests();
    const l = effectiveApplicationLimits({});
    expect(trouver(l, 't1_analyze_document', 'Seuil de saturation')).toMatchObject({ value: 0.9, origin: 'default' });
    expect(trouver(l, 't2_answer', 'Plafond de sécurité')).toMatchObject({ value: 12_000, origin: 'default' });
    expect(trouver(l, 't2_answer', 'Lecture')).toMatchObject({ value: 4_000 });
    expect(trouver(l, 't2_answer', 'Réserve du prompt')).toMatchObject({ origin: 'resolved' });
    expect(trouver(l, 't3_knowledge_query', 'Pages au total')).toMatchObject({ value: 15, origin: 'default' });
    expect(trouver(l, 't4_verify_completion', 'Relectures')).toMatchObject({ value: 2 });
    expect(trouver(l, 't6_formulate', 'Message')).toMatchObject({ value: 420, origin: 'fixed' });
    expect(l.every((x) => x.role.length > 0)).toBe(true);
  });

  it('surcharges explicites : origine « surcharge explicite », valeur bornée par la même fonction que le traitement', () => {
    const l = effectiveApplicationLimits({ T1_SATURATION_OUTPUT_TOKENS: '40000', T3_KNOWLEDGE_QUERY_MAX_CONTINUATION_PAGES: '999', T4_EVIDENCE_MAX_REREADS: '1' },
      { maxInputTokens: 8_000, maxInputTokensExplicit: true, maxExcerptChars: 4_000, maxSources: 8, maxVisibleSources: 5 });
    expect(trouver(l, 't1_analyze_document', 'Seuil de saturation (absolu)')).toMatchObject({ value: 40_000, origin: 'explicit_override' });
    expect(trouver(l, 't3_knowledge_query', 'Pages au total')).toMatchObject({ value: 60, origin: 'explicit_override' });
    expect(trouver(l, 't4_verify_completion', 'Relectures')).toMatchObject({ value: 1, origin: 'explicit_override' });
    expect(trouver(l, 't2_answer', 'Plafond de sécurité')).toMatchObject({ value: 8_000, origin: 'explicit_override' });
  });
});
