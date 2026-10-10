/**
 * Prompt maître T1 — CDC 15 §23, §22.2, §29, T1-06, T1-07, D-04.
 * Lot 16b-3 : seul moteur T1 (plus d'aiguillage `AI_T1_ANALYSIS_MODE`, plus
 * d'observation D-18).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const { T1_PROMPT_VARIABLES } = await import('../prompt-context');
const { checkMasterTemplate, inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
const { RETIRED_AI_VARIABLES } = await import('@/services/ai/config/retired-variables');

const MASTER = readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');

describe('t1_master_v1.txt — transcription du §23', () => {
  it('structure master : {{TASK}}, les deux branches, exactement les emplacements fournis par le serveur', () => {
    expect(checkMasterTemplate(MASTER, ['GROUP_UPLOAD', 'ANALYZE_DOCUMENT'])).toEqual([]);
    const info = inspectMasterTemplate(MASTER);
    expect(info.placeholders.sort()).toEqual(['TASK', ...T1_PROMPT_VARIABLES].sort());
    expect(info.branches).toEqual(['GROUP_UPLOAD', 'ANALYZE_DOCUMENT']);
  });

  it('règles universelles U1 à U18, dans l’ordre', () => {
    const positions = Array.from({ length: 18 }, (_, i) => MASTER.indexOf(`U${i + 1} — `));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('T1-06 : « Dernier entretien » illustre lastRevision, jamais maintenanceDueDate', () => {
    const u15 = MASTER.slice(MASTER.indexOf('U15 — '), MASTER.indexOf('U16 — '));
    expect(u15).toContain('« Dernier entretien : 15/11/2026 » établit une date d’entretien réalisé (`lastRevision`');
    // Lot 34D : l'exemple JSON est retiré (le contrat runtime porte la structure) ;
    // le cas typique reste décrit en sémantique.
    expect(MASTER).toContain('mention « Dernier entretien : 15/11/2026 » : `lastRevision`, événement `maintenance` HISTORICAL, jamais une prochaine échéance');
    expect(MASTER).not.toMatch(/maintenanceDueDate[^\n]*Dernier entretien/);
  });

  it('T1-07 : probable = lecture incertaine, jamais une inférence', () => {
    const u11 = MASTER.slice(MASTER.indexOf('U11 — '), MASTER.indexOf('U12 — '));
    expect(u11).toContain('JAMAIS une inférence');
    expect(u11).not.toMatch(/déductible/);
  });

  it('T1-03 : plus de « tout en centimes » ; amountCents seul en centimes', () => {
    expect(MASTER).not.toMatch(/Montants : en centimes/);
    expect(MASTER).toContain('ne multiplie jamais une valeur métier par 100');
  });

  it('RTC — le prompt ne recopie plus le schéma : les champs sont portés par le contrat runtime', async () => {
    // Lot 34D : plus de JSON d'exemple ni de liste d'énumérations / de nullabilité dans le texte.
    expect(MASTER).not.toContain('"canonicalKey"');
    expect(MASTER).not.toMatch(/n’écris jamais `null` pour/);
    expect(MASTER).toContain('fixée par le contrat runtime joint à l’appel');
    // La sémantique est conservée (date du document, montant documentaire en centimes, preuve lue).
    expect(MASTER).toContain('`documentDate`');
    expect(MASTER).toContain('`amountCents`');
    const { resolveRuntimeContract, contractJsonSchemaText } = await import('@/services/ai/gateway/output-resolution/runtime-contract');
    const { T1AnalyzeDocumentOutput } = await import('../t1-contract');
    const { contract, mismatch } = resolveRuntimeContract({ schemaName: 'T1AnalyzeDocumentOutput', operationCode: 't1_analyze_document', callerSchema: T1AnalyzeDocumentOutput });
    expect(mismatch).toBeNull();
    const schema = contractJsonSchemaText(contract);
    for (const cle of ['"canonicalKey"', '"rawKey"', '"rawValue"', '"normalizedValue"', '"valueType"', '"canonicalUnit"',
      '"target"', '"provenance"', '"evidence"', '"visualEvidence"', '"semanticEvent"', '"hasExploitableContent"',
      '"classification"', '"canonicalType"', '"rubricCode"', '"documentTypeCode"', '"multiAsset"', '"evidenceSignals"',
      '"documentDate"', '"amountCents"', '"supplier"']) {
      expect(schema).toContain(cle);
    }
  });
});

describe('master seul (lot 16b-3)', () => {
  it('commutateur AI_T1_ANALYSIS_MODE retiré du catalogue', () => {
    // Lot 16b-3 : plus aucun commutateur ; la variable est listée parmi les retirées.
    expect(RETIRED_AI_VARIABLES.map((x) => x.name)).toContain('AI_T1_ANALYSIS_MODE');
  });

  it('aiguillage et observation supprimés', () => {
    for (const f of ['analysis-mode.ts', 'shadow.ts']) {
      expect(existsSync(join(process.cwd(), 'src/services/ai/source-analysis/master', f)), f).toBe(false);
    }
  });

  it('T1 est un traitement « master » seul ; steps refusé', async () => {
    const { isMasterOnlyTreatment } = await import('@/services/ai/config/treatments');
    const { checkPromptArchitectureChange } = await import('@/services/ai/config/prompt-architecture');
    expect(isMasterOnlyTreatment('T1')).toBe(true);
    expect(checkPromptArchitectureChange({ status: 'DRAFT', treatment: 'T1', from: 'master', to: 'steps' }))
      .toMatchObject({ allowed: false, code: 'MASTER_ONLY_TREATMENT' });
  });
});
