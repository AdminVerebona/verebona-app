/**
 * Lot 58C — rapport d'exécution T1 / T3, partie pure (REP-U*). Les preuves
 * sur base réelle sont dans `src/test/e2e/scenarios/l58c-reporting.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  entriesFingerprint, errorText, factMatchKey, INLINE_TEXT_MAX, normalizeT3Reason, reportStatus, serializeForHash, sha256,
  unmatchedDeclared, valueOrRef,
} from '../model';
import { reconciliationBusinessResult } from '../../reconciliation/t3-queue';

describe('REP-U — rapport d’exécution (pur)', () => {
  it('REP-U01 valeur courte recopiée, valeur longue référencée par empreinte (jamais tronquée)', () => {
    expect(valueOrRef('Allianz')).toEqual({ value: 'Allianz', ref: null });
    const long = 'x'.repeat(INLINE_TEXT_MAX + 1);
    const r = valueOrRef(long);
    expect(r.value).toBeNull();
    expect(r.ref).toEqual({ sha256: sha256(long), chars: long.length });
    expect(sha256(serializeForHash({ a: 1 }))).toBe(sha256('{"a":1}'));
  });

  it('REP-U02 motifs normalisés des champs examinés non modifiés (7 motifs du ticket)', () => {
    const m = (action: string, reasonCode: string, outcome?: string, error?: string, candidateCount = 1) =>
      normalizeT3Reason({ action, reasonCode, outcome, error, candidateCount });
    expect(m('ignore', 'NO_EVIDENCE', undefined, undefined, 0)).toBe('NO_EXPLOITABLE_INFO');
    expect(m('keep', 'WEAKER_EVIDENCE')).toBe('EXTRACTED_NOT_RETAINED');
    expect(m('keep', 'IDENTICAL_VALUE')).toBe('SAME_VALUE');
    expect(m('create_conflict', 'EQUAL_AUTHORITY_DIVERGENCE')).toBe('SOURCE_CONFLICT');
    expect(m('create_conflict', 'MANUAL_VALUE_CONTRADICTED')).toBe('USER_VALUE_PROTECTED');
    expect(m('create_conflict', 'CRITICAL_FIELD_INSUFFICIENT_PROOF')).toBe('INSUFFICIENT_EVIDENCE');
    expect(m('apply', 'EMPTY_FIELD_SINGLE_CERTAIN', 'protected')).toBe('USER_VALUE_PROTECTED');
    expect(m('apply', 'EMPTY_FIELD_SINGLE_CERTAIN', 'unchanged')).toBe('SAME_VALUE');
    expect(m('apply', 'EMPTY_FIELD_SINGLE_CERTAIN', 'invalid')).toBe('WRITE_REFUSED_OR_FAILED');
    expect(m('apply', 'EMPTY_FIELD_SINGLE_CERTAIN', undefined, 'boom')).toBe('WRITE_REFUSED_OR_FAILED');
  });

  it('REP-U03 déclaré ↔ persisté : chaque fait manquant est identifié (multiensemble)', () => {
    const d = [{ factKey: 'insurer', valueText: 'Allianz', valueNumber: null }, { factKey: 'x', valueText: 'a', valueNumber: null }, { factKey: 'x', valueText: 'a', valueNumber: null }];
    const persisted = [factMatchKey({ factKey: 'insurer', valueText: 'Allianz', valueNumber: null }), factMatchKey({ factKey: 'x', valueText: 'a', valueNumber: null })];
    expect(unmatchedDeclared(d, persisted, factMatchKey)).toEqual([{ factKey: 'x', valueText: 'a', valueNumber: null }]);
  });

  it('REP-U04 statut : une écriture non confirmée ou en échec n’est jamais un succès', () => {
    expect(reportStatus({ failed: false, steps: [], entries: [{ writeResult: 'WRITTEN' }], treatment: 'T3' })).toBe('SUCCESS');
    expect(reportStatus({ failed: false, steps: [], entries: [{ writeResult: 'DECIDED_NOT_CONFIRMED' }], treatment: 'T3' })).toBe('PARTIAL');
    expect(reportStatus({ failed: false, steps: [], entries: [{ writeResult: 'NOT_WRITTEN' }], treatment: 'T3' })).toBe('NO_CHANGE');
    expect(reportStatus({ failed: false, steps: [{ step: 'KNOWLEDGE', status: 'FAILED' }], entries: [], treatment: 'T1' })).toBe('PARTIAL');
    expect(reportStatus({ failed: true, steps: [], entries: [{ writeResult: 'WRITTEN' }], treatment: 'T1' })).toBe('FAILED');
  });

  it('REP-U05 APPLIED = écritures confirmées : une intention non écrite ne compte pas', () => {
    const apply = { fieldKey: 'insurer', currentValue: null, proposedValue: 'A', action: 'apply' as const, reasonCode: 'EMPTY_FIELD_SINGLE_CERTAIN', confidence: 'certain' as const, evidenceIds: [1], deterministic: true };
    expect(reconciliationBusinessResult([apply], 0).result).toBe('NO_CHANGE');
    expect(reconciliationBusinessResult([apply], 0).detail).toMatchObject({ applied: 0, intended: 1 });
    expect(reconciliationBusinessResult([apply], 1).result).toBe('APPLIED');
  });

  it('REP-U06 empreinte stable, message d’erreur sans URL de connexion', () => {
    expect(entriesFingerprint([{ section: 'FIELD', writeResult: 'NOT_WRITTEN' }])).toBe(entriesFingerprint([{ section: 'FIELD', writeResult: 'NOT_WRITTEN' }]));
    expect(errorText(new Error('connexion postgres://u:secret@h/db refusée'))).not.toContain('secret');
  });
});
