/**
 * CDC 15 §29 étape 15, §32, D-02 — préconditions du retrait (calcul pur).
 */
import { describe, it, expect } from 'vitest';
import { computeCutover, type CutoverInputs } from '../cutover-check';
import { AI_OPERATIONS, operationDeprecation } from '../../../registry/operations';
import { treatmentForUseCase } from '../../../config/treatments';

const ops = [AI_OPERATIONS.extract_source, AI_OPERATIONS.classify_document, AI_OPERATIONS.t1_analyze_document, AI_OPERATIONS.legacy_document_analysis];

const inputs = (over: Partial<CutoverInputs> = {}): CutoverInputs => ({
  operations: ops,
  deprecationOf: operationDeprecation,
  treatmentOf: (op) => treatmentForUseCase(op.useCaseCode),
  activeArchitecture: { T1: 'master' },
  switches: { T1: { name: 'AI_T1_ANALYSIS_MODE', mode: 'enabled' } },
  flagOf: () => ({ name: 'AI_UNIFIED_SOURCE_ANALYSIS', mode: 'enabled' }),
  corpusGreen: { T1: true },
  usage: {},
  days: 30,
  promptFileOf: (code) => `prompts/source-analysis/${code}.txt`,
  promptFiles: [
    { promptCode: 'extract_source_v5', path: 'prompts/source-analysis/extract_source_v5.txt' },
    { promptCode: 'extract_source_v2', path: 'prompts/source-analysis/extract_source_v2.txt' },
    { promptCode: 'extract_source_v1', path: 'prompts/source-analysis/extract_source_v1.txt' },
  ],
  callersOf: (c) => (c === 'extract_source' ? ['src/services/ai/source-analysis/steps/extract.ts'] : []),
  referencesOf: (c) => (c === 'extract_source_v2' ? ['src/x.test.ts'] : []),
  ...over,
});

describe('computeCutover', () => {
  it('toutes préconditions réunies : liste EXACTE des opérations et fichiers supprimables (+ orphelins)', () => {
    const r = computeCutover(inputs());
    expect(r.mode).toBe('base');
    expect(r.removableOperations).toEqual(['extract_source', 'classify_document', 'legacy_document_analysis']);
    expect(r.operations.map((o) => o.operationCode)).not.toContain('t1_analyze_document');
    expect(r.removableFiles).toEqual(expect.arrayContaining([
      `prompts/source-analysis/${AI_OPERATIONS.extract_source.promptCode}.txt`,
      'prompts/source-analysis/extract_source_v1.txt',
    ]));
    expect(r.orphanPromptFiles).toEqual(['prompts/source-analysis/extract_source_v1.txt']);
    expect(r.referencedOrphans).toEqual([{ path: 'prompts/source-analysis/extract_source_v2.txt', references: ['src/x.test.ts'] }]);
    expect(r.operations.find((o) => o.operationCode === 'extract_source')?.callers).toHaveLength(1);
    expect(r.ready).toBe(true);
  });

  it('chaque précondition manquante bloque : steps, commutateur, drapeau, corpus, appels récents', () => {
    const cas: Array<[Partial<CutoverInputs>, string]> = [
      [{ activeArchitecture: { T1: 'steps' } }, 'ACTIVE_MASTER'],
      [{ switches: { T1: { name: 'AI_T1_ANALYSIS_MODE', mode: 'shadow' } } }, 'SWITCH_ENABLED'],
      [{ flagOf: () => ({ name: 'AI_UNIFIED_SOURCE_ANALYSIS', mode: 'legacy' }) }, 'AI_FLAG_ENABLED'],
      [{ corpusGreen: { T1: false } }, 'CORPUS_GREEN'],
      [{ usage: { extract_source: 3 } }, 'NO_RECENT_CALLS'],
    ];
    for (const [over, code] of cas) {
      const r = computeCutover(inputs(over));
      const e = r.operations.find((o) => o.operationCode === 'extract_source')!;
      expect(e.removable, code).toBe('bloquant');
      expect(e.preconditions.find((p) => p.code === code)?.status).toBe('bloquant');
      expect(r.removableOperations).not.toContain('extract_source');
      expect(r.ready).toBe(false);
    }
  });

  it('sans base : analyse statique, « à vérifier », aucune opération déclarée supprimable', () => {
    const r = computeCutover(inputs({ activeArchitecture: null, corpusGreen: null, usage: null }));
    expect(r.mode).toBe('statique');
    expect(r.removableOperations).toEqual([]);
    expect(r.operations.every((o) => o.removable === 'à vérifier')).toBe(true);
    // Les orphelins non référencés restent supprimables.
    expect(r.removableFiles).toEqual(['prompts/source-analysis/extract_source_v1.txt']);
  });
});
