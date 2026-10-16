/**
 * Contrat du prompt maître T1 (CDC 15 §23, PM-T1-PRE) et rétrocompatibilité
 * de `ExtractedField` (champs enrichis optionnels).
 *
 * Lot 65A : le point d'entrée `source-analysis/schemas.ts`, qui ne faisait
 * que réexporter `master/t1-contract.ts` et n'était importé que par ce test,
 * est supprimé ; les consommateurs importent le contrat directement.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, expectTypeOf } from 'vitest';
import * as contract from '../master/t1-contract';
import type { ExtractedField, ProjectedFact, PersistedFactTarget } from '../types';

describe('contrat T1 — point d’entrée unique', () => {
  it('L65-NET — plus de module de réexport (aucune copie qui pourrait diverger)', () => {
    expect(existsSync(join(__dirname, '../schemas.ts'))).toBe(false);
  });

  it('les schémas des étapes supprimées ne sont pas exportés (lot 16b-3)', () => {
    for (const name of ['ExtractSourceOutput', 'GroupSourcesOutput', 'ClassifyDocumentOutput', 'ClassifyRubricOutput', 'IdentifyEntitiesOutput', 'ProposeLinksOutput']) {
      expect((contract as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });

  it('union discriminée par task', () => {
    const r = contract.T1MasterOutput.safeParse({ task: 'GROUP_UPLOAD', groups: [[0, 1]] });
    expect(r.success).toBe(true);
    const fact = contract.t1Fact.parse({
      canonicalKey: 'acquisitionPrice', normalizedValue: 749, confidence: 'certain',
      target: { type: 'ASSET', entityId: 10 }, evidence: { excerpt: '749 €' },
    });
    expect(fact.target).toMatchObject({ type: 'ASSET', entityId: 10, confidence: 'probable', evidenceSignals: [] });
  });
});

describe('ExtractedField — rétrocompatible', () => {
  it('un champ historique reste valide sans aucun champ enrichi', () => {
    const f: ExtractedField = { fieldKey: 'x', value: 1, confidence: 'certain' };
    expect(f.target).toBeUndefined();
    expectTypeOf<ExtractedField['target']>().toEqualTypeOf<PersistedFactTarget | undefined>();
    expectTypeOf<ProjectedFact['target']>().toEqualTypeOf<PersistedFactTarget>();
  });
});
