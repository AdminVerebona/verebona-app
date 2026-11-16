/**
 * Lot 115F (Trello #792) — CLÔTURE DES DIX ÉCARTS RÉSIDUELS DU LOT 114G.
 *
 * Un bloc par écart, numéroté comme la carte. Chaque test REPRODUIT d'abord le
 * défaut (état obtenu par le code d'avant, décrit dans le commentaire) puis
 * prouve la correction. Aucun appel à un fournisseur d'IA : la passe de
 * réparation reçoit son appel par injection (`call`).
 *
 *   É01 (P1-01)  couverture par valeur dès UNE valeur significative ;
 *   É02 (P1-02)  contrat du contrat de décision réellement utilisé par l'appel,
 *                candidats actifs fournis à la validation ;
 *   É03 (P1-03)  lien par identifiant d'unité cité, refus de l'ambiguïté,
 *                fallback d'ordre signalé ;
 *   É04 (P1-04)  une empreinte par fait (jamais la première de la clé) ;
 *   É05 (P2-05)  candidat ancré sur les unités de ses preuves stockées ;
 *   É06 (P2-06)  coordonnées de contact prouvées une par une, provenance typée ;
 *   É07 (P2-07)  voir `l114g-bo-et-schema.test.ts` (sondes de schéma simulées) ;
 *   É08 (P2-08)  « non réparable » : même règle que la sélection ;
 *   É09 (P2-09)  filtres provenance / règle, lecture complète des unités ;
 *   É10 (P2-10)  « connaissance conservée » seulement sur preuve relue.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoveredSourceUnit } from '../types';

/** Base simulée : sondes de schéma prêtes, unités servies par pages d'ordinal. */
const base = vi.hoisted(() => ({ unites: [] as Array<Record<string, unknown>>, lectures: [] as Array<{ after: number; limit: number }> }));
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: vi.fn(async (q: string, params: unknown[] = []) => {
      const x = q.replace(/\s+/g, ' ').trim();
      if (/to_regclass\('document_source_units'\)/.test(x)) return [{ a: true, b: true, c: true, d: true }];
      if (/information_schema\.columns/.test(x)) return [{ n: 5 }];
      if (/FROM document_source_units u/.test(x)) {
        const after = Number(params[6]);
        const limit = Number(params[7]);
        base.lectures.push({ after, limit });
        return base.unites.filter((u) => Number(u.ordinal) > after).slice(0, limit);
      }
      return [];
    }),
  },
  db: {},
}));

const { buildSourceUnits } = await import('../build-units');
const { computeCoverage, repairIneligibility, selectRepairUnits, SourceUnitLinker } = await import('../coverage');
const { candidateReconciliationValue, reconcileCoverage, residualPolicyOf } = await import('../coverage-reconciliation');
const { FactRefs, LocalLinks } = await import('../repair-identity');
const { runRepairPass } = await import('../repair');
const { repairDecisionContract } = await import('../../value-decisions/contract');
const { validateValueDecisions } = await import('../../value-decisions/validate');
const { pageCompletenessUnits } = await import('../completeness-detail');
const { loadAllDocumentSourceUnits } = await import('../repository');
const { knowledgeLossFamily, knowledgePreservedBy } = await import('../../../execution-report/t1-report');

type Units = ReturnType<typeof buildSourceUnits>;
const unites = (text: string) => buildSourceUnits({ segments: [{ text, pageOffset: 0, origin: 'PASS_1' }] });
const lien = (units: Units, excerpt: string, values: unknown[], labels: string[] = [], page: number | null = 1) => ({
  excerpt, page, values, labels, unitIds: new SourceUnitLinker(units).link({ excerpt, page, values: values as string[], labels }),
});
const avant = (units: Units, facts: Array<ReturnType<typeof lien>>) =>
  computeCoverage(units, { facts: facts.map((f) => ({ unitIds: f.unitIds, confidence: 'certain' as const, values: f.values as string[] })) });
const apres = (units: Units, facts: Array<ReturnType<typeof lien>>, extra: Partial<Parameters<typeof reconcileCoverage>[1]> = {}) =>
  reconcileCoverage(avant(units, facts), { stage: 'ANALYSIS', facts: facts.map((f, i) => ({ ref: `f${i}`, ...f })), ...extra });
const unite = (cov: ReturnType<typeof avant>, debut: string) => cov.find((u) => (u.text ?? '').startsWith(debut))!;
const etat = (cov: ReturnType<typeof avant>, debut: string) => { const u = unite(cov, debut); return `${u.status}/${u.reason}`; };

describe('L115F-É01 — P1-01 : une seule valeur suffit pour exiger une preuve', () => {
  // L'extrait du fait (« Acompte versé 30,00 € ») est CONTENU dans le bloc : le lien existe, mais le fait porte
  // une AUTRE valeur. Avant : `sig.length < 2` → unité laissée COVERED/fact (faux COUVERT).
  const BLOC = 'Acompte verse 30,00 EUR';

  it('défaut reproduit : un fait rattaché à l’unité mais d’une autre valeur → COVERED/fact par la seule couverture', () => {
    const u = unites(BLOC);
    expect(etat(avant(u, [lien(u, BLOC, ['999.00'], ['autre_montant'])]), 'Acompte')).toBe('COVERED/fact');
  });

  it('corrigé : la valeur unique non représentée rend l’unité NON RÉSOLUE, avec son décompte', () => {
    const u = unites(BLOC);
    const r = unite(apres(u, [lien(u, BLOC, ['999.00'], ['autre_montant'])]), 'Acompte');
    expect(`${r.status}/${r.reason}`).toBe('UNRESOLVED/values_partially_structured');
    expect(r.coverageProvenance).toMatchObject({
      rule: 'covered_unit_values_partially_structured', previous: { status: 'COVERED', reason: 'fact' },
      values: { total: 1, represented: 0, notRetained: 0, undetermined: 0 },
    });
  });

  it('cas conformes préservés : valeur représentée, et unité sans valeur exploitable', () => {
    const u = unites(BLOC);
    expect(etat(apres(u, [lien(u, BLOC, ['30.00'], ['acompte'])]), 'Acompte')).toBe('COVERED/fact');
    const sansValeur = unites('Merci de votre confiance et a bientot');
    const f = [lien(sansValeur, 'Merci de votre confiance et a bientot', ['x'], ['note'])];
    expect(etat(apres(sansValeur, f), 'Merci')).toBe('COVERED/fact');
  });

  it('même montant sur deux pages, occurrences DISTINCTES : la seconde n’est pas promue par la valeur seule', () => {
    const PAGE1 = 'Total TTC : 120,00 EUR';
    const PAGE2 = 'Acompte deja verse : 120,00 EUR';
    const u = unites(`${PAGE1}\f\n${PAGE2}`);
    const champs = u.filter((x) => x.kind === 'LABEL_VALUE');
    expect(champs.map((x) => x.page)).toEqual([1, 2]);
    // Le fait est prouvé par l'unité de la PAGE 1 seulement (lien explicite sur cette unité).
    const cov = apres(u, [{ excerpt: PAGE1, page: 1, values: ['120.00'], labels: ['total_ttc'], unitIds: [champs[0].sourceUnitId] }]);
    expect(etat(cov, PAGE1)).toBe('COVERED/fact');
    // Même valeur normalisée, AUTRE occurrence : aucune promotion croisée.
    const page2 = cov.find((x) => x.page === 2 && x.kind === 'LABEL_VALUE')!;
    expect(`${page2.status}/${page2.reason}`).toMatch(/^UNRESOLVED\//);
  });

  it('répétition LITTÉRALE d’une unité couverte : règle antérieure conservée, et sa provenance nomme l’unité jumelle', () => {
    const LIGNE = 'Total TTC : 120,00 EUR';
    const u = unites(`${LIGNE}\f\n${LIGNE}`);
    const champs = u.filter((x) => x.kind === 'LABEL_VALUE');
    const cov = apres(u, [{ excerpt: LIGNE, page: 1, values: ['120.00'], labels: ['total_ttc'], unitIds: [champs[0].sourceUnitId] }]);
    const page2 = cov.find((x) => x.page === 2 && x.kind === 'LABEL_VALUE')!;
    // Texte strictement identique d'une unité de même nature déjà COUVERTE : la valeur EST expliquée,
    // et le rattachement est ancré sur l'unité jumelle (jamais un rapprochement par valeur globale).
    expect(`${page2.status}/${page2.reason}`).toBe('COVERED/duplicate');
    expect(page2.coverageProvenance).toMatchObject({
      rule: 'duplicate_of_covered_unit', sources: ['UNIT'], refs: [`unit:${champs[0].sourceUnitId}`],
    });
  });

  it('ligne de tableau à plusieurs cellules : jamais dégradée par ce contrôle (règle métier des tableaux inchangée)', () => {
    const cellule = (column: number, columnHeader: string, value: string) => ({
      row: 0, column, rowHeader: null, columnHeader, columnPath: [columnHeader], value,
      normalized: value, valueType: null, colspan: 1, rowspan: 1, page: 1, confidence: 'certain' as const,
    });
    const u = buildSourceUnits({
      segments: [{ text: 'Detail des prestations', pageOffset: 0, origin: 'PASS_1' }],
      tables: [{
        index: 0, title: 'Prestations', pageStart: 1, pageEnd: 1,
        columns: [{ header: 'Prestation', path: ['prestation'] }, { header: 'Montant', path: ['montant'] }, { header: 'Quantite', path: ['quantite'] }],
        rowCount: 1, columnCount: 3,
        cells: [cellule(0, 'Prestation', 'Entretien'), cellule(1, 'Montant', '45,20 EUR'), cellule(2, 'Quantite', '2')],
        confidence: 'certain', uncertain: false, issues: [],
      }],
    });
    const ligne = u.find((x) => x.kind === 'TABLE_ROW')!;
    // Chaque cellule renseignée est confirmée par un fait : la ligne reste COUVERTE (contrôle par valeur non appliqué aux tableaux).
    const faits = [{ unitIds: [ligne.sourceUnitId], confidence: 'certain' as const, values: ['Entretien', '45.20', '2'] }];
    const cov = reconcileCoverage(computeCoverage(u, { facts: faits }), {
      stage: 'ANALYSIS', facts: [{ ref: 'f0', unitIds: [ligne.sourceUnitId], values: ['Entretien', '45.20', '2'], labels: [], excerpt: null, page: 1 }],
    });
    const apresReco = cov.find((x) => x.kind === 'TABLE_ROW')!;
    expect(apresReco.status).toBe('COVERED');
  });
});

describe('L115F-É02 — P1-02 : contrat de l’appel et candidats réellement persistés', () => {
  it('défaut reproduit puis corrigé : prompt publié depuis l’analyse — décisions plus écartées, version tracée', () => {
    // Avant : `cap.version !== promptVersion` → CONTRACT_NOT_CARRIED, alors que l'appel portait le contrat.
    const c = repairDecisionContract({ carried: true, version: 'v12' }, 'v11');
    expect(c).toEqual({ carried: true, promptVersion: 'v12', versionChanged: true });
    expect(repairDecisionContract({ carried: true, version: null }, 'v11')).toEqual({ carried: true, promptVersion: 'v11', versionChanged: false });
    // Contrat non porté : rien n'est persisté (règle conservée).
    expect(repairDecisionContract({ carried: false, version: 'v12' }, 'v12').carried).toBe(false);
  });

  it('défaut reproduit puis corrigé : décision rattachée à un candidat ACTIF du document', () => {
    const u = unites('Reference du devis : DEV-2026-0042');
    const cible = u.find((x) => x.kind === 'LABEL_VALUE')!;
    const decision = {
      value: 'DEV-2026-0042', kind: 'IDENTIFIER' as const, normalizedValue: 'DEV20260042', decision: 'COMPONENT_OR_CONTEXT' as const,
      reason: 'reference reprise par le devis rattache a cette prestation', sourceUnitId: cible.sourceUnitId,
      evidence: { excerpt: cible.text ?? undefined }, relatedFactRefs: [], relatedCandidateKeys: ['cand-1'],
      confidence: 'certain' as const, origin: 'PASS_1' as const,
    };
    // Clé citée mais ABSENTE des candidats actifs : lien INCONNU (distinct d'une décision sans aucun lien cité).
    const sansCandidats = validateValueDecisions([decision], { units: u, keptFactRefs: new Set(), candidateKeys: new Set() });
    expect(sansCandidats[0]).toMatchObject({ validity: 'INVALID', invalidReason: 'LINK_UNKNOWN', relatedCandidateKeys: [] });
    const sansLien = validateValueDecisions([{ ...decision, relatedCandidateKeys: [] }], { units: u, keptFactRefs: new Set(), candidateKeys: new Set(['cand-1']) });
    expect(sansLien[0]).toMatchObject({ validity: 'INVALID', invalidReason: 'LINK_MISSING' });
    const avecCandidats = validateValueDecisions([decision], { units: u, keptFactRefs: new Set(), candidateKeys: new Set(['cand-1']) });
    expect(avecCandidats[0]).toMatchObject({ validity: 'VALID', relatedCandidateKeys: ['cand-1'] });
  });
});

describe('L115F-É03 — P1-03 : liens locaux explicites, ambiguïté refusée, fallback signalé', () => {
  const PASSAGE = 'Montant restant du : 132,00 EUR';
  const zone = () => {
    const u = unites(`${PASSAGE}\f\n${PASSAGE}`).filter((x) => x.kind === 'LABEL_VALUE');
    expect(u).toHaveLength(2);
    return computeCoverage(u, { facts: [] });
  };
  const fait = (excerpt: string) => ({
    canonicalKey: null, rawKey: 'montant_restant', label: 'Montant restant du', attribute: null, subject: null,
    rawValue: '132,00 EUR', normalizedValue: '132.00', valueType: 'amount', unit: 'EUR', confidence: 'certain',
    provenance: 'TEXT_EXTRACTION', evidence: { excerpt }, target: { type: 'DOCUMENT' },
  });
  const passe = (excerpt: string, units: CoveredSourceUnit[]) => runRepairPass({
    input: { sourceType: 'file', sourceIds: [1], accountId: 1, userId: 1, mimeTypes: ['text/plain'], displayNames: ['doc'] } as never,
    groupIndices: [0], ctx: {} as never, capabilities: { rooms: true, equipments: true } as never, v2Families: [],
    units, maxCalls: 1, pass: 1,
    call: async () => ({ output: { facts: [fait(excerpt)], entities: { rooms: [], equipments: [] } } as never, valueDecisions: null }),
  });

  it('défaut reproduit puis corrigé : extrait présent dans DEUX unités ciblées → aucun lien local inventé, ambiguïté comptée', async () => {
    const u = zone();
    const r = await passe(PASSAGE, u);
    expect(r.facts).toHaveLength(1);
    expect(r.links.size).toBe(0);
    expect(r.linksAmbiguous).toBe(1);
    // Page jamais prise sur une unité choisie au hasard (les deux candidates sont sur des pages différentes).
    expect(r.facts[0].evidence.page).toBeUndefined();
  });

  it('corrigé : identifiant d’unité cité en tête de l’extrait → lien explicite et page de CETTE unité', async () => {
    const u = zone();
    const r = await passe(`[${u[1].sourceUnitId}]\n${PASSAGE}`, u);
    expect(r.linksByCitedId).toBe(1);
    expect(r.linksAmbiguous).toBe(0);
    expect([...r.links.values()]).toEqual([[u[1].sourceUnitId]]);
    expect(r.facts[0].evidence.page).toBe(u[1].page);
  });

  it('corrigé : appariement par ORDRE signalé (deux faits de même clé, unités différentes)', () => {
    const f = { rawKey: 'montant', rawValue: '132,00', evidence: { excerpt: PASSAGE } };
    const liens = new LocalLinks(new Map([[{ ...f }, ['page:1:field:1']], [{ ...f }, ['page:2:field:1']]]));
    expect(liens.takeDetailed(f)).toEqual({ ids: ['page:1:field:1'], ordered: true });
    expect(liens.takeDetailed(f)).toEqual({ ids: ['page:2:field:1'], ordered: true });
    // Même clé, MÊME unité : aucun fallback d'ordre à signaler.
    const stable = new LocalLinks(new Map([[{ ...f }, ['page:1:field:1']], [{ ...f, label: 'autre' }, ['page:1:field:1']]]));
    expect(stable.takeDetailed(f)?.ordered).toBe(false);
  });
});

describe('L115F-É04 — P1-04 : une empreinte par fait', () => {
  const faitA = { rawKey: 'montant', rawValue: '132,00', evidence: { excerpt: 'Montant : 132,00' }, t1FactRef: 'ref-A' };
  const faitB = { ...faitA, t1FactRef: 'ref-B' };

  it('défaut reproduit puis corrigé : deux faits de même clé de correspondance gardent CHACUN son empreinte', () => {
    const refs = new FactRefs([faitA, faitB]);
    expect(refs.take(faitA)).toBe('ref-A');
    expect(refs.take(faitB)).toBe('ref-B');
    // La dernière reste disponible (relecture du même fait).
    expect(refs.take(faitA)).toBe('ref-B');
  });

  it('fait sans empreinte : aucune invention', () => {
    expect(new FactRefs([{ rawKey: 'x', rawValue: '1', evidence: { excerpt: 'x' } }]).take({ rawKey: 'x', rawValue: '1', evidence: { excerpt: 'x' } })).toBeNull();
    expect(new FactRefs([]).size).toBe(0);
  });
});

describe('L115F-É05 — P2-05 : candidat ancré sur les unités de ses preuves', () => {
  const payload = (unitIds: string[]) => ({
    businessReferences: [{ value: 'DEV-2026-0042' }],
    financialHints: [{ amountMinor: 45020, evidence: { factId: 7, fingerprint: 'fp', sourceUnitIds: unitIds } }],
    evidence: [{ factId: 7, fingerprint: 'fp', sourceUnitIds: unitIds }],
  });

  it('les unités citées par les preuves stockées sont rendues (références réellement enregistrées)', () => {
    expect(candidateReconciliationValue('c1', payload(['page:1:field:2'])).unitIds).toEqual(['page:1:field:2']);
    expect(candidateReconciliationValue('c1', { evidence: 'x', financialHints: [{}] }).unitIds).toEqual([]);
  });

  it('corrigé : valeur portée par le candidat et ANCRÉE sur cette unité → couverte, provenance CANDIDATE', () => {
    const u = unites('Reference du devis : DEV-2026-0042');
    const cible = u.find((x) => x.kind === 'LABEL_VALUE')!;
    const r = unite(apres(u, [], { values: [candidateReconciliationValue('c1', payload([cible.sourceUnitId]))] }), 'Reference du devis');
    expect(`${r.status}/${r.reason}`).toBe('COVERED/values_structured');
    expect(r.coverageProvenance?.sources).toEqual(['CANDIDATE']);
    expect(r.coverageProvenance?.refs).toEqual(['candidate:c1']);
  });

  it('défaut reproduit puis corrigé : preuve du candidat ancrée AILLEURS → aucune couverture (page omise auparavant)', () => {
    const u = unites('Reference du devis : DEV-2026-0042\f\nAutre page sans reference');
    const cible = u.find((x) => x.kind === 'LABEL_VALUE')!;
    const r = unite(apres(u, [], { values: [candidateReconciliationValue('c1', payload(['page:9:field:9']))] }), 'Reference du devis');
    expect(r.sourceUnitId).toBe(cible.sourceUnitId);
    expect(`${r.status}/${r.reason}`).toMatch(/^UNRESOLVED\//);
  });
});

describe('L115F-É06 — P2-06 : coordonnées prouvées une par une, provenance typée', () => {
  const CONTACT = 'Contact : service.client@assureur-exemple.fr — 01 23 45 67 89';
  const depart = () => {
    const u = unites(`Assureur Exemple\n\n${CONTACT}`);
    return avant(u, [lien(u, CONTACT, ['Assureur Exemple'], ['emetteur'])]);
  };

  it('corrigé : chaque coordonnée rapportée à la donnée qui la porte — provenance et compteurs exacts', () => {
    const r = unite(reconcileCoverage(depart(), {
      stage: 'STORED',
      facts: [{ ref: 'db:1', unitIds: [], values: ['service.client@assureur-exemple.fr'], labels: ['contact.email'], excerpt: null, page: null }],
      values: [{ ref: 'supplier', source: 'METADATA', values: ['0123456789'], page: null }],
    }), 'Contact');
    expect(`${r.status}/${r.reason}`).toBe('COVERED/values_structured');
    expect(r.coverageProvenance).toMatchObject({
      rule: 'contact_values_structured', sources: ['FACT', 'METADATA'], refs: ['fact:db:1', 'meta:supplier'],
      values: { total: 2, represented: 2, notRetained: 0, undetermined: 0 },
    });
  });

  it('corrigé : une coordonnée non prouvée → NON RÉSOLUE, décompte exact et origine de ce qui est prouvé', () => {
    const r = unite(reconcileCoverage(depart(), {
      stage: 'STORED',
      facts: [{ ref: 'db:1', unitIds: [], values: ['service.client@assureur-exemple.fr'], labels: ['contact.email'], excerpt: null, page: null }],
    }), 'Contact');
    expect(`${r.status}/${r.reason}`).toBe('UNRESOLVED/values_not_structured');
    expect(r.coverageProvenance).toMatchObject({
      rule: 'contact_values_partially_structured', sources: ['FACT'], refs: ['fact:db:1'],
      values: { total: 2, represented: 1 },
    });
  });

  it('idempotente : rejouée sur sa propre sortie, même état et état d’origine conservé', () => {
    const entree = { stage: 'STORED' as const, facts: [{ ref: 'db:1', unitIds: [], values: ['service.client@assureur-exemple.fr'], labels: ['contact.email'], excerpt: null, page: null }] };
    const une = reconcileCoverage(depart(), entree);
    const deux = reconcileCoverage(une, entree);
    expect(unite(deux, 'Contact').coverageProvenance?.previous).toEqual({ status: 'UNRESOLVED', reason: 'values_not_structured' });
  });
});

describe('L115F-É08 — P2-08 : « non réparable », même règle que la sélection', () => {
  let n = 0;
  // Chaque cas porte son PROPRE identifiant : sans cela la comparaison sélection / politique
  // était faussée (tous les cas partageaient un identifiant retenu par le premier d'entre eux).
  const u = (over: Partial<CoveredSourceUnit>): CoveredSourceUnit => ({
    sourceUnitId: `page:1:block:${(n += 1)}`, kind: 'TEXT_BLOCK', page: 1, ordinal: n, parentUnitId: null,
    text: 'Solde restant du : 45,20 EUR', payload: {}, location: {}, origin: 'PASS_1', salient: true,
    status: 'UNRESOLVED', reason: 'not_extracted', factCount: 0, repairAttempts: 0, repairState: null, ...over,
  });

  it('la politique ne promet une reprise que si la sélection peut vraiment soumettre l’unité', () => {
    const attendus: Array<[CoveredSourceUnit, string | null]> = [
      [u({}), null],
      [u({ salient: false, reason: 'not_structured' }), 'NOT_SALIENT'],
      [u({ text: null }), 'NO_TEXT'],
      [u({ kind: 'VISUAL_OBSERVATION', status: 'UNCERTAIN', reason: 'observation_conflictual' }), 'KIND_NOT_REPAIRABLE'],
      [u({ status: 'FAILED', reason: 'repair_failed:final' }), 'FINAL_FAILURE'],
      [u({ status: 'FAILED', reason: 'repair_failed:retryable' }), null],
      [u({ coverageProvenance: { rule: 'covered_unit_values_partially_structured', sources: [], refs: [], previous: { status: 'COVERED', reason: 'fact' }, values: { total: 2, represented: 1, notRetained: 0, undetermined: 0 }, stage: 'STORED' } }), 'VALUE_DECISION_REVIEW'],
    ];
    const cas = attendus.map(([c]) => c);
    const retenues = new Set(selectRepairUnits(cas, 3).map((x) => x.sourceUnitId));
    for (const [c, motifAttendu] of attendus) {
      const motif = repairIneligibility(c);
      expect(motif).toBe(motifAttendu);
      // UNE SEULE règle : la sélection retient exactement les unités sans motif structurel.
      expect(retenues.has(c.sourceUnitId)).toBe(motif === null);
      // La politique résiduelle nomme le même motif — plus de « reprise ciblée possible » trompeuse.
      if (motif !== null && c.status === 'UNRESOLVED' && c.repairAttempts === 0) {
        expect(residualPolicyOf(c)).toBe(`REPAIR_NOT_ELIGIBLE:${motif}`);
      }
    }
    // Unité réellement éligible : « non tentée » subsiste, car une tentative est possible.
    expect(residualPolicyOf(cas[0])).toBe('REPAIR_NOT_ATTEMPTED');
    // Texte non structuré SANS valeur exploitable : règle antérieure conservée (préservation, pas un motif d'inéligibilité).
    expect(residualPolicyOf(u({ reason: 'not_structured', text: 'Merci de votre confiance', salient: false }))).toBe('PRESERVED_UNSTRUCTURED');
  });

  it('une tentative tracée ou un état de réparation restent prioritaires (règles conservées)', () => {
    expect(residualPolicyOf(u({ repairAttempts: 1, salient: false, reason: 'not_structured' }))).toBe('REPAIR_ATTEMPTED_NO_RESULT');
    expect(residualPolicyOf(u({ repairState: 'PENDING', salient: false, reason: 'not_structured' }))).toBe('REPAIR_PENDING');
  });
});

describe('L115F-É09 — P2-09 : filtres provenance / règle, et liste jamais tronquée en silence', () => {
  const ligne = (i: number, over: Record<string, unknown> = {}) => ({
    unitId: `page:1:block:${i}`, kind: 'TEXT_BLOCK', page: 1, status: 'UNRESOLVED', reason: 'not_extracted', factCount: 0,
    repairState: null, repairAttempts: 0, residualPolicy: 'REPAIR_NOT_ATTEMPTED', provenance: null, valueKinds: {}, textLength: 10, ...over,
  }) as Parameters<typeof pageCompletenessUnits>[0][number];
  const prov = (rule: string, sources: string[]) => ({ rule, sources, refs: [], previous: { status: 'UNRESOLVED', reason: 'not_extracted' }, stage: 'STORED' });

  it('corrigé : recherche par provenance (origine de la preuve) et par règle', () => {
    const rows = [
      ligne(1, { status: 'COVERED', reason: 'values_structured', provenance: prov('contact_values_structured', ['FACT', 'METADATA']) }),
      ligne(2, { status: 'COVERED', reason: 'values_structured', provenance: prov('values_structured', ['CANDIDATE']) }),
      ligne(3),
    ];
    expect(pageCompletenessUnits(rows, { all: true, provenance: 'CANDIDATE' }).units.map((r) => r.unitId)).toEqual(['page:1:block:2']);
    expect(pageCompletenessUnits(rows, { all: true, provenance: 'metadata' }).units.map((r) => r.unitId)).toEqual(['page:1:block:1']);
    expect(pageCompletenessUnits(rows, { all: true, rule: 'values_structured' }).units.map((r) => r.unitId)).toEqual(['page:1:block:2']);
    const combine = pageCompletenessUnits(rows, { all: true, provenance: 'FACT', status: 'COVERED' });
    expect(combine.units.map((r) => r.unitId)).toEqual(['page:1:block:1']);
    expect(combine.paging).toMatchObject({ listed: 3, matched: 1 });
  });

  it('défaut reproduit puis corrigé : au-delà d’une page de lecture, les unités suivantes ne sont plus perdues', async () => {
    base.unites = Array.from({ length: 25 }, (_, i) => ({ sourceUnitId: `page:1:block:${i + 1}`, ordinal: i + 1 }));
    base.lectures = [];
    const tout = await loadAllDocumentSourceUnits(1, { accountId: 1, pageSize: 10 });
    expect(tout).toHaveLength(25);
    expect(tout[24].sourceUnitId).toBe('page:1:block:25');
    // Pages successives sans trou ni répétition (dernier ordinal lu comme curseur).
    expect(base.lectures).toEqual([{ after: -1, limit: 10 }, { after: 10, limit: 10 }, { after: 20, limit: 10 }]);
  });
});

describe('L115F-É10 — P2-10 : « connaissance conservée » seulement sur preuve relue', () => {
  const relus = new Set(['surface_m2\u000175', 'montant_ttc\u0001120.00']);

  it('défaut reproduit puis corrigé : vrai sur preuve relue, faux sinon, inconnu si la relecture a échoué', () => {
    expect(knowledgePreservedBy(relus, ['surface_m2'], [75])).toBe(true);
    expect(knowledgePreservedBy(relus, ['surface_m2'], [80])).toBe(false);
    expect(knowledgePreservedBy(relus, [null, ''], [75])).toBe(false);
    expect(knowledgePreservedBy(null, ['surface_m2'], [75])).toBeNull();
  });

  it('famille de perte : jamais « conservée » sans preuve', () => {
    expect(knowledgeLossFamily(true, 'DELEGATED_OR_UNCHANGED_KNOWLEDGE_KEPT')).toBe('DELEGATED_OR_UNCHANGED_KNOWLEDGE_KEPT');
    expect(knowledgeLossFamily(false, 'DELEGATED_OR_UNCHANGED_KNOWLEDGE_KEPT')).toBe('KNOWLEDGE_NOT_FOUND_AFTER_REREAD');
    expect(knowledgeLossFamily(null, 'PROJECTION_ONLY_KNOWLEDGE_KEPT')).toBe('KNOWLEDGE_NOT_VERIFIABLE');
  });
});

describe('L115F-É10 — P2-10 : appels, échecs et coût ventilés par famille', () => {
  const unitesCiblees = () => computeCoverage(unites('Solde restant du : 45,20 EUR'), { facts: [] }).filter((x) => x.kind === 'LABEL_VALUE');
  const passe = (call: Parameters<typeof runRepairPass>[0]['call']) => runRepairPass({
    input: { sourceType: 'file', sourceIds: [1], accountId: 1, userId: 1, mimeTypes: ['text/plain'], displayNames: ['doc'] } as never,
    groupIndices: [0], ctx: {} as never, capabilities: { rooms: true, equipments: true } as never, v2Families: [],
    units: unitesCiblees(), maxCalls: 1, pass: 1, call,
  });
  const vide = { output: { facts: [], entities: { rooms: [], equipments: [] } } as never, valueDecisions: null };

  it('coût rendu par la passerelle : cumulé ; appel en échec : compté à part et coût laissé INCONNU', async () => {
    const avecCout = await passe(async () => ({ ...vide, res: { costMicros: 12_500 } }));
    expect(avecCout).toMatchObject({ calls: 1, callsFailed: 0, costMicros: 12_500, costUnknownCalls: 0 });

    // Coût non rendu : inconnu, JAMAIS zéro.
    const sansCout = await passe(async () => vide);
    expect(sansCout).toMatchObject({ calls: 1, callsFailed: 0, costMicros: 0, costUnknownCalls: 1 });

    // Appel en échec : l'appel est compté, l'échec aussi, le coût reste inconnu — et l'unité est en échec reprenable.
    const echec = await passe(async () => { throw new Error('fournisseur indisponible'); });
    expect(echec).toMatchObject({ calls: 1, callsFailed: 1, costMicros: 0, costUnknownCalls: 1 });
    expect([...echec.failed.values()][0]).toMatchObject({ retryable: true });
  });

  it('BO : un coût inconnu n’est jamais présenté comme nul, et « aucun appel » reste un coût nul établi', async () => {
    const { callCostText } = await import('@/app/admin/ai-executions/_components/T1CompletenessUnits');
    expect(callCostText({ calls: 0 })).toBe('aucun appel, aucun coût');
    expect(callCostText({ calls: 1, callsFailed: 0, costMicros: 0, costUnknownCalls: 1 })).toBe('1 appel(s), coût inconnu (1 appel(s))');
    expect(callCostText({ calls: 2, callsFailed: 1, costMicros: 12_500, costUnknownCalls: 1 }))
      .toBe('2 appel(s), 1 en échec, coût au moins 0.0125 (1 appel(s) au coût inconnu)');
    expect(callCostText({ calls: 1, callsFailed: 0, costMicros: 12_500, costUnknownCalls: 0 })).toBe('1 appel(s), coût 0.0125');
    // Diagnostic écrit avant ce lot : le coût est dit NON CONSIGNÉ, pas nul.
    expect(callCostText({ calls: 3 })).toBe('3 appel(s), coût non consigné');
  });

  it('BO : la reprise différée ventile le texte ciblé et la relecture du fichier', async () => {
    const { deferredRepairText } = await import('@/app/admin/ai-executions/_components/T1CompletenessUnits');
    const t = deferredRepairText({
      coverageRepair: null, retryAttempts: 1, lastRetryResult: 'REPAIRED_1',
      deferredRepair: { calls: 3, attemptedUnits: 2, newFacts: 1, textRepair: { calls: 2, callsFailed: 1, costMicros: 12_500, costUnknownCalls: 1 }, sourceReread: { calls: 1, callsFailed: 0 } },
      sourceReread: { runs: 1, failed: 0, resolved: 1 },
    });
    expect(t).toContain('3 appel(s) au total');
    expect(t).toContain('Texte ciblé : 2 appel(s), 1 en échec, coût au moins 0.0125 (1 appel(s) au coût inconnu).');
    expect(t).toContain('Relectures du fichier : 1 (1 unité(s) levée(s), 0 en échec).');
  });
});

describe('L115F-PO — étape 56 : bloc PO du guide, et code tolérant à son absence', () => {
  it('le bloc balisé existe, ne demande aucun champ nouveau, et n’est pas une règle métier', async () => {
    const { readFileSync } = await import('node:fs');
    const guide = readFileSync('docs/exploitation/prompts-a-appliquer-par-le-po.md', 'utf8');
    const m = /<!-- l89c:bloc ([^>]*?id="t1-repair-unit-citation-v1"[^>]*?) -->\s*\n```text\n([\s\S]*?)\n```/.exec(guide);
    expect(m, 'bloc t1-repair-unit-citation-v1 absent du guide').toBeTruthy();
    const texte = m![2];
    expect(texte).toContain('EXTRAIT CIBLÉ — contrat t1-repair-unit-citation-v1');
    // L'identifiant est recopié TEL QUEL, jamais composé ; aucune valeur, aucun champ nouveau.
    expect(texte).toContain('recopie cet identifiant TEL QUEL');
    expect(texte).not.toMatch(/\{\{|\}\}/);
  });

  it('absence du bloc : le code refuse l’ambiguïté au lieu d’inventer un lien (aucune dépendance au prompt)', async () => {
    // Même passage dans DEUX unités, extrait rendu SANS identifiant (prompt non modifié) :
    // aucun lien local, ambiguïté comptée — et la page du modèle n'est pas conservée.
    const u = unites(`${'Montant restant du : 132,00 EUR'}\f\n${'Montant restant du : 132,00 EUR'}`).filter((x) => x.kind === 'LABEL_VALUE');
    const r = await runRepairPass({
      input: { sourceType: 'file', sourceIds: [1], accountId: 1, userId: 1, mimeTypes: ['text/plain'], displayNames: ['doc'] } as never,
      groupIndices: [0], ctx: {} as never, capabilities: { rooms: true, equipments: true } as never, v2Families: [],
      units: computeCoverage(u, { facts: [] }), maxCalls: 1, pass: 1,
      call: async () => ({
        output: {
          facts: [{
            canonicalKey: null, rawKey: 'montant_restant', label: 'Montant restant du', attribute: null, subject: null,
            rawValue: '132,00 EUR', normalizedValue: '132.00', valueType: 'amount', unit: 'EUR', confidence: 'certain',
            // La page rendue par le modèle est celle de l'extrait transmis : elle ne doit pas trancher l'ambiguïté.
            provenance: 'TEXT_EXTRACTION', evidence: { excerpt: 'Montant restant du : 132,00 EUR', page: 1 }, target: { type: 'DOCUMENT' },
          }],
          entities: { rooms: [], equipments: [] },
        } as never,
        valueDecisions: null,
      }),
    });
    expect(r.linksAmbiguous).toBe(1);
    expect(r.links.size).toBe(0);
    expect(r.linksByCitedId).toBe(0);
    expect(r.facts[0].evidence.page).toBeUndefined();
  });
});

beforeEach(() => { base.lectures = []; });
