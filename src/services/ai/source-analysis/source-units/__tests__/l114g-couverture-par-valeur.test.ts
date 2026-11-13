/**
 * Lot 114G (Trello #760, audit T1 du 13/11) — fonctions pures de la couverture.
 *
 *   V01  P1-01 : unité « couverte » par un fait mais à plusieurs valeurs, dont
 *        une non représentée → NON RÉSOLUE `values_partially_structured` ;
 *        toutes expliquées (fait, décision) → reste couverte ; une seule
 *        valeur → jamais dégradée ; aucune promotion sur simple égalité ;
 *   V02  P2-05 : valeur portée par un seul candidat Opération — même résultat
 *        en analyse et depuis la charge persistée du candidat ;
 *   V03  P2-06 : coordonnées de contact comparées à la connaissance
 *        persistée — toutes représentées → couverte ; une manque → non résolue ;
 *   V04  P2-08 : politique résiduelle déduite d'une trace réelle.
 */
import { describe, expect, it } from 'vitest';
import { buildSourceUnits } from '../build-units';
import { computeCoverage, SourceUnitLinker } from '../coverage';
import { candidateReconciliationValue, reconcileCoverage, residualPolicyOf } from '../coverage-reconciliation';

type Units = ReturnType<typeof buildSourceUnits>;
const unites = (text: string) => buildSourceUnits({ segments: [{ text, pageOffset: 0, origin: 'PASS_1' }] });
const lien = (units: Units, excerpt: string, values: unknown[], labels: string[] = []) => ({
  excerpt, page: 1, values, labels, unitIds: new SourceUnitLinker(units).link({ excerpt, page: 1, values: values as string[], labels }),
});
const avant = (units: Units, facts: Array<ReturnType<typeof lien>>) =>
  computeCoverage(units, { facts: facts.map((f) => ({ unitIds: f.unitIds, confidence: 'certain' as const, values: f.values as string[] })) });
const apres = (units: Units, facts: Array<ReturnType<typeof lien>>, extra: Partial<Parameters<typeof reconcileCoverage>[1]> = {}) =>
  reconcileCoverage(avant(units, facts), { stage: 'ANALYSIS', facts: facts.map((f, i) => ({ ref: `f${i}`, ...f })), ...extra });
const unite = (cov: ReturnType<typeof avant>, debut: string) => cov.find((u) => (u.text ?? '').startsWith(debut))!;
const etat = (cov: ReturnType<typeof avant>, debut: string) => { const u = unite(cov, debut); return `${u.status}/${u.reason}`; };

const BLOC = 'Total TTC 120,00 € dont HT 100,00 € et acompte versé 30,00 €';

describe('L114G-V01 — P1-01 : couverture par valeur d’une unité à plusieurs valeurs', () => {
  it('défaut reproduit : un seul des trois montants structuré — `computeCoverage` seul dit COVERED/fact', () => {
    const u = unites(BLOC);
    expect(etat(avant(u, [lien(u, BLOC, ['120.00'], ['total_ttc'])]), 'Total TTC')).toBe('COVERED/fact');
  });

  it('après réconciliation : NON RÉSOLUE, motif précis, provenance et décompte par valeur', () => {
    const u = unites(BLOC);
    const r = unite(apres(u, [lien(u, BLOC, ['120.00'], ['total_ttc'])]), 'Total TTC');
    expect(`${r.status}/${r.reason}`).toBe('UNRESOLVED/values_partially_structured');
    expect(r.coverageProvenance).toMatchObject({
      rule: 'covered_unit_values_partially_structured', previous: { status: 'COVERED', reason: 'fact' },
      values: { total: 3, represented: 1, notRetained: 0, undetermined: 0 },
    });
  });

  it('les trois montants structurés : l’unité reste couverte (jamais dégradée)', () => {
    const u = unites(BLOC);
    const f = [lien(u, BLOC, ['120.00'], ['total_ttc']), lien(u, BLOC, ['100.00'], ['total_ht']), lien(u, BLOC, ['30.00'], ['acompte'])];
    expect(etat(apres(u, f), 'Total TTC')).toBe('COVERED/fact');
  });

  it('valeur non retenue AVEC décision valide : expliquée ; décision indéterminée : unité incertaine', () => {
    const u = unites(BLOC);
    const id = unite(avant(u, []), 'Total TTC').sourceUnitId;
    const f = [lien(u, BLOC, ['120.00'], ['total_ttc']), lien(u, BLOC, ['100.00'], ['total_ht'])];
    const dec = (decision: string) => [{ ref: 'd1', sourceUnitId: id, kind: 'AMOUNT', normalizedValue: '3000', decision }];
    expect(etat(apres(u, f, { decisions: dec('NOT_RETAINED') }), 'Total TTC')).toBe('COVERED/fact');
    expect(etat(apres(u, f, { decisions: dec('UNDETERMINED') }), 'Total TTC')).toBe('UNCERTAIN/value_undetermined');
  });

  it('une seule valeur dans l’unité : inchangée', () => {
    const u = unites('Total TTC 120,00 €');
    expect(etat(apres(u, [lien(u, 'Total TTC 120,00 €', ['120.00'], ['total_ttc'])]), 'Total TTC')).toBe('COVERED/fact');
  });

  it('aucune promotion sur simple égalité numérique : même montant structuré ailleurs, sans ancrage', () => {
    const u = unites(`${BLOC}\n\nFrais de dossier : 100,00 €\n\nRemise : 100,00 €`);
    // « 100,00 € » est un fait des frais de dossier (autre unité, autre libellé) ; deux autres unités portent ce montant.
    const f = [lien(u, BLOC, ['120.00'], ['total_ttc']), lien(u, 'Frais de dossier : 100,00 €', ['100.00'], ['frais_dossier'])];
    expect(etat(apres(u, f), 'Total TTC')).toBe('UNRESOLVED/values_partially_structured');
  });

  it('idempotente : rejouée sur sa propre sortie, même état et état d’origine conservé', () => {
    const u = unites(BLOC);
    const f = [lien(u, BLOC, ['120.00'], ['total_ttc'])];
    const une = apres(u, f);
    const deux = reconcileCoverage(une, { stage: 'STORED', facts: f.map((x, i) => ({ ref: `f${i}`, ...x })) });
    const r = unite(deux, 'Total TTC');
    expect(`${r.status}/${r.reason}`).toBe('UNRESOLVED/values_partially_structured');
    expect(r.coverageProvenance?.previous).toEqual({ status: 'COVERED', reason: 'fact' });
  });
});

describe('L114G-V02 — P2-05 : candidats Opération, même lecture en analyse et sur stockage', () => {
  const candidat = { candidateKey: 'c1', businessReferences: [{ value: 'DEV-2026-0042' }], financialHints: [{ amountMinor: 45020, economicDate: '2026-03-12', periodStart: null, periodEnd: null }], temporalHints: { signedAt: '2026-03-10' } };

  it('la charge persistée (JSON) rend les mêmes valeurs que le candidat en mémoire', () => {
    const memoire = candidateReconciliationValue('c1', candidat);
    const stocke = candidateReconciliationValue('c1', JSON.parse(JSON.stringify(candidat)));
    expect(stocke).toEqual(memoire);
    expect(memoire).toMatchObject({ ref: 'c1', source: 'CANDIDATE', values: ['DEV-2026-0042', 450.2, '2026-03-12', '2026-03-10'] });
  });

  it('charge vide ou mal formée : aucune valeur, jamais une erreur', () => {
    expect(candidateReconciliationValue('c', null).values).toEqual([]);
    expect(candidateReconciliationValue('c', { financialHints: 'x', businessReferences: [{ value: { a: 1 } }] }).values).toEqual([]);
  });

  it('fait absent, valeur portée UNIQUEMENT par un candidat valide → couverte, provenance CANDIDATE', () => {
    const u = unites('Devis\n\nRéférence du devis : DEV-2026-0042');
    const r = unite(apres(u, [], { values: [candidateReconciliationValue('c1', candidat)] }), 'Référence du devis');
    expect(`${r.status}/${r.reason}`).toBe('COVERED/values_structured');
    expect(r.coverageProvenance?.sources).toEqual(['CANDIDATE']);
  });

  it('valeur seulement mentionnée à deux endroits : pas de preuve sans lien démontré', () => {
    const u = unites('Référence du devis : DEV-2026-0042\n\nRappel de la référence DEV-2026-0042 en cas de réclamation');
    const cov = apres(u, [], { values: [candidateReconciliationValue('c1', candidat)] });
    expect(etat(cov, 'Référence du devis')).toMatch(/^UNRESOLVED\//);
  });
});

describe('L114G-V03 — P2-06 : coordonnées de contact, sans IA', () => {
  const CONTACT = 'Contact : service.client@assureur-exemple.fr — 01 23 45 67 89';
  const nonStructure = (text: string) => {
    const u = unites(`Assureur Exemple\n\n${text}`);
    // Unité liée à un fait (nom de l'émetteur) mais dont les coordonnées ne sont pas structurées.
    return { u, cov: avant(u, [lien(u, text, ['Assureur Exemple'], ['emetteur'])]) };
  };

  it('état de départ : `values_not_structured` (lot 111X)', () => {
    expect(etat(nonStructure(CONTACT).cov, 'Contact')).toBe('UNRESOLVED/values_not_structured');
  });

  it('toutes les coordonnées portées par la connaissance persistée (fait d’une autre unité, fournisseur) → couverte', () => {
    const { cov } = nonStructure(CONTACT);
    const r = unite(reconcileCoverage(cov, { stage: 'STORED', facts: [
      { ref: 'db:1', unitIds: [], values: ['service.client@assureur-exemple.fr'], labels: ['contact.email'], excerpt: null, page: null },
    ], values: [{ ref: 'supplier', source: 'METADATA', values: ['0123456789'], page: null }] }), 'Contact');
    expect(`${r.status}/${r.reason}`).toBe('COVERED/values_structured');
    expect(r.coverageProvenance).toMatchObject({ rule: 'contact_values_structured', previous: { status: 'UNRESOLVED', reason: 'values_not_structured' } });
  });

  it('coordonnées multiples dont UNE manque : reste NON RÉSOLUE (résidu réel)', () => {
    const { cov } = nonStructure(CONTACT);
    const r = reconcileCoverage(cov, { stage: 'STORED', facts: [
      { ref: 'db:1', unitIds: [], values: ['service.client@assureur-exemple.fr'], labels: ['contact.email'], excerpt: null, page: null },
    ] });
    expect(etat(r, 'Contact')).toBe('UNRESOLVED/values_not_structured');
  });
});

describe('L114G-V04 — P2-08 : politique résiduelle déduite d’une trace réelle', () => {
  const base = { kind: 'TEXT_BLOCK' as const, salient: true, payload: {}, repairAttempts: 0, repairState: null, status: 'UNRESOLVED' as const };

  it('aucune tentative, aucun motif d’exclusion : jamais « tentée sans résultat »', () => {
    expect(residualPolicyOf({ ...base, reason: 'not_extracted' })).toBe('REPAIR_NOT_ATTEMPTED');
  });

  it('tentative réelle (compteur ou état posé par une passe) : « tentée sans résultat »', () => {
    expect(residualPolicyOf({ ...base, reason: 'not_extracted', repairAttempts: 1 })).toBe('REPAIR_ATTEMPTED_NO_RESULT');
    expect(residualPolicyOf({ ...base, reason: 'not_extracted', repairState: 'ATTEMPTED_FAILED' })).toBe('REPAIR_ATTEMPTED_NO_RESULT');
  });

  it.each([['DISABLED'], ['BELOW_MIN_UNITS'], ['BUDGET']])('réparation non exécutée (%s) : motif dit', (motif) => {
    expect(residualPolicyOf({ ...base, reason: 'not_extracted' }, { repairSkipped: motif })).toBe(`REPAIR_NOT_RUN:${motif}`);
  });

  it('en attente, plafond atteint, échec : états distincts', () => {
    expect(residualPolicyOf({ ...base, reason: 'not_extracted', repairState: 'PENDING' })).toBe('REPAIR_PENDING');
    expect(residualPolicyOf({ ...base, reason: 'not_extracted', repairState: 'EXHAUSTED', repairAttempts: 2 })).toBe('REPAIR_EXHAUSTED');
    expect(residualPolicyOf({ ...base, status: 'FAILED', reason: 'repair_failed:final' })).toBe('TECHNICAL_FAILURE_FINAL');
  });

  it('« non structuré » : conservé seulement si le texte ne porte AUCUNE valeur exploitable', () => {
    expect(residualPolicyOf({ ...base, reason: 'not_structured', salient: false, text: 'Merci de votre confiance et à bientôt' })).toBe('PRESERVED_UNSTRUCTURED');
    expect(residualPolicyOf({ ...base, reason: 'not_structured', salient: false, text: 'Solde restant dû : 45,20 € au 12/03/2026' })).toBe('REPAIR_NOT_ATTEMPTED');
    // Appel historique sans texte : comportement d'avant conservé.
    expect(residualPolicyOf({ ...base, reason: 'not_structured', salient: false })).toBe('PRESERVED_UNSTRUCTURED');
  });
});
