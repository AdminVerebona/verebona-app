/**
 * Lot 111K — T2 : pertinence des preuves, suffisance, contradictions,
 * contrôle final commun, diagnostic (ticket §3, §6, §7).
 *
 *   U01  compréhension : propriété hors registre, tête, nature, règlement, période ;
 *   U02  adéquation : propriété voisine rejetée, nature, contexte (devis / réglé),
 *        période, valeur principale, incertitude ;
 *   U03  pluralité : informations distinctes, versions successives, concordance,
 *        conflit réel seulement (même information, même objet, contexte compatible) ;
 *   U04  suffisance calculée sur les seuls admissibles, sans seuil relevé ;
 *   U05  chemins T2 réels (`answerFromData`) : familles du §5.2 sur biens,
 *        documents et propriétés variés ; pas d'abstention injustifiée ;
 *   U06  contrôle final commun : règlement non prouvé, réserve parasite,
 *        nature, hors sujet, composite partielle, insuffisance ;
 *   U07  orchestrateur réel : génération hors sujet rejetée, réponse
 *        déterministe intacte, IA indisponible → repli sûr ; trace `pertinence` ;
 *   U08  diagnostic et journal « Questions sans réponse » (motifs 110E) ;
 *   U09  lecture canonique : montant ≠ règlement ; échéance de deux biens ≠ conflit.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { analyzeQuestionFocus, asksSettlement, sameRoot } = await import('../../question-focus');
const { assessFactCandidates, factValueNature, documentQualification } = await import('../../evidence-adequacy');
const { decideFacts, DEFAULT_THRESHOLDS } = await import('../../sufficiency');
const { answerFromData } = await import('../../data-answer.service');
const { controlFinalAnswer, affirmsSettlement, answerStatesConflict, FINAL_CONTROL_INSUFFICIENT_MESSAGE } = await import('../../final-answer-control');
const { startPertinenceTrace, concludePertinence } = await import('../../pertinence-trace');
const { classifyJournalRow } = await import('../../unanswered-journal');
const H = await import('../lot29/harness');
type Port = import('../../data-answer.service').AccountDataPort;
type FactHit = import('../../data-answer.service').FactHit;
type Claim = import('../../../types/sources').Claim;

let seq = 0;
function fait(o: Partial<FactHit>): FactHit {
  seq += 1;
  return {
    id: seq, fileId: 100 + seq, factKey: 'fact', subject: null, attribute: null, label: null, valueText: null, valueNumber: null, valueUnit: null,
    confidence: 'certain', excerpt: 'extrait', documentTitle: 'Document', matchedTerms: 1, canonicalKey: null, rawKey: null, valueType: null,
    targetType: null, targetEntityId: null, linkedToEntity: false, assetId: null, ...o,
  };
}
const eur = (n: number) => ({ valueNumber: n, valueUnit: 'EUR' });

const BIENS = [
  { id: 20, name: 'Polo', category: 'VEHICULE', subtype: null, purchaseDate: null, isRented: false, matched: 1 },
  { id: 30, name: 'Maison', category: 'IMMOBILIER', subtype: null, purchaseDate: null, isRented: false, matched: 1 },
  { id: 40, name: 'Appartement Lyon', category: 'IMMOBILIER', subtype: null, purchaseDate: null, isRented: false, matched: 1 },
];
function port(facts: FactHit[], over: Partial<Port> = {}): Port {
  return {
    today: () => '2026-11-05',
    findAssets: async (_a, w) => BIENS.filter((b) => b.name.toLowerCase().split(' ').some((x) => w.includes(x))),
    listAssets: async () => BIENS,
    countDocuments: async () => 0, countAgenda: async () => 0, upcomingAgenda: async () => [],
    sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }),
    searchFacts: async () => facts, searchDocuments: async () => [],
    ...over,
  };
}
const ask = (message: string, facts: FactHit[], extra: Record<string, unknown> = {}, over: Partial<Port> = {}) =>
  answerFromData({ port: port(facts, over), accountId: 1, message, thresholds: DEFAULT_THRESHOLDS, ...extra });

describe('L111K-U01 — ce que la question demande', () => {
  it('tête hors registre, termes de contexte, objet nommé écarté', () => {
    const f = analyzeQuestionFocus('Quelle est la franchise de l’assurance habitation de la Maison ?', { objectNames: ['Maison'] });
    expect(f.headTerm).toBe('franchise');
    expect(f.propertyTerms).toEqual(expect.arrayContaining(['franchise', 'assurance']));
    expect(f.propertyTerms).not.toContain('maison');
    expect(f.registryKeys).toEqual([]);
  });
  it('nature lue dans la forme de la question, pas dans un mot isolé', () => {
    expect(analyzeQuestionFocus('Quel est le prix de la révision ?').valueNature).toBe('AMOUNT');
    expect(analyzeQuestionFocus('Quand expire la garantie du lave-linge ?')).toMatchObject({ valueNature: 'DATE', dateRole: 'END', headTerm: 'garantie' });
    expect(analyzeQuestionFocus('Combien de chevaux fiscaux fait la Clio ?').valueNature).toBe('QUANTITY');
    expect(analyzeQuestionFocus('Jusqu’à quand le lave-linge est-il garanti ?')).toMatchObject({ valueNature: 'DATE', yesNo: false });
    // Contenant documentaire en tête : la valeur principale de la nature demandée.
    expect(analyzeQuestionFocus('Quel est le montant de la facture du plombier ?').headTerm).toBeNull();
  });
  it('« combien ai-je payé » = montant ; « est-ce réglé », « reste à payer », « preuve de paiement » = règlement', () => {
    expect(asksSettlement('Combien ai-je payé pour l’entretien de la Polo ?')).toBe(false);
    expect(asksSettlement('J’ai payé combien pour la Polo ?')).toBe(false);
    for (const q of ['La facture du garage a-t-elle été réglée ?', 'Ai-je déjà payé l’assurance ?', 'Reste-t-il à payer sur les travaux ?', 'Ai-je une preuve de paiement pour la révision ?', 'Est-ce que la révision est payée ?']) {
      expect(asksSettlement(q), q).toBe(true);
    }
    const f = analyzeQuestionFocus('Combien ai-je payé pour l’entretien de la Polo ?');
    expect(f).toMatchObject({ asksSettlement: false, valueNature: 'AMOUNT', qualification: null });
    expect(analyzeQuestionFocus('Quel était le montant prévu au devis de la toiture ?').qualification).toBe('FORECAST');
  });
  it('période et demande composite ; registre conservé', () => {
    const f = analyzeQuestionFocus('Quel était le loyer en 2024 ?', { today: '2026-11-05' });
    expect(f.period).toMatchObject({ from: '2024-01-01', to: '2024-12-31' });
    expect(analyzeQuestionFocus('Quand ai-je acheté le lave-vaisselle et quelle est sa garantie ?', { requestedFacts: ['acquisitionDate', 'warrantyEndDate'] }).composite).toBe(true);
    expect(analyzeQuestionFocus('x', { requestedFacts: ['serialNumber', 'cleInconnue'] }).registryKeys).toEqual(['serialNumber']);
  });
  it('racines : pluriel, -aux, une lettre d’écart sur un mot long', () => {
    expect(sameRoot('franchises', 'franchise')).toBe(true);
    expect(sameRoot('fiscaux', 'fiscal')).toBe(true);
    expect(sameRoot('achat', 'achete')).toBe(true);
    expect(sameRoot('prime', 'franchise')).toBe(false);
  });
});

describe('L111K-U02 — adéquation de chaque candidat (extraction ≠ pertinence)', () => {
  it('propriété voisine parfaitement extraite : rejetée (PROPERTY_MISMATCH), jamais retenue pour son mot ou son unité', () => {
    const focus = analyzeQuestionFocus('Quelle est la franchise de l’assurance habitation ?');
    const r = assessFactCandidates([
      fait({ subject: 'Assurance habitation', attribute: 'Prime annuelle', ...eur(480), confidence: 'certain' }),
      fait({ subject: 'Assurance habitation', attribute: 'Franchise', ...eur(300), confidence: 'probable' }),
    ], focus, { object: null, requestedFacts: [] });
    expect(r.assessed.map((a) => [a.verdict.decision, a.verdict.reason])).toEqual([['REJECTED', 'PROPERTY_MISMATCH'], ['KEPT', 'ACCOUNT_SCOPE']]);
    expect(r.assessed[0].dims).toMatchObject({ extraction: 'certain', property: 'NONE' });
  });
  it('nature : un montant ne répond pas à « quand », une durée pour une fin de garantie reste incertaine', () => {
    const focus = analyzeQuestionFocus('Quand se termine la garantie du téléviseur ?');
    const r = assessFactCandidates([
      fait({ subject: 'Téléviseur', attribute: 'Prix garantie étendue', ...eur(79) }),
      fait({ subject: 'Téléviseur', attribute: 'Garantie', valueNumber: 2, valueUnit: 'ans' }),
      fait({ subject: 'Téléviseur', attribute: 'Fin de garantie', valueText: '12/03/2027', valueType: 'date' }),
    ], focus, { object: null, requestedFacts: [] });
    expect(r.assessed.map((a) => a.verdict.decision)).toEqual(['UNCERTAIN', 'UNCERTAIN', 'KEPT']);
    expect(r.assessed.map((a) => a.verdict.reason).slice(0, 2)).toEqual(['VALUE_NATURE_MISMATCH', 'VALUE_NATURE_MISMATCH']);
    expect(factValueNature({ valueText: '1 250,00 €', valueNumber: null, valueUnit: null, valueType: null })).toBe('AMOUNT');
  });
  it('contexte documentaire : question de règlement → seules les preuves de paiement ; devis = prévu ; prévu/réalisé/réglé conservés', () => {
    const facts = [
      fait({ subject: 'Révision', attribute: 'Total TTC', ...eur(412), documentTypeCode: 'MAINTENANCE_INVOICE' }),
      fait({ subject: 'Révision', attribute: 'Montant prévu', ...eur(380), documentTypeCode: 'MAINTENANCE_QUOTE' }),
      fait({ subject: 'Révision', attribute: 'Montant réglé', ...eur(412), documentTypeCode: 'WORKS_PAYMENT_PROOF' }),
    ];
    expect(facts.map((f) => documentQualification(f))).toEqual(['DOCUMENTED', 'FORECAST', 'SETTLED']);
    const reglement = assessFactCandidates(facts, analyzeQuestionFocus('La révision a-t-elle été réglée ?'), { object: null, requestedFacts: [] });
    expect(reglement.selected.map((f) => f.attribute)).toEqual(['Montant réglé']);
    const cout = assessFactCandidates(facts, analyzeQuestionFocus('Combien a coûté la révision ?'), { object: null, requestedFacts: [] });
    expect(cout.selected.map((f) => f.attribute)).toEqual(['Total TTC']);
    expect(cout.assessed.find((a) => a.fact.attribute === 'Montant prévu')!.verdict.reason).toBe('OTHER_QUALIFICATION');
    const prevu = assessFactCandidates(facts, analyzeQuestionFocus('Quel était le montant prévu pour la révision ?'), { object: null, requestedFacts: [] });
    expect(prevu.selected.map((f) => f.attribute)).toEqual(['Montant prévu']);
  });
  it('période : hors bornes → PERIOD_MISMATCH ; date inconnue conservée', () => {
    const focus = analyzeQuestionFocus('Quel était le loyer en 2024 ?', { today: '2026-11-05' });
    const r = assessFactCandidates([
      fait({ attribute: 'Loyer mensuel', ...eur(750), documentDate: '2023-07-01', periodStart: '2023-07-01', periodEnd: '2024-06-30' }),
      fait({ attribute: 'Loyer mensuel', ...eur(780), documentDate: '2025-07-01', periodStart: '2025-07-01' }),
    ], focus, { object: null, requestedFacts: [] });
    expect(r.assessed.map((a) => a.verdict.reason)).toEqual(['ACCOUNT_SCOPE', 'PERIOD_MISMATCH']);
  });
  it('objet (101A) toujours prioritaire : un fait d’un autre équipement reste rejeté', () => {
    const r = assessFactCandidates([fait({ attribute: 'Capacité', valueNumber: 200, valueUnit: 'L', targetType: 'EQUIPMENT', targetEntityId: 9 })],
      analyzeQuestionFocus('Quelle est la capacité du ballon ?'), { object: { type: 'equipment', id: 8 }, requestedFacts: [] });
    expect(r.assessed[0].verdict).toMatchObject({ decision: 'REJECTED', reason: 'OTHER_OBJECT' });
  });
});

describe('L111K-U03 — pluralité : contradiction seulement si même information, même objet, contexte compatible', () => {
  const q = analyzeQuestionFocus('Quelle est la franchise de l’assurance ?');
  const ctx = { object: null, requestedFacts: [] };
  it('valeurs identiques de deux sources : CONCORDANT', () => {
    const r = assessFactCandidates([fait({ attribute: 'Franchise', ...eur(300), fileId: 1 }), fait({ attribute: 'Franchise', ...eur(300), fileId: 2 })], q, ctx);
    expect(r.plurality).toBe('CONCORDANT');
  });
  it('même information, dates distinctes : versions successives, la plus récente répond', () => {
    const r = assessFactCandidates([
      fait({ attribute: 'Franchise', ...eur(300), documentDate: '2024-01-10' }), fait({ attribute: 'Franchise', ...eur(350), documentDate: '2026-01-10' }),
    ], q, ctx);
    expect(r.plurality).toBe('SUCCESSIVE_VERSIONS');
    expect(r.selected.map((f) => f.valueNumber)).toEqual([350]);
    expect(r.assessed[0].verdict.reason).toBe('SUPERSEDED');
  });
  it('même information, même date (ou sans date) : CONFLIT RÉEL, aucune valeur choisie', () => {
    const r = assessFactCandidates([fait({ attribute: 'Franchise', ...eur(300) }), fait({ attribute: 'Franchise', ...eur(500) })], q, ctx);
    expect(r.plurality).toBe('REAL_CONFLICT');
    expect(r.groups[0].retained).toEqual([]);
  });
  it('informations différentes (franchise vol, franchise bris de glace) ou objets différents : jamais un conflit', () => {
    const r = assessFactCandidates([fait({ attribute: 'Franchise vol', ...eur(300) }), fait({ attribute: 'Franchise bris de glace', ...eur(150) })], q, ctx);
    expect(r.plurality).toBe('DIFFERENT_INFORMATION');
    const objets = assessFactCandidates([fait({ attribute: 'Franchise', ...eur(300), assetId: 20 }), fait({ attribute: 'Franchise', ...eur(500), assetId: 30 })], q, ctx);
    expect(objets.plurality).toBe('DIFFERENT_INFORMATION');
  });
});

describe('L111K-U04 — suffisance sur les seuls admissibles, seuils inchangés', () => {
  it('valeurs de même pertinence lexicale mais d’informations différentes : SUFFISANT, pas CONFLICTING', () => {
    const d = decideFacts([
      { comparable: '300|eur', confidence: 'certain', matchedTerms: 2, sourceKey: 'doc_1', infoKey: 'franchise vol|SCOPE|DOCUMENTED', coverage: 1 },
      { comparable: '150|eur', confidence: 'certain', matchedTerms: 2, sourceKey: 'doc_1', infoKey: 'franchise bris|SCOPE|DOCUMENTED', coverage: 1 },
    ], 2, DEFAULT_THRESHOLDS);
    expect(d).toMatchObject({ status: 'SUFFICIENT_RETRIEVAL', plurality: 'DIFFERENT_INFORMATION' });
  });
  it('confiance d’extraction et pertinence restent distinctes : « probable » × couverture partielle → insuffisant (seuil de gouvernance)', () => {
    const d = decideFacts([{ comparable: 'x', confidence: 'probable', matchedTerms: 1, sourceKey: 'doc_1', coverage: 0.5 }], 2, DEFAULT_THRESHOLDS);
    expect(d).toMatchObject({ status: 'INSUFFICIENT', reason: 'LOW_RELEVANCE', threshold: DEFAULT_THRESHOLDS.text });
  });
  it('aucun admissible : NO_RESULT ; conflit réel : CONFLICTING', () => {
    expect(decideFacts([], 1, DEFAULT_THRESHOLDS).reason).toBe('NO_RESULT');
    expect(decideFacts([
      { comparable: 'a', confidence: 'certain', matchedTerms: 1, sourceKey: 'doc_1', infoKey: 'k' }, { comparable: 'b', confidence: 'certain', matchedTerms: 1, sourceKey: 'doc_2', infoKey: 'k' },
    ], 1, DEFAULT_THRESHOLDS)).toMatchObject({ status: 'CONFLICTING', plurality: 'REAL_CONFLICT' });
  });
});

describe('L111K-U05 — chemins T2 réels (`answerFromData`), familles du §5.2', () => {
  it('réponse exacte dans une source (garantie d’un équipement) : restitution directe', async () => {
    const r = await ask('Quand se termine la garantie du lave-linge ?', [
      fait({ subject: 'Lave-linge', attribute: 'Fin de garantie', valueText: '14/03/2028', valueType: 'date', documentTitle: 'Facture Darty', matchedTerms: 2 }),
      fait({ subject: 'Lave-linge', attribute: 'Prix TTC', ...eur(549), documentTitle: 'Facture Darty', matchedTerms: 1 }),
    ]);
    expect(r).toMatchObject({ handled: true, strategy: 'retrieval.t1_fact' });
    expect(r.answer).toContain('14/03/2028');
    expect(r.answer).not.toContain('549');
    expect(r.pertinence).toMatchObject({ admissible: 1, plurality: 'SINGLE' });
  });
  it('information absente, données voisines présentes (préavis d’un contrat) : abstention, aucune valeur périphérique', async () => {
    const r = await ask('Quel est le délai de préavis du contrat d’entretien ?', [
      fait({ subject: 'Contrat d’entretien', attribute: 'Prix annuel', ...eur(189), matchedTerms: 2 }),
      fait({ subject: 'Contrat d’entretien', attribute: 'Date de début', valueText: '01/09/2025', valueType: 'date', matchedTerms: 2 }),
    ]);
    expect(r.handled).toBe(false);
    expect(r.contextSources.map((s) => s.content).join(' ')).not.toMatch(/189|2025/);
    expect(r.attempts.find((a) => a.strategy === 'retrieval.t1_fact')?.reason).toBe('NO_ADMISSIBLE_EVIDENCE');
  });
  it('sources concordantes (immatriculation + facture) : une réponse étayée par les deux', async () => {
    const r = await ask('Quelle est la puissance fiscale de la Polo ?', [
      fait({ fileId: 801, attribute: 'Puissance fiscale', valueNumber: 5, valueUnit: 'CV', assetId: 20, matchedTerms: 2 }),
      fait({ fileId: 802, attribute: 'Puissance fiscale', valueNumber: 5, valueUnit: 'CV', assetId: 20, matchedTerms: 2 }),
    ]);
    expect(r.handled).toBe(true);
    expect(r.sources.map((s) => s.id)).toEqual(['doc_801', 'doc_802']);
    expect(r.pertinence?.plurality).toBe('CONCORDANT');
  });
  it('valeurs réellement contradictoires (même information, même bien) : conflit signalé avec ses sources', async () => {
    const r = await ask('Quelle est la puissance fiscale de la Polo ?', [
      fait({ fileId: 811, attribute: 'Puissance fiscale', valueNumber: 5, valueUnit: 'CV', assetId: 20, documentTitle: 'Carte grise' }),
      fait({ fileId: 812, attribute: 'Puissance fiscale', valueNumber: 6, valueUnit: 'CV', assetId: 20, documentTitle: 'Facture' }),
    ]);
    expect(r.decision.status).toBe('CONFLICTING');
    expect(r.answer).toMatch(/deux valeurs différentes.*5\sCV.*6\sCV/);
    expect(r.sources).toHaveLength(2);
    expect(r.pertinence?.conflicts).toHaveLength(1);
  });
  it('valeurs historiques et actuelles (loyer, bail puis avenant) : la valeur actuelle avec sa date, sans liste', async () => {
    const r = await ask('Quel est le loyer de l’appartement Lyon ?', [
      fait({ fileId: 1101, attribute: 'Loyer mensuel', ...eur(750), assetId: 40, documentDate: '2023-07-01', matchedTerms: 2 }),
      fait({ fileId: 1102, attribute: 'Loyer mensuel', ...eur(780), assetId: 40, documentDate: '2025-07-01', matchedTerms: 2 }),
    ]);
    expect(r.handled).toBe(true);
    expect(r.answer).toMatch(/780/);
    expect(r.answer).not.toMatch(/750|valeurs différentes/);
    expect(r.answer).toContain('1 juillet 2025');
  });
  it('propriété hors registre (capacité) formulée autrement dans le document : retrouvée, pas d’abstention injustifiée', async () => {
    const r = await ask('Quelle est la capacité du ballon d’eau chaude ?', [
      fait({ subject: 'Chauffe-eau', label: 'Capacité', valueNumber: 200, valueUnit: 'L', matchedTerms: 1 }),
      fait({ subject: 'Chauffe-eau', label: 'Puissance', valueNumber: 2200, valueUnit: 'W', matchedTerms: 1 }),
    ]);
    expect(r.handled).toBe(true);
    expect(r.answer).toMatch(/200\sL/);
    expect(r.answer).not.toMatch(/2\s?200/);
  });
  it('question exprimée indirectement : correspondance incertaine → transmise à la seule validation sémantique bornée', async () => {
    const r = await ask('Jusqu’à quand suis-je couvert pour le vol de la moto ?', [
      fait({ subject: 'Assurance moto', attribute: 'Garantie vol — fin', valueText: '31/03/2027', valueType: 'date', matchedTerms: 2 }),
    ]);
    expect(r.handled).toBe(false);
    expect(r.contextSources.some((s) => /31\/03\/2027/.test(s.content))).toBe(true);
    expect(r.retrieval?.candidates[0]).toMatchObject({ decision: 'UNCERTAIN', reason: 'PROPERTY_UNCERTAIN' });
  });
  it('plusieurs montants d’une même facture (HT, TVA, TTC) : le total, aucun faux conflit', async () => {
    const r = await ask('Quel est le montant de la facture du plombier ?', [
      fait({ attribute: 'Total HT', ...eur(700), documentTitle: 'Facture plomberie Dupont', matchedTerms: 2 }),
      fait({ attribute: 'TVA 20 %', ...eur(140), documentTitle: 'Facture plomberie Dupont', matchedTerms: 2 }),
      fait({ attribute: 'Total TTC', ...eur(840), documentTitle: 'Facture plomberie Dupont', matchedTerms: 2 }),
    ]);
    expect(r.handled).toBe(true);
    expect(r.answer).toMatch(/840/);
    expect(r.answer).not.toMatch(/700|140|valeurs différentes/);
  });
});

const c = (claimKey: string, text: string, sourceIds: string[]): Claim => ({ claimKey, text, sourceIds, derivation: 'direct' });
const SOURCES = [
  { id: 'doc_1', type: 'document', title: 'Facture plomberie', content: 'Remplacement mitigeur · Total TTC : 840,00 €' },
  { id: 'doc_2', type: 'document', title: 'Virement', content: 'Preuve de paiement « Virement » · montant réglé : 840,00 €' },
  { id: 'doc_3', type: 'document', title: 'Facture chaudière', content: 'Chaudière gaz · Prix TTC : 2 450,00 € · Numéro de série : SN-88412' },
];

describe('L111K-U06 — contrôle final commun', () => {
  it('règlement affirmé sans preuve : rejeté (tous parcours) ; avec preuve : admis', () => {
    const f = analyzeQuestionFocus('Combien ai-je payé le plombier ?');
    const sans = controlFinalAnswer({ focus: f, path: 'deterministic', answer: 'x', claims: [c('a', 'Vous avez réglé 840,00 € au plombier.', ['doc_1'])], sources: SOURCES });
    expect(sans).toMatchObject({ verdict: 'REJECTED', answer: FINAL_CONTROL_INSUFFICIENT_MESSAGE });
    expect(sans.reasons).toContain('SETTLEMENT_UNPROVEN');
    const avec = controlFinalAnswer({ focus: f, path: 'generation', answer: 'x', claims: [c('a', 'Vous avez réglé 840,00 € au plombier.', ['doc_2'])], sources: SOURCES });
    expect(avec.verdict).toBe('PASS');
    expect(affirmsSettlement('Ce montant ne prouve pas qu’il a été réglé.')).toBe(false);
    expect(affirmsSettlement('La facture a été payée le 3 mars.')).toBe(true);
  });
  it('réserve parasite retirée, la réponse principale reste complète (pas « partielle »)', () => {
    const f = analyzeQuestionFocus('Quel est le montant de la facture du plombier ?');
    const r = controlFinalAnswer({ focus: f, path: 'generation', answer: '', rebuild: true, sources: SOURCES, claims: [
      c('a', 'La facture du plombier s’élève à 840,00 €.', ['doc_1']), c('b', 'Je n’ai trouvé aucune preuve de paiement pour cette facture.', ['doc_1']),
    ] });
    expect(r).toMatchObject({ verdict: 'PASS', answer: 'La facture du plombier s’élève à 840,00 €.' });
    expect(r.rejected).toEqual([{ claimKey: 'b', reason: 'PARASITIC_RESERVE' }]);
  });
  it('valeur correcte mais hors sujet (le prix pour un numéro de série) : rejet, insuffisance', () => {
    const f = analyzeQuestionFocus('Quel est le numéro de série de la chaudière ?', { requestedFacts: ['serialNumber'] });
    const r = controlFinalAnswer({ focus: f, path: 'generation', answer: '', rebuild: true, sources: SOURCES, claims: [c('a', 'La chaudière a coûté 2 450,00 €.', ['doc_3'])] });
    expect(r).toMatchObject({ verdict: 'REJECTED', reasons: ['OFF_TOPIC', 'NO_ADMISSIBLE_CLAIM'] });
    const bon = controlFinalAnswer({ focus: f, path: 'generation', answer: '', rebuild: true, sources: SOURCES, claims: [c('a', 'Le numéro de série de la chaudière est SN-88412.', ['doc_3'])] });
    expect(bon.verdict).toBe('PASS');
  });
  it('nature : un montant pour « quand ? » est rejeté', () => {
    const f = analyzeQuestionFocus('Quand a été posée la chaudière ?');
    const r = controlFinalAnswer({ focus: f, path: 'generation', answer: '', rebuild: true, sources: SOURCES, claims: [c('a', 'La chaudière posée a coûté 2 450,00 €.', ['doc_3'])] });
    expect(r.reasons).toContain('VALUE_NATURE_MISMATCH');
  });
  it('composite partiellement documentée : partielle explicite, le manque est dit sobrement', () => {
    const f = analyzeQuestionFocus('Quand ai-je acheté le lave-vaisselle et jusqu’à quand est-il garanti ?', { requestedFacts: ['acquisitionDate', 'warrantyEndDate'] });
    const r = controlFinalAnswer({ focus: f, path: 'generation', answer: '', rebuild: true, claims: [c('a', 'Vous avez acheté le lave-vaisselle le 2 février 2024.', ['doc_9'])],
      sources: [{ id: 'doc_9', type: 'document', content: 'Date d’achat : 02/02/2024' }] });
    expect(r).toMatchObject({ verdict: 'PARTIAL', missing: ['Fin de garantie'] });
    expect(r.answer).toMatch(/2 février 2024\. Information non trouvée dans vos documents : fin de garantie\.$/);
  });
  it('réponse déterministe correcte : inchangée ; sans question : rien d’autre que le règlement', () => {
    const f = analyzeQuestionFocus('Quelle est la franchise ?');
    expect(controlFinalAnswer({ focus: f, path: 'deterministic', answer: 'Franchise : 300 €.', claims: [c('fact', 'Franchise : 300 €.', ['doc_1'])], sources: SOURCES }).verdict).toBe('PASS');
    expect(controlFinalAnswer({ focus: null, path: 'generation', answer: '', claims: [c('a', 'Elle a été achetée le 3 mars 2020.', ['doc_1'])], sources: SOURCES }).verdict).toBe('PASS');
    expect(answerStatesConflict('J’ai trouvé deux valeurs différentes pour la franchise')).toBe(true);
  });
});

describe('L111K-U07 — orchestrateur réel : tous les parcours passent par le contrôle final', () => {
  const acc = H.account({ assets: [{ id: 30, name: 'Maison', category: 'IMMOBILIER' }] });
  const wire = (h: ReturnType<typeof H.harness>, facts: FactHit[]) => {
    h.ports.answerFromData = (route, input, thresholds) => answerFromData({
      port: port(facts), accountId: input.accountId, message: input.message, thresholds, intent: route.intent,
      requestedFacts: route.understanding?.requestedFacts ?? [], requestedTopics: route.understanding?.requestedTopics ?? [],
    });
  };
  const incertain = [fait({ fileId: 1601, subject: 'Chauffe-eau', attribute: 'Volume du ballon', valueText: '200 L', excerpt: 'Volume du ballon : 200 L · Prix : 600,00 €', documentTitle: 'Notice chauffe-eau', assetId: 30, matchedTerms: 1 })];

  it('génération (synthèse) qui affirme un règlement non démontré, chiffre présent dans la source : rejetée, insuffisance rendue, trace `pertinence` (QUALITY_ALERT)', async () => {
    const doc = { id: 'doc_1601', type: 'document' as const, title: 'Notice chauffe-eau', content: 'Volume du ballon : 200 L · Prix : 600,00 €', relevanceScore: 0.9, meta: { fileId: 1601 } };
    const h = H.harness(acc, { understand: H.understood('ACCOUNT_SUMMARY', []), retrieved: [doc] });
    h.generate.mockImplementation(async () => ({
      answer: 'Le ballon a été payé 600,00 €.', claims: [{ claimKey: 'c1', text: 'Le ballon a été payé 600,00 €.', sourceIds: ['doc_1601'], derivation: 'direct' }],
      actions: [], supportLevel: 'supported' as const, path: 'model',
    }));
    const r = await h.ask('Fais-moi une synthèse du chauffe-eau de la Maison');
    expect(h.generate).toHaveBeenCalled();
    expect(r.answer).toBe(FINAL_CONTROL_INSUFFICIENT_MESSAGE);
    expect(r.supportLevel).toBe('insufficient');
    expect(r.claims).toEqual([]);
    expect(r.cascade?.pertinence?.finalControl).toMatchObject({ verdict: 'REJECTED', path: 'generation', reasons: ['SETTLEMENT_UNPROVEN', 'NO_ADMISSIBLE_CLAIM'] });
    expect(r.cascade?.pertinence).toMatchObject({ outcome: 'INSUFFICIENT', cause: 'PRODUCTION_REJECTED', motive: 'QUALITY_ALERT' });
    expect(r.cascade?.escalationReasons.some((x) => x.startsWith('FINAL_CONTROL:REJECTED'))).toBe(true);
  });

  it('fait à correspondance incertaine, intention sans rédaction par le modèle : repli déterministe sûr (aucune valeur incertaine présentée)', async () => {
    const h = H.harness(acc, { understand: H.understood('ACCOUNT_FACT_ASSET', []) });
    wire(h, incertain);
    const r = await h.ask('Quelle est la capacité du ballon d’eau chaude de la Maison ?');
    expect(h.generate).not.toHaveBeenCalled();
    expect(r.answer).not.toMatch(/200|600/);
    expect(r.cascade?.pertinence).toMatchObject({ candidates: { uncertain: 1 }, outcome: 'INSUFFICIENT', cause: 'EVIDENCE_UNCERTAIN' });
  });

  it('IA indisponible (génération en échec) : repli sûr, aucune valeur voisine présentée comme réponse', async () => {
    const h = H.harness(acc, { understand: H.understood('ACCOUNT_FACT_ASSET', []) });
    wire(h, [fait({ subject: 'Assurance habitation', attribute: 'Prime annuelle', ...eur(480), assetId: 30, matchedTerms: 2 })]);
    h.generate.mockImplementation(async () => null);
    const r = await h.ask('Quelle est la franchise de l’assurance habitation de la Maison ?');
    expect(r.answer).not.toMatch(/480/);
    expect(r.cascade?.pertinence?.candidates).toMatchObject({ evaluated: 1, admissible: 0, rejected: 1, byReason: { PROPERTY_MISMATCH: 1 } });
    expect(r.cascade?.pertinence).toMatchObject({ outcome: 'INSUFFICIENT', cause: 'EVIDENCE_REJECTED', motive: 'ACCOUNT_DATA_INSUFFICIENT' });
  });

  it('réponse déterministe admissible : servie telle quelle, contrôle final PASS tracé', async () => {
    const h = H.harness(acc, { understand: H.understood('ACCOUNT_FACT_ASSET', []) });
    wire(h, [fait({ subject: 'Assurance habitation', attribute: 'Franchise', ...eur(300), assetId: 30, matchedTerms: 3 })]);
    const r = await h.ask('Quelle est la franchise de l’assurance habitation de la Maison ?');
    expect(r.answer).toMatch(/300/);
    expect(h.generate).not.toHaveBeenCalled();
    expect(r.cascade?.pertinence?.finalControl).toMatchObject({ verdict: 'PASS', path: 'deterministic' });
    expect(r.cascade?.pertinence).toMatchObject({ outcome: 'ANSWERED', motive: null, focus: { headTerm: 'franchise', valueNature: null } });
  });
});

describe('L111K-U08 — diagnostic : issue, cause, motif (vocabulaire du journal 110E)', () => {
  const focus = analyzeQuestionFocus('Quelle est la franchise ?');
  const base = (cands: Array<{ decision: 'KEPT' | 'REJECTED' | 'UNCERTAIN'; reason: string }>) => startPertinenceTrace({
    intent: 'ACCOUNT_FACT_ASSET', focus, scope: null, conflicts: [], sufficiency: { status: 'INSUFFICIENT', reason: 'NO_ADMISSIBLE_EVIDENCE', plurality: null },
    candidates: cands.map((x, i) => ({ factId: i, fileId: i, sourceObject: null, sourceProperty: [], score: 1, ...x })),
  });
  const fin = { supportLevel: null, sourceCount: 0, strategy: 'fallback.sources', answeredBy: 'fallback', clarification: false };
  it('absence de donnée, preuve rejetée, correspondance incertaine, conflit réel, défaut de production : causes distinctes', () => {
    expect(concludePertinence(base([]), fin)).toMatchObject({ cause: 'NO_DATA', motive: 'ACCOUNT_DATA_INSUFFICIENT' });
    expect(concludePertinence(base([{ decision: 'REJECTED', reason: 'PROPERTY_MISMATCH' }]), fin)).toMatchObject({ cause: 'EVIDENCE_REJECTED' });
    expect(concludePertinence(base([{ decision: 'UNCERTAIN', reason: 'PROPERTY_UNCERTAIN' }]), fin)).toMatchObject({ cause: 'EVIDENCE_UNCERTAIN' });
    expect(concludePertinence(base([]), { ...fin, supportLevel: 'conflicting', sourceCount: 2 })).toMatchObject({ outcome: 'CONFLICT', motive: 'CONTRADICTION_AMBIGUITY' });
    const rejet = { ...base([]), finalControl: { verdict: 'REJECTED', path: 'generation', reasons: ['OFF_TOPIC'], rejectedClaims: 1, missing: 0 } };
    expect(concludePertinence(rejet, { ...fin, supportLevel: 'insufficient' })).toMatchObject({ cause: 'PRODUCTION_REJECTED', motive: 'QUALITY_ALERT' });
    expect(base([{ decision: 'REJECTED', reason: 'PROPERTY_MISMATCH' }]).focus.headTerm).toBe('franchise');
  });
  it('journal « Questions sans réponse » : même ligne de trace, motif et cause lus dans `pertinence`, aucun journal concurrent', () => {
    const o = classifyJournalRow({
      request_id: 'r1', created_at: '2026-11-05T10:00:00Z', intent: 'ACCOUNT_FACT_ASSET', status: 'ok', error_code: null, state: 'READY', strategy: 'retrieval.t1_fact',
      source_count: 0, ref_outcome: null, fallback_reason: null, help_fallback_reason: null, help_article: null, help_corpus_version: null, resources: null,
      pertinence: { motive: 'ACCOUNT_DATA_INSUFFICIENT', cause: 'EVIDENCE_REJECTED', outcome: 'INSUFFICIENT' }, content: null,
    });
    expect(o).toMatchObject({ corpus: 'ACCOUNT', motive: 'ACCOUNT_DATA_INSUFFICIENT', fallbackReason: 'PERTINENCE:EVIDENCE_REJECTED' });
  });
});

describe('L111K-U09 — lecture canonique et agenda', () => {
  it('même échéance de deux biens : deux informations listées, jamais « deux valeurs différentes »', async () => {
    const rows = [
      { id: 1, title: 'Contrôle technique', date: '2027-03-03', assetNames: ['Polo'] },
      { id: 2, title: 'Contrôle technique', date: '2027-06-09', assetNames: ['Clio'] },
    ];
    const r = await ask('Quand expire le contrôle technique ?', [], {}, { upcomingAgenda: async () => rows });
    expect(r.strategy).toBe('structured.deadline_of');
    expect(r.answer).not.toMatch(/valeurs différentes/);
    expect(r.answer).toMatch(/Polo : 3 mars 2027 ; Clio : 9 juin 2027/);
  });
  it('même échéance du MÊME bien à deux dates : conflit conservé', async () => {
    const rows = [
      { id: 1, title: 'Contrôle technique', date: '2027-03-03', assetNames: ['Polo'] },
      { id: 2, title: 'Contrôle technique', date: '2027-06-09', assetNames: ['Polo'] },
    ];
    const r = await ask('Quand expire le contrôle technique ?', [], {}, { upcomingAgenda: async () => rows });
    expect(r.answer).toMatch(/deux valeurs différentes/);
  });
});

describe('L111K-U10 — corpus : oracles de pertinence rejoués sur les sorties enregistrées', () => {
  it('P-T2-08 corrigé et familles P-T2-10 à P-T2-23 : conformes ; l’ANCIENNE sortie de P-T2-08 (réserve de règlement) est détectée', async () => {
    const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { MASTER_CORPUS_EVALUATORS } = await import('@/services/ai/governance/master-corpus/evaluators');
    const cas = loadMasterCorpusCases(readMasterFileFromRepo).filter((x) => /^P-T2-(08|1\d|2[0-3])$/.test(x.id));
    expect(cas.map((x) => x.id).sort()).toEqual(['P-T2-08', ...Array.from({ length: 14 }, (_x, i) => `P-T2-${10 + i}`)]);
    const ctx = { masterText: readMasterFileFromRepo };
    for (const x of cas) expect(await MASTER_CORPUS_EVALUATORS.t2_answer(x, x.output, ctx), x.id).toEqual([]);
    const p08 = cas.find((x) => x.id === 'P-T2-08')!;
    const ancienne = { mode: 'ANSWER', format: 'claims', status: 'answered', claims: [
      { text: 'Je n’ai trouvé aucune preuve de paiement pour l’entretien de la Polo : le règlement n’est pas confirmé.', sourceIds: ['expenses:maintenance:20'], derivation: 'direct', factual: true },
      { text: 'Le coût documenté de l’intervention « Révision 60 000 km » est de 1 250,00 €.', sourceIds: ['doc_31'], derivation: 'direct', factual: true },
    ] };
    // La réserve parasite est retirée par le contrôle final : la réponse rendue reste conforme…
    expect(await MASTER_CORPUS_EVALUATORS.t2_answer(p08, ancienne, ctx)).toEqual([]);
    // …mais une sortie qui AFFIRME le règlement à partir du coût est rejetée (chiffres justes, conclusion fausse).
    const affirme = { ...ancienne, claims: [{ text: 'Vous avez payé 1 250,00 € pour l’entretien de la Polo.', sourceIds: ['doc_31'], derivation: 'direct', factual: true }] };
    expect((await MASTER_CORPUS_EVALUATORS.t2_answer(p08, affirme, ctx)).join(' ')).toMatch(/état de sortie insufficient|valeur attendue absente/);
    // Faux conflit sur des valeurs de nature différente : détecté par l'oracle `noFalseConflict`.
    const p15 = cas.find((x) => x.id === 'P-T2-15')!;
    const fauxConflit = { mode: 'ANSWER', format: 'claims', status: 'answered', claims: [
      { text: 'La facture indique deux valeurs différentes : 840,00 € et 700,00 €.', sourceIds: ['doc_1001'], derivation: 'direct', factual: true },
    ] };
    expect((await MASTER_CORPUS_EVALUATORS.t2_answer(p15, fauxConflit, ctx)).join(' ')).toMatch(/fausse contradiction/);
  });
});
