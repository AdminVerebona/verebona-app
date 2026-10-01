/**
 * Clarification de comparaison : liste bornée à 8 noms, puis « et N autres »
 * (relecture lot 19).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(async () => {}) }));

const { biensAComparer, listeBornee, CLARIFICATION_MAX_NAMES } = await import('../synthesis-planner');

describe('liste bornée de la clarification', () => {
  it('8 noms au plus, puis « et N autres » (singulier compris)', () => {
    const noms = Array.from({ length: 11 }, (_, i) => `Voiture ${i + 1}`);
    expect(CLARIFICATION_MAX_NAMES).toBe(8);
    expect(listeBornee(noms)).toBe('Voiture 1, Voiture 2, Voiture 3, Voiture 4, Voiture 5, Voiture 6, Voiture 7, Voiture 8 et 3 autres');
    expect(listeBornee(noms.slice(0, 9))).toMatch(/Voiture 8 et 1 autre$/);
    expect(listeBornee(noms.slice(0, 8))).toBe(noms.slice(0, 8).join(', '));
  });

  it('« compare mes voitures » avec 12 véhicules : question bornée, total annoncé, candidats complets', async () => {
    const tous = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Auto ${i + 1}`, category: 'VEHICULE' }));
    const r = await biensAComparer({ message: 'Compare mes voitures' } as never, { namedAssets: [] }, async () => tous);
    expect(r.kind).toBe('clarification');
    if (r.kind !== 'clarification') return;
    expect(r.clarification.question).toContain('(12)');
    expect(r.clarification.question).toContain('Auto 8 et 4 autres');
    expect(r.clarification.question).not.toContain('Auto 9');
    expect(r.candidates).toHaveLength(12);
  });
});
