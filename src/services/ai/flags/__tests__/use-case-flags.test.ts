/**
 * CDC Refonte §10.1 et §10.4 — la correspondance usage ⇄ drapeau doit être
 * bijective et complète, faute de quoi un usage pourrait être basculé sans
 * décision explicite, ou deux usages partager le même interrupteur.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AI_USE_CASE_CODES } from '../../registry/use-cases';
import { AI_FLAGS } from '../ai-feature-flags';
import {
  USE_CASE_FLAGS, getUseCaseFlag, getUseCaseMode, isUseCaseRunning,
  listRunningUseCases, isAnyUseCaseRunning, snapshotUseCaseModes,
} from '../use-case-flags';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  for (const f of AI_FLAGS) delete process.env[f];
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('correspondance usage ⇄ drapeau', () => {
  it('couvre les cinq usages, sans oubli', () => {
    expect(Object.keys(USE_CASE_FLAGS).sort()).toEqual([...AI_USE_CASE_CODES].sort());
  });

  it('est bijective — aucun drapeau ne pilote deux usages', () => {
    const flags = Object.values(USE_CASE_FLAGS);
    expect(new Set(flags).size).toBe(flags.length);
    expect(new Set(flags)).toEqual(new Set(AI_FLAGS));
  });

  it('renvoie le drapeau attendu pour chaque usage', () => {
    expect(getUseCaseFlag('SOURCE_ANALYSIS')).toBe('AI_UNIFIED_SOURCE_ANALYSIS');
    expect(getUseCaseFlag('AI_GOVERNANCE')).toBe('AI_PROMPT_GOVERNANCE');
  });
});

describe('état de bascule', () => {
  it('sans variable d\'environnement, aucun usage n\'est basculé', () => {
    expect(listRunningUseCases()).toEqual([]);
    expect(isAnyUseCaseRunning()).toBe(false);
    expect(getUseCaseMode('SOURCE_ANALYSIS')).toBe('legacy');
  });

  it('compte le mode observation comme actif — il consomme des appels modèles', () => {
    process.env.AI_RECONCILIATION_ENGINE = 'shadow';
    expect(isUseCaseRunning('DATA_RECONCILIATION')).toBe(true);
    expect(listRunningUseCases()).toEqual(['DATA_RECONCILIATION']);
  });

  it('n\'active que l\'usage dont le drapeau est positionné', () => {
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    expect(listRunningUseCases()).toEqual(['SOURCE_ANALYSIS']);
    expect(isUseCaseRunning('AGENDA_INTELLIGENCE')).toBe(false);
  });

  it('conserve l\'ordre du CDC dans la liste des usages actifs', () => {
    process.env.AI_PROMPT_GOVERNANCE = 'enabled';
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    expect(listRunningUseCases()).toEqual(['SOURCE_ANALYSIS', 'AI_GOVERNANCE']);
  });

  it('expose un instantané complet pour l\'administration', () => {
    process.env.AI_AGENDA_ENGINE = 'shadow';
    const snap = snapshotUseCaseModes();
    expect(Object.keys(snap)).toHaveLength(5);
    expect(snap.AGENDA_INTELLIGENCE).toBe('shadow');
    expect(snap.SOURCE_ANALYSIS).toBe('legacy');
  });
});
