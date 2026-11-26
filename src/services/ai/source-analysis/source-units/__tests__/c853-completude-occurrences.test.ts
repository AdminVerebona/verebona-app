/**
 * Carte Trello #853 (P1-01 de #835) — SUPPRIMER LES FAUX COVERED : complétude T1 par valeur ET par occurrence.
 *
 * Contre-exemples de la carte (AC01–AC12) sur le chemin RÉEL de production des fonctions pures : construction de
 * la couche A (`buildSourceUnits`), rattachement des preuves (`SourceUnitLinker`), couverture de base
 * (`computeCoverage`) puis réconciliation (`reconcileCoverage`). Ce fichier n'importe QUE des modules antérieurs à
 * la carte : il est rejoué tel quel sur le code d'avant pour la preuve « rouge avant / vert après » (rapport).
 * Les fixtures sont construites, pas des preuves terrain.
 */
import { describe, expect, it } from 'vitest';
import { buildSourceUnits } from '../build-units';
import { computeCoverage, SourceUnitLinker } from '../coverage';
import { reconcileCoverage, type ReconciliationInput } from '../coverage-reconciliation';
import type { ExtractedTable } from '../../types';
import type { CoveredSourceUnit } from '../types';

type Units = ReturnType<typeof buildSourceUnits>;
type Fact = { excerpt: string; page: number | null; values: unknown[]; labels: string[]; unitIds: string[] };
const unites = (text: string, tables: ExtractedTable[] = []) => buildSourceUnits({ segments: [{ text, pageOffset: 0, origin: 'PASS_1' }], tables });
const lien = (units: Units, excerpt: string, values: unknown[], labels: string[] = [], page: number | null = 1): Fact => ({
  excerpt, page, values, labels, unitIds: new SourceUnitLinker(units).link({ excerpt, page, values: values as string[], labels }),
});
const avant = (units: Units, facts: Fact[]) =>
  computeCoverage(units, { facts: facts.map((f) => ({ unitIds: f.unitIds, confidence: 'certain' as const, values: f.values as string[] })) });
const apres = (units: Units, facts: Fact[], extra: Partial<ReconciliationInput> = {}, base: CoveredSourceUnit[] = avant(units, facts)) =>
  reconcileCoverage(base, { stage: 'ANALYSIS', facts: facts.map((f, i) => ({ ref: `f${i}`, ...f })), ...extra });
const unite = (cov: CoveredSourceUnit[], debut: string) => cov.find((u) => (u.text ?? '').startsWith(debut))!;
const etat = (cov: CoveredSourceUnit[], debut: string) => { const u = unite(cov, debut); return `${u.status}/${u.reason}`; };
/** Compteurs par occurrence enregistrés avec la provenance (carte #853). */
const occ = (u: CoveredSourceUnit) => (u.coverageProvenance as { occurrences?: Record<string, number> } | null | undefined)?.occurrences;

describe('C853-A — cardinalité et contexte (AC01–AC04)', () => {
  const BLOC = 'Montant TTC 120,00 EUR ; HT 100,00 EUR ; acompte verse 30,00 EUR';

  it('AC01 — TTC / HT / acompte : un ou deux faits → omissions détaillées ; trois preuves exactes → COVERED', () => {
    const u = unites(BLOC);
    const un = unite(apres(u, [lien(u, BLOC, ['120.00'], ['total_ttc'])]), 'Montant');
    expect(`${un.status}/${un.reason}`).toBe('UNRESOLVED/values_partially_structured');
    expect(occ(un)).toMatchObject({ total: 3, structured: 1, unresolved: 2 });
    const deux = unite(apres(u, [lien(u, BLOC, ['120.00'], ['total_ttc']), lien(u, BLOC, ['100.00'], ['montant_ht'])]), 'Montant');
    expect(occ(deux)).toMatchObject({ total: 3, structured: 2, unresolved: 1 });
    const trois = apres(u, [lien(u, BLOC, ['120.00'], ['total_ttc']), lien(u, BLOC, ['100.00'], ['montant_ht']), lien(u, BLOC, ['30.00'], ['acompte'])]);
    expect(etat(trois, 'Montant')).toBe('COVERED/fact');
  });

  it('AC02 — deux prestations DISTINCTES à 120 € + main-d’œuvre 80 € : un fait 120 + un fait 80 → exactement UNE prestation non résolue', () => {
    const T = 'Plaquettes 120,00 EUR ; Vidange 120,00 EUR ; Main-d oeuvre 80,00 EUR';
    const u = unites(T);
    const r = unite(apres(u, [lien(u, T, ['120.00'], ['plaquettes']), lien(u, T, ['80.00'], ['main_oeuvre'])]), 'Plaquettes');
    // Avant : formes {120, 80} toutes deux représentées → COVERED/fact (faux COVERED).
    expect(`${r.status}/${r.reason}`).toBe('UNRESOLVED/values_partially_structured');
    expect(occ(r)).toMatchObject({ total: 3, structured: 2, unresolved: 1 });
    // L'occurrence non résolue est bien la VIDANGE (rôle discriminant), pas la première venue.
    const details = (r.coverageProvenance as { details?: Array<{ id: string; outcome: string }> }).details!;
    const vidange = `${r.sourceUnitId}@${T.indexOf('120,00', T.indexOf('Vidange'))}`;
    expect(details.find((d) => d.id === vidange)?.outcome).toBe('UNRESOLVED');
    // Trois preuves (deux faits distincts à 120 €) → COVERED.
    const ok = apres(u, [lien(u, T, ['120.00'], ['plaquettes']), lien(u, T, ['120.00'], ['vidange']), lien(u, T, ['80.00'], ['main_oeuvre'])]);
    expect(etat(ok, 'Plaquettes')).toBe('COVERED/fact');
  });

  it('AC03 — même montant sur deux pages / deux rôles : la preuve unique ne couvre que l’occurrence démontrée', () => {
    const P1 = 'Loyer janvier 450,00 EUR';
    const P2 = 'Loyer fevrier 450,00 EUR';
    const u = unites(`${P1}\f\n${P2}`);
    const cov = apres(u, [lien(u, P1, ['450.00'], ['loyer_janvier'])]);
    expect(etat(cov, P1)).toBe('COVERED/fact');
    expect(unite(cov, P2).status).toBe('UNRESOLVED');
    // Même valeur, deux rôles dans le même passage : le fait « plafond » ne prouve pas la franchise.
    const T = 'Plafond 5 000,00 EUR ; franchise 5 000,00 EUR';
    const v = unites(T);
    const r = unite(apres(v, [lien(v, T, ['5000.00'], ['plafond'])]), 'Plafond');
    expect(`${r.status}/${r.reason}`).toBe('UNRESOLVED/values_partially_structured');
    expect(occ(r)).toMatchObject({ total: 2, structured: 1, unresolved: 1 });
  });

  it('AC04 — rappel du même fait : plausible seulement → INCERTAIN ; justifié par une décision de T1 → occurrences expliquées, UN fait ; segments chevauchants : aucun double compte ; ligne répétée : deux occurrences', () => {
    const T = 'Total TTC 120,00 EUR\nTotal TTC 120,00 EUR';
    const u = unites(T);
    const fait = [lien(u, 'Total TTC 120,00 EUR', ['120.00'], ['total_ttc'])];
    // Même valeur, même rôle : rappel PLAUSIBLE mais non démontré (avant : forme unique → COVERED/fact).
    const plausible = unite(apres(u, fait), 'Total');
    expect(`${plausible.status}/${plausible.reason}`).toBe('UNCERTAIN/occurrence_unverifiable');
    expect(occ(plausible)).toMatchObject({ total: 2, structured: 1, uncertain: 1 });
    // T1 déclare explicitement le rappel (décision sur l'occurrence) : deux occurrences expliquées, toujours UN seul fait.
    const id = u.find((x) => x.kind === 'TEXT_BLOCK')!.sourceUnitId;
    const justifie = apres(u, fait, { decisions: [{ ref: 'd1', sourceUnitId: id, kind: 'AMOUNT', normalizedValue: '12000', decision: 'STRUCTURED' }] });
    expect(etat(justifie, 'Total')).toBe('COVERED/fact');
    expect(occ(unite(apres(u, fait), 'Total'))!.total).toBe(2);
    // Même page relue par deux segments (recouvrement de lots) : une seule unité, une seule occurrence.
    const deuxSegments = buildSourceUnits({ segments: [
      { text: 'Vidange : 120,00 EUR', pageOffset: 0, origin: 'PASS_1' }, { text: 'Vidange : 120,00 EUR', pageOffset: 0, origin: 'CHUNK' },
    ] });
    expect(deuxSegments.filter((x) => x.kind === 'LABEL_VALUE')).toHaveLength(1);
    // Même ligne répétée DANS un segment : deux achats possibles, deux unités (avant : fusionnées — une occurrence perdue).
    const repetee = unites('Filtre : 12,00 EUR\nFiltre : 12,00 EUR');
    expect(repetee.filter((x) => x.kind === 'LABEL_VALUE')).toHaveLength(2);
    const covR = apres(repetee, [lien(repetee, 'Filtre : 12,00 EUR', ['12.00'], ['filtre'])]);
    // Un seul fait : une ligne couverte, l'autre jamais déclarée couverte par ce même fait.
    expect(covR.filter((x) => x.kind === 'LABEL_VALUE').map((x) => x.status)).toEqual(['COVERED', 'UNCERTAIN']);
  });
});

describe('C853-B — natures d’unités (AC05–AC08)', () => {
  it('AC05 — une seule valeur : fait générique → UNRESOLVED ; bonne valeur mais MAUVAIS rôle → non prouvée ; fait exact → COVERED', () => {
    const T = 'Acompte : 30,00 EUR';
    const u = unites(T);
    expect(etat(apres(u, [lien(u, T, ['facture'], ['type_document'])]), 'Acompte')).toBe('UNRESOLVED/values_partially_structured');
    // Avant : la valeur 30 € est « représentée » quel que soit le rôle du fait → COVERED/fact.
    expect(etat(apres(u, [lien(u, T, ['30.00'], ['remise'])]), 'Acompte')).toBe('UNRESOLVED/values_partially_structured');
    expect(etat(apres(u, [lien(u, T, ['30.00'], ['acompte'])]), 'Acompte')).toBe('COVERED/fact');
  });

  const tableAssurance = (opts: { franchiseHeader?: string | null; secondeFranchise?: boolean } = {}): ExtractedTable => {
    const h = opts.franchiseHeader === undefined ? 'Franchise' : opts.franchiseHeader;
    const cell = (row: number, column: number, columnHeader: string | null, value: string | null) => ({
      row, column, rowHeader: null, columnHeader, columnPath: [], value, normalized: null, valueType: null, colspan: 1, rowspan: 1, page: 1, confidence: 'certain' as const,
    });
    return {
      index: 0, title: 'Garanties', pageStart: 1, pageEnd: 1, columns: [{ header: 'Garantie', path: [] }, { header: 'Plafond', path: [] }, { header: h ?? '', path: [] }],
      rowCount: 2, columnCount: 3, confidence: 'certain', uncertain: false, issues: [],
      cells: [
        cell(0, 0, 'Garantie', 'Vol'), cell(0, 1, 'Plafond', '5 000,00 EUR'), cell(0, 2, 'Franchise', '250,00 EUR'),
        cell(1, 0, 'Garantie', 'Degat des eaux'), cell(1, 1, 'Plafond', '10 000,00 EUR'), cell(1, 2, h, opts.secondeFranchise === false ? null : '150,00 EUR'),
      ],
    };
  };

  it('AC06 — tableau assurance : toutes les cellules conservées avec leur rôle → COVERED sans fait par cellule ; franchise sans rôle → ligne et tableau NON RÉSOLUS', () => {
    const ok = apres(unites('', [tableAssurance()]), []);
    expect(ok.filter((x) => x.kind === 'TABLE_ROW').map((x) => `${x.status}/${x.reason}`)).toEqual(['COVERED/table', 'COVERED/table']);
    expect(ok.find((x) => x.kind === 'TABLE')!.status).toBe('COVERED');
    // Seconde franchise SANS en-tête (rôle perdu) ni preuve : avant → ligne COVERED/table et tableau couvert.
    const u = unites('', [tableAssurance({ franchiseHeader: null })]);
    const ko = apres(u, []);
    const ligne2 = ko.find((x) => x.sourceUnitId.endsWith(':row:2'))!;
    expect(`${ligne2.status}/${ligne2.reason}`).toBe('UNRESOLVED/values_partially_structured');
    expect(occ(ligne2)).toMatchObject({ total: 3, preserved: 2, unresolved: 1 });
    expect(ko.find((x) => x.sourceUnitId.endsWith(':row:1'))!.status).toBe('COVERED');
    expect(`${ko.find((x) => x.kind === 'TABLE')!.status}/${ko.find((x) => x.kind === 'TABLE')!.reason}`).toBe('UNRESOLVED/table_rows_unresolved');
    // Un fait rattaché à CETTE cellule la prouve : ligne et tableau couverts.
    const cellule = `${ligne2.sourceUnitId}:cell:3`;
    const prouve = apres(u, [{ excerpt: '150,00 EUR', page: 1, values: ['150.00'], labels: ['franchise'], unitIds: [cellule] }]);
    expect(prouve.find((x) => x.sourceUnitId.endsWith(':row:2'))!.status).toBe('COVERED');
    expect(prouve.find((x) => x.kind === 'TABLE')!.status).toBe('COVERED');
  });

  it('AC06 — cellule vide exclue avec motif ; deux lignes de même prix restent chacune prouvée par SA cellule', () => {
    const vide = apres(unites('', [tableAssurance({ secondeFranchise: false })]), []);
    const l2 = vide.find((x) => x.sourceUnitId.endsWith(':row:2'))!;
    expect(l2.status).toBe('COVERED');
    const t = tableAssurance();
    t.cells[1].value = '150,00 EUR'; // même prix sur les deux lignes (plafond ligne 1, franchise ligne 2)
    const memePrix = apres(unites('', [t]), []);
    expect(memePrix.filter((x) => x.kind === 'TABLE_ROW').every((x) => x.status === 'COVERED')).toBe(true);
  });

  it('AC07 — proposition sans nombre : fait générique seul → pas de couverture automatique ; passage fidèle conservé → COVERED ; décoratif → NON_INFORMATIONAL', () => {
    const T = 'L entretien annuel de la chaudiere doit etre realise par un professionnel qualifie.';
    const u = unites(T);
    const generique = [lien(u, T, ['chaudiere'], ['equipement'])];
    // Avant : aucune valeur significative → unité jamais contrôlée, COVERED/fact.
    expect(etat(apres(u, generique), 'L entretien')).toBe('UNCERTAIN/occurrence_unverifiable');
    // Page dont la transcription est vérifiée : le passage est conservé fidèlement dans la couche A → COVERED.
    expect(etat(apres(u, generique, { faithfulPage: (p) => p === 1 }), 'L entretien')).toBe('COVERED/fact');
    // Fait qui PORTE la proposition (valeur de même contenu) : COVERED même sans vérification de page.
    expect(etat(apres(u, [lien(u, T, ['entretien annuel de la chaudiere par un professionnel'], ['obligation_entretien'])]), 'L entretien')).toBe('COVERED/fact');
    // Décoratif : non informatif, motif démontré.
    const deco = avant(unites('- 2 -'), []);
    expect(`${deco[0].status}/${deco[0].reason}`).toBe('NON_INFORMATIONAL/pagination_or_decoration');
  });

  it('AC08 — candidat / métadonnée : preuve propre obligatoire ; ancrée ailleurs ou autre valeur → refus', () => {
    const T = 'Echeance : 15/04/2026';
    const u = unites(T);
    const id = u.find((x) => x.kind === 'LABEL_VALUE')!.sourceUnitId;
    const base = avant(u, []);
    const candidat = (unitIds: string[]) => ({ ref: 'op-1', source: 'CANDIDATE' as const, values: ['2026-04-15'], page: null, unitIds });
    expect(etat(apres(u, [], { values: [candidat([id])] }, base), 'Echeance')).toBe('COVERED/values_structured');
    expect(etat(apres(u, [], { values: [candidat(['page:9:field:1'])] }, base), 'Echeance')).toBe('UNRESOLVED/not_extracted');
    expect(etat(apres(u, [], { values: [{ ref: 'documentDate', source: 'METADATA', values: ['2026-03-01'], page: null }] }, base), 'Echeance')).toBe('UNRESOLVED/not_extracted');
    // FORM_FIELD : case cochée avec montant, sans preuve → non couverte.
    const f = unites('[x] Option assistance 0 km 45,00 EUR');
    expect(avant(f, []).find((x) => x.kind === 'FORM_FIELD')!.status).toBe('UNRESOLVED');
  });
});

describe('C853-C — preuves et décisions (AC09, AC10, AC12, AC14)', () => {
  const T = 'Vidange 120,00 EUR ; Plaquettes 120,00 EUR';
  const decision = (u: Units, decision: string) => ({
    ref: 'd1', sourceUnitId: u.find((x) => x.kind === 'TEXT_BLOCK')!.sourceUnitId, kind: 'AMOUNT', normalizedValue: '12000', decision,
  });

  it('AC09 — deux occurrences identiques, UNE décision STRUCTURED ancrée → l’autre reste non couverte', () => {
    const u = unites(T);
    const r = unite(apres(u, [], { decisions: [decision(u, 'STRUCTURED')] }), 'Vidange');
    // Avant : décision indexée par FORME → les deux occurrences « décidées » → COVERED/value_decision.
    expect(`${r.status}/${r.reason}`).toBe('UNRESOLVED/values_partially_structured');
    expect(occ(r)).toMatchObject({ total: 2, structured: 1, unresolved: 1 });
    // Décision ancrée à une AUTRE unité : aucun effet.
    const autre = { ...decision(u, 'STRUCTURED'), sourceUnitId: 'page:7:block:1' };
    expect(etat(apres(u, [], { decisions: [autre] }), 'Vidange')).toBe('UNRESOLVED/not_extracted');
  });

  it('AC10 — NOT_RETAINED valide sur l’unique occurrence → non-rétention séparée ; UNDETERMINED → INCERTAINE', () => {
    const S = 'Frais de dossier 15,00 EUR';
    const u = unites(S);
    const d = (x: string) => ({ ref: 'd1', sourceUnitId: u.find((y) => y.kind === 'TEXT_BLOCK')!.sourceUnitId, kind: 'AMOUNT', normalizedValue: '1500', decision: x });
    const nr = unite(apres(u, [], { decisions: [d('NOT_RETAINED')] }), 'Frais');
    expect(`${nr.status}/${nr.reason}`).toBe('COVERED/value_decision_not_retained');
    expect(occ(nr)).toMatchObject({ total: 1, notRetained: 1, structured: 0 });
    expect(etat(apres(u, [], { decisions: [d('UNDETERMINED')] }), 'Frais')).toBe('UNCERTAIN/value_undetermined');
  });

  it('AC12 — idempotence : la réconciliation rejouée sur sa propre sortie ne change rien', () => {
    const u = unites(T);
    const un = apres(u, [], { decisions: [decision(u, 'STRUCTURED')] });
    const deux = apres(u, [], { decisions: [decision(u, 'STRUCTURED')] }, un);
    expect(deux.map((x) => `${x.status}/${x.reason}`)).toEqual(un.map((x) => `${x.status}/${x.reason}`));
    expect(deux.map((x) => x.coverageProvenance?.previous ?? null)).toEqual(un.map((x) => x.coverageProvenance?.previous ?? null));
  });

  it('AC14 — faux COVERED historique (règle antérieure) : recalculé depuis son état d’origine, sans réanalyse ; vrai COVERED préservé', () => {
    const u = unites(T);
    const id = u.find((x) => x.kind === 'TEXT_BLOCK')!.sourceUnitId;
    // État stocké par l'ancienne règle : COVERED/value_decision, provenance d'origine UNRESOLVED/not_extracted.
    const historique = avant(u, []).map((x) => (x.sourceUnitId !== id ? x : {
      ...x, status: 'COVERED' as const, reason: 'value_decision',
      coverageProvenance: { rule: 'value_decision', sources: ['VALUE_DECISION' as const], refs: ['decision:db:1'], previous: { status: 'UNRESOLVED' as const, reason: 'not_extracted' }, values: { total: 1, represented: 1, notRetained: 0, undetermined: 0 }, stage: 'STORED' as const },
    }));
    const r = apres(u, [], { stage: 'STORED', decisions: [decision(u, 'STRUCTURED')] }, historique).find((x) => x.sourceUnitId === id)!;
    expect(`${r.status}/${r.reason}`).toBe('UNRESOLVED/values_partially_structured');
    expect(r.coverageProvenance?.previous).toEqual({ status: 'UNRESOLVED', reason: 'not_extracted' });
    // Vrai COVERED : deux décisions… impossibles sur une même valeur — deux FAITS rattachés de rôles distincts.
    const vrai = apres(u, [lien(u, T, ['120.00'], ['vidange']), lien(u, T, ['120.00'], ['plaquettes'])], { stage: 'STORED' });
    expect(etat(vrai, 'Vidange')).toBe('COVERED/fact');
  });
});
