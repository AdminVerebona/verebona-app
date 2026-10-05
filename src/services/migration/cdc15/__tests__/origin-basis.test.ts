/**
 * Relecture lot 17 — `__originBasis` (motif MIG-03) retiré dès que
 * l'utilisateur ressaisit la valeur : `writeOrigin`, primitive canonique
 * (seul chemin de la fiche depuis le lot 16b-3).
 */
import { describe, it, expect } from 'vitest';
import { writeOrigin } from '@/services/ai/reconciliation/field-origin';
import { planCanonicalWrites, type AssetRowJson } from '@/services/canonical/asset-state';
import { humanOriginProof } from '../origin-proof';

const kc = { mileage: 45000, mileage__origin: 'USER', mileage__originBasis: 'NO_AI_PROOF_PROTECTED' };

describe('__originBasis retiré à la ressaisie', () => {
  it('writeOrigin', () => {
    const n = writeOrigin(kc, 'mileage', 'USER', { updatedAt: '2026-10-01' });
    expect(n).not.toHaveProperty('mileage__originBasis');
    expect(humanOriginProof(n, 'mileage', 'mileage', 45000, undefined)).toBe('PROVEN');
  });
  it('primitive canonique (écriture humaine)', () => {
    const row = { id: 1, account_id: 1, category: 'VEHICULE', key_characteristics: JSON.stringify(kc) } as AssetRowJson;
    const p = planCanonicalWrites(row, [{ key: 'mileage', value: 46000 }], { origin: 'USER', now: '2026-10-01' });
    expect(p.kc).not.toHaveProperty('mileage__originBasis');
  });
});
