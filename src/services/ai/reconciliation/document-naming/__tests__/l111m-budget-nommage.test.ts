/**
 * Lot 111M (ticket « budgets IA », étape 6) — DOCUMENT_NAMING : budgets tirés
 * de la RÉSOLUTION COMMUNE (plafond transmis, modèle, prompt actif) ; les
 * variables T3_NAMING_* restent des surcharges explicites. Logique de lots et
 * de reprise inchangée (111A).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { namingBudget, maxTargetsForOutput } = await import('../adaptive');
const { resolveBudget, recordBudgetSnapshot, __resetBudgetSnapshotsForTests } = await import('../../../gateway/budget-resolution');
const { getOperation } = await import('../../../registry/operations');

const resolu = (maxOutputTokens: number, model = 'gemini-2.5-flash', promptText = 'p'.repeat(35_000)) => resolveBudget({
  operationCode: 't3_document_naming', op: getOperation('t3_document_naming'),
  config: { primaryModel: model, fallbackModels: [], maxOutputTokens, configVersionId: 3 }, promptText,
});
afterEach(() => __resetBudgetSnapshotsForTests());

describe('L111M-NOM-01 — budgets résolus', () => {
  it('sans instantané : valeurs du lot 109J inchangées', () => {
    expect(namingBudget({}, null)).toMatchObject({ inputTokens: 24_000, outputTokens: 3_000, outputTokensPerDoc: 160, promptOverheadTokens: 5_000 });
  });

  it('plafond BO 8 192 : sortie visible 3 000 (part visible 40 %) ; partie fixe = prompt maître ACTIF mesuré + contrat', () => {
    const b = namingBudget({}, resolu(8_192));
    expect(b.outputTokens).toBe(3_000);
    expect(b.promptOverheadTokens).toBe(10_000 + 1_500);
    expect(b.origins).toMatchObject({ outputTokens: 'default', promptOverheadTokens: 'resolved', inputTokens: 'default' });
  });

  it('plafond BO bas (4 096) : lots réduits AVANT envoi (sortie visible 1 638) au lieu d’une troncature', () => {
    const b = namingBudget({}, resolu(4_096));
    expect(b.outputTokens).toBe(1_638);
    expect(b.origins?.outputTokens).toBe('resolved');
    expect(maxTargetsForOutput(b)).toBe(10);
  });

  it('surcharges T3_NAMING_* explicites : priment sur la résolution', () => {
    const b = namingBudget({ T3_NAMING_OUTPUT_TOKEN_BUDGET: '2500', T3_NAMING_PROMPT_OVERHEAD_TOKENS: '4000' }, resolu(4_096));
    expect(b).toMatchObject({ outputTokens: 2_500, promptOverheadTokens: 4_000 });
    expect(b.origins).toMatchObject({ outputTokens: 'explicit_override', promptOverheadTokens: 'explicit_override' });
  });

  it('lecture synchrone de l’instantané amorcé (appel sans argument, comme phase.ts)', () => {
    recordBudgetSnapshot(resolu(4_096));
    expect(namingBudget().outputTokens).toBe(1_638);
  });
});
