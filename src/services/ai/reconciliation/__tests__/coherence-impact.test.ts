/**
 * T3-004 : T3 n'est déclenché que par une modification à impact de cohérence.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));
const { hasCoherenceImpact, structuralFieldsIn } = await import('../coherence-impact');

describe('impact de cohérence (T3-004)', () => {
  it('champ structurant : déclenche, sans lire les preuves', async () => {
    const load = vi.fn(async () => []);
    expect(await hasCoherenceImpact(1, 2, ['notes', 'address1'], load)).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(structuralFieldsIn(['registrationNumber', 'notes'])).toEqual(['registrationNumber']);
  });

  it('édition sans impact (notes, valorisation, acquittements) : ne déclenche pas', async () => {
    expect(await hasCoherenceImpact(1, 2, ['notes', 'estimatedValue', 'dismissedCoherenceAlerts'], async () => [])).toBe(false);
    expect(await hasCoherenceImpact(1, 2, [], async () => ['notes'])).toBe(false);
  });

  it('champ portant des preuves documentaires : déclenche ; base illisible : déclenche par prudence', async () => {
    expect(await hasCoherenceImpact(1, 2, ['boilerPower'], async () => ['boilerPower'])).toBe(true);
    expect(await hasCoherenceImpact(1, 2, ['boilerPower'], async () => { throw new Error('KO'); })).toBe(true);
  });

  it('l’écriture des sections de bien passe par le filtre', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/asset-details-write.service.ts'), 'utf8');
    expect(src).toMatch(/hasCoherenceImpact\(accountId, assetId, Object\.keys\(fields\)\)/);
  });
});
