/**
 * Empreinte du run d'analyse — CDC §4.1.7 ; CDC 15 lot 12 ; lot 16b-3.
 * Master seul : route et version résolue du master entrent dans l'empreinte ;
 * la formule reste STRICTEMENT celle des runs master déjà écrits (idempotence
 * d'une reprise sur une même version de source après le déploiement).
 */
import { createHash } from 'crypto';
import { describe, it, expect } from 'vitest';
import { computeInputHash } from '../analysis-result.repository';
import type { SourceInput } from '../../types';

const input = { sourceType: 'file', sourceVersion: 3 } as SourceInput;

/** Formule des runs master écrits avant le lot 16b-3, recopiée telle quelle. */
function empreinteMasterAvant16b3(ids: number[], masterPrompt: string): string {
  return createHash('sha256').update(JSON.stringify({
    sources: [...ids].sort((a, b) => a - b),
    type: 'file',
    version: 3,
    prompt: 'extract_source_v5',
    route: 'master',
    masterPrompt,
  })).digest('hex');
}

describe('empreinte du run', () => {
  it('même empreinte que les runs master antérieurs au retrait des étapes', () => {
    expect(computeInputHash({ groupSourceIds: [9, 4], input, master: { masterPromptVersion: 't1_master_v1@file' } }))
      .toBe(empreinteMasterAvant16b3([4, 9], 't1_master_v1@file'));
  });

  it('distincte par version résolue du master', () => {
    const m1 = computeInputHash({ groupSourceIds: [4], input, master: { masterPromptVersion: 't1_master_v1@file' } });
    const m2 = computeInputHash({ groupSourceIds: [4], input, master: { masterPromptVersion: 't1_master_v1@cfg8:abcdef123456' } });
    expect(m1).not.toBe(m2);
  });
});
