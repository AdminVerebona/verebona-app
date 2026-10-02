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

  it('est injective — aucun drapeau ne pilote deux usages, et chaque drapeau pilote un usage', () => {
    const flags = Object.values(USE_CASE_FLAGS).filter((f) => f !== null);
    expect(new Set(flags).size).toBe(flags.length);
    expect(new Set(flags)).toEqual(new Set(AI_FLAGS));
  });

  it('renvoie le drapeau attendu pour chaque usage ; T5 et T6 n’en ont plus (lot 16b)', () => {
    expect(getUseCaseFlag('SOURCE_ANALYSIS')).toBe('AI_UNIFIED_SOURCE_ANALYSIS');
    expect(getUseCaseFlag('AI_GOVERNANCE')).toBeNull();
    expect(getUseCaseFlag('HOME_MASCOT')).toBeNull();
    expect(AI_FLAGS as readonly string[]).not.toContain('AI_PROMPT_GOVERNANCE');
    expect(AI_FLAGS as readonly string[]).not.toContain('AI_HOME_MASCOT');
  });
});

describe('état de bascule', () => {
  it('sans variable d\'environnement, seuls les usages sans drapeau (T5, T6) tournent', () => {
    expect(listRunningUseCases()).toEqual(['AI_GOVERNANCE', 'HOME_MASCOT']);
    expect(isAnyUseCaseRunning()).toBe(true);
    expect(getUseCaseMode('SOURCE_ANALYSIS')).toBe('legacy');
    expect(getUseCaseMode('AI_GOVERNANCE')).toBe('enabled');
    expect(getUseCaseMode('HOME_MASCOT')).toBe('enabled');
  });

  it('compte le mode observation comme actif — il consomme des appels modèles', () => {
    process.env.AI_RECONCILIATION_ENGINE = 'shadow';
    expect(isUseCaseRunning('DATA_RECONCILIATION')).toBe(true);
    expect(listRunningUseCases()).toEqual(['DATA_RECONCILIATION', 'AI_GOVERNANCE', 'HOME_MASCOT']);
  });

  it('n\'active que l\'usage dont le drapeau est positionné', () => {
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    expect(listRunningUseCases()).toEqual(['SOURCE_ANALYSIS', 'AI_GOVERNANCE', 'HOME_MASCOT']);
    expect(isUseCaseRunning('AGENDA_INTELLIGENCE')).toBe(false);
  });

  it('conserve l\'ordre du CDC dans la liste des usages actifs', () => {
    process.env.AI_AGENDA_ENGINE = 'enabled';
    process.env.AI_UNIFIED_SOURCE_ANALYSIS = 'enabled';
    expect(listRunningUseCases()).toEqual(['SOURCE_ANALYSIS', 'AGENDA_INTELLIGENCE', 'AI_GOVERNANCE', 'HOME_MASCOT']);
  });

  it('expose un instantané complet pour l\'administration', () => {
    process.env.AI_AGENDA_ENGINE = 'shadow';
    const snap = snapshotUseCaseModes();
    expect(Object.keys(snap)).toHaveLength(6);
    expect(snap.AGENDA_INTELLIGENCE).toBe('shadow');
    expect(snap.SOURCE_ANALYSIS).toBe('legacy');
  });
});
