/**
 * Harnais E2E — parties pures, testées sans base (suite unitaire) :
 * rejeu des sorties enregistrées et construction de l'URL de la base.
 */
import { describe, it, expect } from 'vitest';
import { ReplayProvider } from '../replay-gateway';
import { withDatabase, adminUrlFromEnv, assertSafeAdminUrl } from '../db-bootstrap';

const appel = (operationCode: string, task?: string, prompt = 'p') => ({
  model: 'm', prompt, attachments: [], timeoutMs: 1000, operationCode, ...(task ? { task } : {}),
});

describe('rejeu des sorties enregistrées', () => {
  it('par opération puis TASK, dans l’ordre, sans réutilisation implicite', async () => {
    const r = new ReplayProvider([
      { operationCode: 'extract_source', task: 'GROUP_UPLOAD', output: { g: 1 } },
      { operationCode: 'extract_source', task: 'ANALYZE_DOCUMENT', output: { a: 1 } },
      { operationCode: 'extract_source', task: 'ANALYZE_DOCUMENT', output: { a: 2 } },
    ]);
    expect((await r.call(appel('extract_source', 'ANALYZE_DOCUMENT'))).rawText).toBe('{"a":1}');
    expect((await r.call(appel('extract_source', 'GROUP_UPLOAD'))).rawText).toBe('{"g":1}');
    expect((await r.call(appel('extract_source', 'ANALYZE_DOCUMENT'))).rawText).toBe('{"a":2}');
    await expect(r.call(appel('extract_source', 'ANALYZE_DOCUMENT'))).rejects.toThrow(/aucune sortie enregistrée/);
    expect(r.pending()).toEqual([]);
  });

  it('enregistrement sans TASK : sert tout appel de l’opération ; `repeat` le réutilise', async () => {
    const r = new ReplayProvider([{ operationCode: 'generate_answer', output: 'texte', repeat: true, outputTokens: 3 }]);
    expect(await r.call(appel('generate_answer', 'X'))).toEqual({ rawText: 'texte', inputTokens: 0, outputTokens: 3 });
    expect((await r.call(appel('generate_answer'))).rawText).toBe('texte');
  });

  it('filtre sur le prompt', async () => {
    const r = new ReplayProvider([
      { operationCode: 'o', output: 'A', promptIncludes: 'facture' },
      { operationCode: 'o', output: 'B' },
    ]);
    expect((await r.call(appel('o', undefined, 'un devis'))).rawText).toBe('B');
    expect((await r.call(appel('o', undefined, 'une facture'))).rawText).toBe('A');
  });
});

describe('base E2E', () => {
  it('URL de la base créée à partir de l’URL d’administration', () => {
    expect(withDatabase('postgres://u:p@h:5432/postgres?sslmode=disable', 'verebona_e2e_1'))
      .toBe('postgres://u:p@h:5432/verebona_e2e_1?sslmode=disable');
  });
  it('E2E_DATABASE_URL seulement, jamais DATABASE_URL', () => {
    expect(adminUrlFromEnv({ E2E_DATABASE_URL: 'a', DATABASE_URL: 'b' } as unknown as NodeJS.ProcessEnv)).toBe('a');
    expect(adminUrlFromEnv({ DATABASE_URL: 'b' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
  it('serveur non local refusé sauf E2E_ALLOW_REMOTE=1', () => {
    const env = {} as unknown as NodeJS.ProcessEnv;
    expect(assertSafeAdminUrl('postgres://p@127.0.0.1:5432/postgres', env)).toContain('127.0.0.1');
    expect(assertSafeAdminUrl('postgres://p@localhost/postgres', env)).toContain('localhost');
    expect(() => assertSafeAdminUrl('postgres://p@prod.example.com/verebona', env)).toThrow(/non local refusé/);
    expect(assertSafeAdminUrl('postgres://p@ci-db/postgres', { E2E_ALLOW_REMOTE: '1' } as unknown as NodeJS.ProcessEnv)).toContain('ci-db');
  });
});
