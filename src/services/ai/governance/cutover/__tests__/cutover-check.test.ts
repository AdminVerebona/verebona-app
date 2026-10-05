/**
 * CDC 15 §29 étape 15, §32, D-02 ; lot 16b — `ai:cutover-check` devient un
 * GARDE de l'architecture cible (calcul pur).
 *
 * Le registre réel doit le passer (aucune opération dépréciée, prompts
 * maîtres seuls) ; des définitions SYNTHÉTIQUES (même forme que le registre)
 * vérifient chaque cause de blocage.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { computeCutover, type CutoverInputs } from '../cutover-check';
import {
  AI_OPERATIONS, isTargetArchitectureOperation, listNonTargetOperations, type AiOperationDefinition,
} from '../../../registry/operations';

const base = AI_OPERATIONS.t3_value_conflict;
const etape = (code: string, over: Partial<AiOperationDefinition> = {}): AiOperationDefinition => ({
  ...base, operationCode: code, masterPromptCode: undefined, task: undefined, promptVariables: undefined,
  promptCode: `${code}_v1`, ...over,
});

const inputs = (over: Partial<CutoverInputs> = {}): CutoverInputs => ({
  operations: [base, AI_OPERATIONS.t3_link_ambiguity, AI_OPERATIONS.evaluate_prompt, AI_OPERATIONS.collect_evidence],
  isTarget: isTargetArchitectureOperation,
  promptFiles: [{ promptCode: 't3_master_v1', path: 'prompts/reconciliation/t3_master_v1.txt' }],
  legacyTemplates: [],
  storedSteps: [],
  retiredVariables: [],
  usage: { t3_value_conflict: 4 },
  days: 30,
  ...over,
});

describe('computeCutover — garde', () => {
  it('architecture cible : prêt, aucun contrôle bloquant (évaluation candidate et déterministes admis)', () => {
    const r = computeCutover(inputs());
    expect(r.mode).toBe('base');
    expect(r.ready).toBe(true);
    expect(r.checks.every((c) => c.status === 'ok')).toBe(true);
    expect(r.nonTargetOperations).toEqual([]);
  });

  it('chaque retour de l’ancien moteur bloque : étape, relais, prompt orphelin, gabarit, configuration « steps »', () => {
    const cas: Array<[Partial<CutoverInputs>, string]> = [
      [{ operations: [base, etape('resolve_ambiguity')] }, 'NON_TARGET_OPERATION'],
      [{ promptFiles: [
        { promptCode: 't3_master_v1', path: 'prompts/reconciliation/t3_master_v1.txt' },
        { promptCode: 'resolve_ambiguity_v1', path: 'prompts/reconciliation/resolve_ambiguity_v1.txt' },
      ] }, 'ORPHAN_PROMPT_FILE'],
      [{ legacyTemplates: ['src/services/document-ai/prompts/asset_suggest_v1.txt'] }, 'LEGACY_TEMPLATE'],
      [{ storedSteps: [{ versionId: 12, treatment: 'T3' }] }, 'STORED_STEPS'],
    ];
    for (const [over, code] of cas) {
      const r = computeCutover(inputs(over));
      expect(r.ready, code).toBe(false);
      expect(r.checks.find((c) => c.code === code)?.status, code).toBe('bloquant');
    }
    // Une opération inactive n'est pas un retour de l'ancien moteur.
    expect(computeCutover(inputs({ operations: [base, etape('old', { active: false })] })).ready).toBe(true);
  });

  it('avertissements non bloquants : variable retirée posée, appel récent à une opération retirée', () => {
    const r = computeCutover(inputs({
      retiredVariables: ['AI_RECONCILIATION_ENGINE'],
      usage: { t3_value_conflict: 2, resolve_ambiguity: 7 },
    }));
    expect(r.ready).toBe(true);
    expect(r.checks.find((c) => c.code === 'RETIRED_VARIABLE')?.status).toBe('avertissement');
    expect(r.retiredOperationCalls).toEqual([{ operationCode: 'resolve_ambiguity', calls: 7 }]);
    expect(r.checks.find((c) => c.code === 'RETIRED_OPERATION_CALL')?.status).toBe('avertissement');
  });

  it('sans base : analyse statique, contrôles en base « à vérifier », sortie prête', () => {
    const r = computeCutover(inputs({ storedSteps: null, usage: null }));
    expect(r.mode).toBe('statique');
    expect(r.ready).toBe(true);
    expect(r.checks.filter((c) => c.status === 'à vérifier').map((c) => c.code)).toEqual(['STORED_STEPS', 'RETIRED_OPERATION_CALL']);
  });
});

describe('le dépôt respecte l’architecture cible (lot 16b)', () => {
  it('registre : aucune opération active hors prompt maître', () => {
    expect(listNonTargetOperations()).toEqual([]);
  });

  it('fichiers : seuls les six masters sous ai/prompts, plus aucun gabarit document-ai', () => {
    const racine = join(process.cwd(), 'src/services/ai/prompts');
    const fichiers = readdirSync(racine).flatMap((d) => (statSync(join(racine, d)).isDirectory()
      ? readdirSync(join(racine, d)).filter((f) => f.endsWith('.txt')).map((f) => ({ promptCode: f.replace(/\.txt$/, ''), path: `${d}/${f}` }))
      : []));
    const r = computeCutover({
      operations: Object.values(AI_OPERATIONS), isTarget: isTargetArchitectureOperation, promptFiles: fichiers,
      legacyTemplates: existsSync(join(process.cwd(), 'src/services/document-ai/prompts')) ? ['présent'] : [],
      storedSteps: null, retiredVariables: [], usage: null, days: 30,
    });
    expect(fichiers.map((f) => f.promptCode).sort()).toEqual(
      ['t1_master_v1', 't2_master_v1', 't3_master_v1', 't4_master_v1', 't5_master_v1', 't6_master_v1'],
    );
    expect(r.ready).toBe(true);
  });
});
