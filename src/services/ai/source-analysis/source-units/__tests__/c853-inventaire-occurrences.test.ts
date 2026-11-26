/**
 * Carte Trello #853 (P1-01 de #835) — INVENTAIRE des occurrences (R1), registre et totaux (R3), textes BO (AC15).
 * Fonctions pures, aucun appel IA.
 */
import { describe, expect, it } from 'vitest';
import { buildSourceUnits } from '../build-units';
import { computeCoverage, SourceUnitLinker } from '../coverage';
import { occurrenceTotals, reconcileCoverage, reconciliationSummary, type UnitOccurrenceLedger } from '../coverage-reconciliation';
import {
  equivalentOccurrences, faithfulPagesFromDiagnostics, faithfulPagesOf, isNormative, propositionOccurrencesOf, roleConflict, roleTagsOf, valueOccurrencesOf,
} from '../occurrences';
import { significantValueOccurrences } from '../text';
import { occurrenceCountsText, occurrenceDetailsText } from '@/app/admin/ai-executions/_components/T1CompletenessUnits';

const bloc = (text: string, id = 'page:1:block:1') => ({ sourceUnitId: id, page: 1, text });

describe('C853-I01 — R1 : inventaire, identité stable, pas de fusion par valeur', () => {
  it('deux occurrences de même valeur restent DEUX identités (position), avec leur rôle local', () => {
    const T = 'Plaquettes : 120,00 EUR ; Vidange : 120,00 EUR ; Main-d oeuvre : 80,00 EUR';
    const o = valueOccurrencesOf(bloc(T));
    expect(o.map((x) => x.form)).toEqual(['AMOUNT:12000', 'AMOUNT:12000', 'AMOUNT:8000']);
    expect(new Set(o.map((x) => x.id)).size).toBe(3);
    expect(o[0].id).toBe(`page:1:block:1@${T.indexOf('120,00')}`);
    expect([...o[0].role]).toContain('plaqu');
    expect([...o[1].role]).toContain('vidan');
    expect(equivalentOccurrences(o[0], o[1])).toBe(false);
  });

  it('lectures chevauchantes d’une même zone fusionnées (date ≠ identifiant), nombres nus seulement sur demande', () => {
    expect(significantValueOccurrences('Facture FA2026001 du 12/03/2026 : 45,00 EUR').map((x) => x.kind)).toEqual(['IDENTIFIER', 'DATE', 'AMOUNT']);
    expect(valueOccurrencesOf(bloc('Quantite 45 pieces'))).toEqual([]);
    expect(valueOccurrencesOf(bloc('Quantite 45 pieces'), { numbers: true }).map((x) => x.form)).toEqual(['NUM:45']);
  });

  it('propositions : règle énoncée sans valeur = une occurrence ; formule de politesse et phrase chiffrée exclues', () => {
    expect(isNormative('Le conducteur doit presenter son permis')).toBe(true);
    expect(isNormative('Merci de votre confiance')).toBe(false);
    const T = 'Les dommages dus au gel sont exclus de la garantie. Merci de votre confiance. Paiement avant le 12/03/2026, sinon penalite obligatoire.';
    const p = propositionOccurrencesOf(bloc(T));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ nature: 'PROPOSITION', start: 0 });
  });

  it('rôles discriminants : HT ≠ TTC, franchise ≠ plafond ; rôle inconnu → aucun refus', () => {
    expect([...roleTagsOf('total_ttc')]).toEqual(['ttc']);
    const ht = valueOccurrencesOf(bloc('Montant HT 100,00 EUR'))[0];
    expect(roleConflict(ht, roleTagsOf('montant ttc'))).toBe(true);
    expect(roleConflict(ht, roleTagsOf('montant_ht'))).toBe(false);
    expect(roleConflict(ht, roleTagsOf('amount'))).toBe(false);
  });

  it('fidélité des pages : vérifiée seulement si la source l’est, hors pages manquantes / non vérifiées / numérisées ; inconnue → non prouvée', () => {
    const f = faithfulPagesOf({ status: 'PARTIAL', missing: [3], unverified: [4], scanned: [5] });
    expect([1, 3, 4, 5, null].map((p) => f(p))).toEqual([true, false, false, false, false]);
    expect(faithfulPagesOf(null)(1)).toBe(false);
    expect(faithfulPagesOf({ status: 'UNVERIFIABLE' })(1)).toBe(false);
    expect(faithfulPagesFromDiagnostics({ sourceVerification: 'VERIFIED', pagesMissing: [], pagesUnverified: [2] })(1)).toBe(true);
    expect(faithfulPagesFromDiagnostics({ sourceVerification: 'VERIFIED', pagesUnverified: [2] })(2)).toBe(false);
    expect(faithfulPagesFromDiagnostics('{illisible')(1)).toBe(false);
  });
});

describe('C853-I02 — R3 : registre, totaux par occurrence (unités ≠ occurrences), aucun double compte', () => {
  it('somme des issues = total ; unités et occurrences distinguées ; détail sans valeur', () => {
    const T = 'Plaquettes 120,00 EUR ; Vidange 120,00 EUR ; Main-d oeuvre 80,00 EUR';
    const units = buildSourceUnits({ segments: [{ text: `${T}\n\nRien a signaler ici`, pageOffset: 0, origin: 'PASS_1' }] });
    const lie = (v: string, l: string) => ({ excerpt: T, page: 1, values: [v], labels: [l], unitIds: new SourceUnitLinker(units).link({ excerpt: T, page: 1 }) });
    const faits = [lie('120.00', 'plaquettes'), lie('80.00', 'main_oeuvre')];
    const base = computeCoverage(units, { facts: faits.map((f) => ({ unitIds: f.unitIds, confidence: 'certain' as const, values: f.values })) });
    const ledger = new Map<string, UnitOccurrenceLedger>();
    const cov = reconcileCoverage(base, { stage: 'ANALYSIS', facts: faits.map((f, i) => ({ ref: `f${i}`, ...f })), ledger });
    const t = occurrenceTotals(ledger);
    expect(t.total).toBe(t.structured + t.preserved + t.notRetained + t.undetermined + t.uncertain + t.unresolved + t.failed);
    expect(t).toMatchObject({ total: 3, structured: 2, unresolved: 1 });
    expect(reconciliationSummary(cov, 'ANALYSIS', ledger).occurrences).toEqual(t);
    const detail = ledger.get(units[0].sourceUnitId)!.details;
    expect(detail.map((d) => d.outcome)).toEqual(['STRUCTURED', 'UNRESOLVED', 'STRUCTURED']);
    expect(detail[0].proof).toEqual({ source: 'FACT', ref: 'fact:f0' });
    // Aucune valeur du document dans le détail (identité, position, issue, preuve, motif).
    expect(JSON.stringify(detail)).not.toMatch(/120|80,00|Vidange/);
  });
});

describe('C853-I03 — AC15 : textes BO', () => {
  it('totaux et détail lisibles, contrôle indisponible jamais affiché comme zéro', () => {
    expect(occurrenceCountsText(null)).toBe('Occurrences : contrôle indisponible');
    const c = { total: 3, structured: 1, preserved: 1, notRetained: 0, undetermined: 0, uncertain: 0, unresolved: 1, failed: 0, excluded: 2, units: 1 };
    expect(occurrenceCountsText(c)).toBe('3 occurrence(s) dans 1 unité(s) : 1 structurée(s) · 1 conservée(s) autrement · 0 non retenue(s) · 0 indéterminée(s) · 0 incertaine(s) · 1 non résolue(s) · 0 en échec · 2 exclue(s) (non informatives)');
    expect(occurrenceDetailsText([
      { id: 'u@0', nature: 'AMOUNT', at: 0, outcome: 'STRUCTURED', proof: { source: 'FACT', ref: 'fact:db:4' }, reason: null },
      { id: 'u@9', nature: 'AMOUNT', at: 9, outcome: 'UNRESOLVED', proof: null, reason: 'no_proof' },
    ])).toBe('AMOUNT@0 STRUCTURED ← fact:db:4 · AMOUNT@9 UNRESOLVED (no_proof)');
  });
});
