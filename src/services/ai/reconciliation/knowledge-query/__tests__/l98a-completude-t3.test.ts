/**
 * Lot 98A (P0-A) — T3 KNOWLEDGE_QUERY doit rendre les constituants métier
 * UTILES, pas seulement la valeur directement exploitable. Cas réel : « Le
 * montant du prêt est de 490000,00 euros. La durée est égale à 22 ans » →
 * `duration` = 264 mois ET `repayment`. Avec la seule durée, le code ne peut
 * pas conclure que la date de fin est inutile : la carte reste ouverte.
 *
 *  L98A-A01  complétude : « durée seule » INCOMPLÈTE, « durée + remboursement » complète
 *  L98A-A02  décision permise (chaîne existante, sans IA) : durée seule → date toujours
 *            nécessaire ; durée + remboursement → NO_ACTION / UNDATED_NOT_NEEDED ;
 *            démarche de fin écrite → date nécessaire ; aucune date inventée
 *  L98A-A03  évaluateur du corpus (recette du prompt RÉELLEMENT actif) : P-T3-KQ-01 et
 *            P-T3-KQ-07 rejettent « durée seule », acceptent une réponse complète
 *            formulée autrement que la sortie enregistrée
 *  L98A-A04  qualification par couple (« Tester ce couple » au BO) : cas de RÉFÉRENCE
 *            obligatoires ; une réponse « durée seule » est un défaut OMISSION
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const contrat = await import('../contract');
const val = await import('../validate');
const svc = await import('../service');
const comp = await import('../completeness');
const { MASTER_CORPUS_EVALUATORS } = await import('@/services/ai/governance/master-corpus/evaluators');
const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
const { getRule } = await import('@/services/to-process/rules-catalog');

const BNP = 'Le montant du prêt est de 490000,00 euros. La durée est égale à 22 ans';
const norm = await svc.defaultNormalizers();
const question = await svc.buildKnowledgeQuestion(getRule('DATA-CONTRACT-END')!, 'contractEndDate');
const element = (ref: string, text: string): import('../contract').KnowledgeElement => ({
  ref, document: 'D0', fileId: 10, layer: 'SOURCE_UNIT', kind: 'TEXT_BLOCK', label: null, value: null, text, confidence: 'certain', page: 1,
});
const constat = (target: string, rawValue: string, excerpt: string, ref = 'U-1') =>
  ({ target, rawValue, value: null, evidenceRefs: [ref], excerpt, confidence: 'certain', meaning: 'test' });
const sortie = (findings: unknown[]) => contrat.T3KnowledgeQueryOutput.parse({ task: 'KNOWLEDGE_QUERY', outcome: 'CONSTITUENTS', findings, reason: 'test' });

const DUREE_SEULE = sortie([constat('duration', '22 ans', 'La durée est égale à 22 ans')]);
const COMPLETE = sortie([
  constat('duration', '22 ans', 'La durée est égale à 22 ans'),
  // Formulation différente de la sortie enregistrée du corpus : seule la présence du rôle compte.
  constat('repayment', 'Le montant du prêt est de 490000,00 euros', 'Le montant du prêt est de 490000,00 euros'),
]);
const valides = (out: import('../contract').T3KnowledgeQueryOutput, texte = BNP) => val.validateKnowledgeAnswer(out, question, [element('U-1', texte)], norm);
const ATTENDU = { required: ['duration', 'repayment'], values: { duration: '264' }, forbidden: ['FIELD'] };

describe('L98A-A01 — complétude d’une réponse techniquement valide', () => {
  it('« durée seule » : valide mais INCOMPLÈTE (remboursement manquant)', () => {
    const v = valides(DUREE_SEULE);
    expect(v.outcome).toBe('CONSTITUENTS');
    expect(v.rejected).toEqual([]);
    expect(comp.knowledgeCompleteness(v.findings, ATTENDU)).toEqual({ complete: false, missing: ['repayment'], forbiddenPresent: [], valueMismatches: [] });
  });
  it('« durée + remboursement » : complète, durée normalisée à 264 mois', () => {
    const v = valides(COMPLETE);
    expect(v.findings.map((f) => [f.target, f.normalized])).toEqual([['duration', '264'], ['repayment', null]]);
    expect(comp.knowledgeCompleteness(v.findings, ATTENDU).complete).toBe(true);
  });
  it('valeur attendue différente ou cible interdite : incomplète', () => {
    const v = valides(COMPLETE);
    expect(comp.knowledgeCompleteness(v.findings, { values: { duration: '240' } }).valueMismatches).toEqual([{ target: 'duration', expected: '240', obtained: ['264'] }]);
    expect(comp.knowledgeCompleteness(v.findings, { forbidden: ['repayment'] }).forbiddenPresent).toEqual(['repayment']);
  });
});

describe('L98A-A02 — décision permise par la réponse (chaîne déterministe existante)', () => {
  it('durée seule : la date de fin reste nécessaire (la carte resterait ouverte)', async () => {
    expect(await comp.endDateNeedOf(valides(DUREE_SEULE).findings, [element('U-1', BNP)])).toEqual({ repaymentSchedule: false, endActions: [], decision: 'DATE_STILL_NEEDED' });
  });
  it('durée + remboursement, aucune démarche de fin : NO_ACTION / UNDATED_NOT_NEEDED, aucune date inventée', async () => {
    const v = valides(COMPLETE);
    expect(v.findings.some((f) => f.target === 'FIELD')).toBe(false);
    expect(await comp.endDateNeedOf(v.findings, [element('U-1', BNP)])).toEqual({ repaymentSchedule: true, endActions: [], decision: 'NO_ACTION_UNDATED_NOT_NEEDED' });
  });
  it('démarche attachée à la fin écrite dans le contrat : la date reste nécessaire (jamais fermée à tort)', async () => {
    const texte = `${BNP}. Le contrat est renouvelé par tacite reconduction.`;
    const r = await comp.endDateNeedOf(valides(COMPLETE, texte).findings, [element('U-1', texte)]);
    expect(r.decision).toBe('DATE_STILL_NEEDED');
    expect(r.endActions).toHaveLength(1);
  });
});

describe('L98A-A03 — évaluateur du corpus : recette du prompt T3 réellement actif', () => {
  const CORPUS = loadMasterCorpusCases(readMasterFileFromRepo);
  const cas = (id: string) => { const c = CORPUS.find((x) => x.id === id); expect(c, id).toBeTruthy(); return c!; };
  const evaluer = (id: string, out: unknown) => MASTER_CORPUS_EVALUATORS.t3_knowledge_query(cas(id), out, { masterText: readMasterFileFromRepo });
  const refDe = (id: string) => ((cas(id).context as { knowledgeQuery: { elements: Array<{ ref: string; text: string }> } }).knowledgeQuery.elements[0]);

  it('P-T3-KQ-01 (cas réel) et P-T3-KQ-07 (générique) : réponses de référence, attendus de complétude', () => {
    for (const id of ['P-T3-KQ-01', 'P-T3-KQ-07']) {
      expect(cas(id).qualificationRole).toBe('answer');
      expect(cas(id).expected).toMatchObject({ outcome: 'CONSTITUENTS', required: ['duration', 'repayment'], forbidden: ['FIELD'], endDate: 'NO_ACTION_UNDATED_NOT_NEEDED' });
    }
  });

  it('la sortie enregistrée de chaque cas passe (corpus vert)', async () => {
    for (const id of ['P-T3-KQ-01', 'P-T3-KQ-02', 'P-T3-KQ-07']) expect(await evaluer(id, cas(id).output), id).toEqual([]);
  });

  it('« durée seule » ÉCHOUE (incomplète, date de fin toujours nécessaire)', async () => {
    const e1 = await evaluer('P-T3-KQ-01', DUREE_SEULE);
    expect(e1).toEqual(expect.arrayContaining([expect.stringMatching(/réponse incomplète : constituant\(s\) manquant\(s\) repayment/), expect.stringMatching(/DATE_STILL_NEEDED ≠ NO_ACTION_UNDATED_NOT_NEEDED/)]));
    const u = refDe('P-T3-KQ-07');
    const e7 = await evaluer('P-T3-KQ-07', sortie([constat('duration', '60 mois', 'Durée du financement : 60 mois', u.ref)]));
    expect(e7.join(' ; ')).toMatch(/manquant\(s\) repayment/);
  });

  it('« durée + remboursement » formulée autrement que l’enregistrement : ACCEPTÉE', async () => {
    expect(await evaluer('P-T3-KQ-01', COMPLETE)).toEqual([]);
    const u = refDe('P-T3-KQ-07');
    expect(await evaluer('P-T3-KQ-07', sortie([
      constat('repayment', 'Durée du financement : 60 mois', 'Durée du financement : 60 mois', u.ref),
      constat('duration', '60 mois', 'Durée du financement : 60 mois', u.ref),
    ]))).toEqual([]);
  });

  it('P-T3-KQ-02 (formulation anglaise) : la durée suffit, un remboursement en plus n’est pas une faute', async () => {
    const x = sortie([constat('duration', '22 years', 'Term: 22 years'), constat('repayment', 'Term: 22 years', 'Term: 22 years')]);
    expect(await evaluer('P-T3-KQ-02', x)).toEqual([]);
  });
});

describe('L98A-A04 — qualification par couple : cas de référence exécutables contre le prompt actif', () => {
  it('KQ-01 et KQ-07 obligatoires, jugés contre l’attendu ; « durée seule » = défaut OMISSION', async () => {
    const { buildCaseSet } = await import('@/services/ai/qualification/cases');
    const set = await buildCaseSet('t3_knowledge_query', { readMasterFile: readMasterFileFromRepo });
    for (const id of ['corpus:P-T3-KQ-01', 'corpus:P-T3-KQ-07']) {
      const c = set.cases.find((x) => x.caseId === id)!;
      expect(c, id).toMatchObject({ expectedSource: 'REFERENCE', mandatory: true, advisory: false });
      // Variables réelles de production (constructeur `knowledgeQueryVariables`) : contexte fermé, constituants offerts.
      expect((c.variables.CANDIDATES as Array<{ role: string }>).map((x) => x.role)).toContain('repayment');
    }
    const k1 = set.cases.find((x) => x.caseId === 'corpus:P-T3-KQ-01')!;
    const ko = await k1.evaluate(DUREE_SEULE, { masterText: readMasterFileFromRepo });
    expect(ko.defects.map((d) => d.category)).toContain('OMISSION');
    expect(await k1.evaluate(COMPLETE, { masterText: readMasterFileFromRepo })).toEqual({ defects: [], inconclusive: null });
  });
});
