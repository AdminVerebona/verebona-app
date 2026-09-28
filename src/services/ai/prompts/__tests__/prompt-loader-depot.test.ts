/**
 * GEN-015, E-05, WF-41 : le prompt technique vient TOUJOURS du dépôt ; la
 * table `ai_prompt_versions` (gouvernance parallèle retirée) n'est plus lue.
 */
import { describe, it, expect, vi } from 'vitest';

const unsafe = vi.fn(async () => [{ content: 'ANCIEN PROMPT EN BASE', version: 'v-base' }]);
vi.mock('@/db', () => ({ pgClient: { unsafe } }));

const { resolvePrompt } = await import('../prompt-loader');

describe('prompt technique', () => {
  it('lu dans le fichier du dépôt, jamais en base', async () => {
    const r = await resolvePrompt('classify_document_v2', {}, 'SOURCE_ANALYSIS');
    expect(r.version).toBe('classify_document_v2@file');
    expect(r.text).not.toContain('ANCIEN PROMPT EN BASE');
    expect(unsafe).not.toHaveBeenCalled();
  });
});
