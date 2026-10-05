/**
 * Lot 22 — T6 au plafond IA du mois du compte : texte de secours
 * déterministe (`messages: null`, statut `fallback`), SANS compter d'échec au
 * disjoncteur T6, partagé par tous les comptes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

vi.mock('@/db', () => ({ pgClient: { unsafe: async () => [] } }));

const R = await import('../t6-runner');
const { AiCostCapReachedError } = await import('@/services/ai/gateway/errors');
type Input = import('../t6-contract').T6Input;

const FIX = join(process.cwd(), 'src/services/home/mascot/__fixtures__');
const P = readdirSync(FIX).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(FIX, f), 'utf8')))
  .find((f) => f.case === 'P-T6-01');
const INPUT: Input = P.context.input;

describe('T6 : plafond IA du compte atteint', () => {
  const execute = vi.fn();
  const deps = {
    treatmentAvailable: async () => true,
    promptVersion: async () => 't6_master_v1@file',
    previousBubbles: async () => [] as import('../t6-runner').T6PreviousBubble[],
    execute: (r: unknown) => execute(r),
  };
  beforeEach(() => { execute.mockReset(); R.resetT6Breaker(); });

  it('texte de secours, et le disjoncteur T6 reste fermé pour les autres comptes', async () => {
    execute.mockRejectedValue(new AiCostCapReachedError('t6_formulate', 7, 1_000, 2_000, new Date('2026-10-31T23:00:00Z')));
    for (let i = 0; i < 6; i++) {
      const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: `cap-${i}`, mode: 'pregen' }, deps);
      expect(o).toMatchObject({ status: 'fallback', messages: null });
    }
    expect(R.breakerAllows()).toBe(true);
  });

  it('une vraie panne compte toujours au disjoncteur (comportement inchangé)', async () => {
    execute.mockRejectedValue(new Error('panne'));
    for (let i = 0; i < 6; i++) await R.formulateWithT6({ accountId: 8, input: INPUT, contextHash: `panne-${i}`, mode: 'pregen' }, deps);
    expect(R.breakerAllows()).toBe(false);
  });
});
