/**
 * CDC 15 D-04, migration 0220 — stockage de l'architecture dans
 * `ai_config_entries.prompt_architecture`. Colonne absente (migration en
 * échec) : lecture en `steps`, `master` REFUSÉ, jamais perdu en silence ;
 * contrôle au premier usage comme 0217.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const calls: Array<{ q: string; p?: unknown[] }> = [];
let colonne = true;
let lignes: Array<Record<string, unknown>> = [];
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: async (q: string, p?: unknown[]) => {
      calls.push({ q, p });
      if (/information_schema/.test(q)) return [{ n: colonne ? 2 : 0 }];
      if (/SELECT status FROM ai_config_versions/.test(q)) return [{ status: 'DRAFT' }];
      if (/FROM ai_config_entries/.test(q)) return lignes;
      return [];
    },
  },
}));

const repo = await import('../config-version.repository');
const { emptyTreatmentConfig } = await import('../config-types');

beforeEach(() => {
  calls.length = 0;
  colonne = true;
  lignes = [];
  repo.__resetPromptArchitectureColumnForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('colonne 0220 présente', () => {
  it('lecture réelle de la colonne', async () => {
    lignes = [
      { treatment: 'T1', prompt: 'Préambule', prompt_architecture: 'master', master_prompt: 'MASTER {{TASK}}' },
      { treatment: 'T2', prompt: '', prompt_architecture: 'steps', master_prompt: '  ' },
    ];
    const e = await repo.getEntries(3);
    expect(calls.find((c) => /FROM ai_config_entries/.test(c.q))?.q).toMatch(/cascade, prompt_architecture, master_prompt\s/);
    expect(e.map((x) => [x.promptArchitecture, x.prompt, x.masterPrompt])).toEqual([
      ['master', 'Préambule', 'MASTER {{TASK}}'], ['steps', '', null],
    ]);
  });

  it('écriture réelle dans le même INSERT … ON CONFLICT', async () => {
    await repo.saveEntry(3, {
      ...emptyTreatmentConfig('T1'), prompt: 'Préambule', promptArchitecture: 'master', masterPrompt: 'MASTER',
    }, 1);
    const ins = calls.find((c) => /INSERT INTO ai_config_entries/.test(c.q))!;
    expect(ins.q).toMatch(/prompt_architecture = EXCLUDED\.prompt_architecture/);
    expect(ins.q).toMatch(/master_prompt = EXCLUDED\.master_prompt/);
    expect(ins.p?.[2]).toBe('Préambule');
    expect(ins.p?.[14]).toBe('master');
    expect(ins.p?.[15]).toBe('MASTER');
    expect(calls.some((c) => /UPDATE ai_config_entries/.test(c.q))).toBe(false);
  });

  it('présence mémorisée : un seul contrôle', async () => {
    await repo.getEntries(1);
    await repo.getEntries(2);
    expect(calls.filter((c) => /information_schema/.test(c.q))).toHaveLength(1);
  });
});

describe('colonne 0220 absente (migration en échec)', () => {
  it('lecture en steps, sans citer la colonne', async () => {
    colonne = false;
    lignes = [{ treatment: 'T1', prompt: '', prompt_architecture: null }];
    const e = await repo.getEntries(3);
    expect(calls.find((c) => /FROM ai_config_entries/.test(c.q))?.q).toMatch(/NULL::text AS prompt_architecture, NULL::text AS master_prompt/);
    expect(e[0].promptArchitecture).toBe('steps');
  });

  it('steps écrit sans la colonne ; master refusé AVANT toute écriture, message explicite', async () => {
    colonne = false;
    await repo.saveEntry(3, emptyTreatmentConfig('T1'), 1);
    const ins = calls.find((c) => /INSERT INTO ai_config_entries/.test(c.q))!;
    expect(ins.q).not.toMatch(/prompt_architecture/);
    expect(ins.p).toHaveLength(14);

    calls.length = 0;
    await expect(repo.saveEntry(3, { ...emptyTreatmentConfig('T1'), promptArchitecture: 'master' }, 1))
      .rejects.toThrow(/migration 0220/);
    await expect(repo.saveEntry(3, { ...emptyTreatmentConfig('T1'), masterPrompt: 'MASTER' }, 1))
      .rejects.toThrow(/migration 0220/);
    expect(calls.some((c) => /INSERT/.test(c.q))).toBe(false);
  });

  it('absence signalée une seule fois ; négatif relu après 5 min', async () => {
    colonne = false;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await repo.hasPromptArchitectureColumn();
    await repo.hasPromptArchitectureColumn();
    expect(calls.filter((c) => /information_schema/.test(c.q))).toHaveLength(1);
    expect(err).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ now: Date.now() + 6 * 60_000 });
    colonne = true;
    expect(await repo.hasPromptArchitectureColumn()).toBe(true);
    vi.useRealTimers();
  });
});

describe('migration 0220', () => {
  const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0220_ai_config_prompt_architecture.sql'), 'utf8');

  it('lock_timeout, colonne NOT NULL DEFAULT steps idempotente, CHECK nommée NOT VALID puis validée', () => {
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS prompt_architecture TEXT NOT NULL DEFAULT 'steps',/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS master_prompt\s+TEXT;/);
    expect(sql).toMatch(/IF NOT EXISTS \([\s\S]*conname = 'ai_config_entries_prompt_architecture_check'/);
    expect(sql).toMatch(/CHECK \(prompt_architecture IN \('steps', 'master'\)\) NOT VALID;/);
    expect(sql).toMatch(/VALIDATE CONSTRAINT ai_config_entries_prompt_architecture_check;/);
  });
});
