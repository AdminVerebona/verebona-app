/**
 * CDC §9.7 — « Migrer les historiques vers les cinq identifiants, sans réécrire
 * les événements passés. »
 *
 * Le test central est celui de PARITÉ avec la migration 0110. La table
 * TypeScript rattache les événements à l'écriture, la migration rattache ceux
 * déjà en base : si les deux divergent, l'historique et les nouvelles lignes
 * sont agrégés selon deux règles différentes. Cet écart ne se verrait qu'à la
 * lecture d'un tableau de bord, des mois plus tard, et serait alors très
 * difficile à expliquer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LEGACY_USAGE_MAPPING, resolveLegacyUseCase, listLegacyIdentifiers,
} from '../legacy-usage-mapping';
import { AI_USE_CASE_CODES } from '../use-cases';

/** Relit les valeurs INSERT de la migration 0110. */
function mappingFromMigration(): Record<string, { useCaseCode: string; operationCode: string; legacyUsageNo: number }> {
  const sql = readFileSync(
    join(process.cwd(), 'src', 'db', 'migrations', '0110_legacy_usage_history_mapping.sql'),
    'utf8',
  );
  const out: Record<string, { useCaseCode: string; operationCode: string; legacyUsageNo: number }> = {};
  const re = /\('([a-z_]+)',\s*(\d+),\s*'([A-Z_]+)',\s*'([a-z_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out[m[1]] = { legacyUsageNo: Number(m[2]), useCaseCode: m[3], operationCode: m[4] };
  }
  return out;
}

describe('parité avec la migration 0110', () => {
  const fromSql = mappingFromMigration();

  it('la migration est bien lue', () => {
    expect(Object.keys(fromSql).length).toBeGreaterThanOrEqual(12);
  });

  it('couvre exactement les mêmes identifiants', () => {
    expect(listLegacyIdentifiers()).toEqual(Object.keys(fromSql).sort());
  });

  it('rattache chaque identifiant au même usage et à la même opération', () => {
    for (const [id, expected] of Object.entries(fromSql)) {
      expect(LEGACY_USAGE_MAPPING[id], id).toEqual({
        useCaseCode: expected.useCaseCode,
        operationCode: expected.operationCode,
        legacyUsageNo: expected.legacyUsageNo,
      });
    }
  });
});

describe('résolution', () => {
  it('rattache un identifiant connu', () => {
    expect(resolveLegacyUseCase('enrichissement')).toBe('DATA_RECONCILIATION');
    expect(resolveLegacyUseCase('web_link_analysis')).toBe('SOURCE_ANALYSIS');
    expect(resolveLegacyUseCase('ai_instructions')).toBe('AI_GOVERNANCE');
  });

  it('laisse un identifiant inconnu NON rattaché', () => {
    // Surtout pas un usage par défaut : le ranger d'office dans l'analyse
    // documentaire fausserait les chiffres là où on les regarde.
    expect(resolveLegacyUseCase('operation_inconnue')).toBeNull();
  });

  it('tolère l\'absence de valeur', () => {
    expect(resolveLegacyUseCase(null)).toBeNull();
    expect(resolveLegacyUseCase(undefined)).toBeNull();
    expect(resolveLegacyUseCase('')).toBeNull();
  });
});

describe('cohérence avec le référentiel', () => {
  it('ne rattache qu\'à des usages existants', () => {
    for (const [id, m] of Object.entries(LEGACY_USAGE_MAPPING)) {
      expect(AI_USE_CASE_CODES, id).toContain(m.useCaseCode);
    }
  });

  it('couvre les cinq usages — aucun n\'est orphelin d\'historique', () => {
    const covered = new Set(Object.values(LEGACY_USAGE_MAPPING).map(m => m.useCaseCode));
    expect([...covered].sort()).toEqual([...AI_USE_CASE_CODES].sort());
  });

  it('conserve les onze usages de l\'ancienne nomenclature', () => {
    const numbers = new Set(Object.values(LEGACY_USAGE_MAPPING).map(m => m.legacyUsageNo));
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
