/**
 * Lot 42 (O3b) — la branche OPERATION_MATCH du prompt maître T3 ne casse pas
 * la gouvernance des versions : une version BO antérieure (sans la section)
 * reste activable / réactivable et promouvable, les autres branches restent
 * servies ; seul le rapprochement M3 reste inactif (signalé sans bloquer).
 * Le fichier du dépôt, lui, doit contenir la branche. Tests C6-3x.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkMasterPromptContent } from '../master-prompt-checks';
import { masterConfigIssues, missingOptionalMasterTasks } from '../../config/prompt-architecture';
import { emptyTreatmentConfig } from '../../config/config-types';
import { checkMasterTemplate, isMasterTaskTextPending, isOptionalMasterTask, renderMasterPrompt, MasterPromptError } from '../../prompts/prompt-loader';
import { listMasterTasks } from '../../registry/operations';
import { runMasterCorpus } from '../../governance/master-corpus/runner';
import { readMasterFileFromRepo } from '../../governance/master-corpus/cases';

const livre = readFileSync('src/services/ai/prompts/reconciliation/t3_master_v1.txt', 'utf8');
// Lot 63 : le texte livré porte aussi DOCUMENT_NAMING (après OPERATION_MATCH) — absente de cette version antérieure.
const ancien = livre.slice(0, livre.indexOf('BRANCHE TASK = OPERATION_MATCH')).replace(' | OPERATION_MATCH | DOCUMENT_NAMING', '')
  + 'Réponds uniquement par le JSON correspondant au TASK demandé.';
const VARS = { FIELD: null, CURRENT_STATE: null, EVIDENCES: null, SUBJECT_CONTEXT: null, CANDIDATES: null, RELATION_TYPE: null };

describe('C6-3x — gouvernance des versions du prompt maître T3', () => {
  it('C6-30 la branche est déclarée au registre et optionnelle pour T3 seulement ; le fichier du dépôt la contient', () => {
    // Lot 61 : DOCUMENT_NAMING, également facultative ; lot 63 : son texte est livré dans le fichier du dépôt.
    expect(listMasterTasks('t3_master_v1')).toEqual(['VALUE_CONFLICT', 'LINK_AMBIGUITY', 'OPERATION_MATCH', 'DOCUMENT_NAMING']);
    expect(isOptionalMasterTask('t3_master_v1', 'OPERATION_MATCH')).toBe(true);
    expect(isOptionalMasterTask('t3_master_v1', 'VALUE_CONFLICT')).toBe(false);
    expect(isOptionalMasterTask('t3_master_v1', 'DOCUMENT_NAMING')).toBe(true);
    expect(isMasterTaskTextPending('t3_master_v1', 'DOCUMENT_NAMING')).toBe(false);
    const livrees = listMasterTasks('t3_master_v1');
    expect(checkMasterTemplate(livre, livrees)).toEqual([]);
    expect(checkMasterTemplate(ancien, livrees)).toEqual(['section « BRANCHE TASK = OPERATION_MATCH » absente', 'section « BRANCHE TASK = DOCUMENT_NAMING » absente']);
  });

  it('C6-31 version BO antérieure : activable (aucun blocage), avertissement explicite ; texte livré : rien à signaler', () => {
    const r = checkMasterPromptContent('T3', ancien);
    expect(r.ok).toBe(true);
    expect(r.blocking).toEqual([]);
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: 'OPTIONAL_BRANCH_MISSING', blocking: false }), expect.objectContaining({ code: 'OPTIONAL_BRANCH_MISSING', blocking: false }),
    ]);
    expect(r.warnings[0].message).toMatch(/OPERATION_MATCH[\s\S]*repartez du texte livré avec l’application puis activez la version/);
    // Lot 63 : DOCUMENT_NAMING livrée — même consigne que toute branche facultative (repartir du texte livré).
    expect(r.warnings[1].message).toMatch(/DOCUMENT_NAMING[\s\S]*repartez du texte livré avec l’application puis activez la version/);
    expect(r.warnings[1].message).not.toMatch(/évolution séparée/);
    expect(checkMasterPromptContent('T3', livre)).toMatchObject({ ok: true, blocking: [], warnings: [] });
  });

  it('C6-32 version de configuration portant l’ancien texte : promotion non bloquée, signalement non bloquant', () => {
    const c = { ...emptyTreatmentConfig('T3'), prompt: '', promptArchitecture: 'master' as const, masterPrompt: ancien };
    const issues = masterConfigIssues(c);
    expect(issues.filter((i) => i.blocking)).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ field: 'masterPrompt', blocking: false, message: expect.stringMatching(/OPERATION_MATCH/) }));
    expect(missingOptionalMasterTasks('T3', ancien)).toEqual(['OPERATION_MATCH', 'DOCUMENT_NAMING']);
    expect(missingOptionalMasterTasks('T3', livre)).toEqual([]);
  });

  it('C6-33 à l’exécution : les branches existantes rendent ; OPERATION_MATCH est refusée AVANT tout appel (TASK_BRANCH_MISSING)', () => {
    const tasks = listMasterTasks('t3_master_v1');
    for (const t of ['VALUE_CONFLICT', 'LINK_AMBIGUITY']) {
      expect(() => renderMasterPrompt(ancien, { masterPromptCode: 't3_master_v1', task: t, allowedTasks: tasks, variables: VARS })).not.toThrow();
    }
    let err: unknown = null;
    try { renderMasterPrompt(ancien, { masterPromptCode: 't3_master_v1', task: 'OPERATION_MATCH', allowedTasks: tasks, variables: VARS }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MasterPromptError);
    expect((err as MasterPromptError).code).toBe('TASK_BRANCH_MISSING');
    expect(renderMasterPrompt(livre, { masterPromptCode: 't3_master_v1', task: 'OPERATION_MATCH', allowedTasks: tasks, variables: VARS })).toContain('TASK = OPERATION_MATCH');
  });

  it('C6-34 corpus d’une version antérieure : cas OPERATION_MATCH ignorés, branche non exigée (corpus facultatif, jamais rouge pour autant)', async () => {
    const [r] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T3'], texts: { t3_master_v1: { text: ancien, source: 'config' } } });
    expect(r.status).toBe('PASSED');
    expect(r.branchesRequired).toEqual(['VALUE_CONFLICT', 'LINK_AMBIGUITY']);
    expect(r.skipped?.length).toBeGreaterThanOrEqual(5);
    const [f] = await runMasterCorpus({ readMasterFile: readMasterFileFromRepo, treatments: ['T3'] });
    expect(f.branchesPassed).toEqual(['VALUE_CONFLICT', 'LINK_AMBIGUITY', 'OPERATION_MATCH', 'DOCUMENT_NAMING']);
  });
});
