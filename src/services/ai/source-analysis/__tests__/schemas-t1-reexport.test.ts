/**
 * Point d'entrée unique des schémas T1 (CDC 15 §23, PM-T1-PRE) : `schemas.ts`
 * RÉEXPORTE le contrat maître, sans le dupliquer — et `ExtractedField` reste
 * rétrocompatible (champs enrichis optionnels).
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import * as schemas from '../schemas';
import * as contract from '../master/t1-contract';
import type { ExtractedField, ProjectedFact, PersistedFactTarget } from '../types';

describe('schemas.ts — réexport du contrat T1', () => {
  it('mêmes objets que le contrat (aucune copie qui pourrait diverger)', () => {
    for (const name of [
      'T1GroupUploadOutput', 'T1AnalyzeDocumentOutput', 'T1MasterOutput', 't1Fact', 't1Target', 't1Recurrence',
      't1SemanticEvent', 't1Table', 't1Evidence', 't1VisualEvidence', 't1OutputSchemaFor', 'T1_MASTER_PROMPT_CODE',
      'T1_TASKS', 'T1_TARGET_TYPES', 'T1_VALUE_TYPES', 'T1_PROVENANCES', 'T1_EVENT_NATURES',
    ] as const) {
      expect(schemas[name], name).toBe(contract[name]);
    }
  });

  it('les schémas des étapes supprimées ne sont plus exportés (lot 16b-3)', () => {
    for (const name of ['ExtractSourceOutput', 'GroupSourcesOutput', 'ClassifyDocumentOutput', 'ClassifyRubricOutput', 'IdentifyEntitiesOutput', 'ProposeLinksOutput']) {
      expect((schemas as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });

  it('union discriminée par task, via le point d’entrée', () => {
    const r = schemas.T1MasterOutput.safeParse({ task: 'GROUP_UPLOAD', groups: [[0, 1]] });
    expect(r.success).toBe(true);
    const fact = schemas.t1Fact.parse({
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
