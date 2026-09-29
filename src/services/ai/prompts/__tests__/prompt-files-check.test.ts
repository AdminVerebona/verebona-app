/**
 * CDC 15 §22.3, §29, ARCH-02, ARCH-03 — `prompts:check` : fichiers présents,
 * masters complets ({{TASK}} + une section par TASK), emplacements = variables
 * déclarées, code de sortie ≠ 0 en cas d'échec.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { checkPromptFiles } from '../prompt-files-check';
import type { AiOperationDefinition } from '../../registry/operations';

const FIXTURES = join(__dirname, 'fixtures', 'masters');

const op = (over: Partial<AiOperationDefinition>): AiOperationDefinition => ({
  operationCode: 'op', useCaseCode: 'SOURCE_ANALYSIS', label: 'op', provider: 'gemini',
  primaryModel: 'm', fallbackModels: [], timeoutMs: 1, outputSchema: 'X', active: true, billable: false,
  ...over,
});
const master = (task: string, over: Partial<AiOperationDefinition> = {}) => op({
  operationCode: `t1_${task.toLowerCase()}`, promptCode: 't1_master_v1', masterPromptCode: 't1_master_v1', task, ...over,
});

describe('checkPromptFiles', () => {
  it('master conforme : aucune erreur', () => {
    const r = checkPromptFiles({ root: FIXTURES, operations: [master('GROUP_UPLOAD'), master('ANALYZE_DOCUMENT')] });
    expect(r.errors).toEqual([]);
    expect(r.checkedFiles).toBe(1);
  });

  it('section de branche manquante ou {{TASK}} absent : erreur', () => {
    const read = () => 'BRANCHE TASK = GROUP_UPLOAD\n';
    const r = checkPromptFiles({ root: FIXTURES, read, operations: [master('GROUP_UPLOAD'), master('ANALYZE_DOCUMENT')] });
    expect(r.errors).toEqual([
      'master « t1_master_v1 » : emplacement {{TASK}} absent',
      'master « t1_master_v1 » : section « BRANCHE TASK = ANALYZE_DOCUMENT » absente',
    ]);
  });

  it('fichier absent : erreur si active, avertissement si inactive (ARCH-02)', () => {
    const r = checkPromptFiles({
      root: FIXTURES,
      operations: [op({ operationCode: 'a', promptCode: 'absent_v1' }), op({ operationCode: 'b', promptCode: 'absent_v2', active: false })],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^a : fichier introuvable \(attendu : source-analysis\/absent_v1\.txt\)/);
    expect(r.warnings[0]).toMatch(/^b : .*opération inactive/);
  });

  it('variables déclarées : chaque emplacement a sa variable et inversement', () => {
    const r = checkPromptFiles({
      root: FIXTURES,
      operations: [master('GROUP_UPLOAD', { promptVariables: ['SOURCES', 'EXTRACTED_CONTENT', 'INUTILE'] })],
    });
    expect(r.errors).toEqual([
      't1_group_upload : emplacement {{FIELD_CATALOG}} de « t1_master_v1 » sans variable déclarée',
      't1_group_upload : variable INUTILE déclarée sans emplacement dans « t1_master_v1 »',
    ]);
  });

  it('branche du fichier sans opération : avertissement', () => {
    const r = checkPromptFiles({ root: FIXTURES, operations: [master('GROUP_UPLOAD')] });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toMatch(/ANALYZE_DOCUMENT/);
  });
});

describe('scripts/check-prompt-files.ts', () => {
  it('code de sortie 1 quand un prompt manque (racine vide)', () => {
    const vide = mkdtempSync(join(tmpdir(), 'prompts-'));
    // Node + CLI de tsx plutôt que `node_modules/.bin/tsx` : sous Windows, ce
    // dernier est un `.cmd` que `spawnSync` sans shell ne sait pas lancer.
    const cli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const r = spawnSync(process.execPath, [cli, 'scripts/check-prompt-files.ts', `--root=${vide}`], { cwd: process.cwd(), encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/fichier introuvable/);
  }, 60_000);
});
