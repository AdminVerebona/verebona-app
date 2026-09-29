/**
 * Empreinte du run d'analyse — CDC §4.1.7 ; CDC 15 lot 12 (passage en master).
 * Chemin étapes : empreinte STRICTEMENT identique à l'historique. Chemin
 * master : route et version résolue du master entrent dans l'empreinte, sans
 * quoi le passage en master retrouverait le run des étapes (dédupliqué).
 */
import { createHash } from 'crypto';
import { describe, it, expect } from 'vitest';
import { computeInputHash } from '../analysis-result.repository';
import { EXTRACT_SOURCE_PROMPT_VERSION } from '../../prompt-version';
import type { SourceInput } from '../../types';

const input = { sourceType: 'file', sourceVersion: 3 } as SourceInput;

/** Formule historique (avant le lot 12), recopiée telle quelle. */
function empreinteHistorique(ids: number[]): string {
  return createHash('sha256').update(JSON.stringify({
    sources: [...ids].sort((a, b) => a - b),
    type: 'file',
    version: 3,
    prompt: EXTRACT_SOURCE_PROMPT_VERSION,
  })).digest('hex');
}

describe('empreinte du run', () => {
  it('chemin étapes : même empreinte qu’avant', () => {
    expect(computeInputHash({ groupSourceIds: [9, 4], input })).toBe(empreinteHistorique([4, 9]));
  });

  it('chemin master : empreinte distincte, et distincte par version résolue du master', () => {
    const etapes = computeInputHash({ groupSourceIds: [4], input });
    const m1 = computeInputHash({ groupSourceIds: [4], input, master: { masterPromptVersion: 't1_master_v1@file' } });
    const m2 = computeInputHash({ groupSourceIds: [4], input, master: { masterPromptVersion: 't1_master_v1@cfg8:abcdef123456' } });
    expect(new Set([etapes, m1, m2]).size).toBe(3);
  });
});
