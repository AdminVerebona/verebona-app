/**
 * CDC 15 §28 (T6) — master dont la sortie ne porte pas de discriminant :
 * `taskField: 'none'` saute le contrôle de branche, le schéma strict
 * (`schemaVersion`) décide.
 */
import { describe, it, expect } from 'vitest';
import { validateOutput } from '../output-validator';
import { T6FormulateOutput } from '@/services/home/mascot/t6-contract';
import { AI_OPERATIONS } from '../../registry/operations';

const ok = JSON.stringify({ schemaVersion: 't6-output-v2', messages: [{ subjectId: 's1', text: 'Votre contrôle technique approche.', highlight: null }] });

describe('taskField none', () => {
  it('sortie sans `mode` acceptée ; mauvais schemaVersion rejeté', () => {
    expect(validateOutput(ok, T6FormulateOutput, 't6_formulate', 'json', { expectedTask: 'FORMULATE', taskField: 'none' }))
      .toMatchObject({ schemaVersion: 't6-output-v2' });
    expect(() => validateOutput(ok.replace('v2', 'v1'), T6FormulateOutput, 't6_formulate', 'json', { expectedTask: 'FORMULATE', taskField: 'none' }))
      .toThrow(/schéma/);
  });

  it('sans `none`, la même sortie serait refusée (discriminant absent)', () => {
    expect(() => validateOutput(ok, T6FormulateOutput, 't6_formulate', 'json', { expectedTask: 'FORMULATE', taskField: 'mode' }))
      .toThrow(/MODE=FORMULATE/);
  });

  it('registre : t6_formulate en master sans discriminant ; formulate_mascot migre vers lui', () => {
    expect(AI_OPERATIONS.t6_formulate).toMatchObject({ masterPromptCode: 't6_master_v1', task: 'FORMULATE', taskField: 'none', outputSchema: 'T6FormulateOutput' });
    expect(AI_OPERATIONS.formulate_mascot.migratesTo).toEqual({ masterPromptCode: 't6_master_v1', task: 'FORMULATE', operationCode: 't6_formulate' });
  });
});
