/**
 * Lot 49 (49E) — ticket 12 « BO IA — Supprimer définitivement T5 (Prompt
 * Control) sans régression des traitements IA » : critères transverses
 * (T12-AC02, AC03, AC05, AC06, AC07, AC10, AC14, AC15) que les tests de
 * chaque module ne couvrent pas. Parcours PostgreSQL (migration 0336,
 * versions historiques, rollback, historiques et coûts) :
 * `src/test/e2e/scenarios/l49e-retrait-t5.e2e.ts`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const root = process.cwd();
const lire = (p: string) => readFileSync(join(root, p), 'utf8');

describe('T12-AC02 / T12-AC03 — plus aucune exécution fonctionnelle T5', () => {
  it('T12-AC02 — registre : ni t5_analyze ni t5_modify, ni prompt maître t5_master_v1 ; toute invocation est refusée', async () => {
    const { AI_OPERATIONS, getOperation, listMasterPrompts } = await import('../../registry/operations');
    expect(Object.keys(AI_OPERATIONS).filter((c) => /^t5_/i.test(c))).toEqual([]);
    for (const code of ['t5_analyze', 't5_modify']) expect(() => getOperation(code)).toThrow(/Opération inconnue/);
    expect(listMasterPrompts().map((m) => m.masterPromptCode)).not.toContain('t5_master_v1');
    expect(listMasterPrompts().map((m) => m.masterPromptCode).sort()).toEqual(['t1_master_v1', 't2_master_v1', 't3_master_v1', 't4_master_v1', 't6_master_v1']);
  });

  it('T12-AC03 — fichiers exclusivement T5 supprimés ; aucune importation résiduelle', () => {
    for (const f of [
      'src/services/ai/governance/prompt-control.service.ts',
      'src/services/ai/governance/prompt-control.audit.ts',
      'src/services/ai/governance/master/t5-contract.ts',
      'src/services/ai/config/t5-messages.ts',
      'src/services/ai/prompts/governance/t5_master_v1.txt',
    ]) expect(existsSync(join(root, f)), f).toBe(false);
    const fichiers: string[] = [];
    const parcourir = (d: string) => {
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') parcourir(p); } else if (/\.(ts|tsx)$/.test(e.name)) fichiers.push(p);
      }
    };
    parcourir('src');
    const fautifs = fichiers.filter((f) => /from ['"][^'"]*(prompt-control\.(service|audit)|t5-contract|t5-messages)['"]/.test(lire(f)));
    expect(fautifs).toEqual([]);
  });
});

describe('T12-AC05 / T12-AC06 / T12-AC07 — référentiel à cinq traitements, AI_GOVERNANCE technique', () => {
  it('T12-AC05 — exactement T1, T2, T3, T4, T6', async () => {
    const { TREATMENTS, RETIRED_TREATMENTS, isTreatment, assertTreatmentMapping } = await import('../treatments');
    expect([...TREATMENTS]).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    expect([...RETIRED_TREATMENTS]).toEqual(['T5']);
    expect(isTreatment('T5')).toBe(false);
    expect(() => assertTreatmentMapping()).not.toThrow();
  });

  it('T12-AC06 / T12-AC07 — sondes, qualification, test fournisseur et évaluation : usage technique, jamais un traitement', async () => {
    const { treatmentOfUseCase } = await import('../treatments');
    expect(treatmentOfUseCase('AI_GOVERNANCE')).toBeNull();
    const { getOperation } = await import('../../registry/operations');
    expect(getOperation('evaluate_prompt').useCaseCode).toBe('AI_GOVERNANCE');
    // Sondes tracées en AI_GOVERNANCE (technique, non facturable).
    for (const f of ['src/services/ai/provider/model-operational.service.ts', 'src/services/ai/provider/provider-test.service.ts']) {
      expect(lire(f), f).toMatch(/useCaseCode: 'AI_GOVERNANCE'/);
      expect(lire(f), f).toMatch(/billable: false/);
    }
  });

  it('T12-AC07 / T12-AC10 — journaux : une sonde est « Technique », un ancien appel T5 « T5 (retiré) » (libellé lot 53, D24), jamais confondus', async () => {
    const { executionScopeLabel } = await import('../../telemetry/execution-filters');
    expect(executionScopeLabel({ treatment: null, useCaseCode: 'AI_GOVERNANCE', operationCode: 'model_operational_probe' })).toBe('Technique');
    expect(executionScopeLabel({ treatment: null, useCaseCode: 'AI_GOVERNANCE', operationCode: 'model_qualification_probe' })).toBe('Technique');
    expect(executionScopeLabel({ treatment: null, useCaseCode: 'AI_GOVERNANCE', operationCode: 'provider_test' })).toBe('Technique');
    expect(executionScopeLabel({ treatment: null, useCaseCode: 'AI_GOVERNANCE', operationCode: 't5_analyze' })).toBe('T5 (retiré)');
    expect(executionScopeLabel({ treatment: null, useCaseCode: 'AI_GOVERNANCE', operationCode: 't5_modify' })).toBe('T5 (retiré)');
    expect(executionScopeLabel({ treatment: 'T2', useCaseCode: 'ASSISTANT', operationCode: 't2_answer' })).toBe('T2');
    // Un ancien lien `?treatment=T5` est ignoré (filtre courant à cinq traitements).
    const { readExecutionFilters } = await import('../../telemetry/execution-filters');
    expect(readExecutionFilters(new URLSearchParams('treatment=T5')).treatment).toBe('');
    expect(readExecutionFilters(new URLSearchParams('treatment=T6')).treatment).toBe('T6');
  });

  it('T12-AC10 — coûts : AI_GOVERNANCE libellé « Technique », même ligne de somme (aucun double comptage)', () => {
    const src = lire('src/services/ai/telemetry/cost-report.repository.ts');
    expect(src).toMatch(/code === 'AI_GOVERNANCE'\) return 'Technique · Gouvernance IA/);
  });
});

describe('T12-AC14 — migration 0336 non destructive et idempotente (contrôle statique)', () => {
  const sql = lire('src/db/migrations/0336_ai_retire_t5.sql');
  const code = sql.replace(/--.*$/gm, '');

  it('T12-AC14 — aucune suppression d’historique : pas de DROP TABLE / TRUNCATE ; DELETE seulement sur l’état opérationnel archivé', () => {
    expect(code).not.toMatch(/DROP\s+TABLE|TRUNCATE|DROP\s+COLUMN/i);
    const deletes = [...code.matchAll(/DELETE\s+FROM\s+(\w+)/gi)].map((m) => m[1]);
    expect(deletes.sort()).toEqual(['ai_cost_settings', 'ai_treatment_state']);
    expect(code).not.toMatch(/DELETE\s+FROM\s+(ai_config_entries|ai_master_prompt_versions|ai_master_prompt_activations|ai_master_prompt_test_runs|ai_master_corpus_runs|ai_usage_event)/i);
    // Archivage vérifiable AVANT neutralisation.
    expect(code).toMatch(/AND EXISTS \(SELECT 1 FROM ai_retired_treatment_archive/);
  });

  it('T12-AC14 — rejouable : IF NOT EXISTS, ON CONFLICT DO NOTHING, CREATE OR REPLACE, DROP TRIGGER IF EXISTS', () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS ai_retired_treatment_archive/);
    expect(code).toMatch(/ON CONFLICT \(source_table, row_key\) DO NOTHING/);
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION ai_retired_treatment_guard/);
    expect(code).toMatch(/DROP TRIGGER IF EXISTS ai_retired_treatment_guard/);
    // Garde sur les prompts maîtres seulement : l'ancien code reste redéployable (retour arrière).
    const gardees = code.slice(code.indexOf('FOR cible IN'), code.indexOf('LOOP'));
    expect(gardees).toMatch(/ai_master_prompt_versions/);
    expect(gardees).not.toMatch(/ai_config_entries|ai_treatment_state|ai_cost_settings/);
    // Anciennes migrations conservées.
    for (const f of ['0231_ai_config_t5_t6_master_only.sql', '0272_ai_master_prompt_t5.sql']) {
      expect(existsSync(join(root, 'src/db/migrations', f)), f).toBe(true);
    }
  });
});

describe('T12-AC15 — rapport des références conservées', () => {
  it('T12-AC15 — rapport d’exploitation présent : références supprimées / conservées, recette préproduction, retour arrière', () => {
    const p = 'docs/exploitation/lot49-retrait-t5.md';
    expect(existsSync(join(root, p))).toBe(true);
    const doc = lire(p);
    for (const titre of ['Références supprimées', 'Références conservées', 'Recette en préproduction', 'Retour arrière']) {
      expect(doc, titre).toContain(titre);
    }
  });
});
