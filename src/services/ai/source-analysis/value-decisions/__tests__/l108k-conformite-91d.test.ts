/**
 * Lot 108K — correctifs de conformité du lot 91D (ticket #581 bis, §A à §E,
 * §4). Sans base — voir le scénario e2e `l108k-t1-conformite-91d.e2e.ts`.
 *
 *  L108K-U01  §A : motifs génériques / tautologiques / sans rapport rejetés (« non pertinent », « information
 *             secondaire », « déjà traité », recopie du libellé) ; exclusion précisément étayée acceptée ; rattachement
 *             technique sans relation cohérente refusé (STRUCTURED, COMPONENT_OR_CONTEXT) ; facture 120 € dont 34 € ;
 *  L108K-U02  §B : deux montants identiques sur deux lignes : le traitement d'un seul ne masque pas l'autre ; même
 *             total répété au même contexte : aucun doublon ; représentation non située ambiguë signalée ;
 *  L108K-U03  §C : présent / vide / absent / mal formé / tronqué ; contrat porté + absent → constat tracé et réexamen
 *             ciblé des valeurs omises ; `[]` cohérent valide ; ancien prompt / interrupteur : compatibles ;
 *  L108K-U04  §D : > 20 unités omises, > 60 unités et > 24 000 caractères : lots couvrant tout, progression, jamais
 *             « revu » à tort, raisons d'arrêt ;
 *  L108K-U05  §E : identifiants en tableau, texte libre et formulaire, avec preuve ; pas de faux positifs (codes
 *             accessoires, quantités, adresses, téléphones, dates, montants) ;
 *  L108K-U06  UNDETERMINED et conflictual jamais acquittés ; FACT_OMITTED_REPAIR_EXHAUSTED reste visible.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { T1AnalyzeDocumentTolerantOutput, splitNormalisation } = await import('../../master/tolerant-output');
const { anchorOperationCandidates } = await import('../../operation-candidates/prepare');
const { buildSourceUnits } = await import('../../source-units/build-units');
const text = await import('../../source-units/text');
const v = await import('../validate');
const oc = await import('../output-conformity');
const { planReviewBatches, reviewMaxBatchesPerPass, REVIEW_MAX_CHARS, REVIEW_MAX_UNITS } = await import('../review');
const ec = await import('@/services/coherence/registry/checks/extract-chain');
const { QUALIFICATION_LABELS } = await import('@/services/coherence/supervision');

type ExtractChainInput = import('@/services/coherence/registry/checks/extract-chain').ExtractChainInput;
type DecisionView = import('@/services/coherence/registry/checks/extract-chain').DecisionView;
type Prepared = import('../validate').PreparedValueDecision;

// ── Facture 120 € dont 34 € (valeurs neutres) ─────────────────────────────────
const FACTURE = ['Facture de maintenance', 'Date : 12/03/2026', 'Total TTC : 120,00 €', 'dont frais de dossier : 34,00 €', '', 'Paiement à réception. SARL au capital de 10 000 €'].join('\n');
const UNITES = buildSourceUnits({ segments: [{ text: FACTURE, pageOffset: 0, origin: 'PASS_1' }] });
const uniteDe = (us: typeof UNITES, morceau: string) => {
  const u = us.find((x) => (v.unitTextOf(x) ?? '').includes(morceau));
  if (!u) throw new Error(`unité introuvable : ${morceau}`);
  return u;
};
const fait = (excerpt: string, rawValue: string, normalizedValue: number | string, label = 'Total TTC') => ({
  canonicalKey: null, rawKey: label, label, rawValue, normalizedValue, valueType: 'money_eur', canonicalUnit: 'EUR',
  target: { type: 'DOCUMENT', entityId: null, confidence: 'certain' }, provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 },
});
const decision = (o: Record<string, unknown>) => ({
  value: '34,00 €', kind: 'AMOUNT', normalizedValue: '3400', decision: 'COMPONENT_OR_CONTEXT',
  reason: 'Frais de dossier déjà inclus dans le total TTC de 120,00 €.', sourceUnitId: null,
  evidence: { excerpt: 'dont frais de dossier : 34,00 €', page: 1 }, relatedFactIndexes: [0], relatedCandidateKeys: [], confidence: 'certain', ...o,
});
/** Chemin de production : lecture tolérante → empreintes → ancrage → validation AVEC contexte des faits. */
const valider = (decisions: unknown[], facts: unknown[] = [fait('Total TTC : 120,00 €', '120,00 €', 120)], units = UNITES) => {
  const { output, report } = splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse({ task: 'ANALYZE_DOCUMENT', document: {}, facts, valueDecisions: decisions }));
  anchorOperationCandidates(output, 'PASS_1');
  const anchored = v.anchorValueDecisions(output, 'PASS_1', report?.invalidValueDecisions ?? [])!;
  const kept = (output.facts as Array<{ t1FactRef?: string }>).filter((f) => f.t1FactRef) as never[];
  return v.validateValueDecisions(anchored, {
    units, keptFactRefs: new Set((kept as Array<{ t1FactRef: string }>).map((f) => f.t1FactRef)), candidateKeys: new Set(['op1']),
    facts: v.factContextOf(kept, units),
  });
};
const rejet = (o: Record<string, unknown>, facts?: unknown[]) => valider([decision(o)], facts)[0].invalidReason;

// ── Contrôle : entrée pure ────────────────────────────────────────────────────
const LUES = ['TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD', 'TABLE_ROW'];
const extractUnits = (us: typeof UNITES, status = 'COVERED') => us.filter((u) => LUES.includes(u.kind)).map((u) => ({
  unitId: u.sourceUnitId, kind: u.kind, ordinal: u.ordinal, text: v.unitTextOf(u), status, reason: 'fact', salient: true,
  repairAttempts: 0, repairState: null, retryable: null, updatedAt: '2026-11-03T08:00:00.000000',
}));
type Rep = import('@/services/coherence/registry/checks/extract-chain').ValueRep;
type RepIn = { units?: string[]; unlocatedFacts?: number; meta?: boolean };
const savoir = (reps: Record<string, RepIn> = {}, amounts: number[] = [], dates: string[] = []) => ({
  amounts: new Set(amounts), dates: new Set(dates), identifiers: new Set<string>(),
  reps: new Map<string, Rep>(Object.entries(reps).map(([k, r]) => [k, { units: new Set(r.units ?? []), unlocatedFacts: r.unlocatedFacts ?? 0, meta: r.meta ?? false }])),
});
type Prog = { fingerprint: string; status: string; outputStatus: string | null; attempts: number };
const entree = (o: Partial<ExtractChainInput> = {}): ExtractChainInput => ({
  fileId: 108, extractionId: 1080, coverage: { retryAttempts: 0, nextRetryAt: null, pagesMissing: [] }, units: extractUnits(UNITES),
  t1: savoir(), t1Unstructured: savoir(), projection: null, repairableUnitIds: new Set(), maxRetries: 2, pendingHashes: new Set(), triedHashes: new Set(), ...o,
});
const vues = (ps: Prepared[]): Map<string, DecisionView> => new Map(ps.filter((p) => p.sourceUnitId && p.kind && p.normalizedValue).map((p, i) => [
  v.valueKey(p.sourceUnitId!, p.kind!, p.normalizedValue!),
  { id: i + 1, decision: p.decision, validity: p.validity, invalidReason: p.invalidReason, confidence: p.confidence, unitFingerprint: p.unitFingerprint,
    linkActive: p.relatedFactRefs.length > 0 || p.relatedCandidateKeys.length > 0 },
]));
const omis = (i: { detail?: Record<string, unknown> }) => ((i.detail?.allOmissions ?? []) as Array<{ unit: string; values: Array<{ kind: string; value: string }> }>);

describe('L108K-U01 — §A : une justification générique n’acquitte pas une omission', () => {
  it('« non pertinent », « information secondaire », « déjà traité », recopie du libellé : REJETÉS (NOT_RETAINED et COMPONENT)', () => {
    const capital = { value: '10 000 €', normalizedValue: '1000000', decision: 'NOT_RETAINED', relatedFactIndexes: [], evidence: { excerpt: 'SARL au capital de 10 000 €', page: 1 } };
    for (const reason of ['Non pertinent pour ce document.', 'Information secondaire.', 'Déjà traité ailleurs.', 'Valeur non retenue, sans intérêt.']) {
      expect(rejet({ ...capital, reason }), reason).toBe('REASON_GENERIC');
      expect(rejet({ reason }), reason).toBe('REASON_GENERIC');
    }
    // Tautologie : le motif recopie les mots de l'unité sans rien expliquer.
    expect(rejet({ reason: 'Frais de dossier.' })).toBe('REASON_GENERIC');
    // Explication sans rapport démontrable avec l'unité, son voisinage ou un fait rattaché.
    expect(rejet({ ...capital, reason: 'Concerne une autre prestation du fournisseur habituel.' })).toBe('REASON_UNRELATED');
    // Le code ne contrôle que la forme : la même décision précisément étayée est acceptée.
    expect(rejet({ ...capital, reason: 'Capital social du prestataire : mention légale sans rapport avec la prestation facturée.' })).toBeNull();
  });

  it('facture 120 € TTC dont 34 € inclus : composante justifiée (rattachement cohérent au total), aucun fait ajouté', () => {
    const [d] = valider([decision({})]);
    expect(d).toMatchObject({ validity: 'VALID', decision: 'COMPONENT_OR_CONTEXT', normalizedValue: '3400' });
    const i = ec.diagnoseExtractChain(entree({
      t1: savoir({ 'AMOUNT:12000': { units: [uniteDe(UNITES, 'Total TTC').sourceUnitId] }, 'DATE:2026-03-12': { units: [uniteDe(UNITES, 'Date').sourceUnitId] } }, [12000], ['2026-03-12']),
      decisions: vues([d, ...valider([decision({ value: '10 000 €', normalizedValue: '1000000', decision: 'NOT_RETAINED', relatedFactIndexes: [], reason: 'Capital social du prestataire, mention légale.', evidence: { excerpt: 'SARL au capital de 10 000 €', page: 1 } })])]),
      decisionContract: 'CARRIED', fullDetail: true,
    }));
    expect(i.verdict).toBe('CONSISTENT');
    expect(i.detail).toMatchObject({ valueDecisions: { justified: 2 }, omissionTotals: { units: 0, values: 0, reconciliation: 'OCCURRENCE' } });
  });

  it('un simple lien technique vers un fait sans relation cohérente ne suffit pas', () => {
    // STRUCTURED rattaché à un fait qui ne porte PAS la valeur.
    expect(rejet({ decision: 'STRUCTURED', reason: 'Frais de dossier repris par le fait du total TTC facturé.' })).toBe('LINK_INCOHERENT');
    // COMPONENT rattaché à un fait éloigné (autre page, autre libellé) que le motif ne cite pas.
    const loin = [fait('Échéance assurance : 15/09/2026', '15/09/2026', '2026-09-15', 'Échéance assurance')];
    const doc = buildSourceUnits({ segments: [{ text: `${FACTURE}\n\n${Array.from({ length: 8 }, (_, k) => `Paragraphe neutre numéro ${k + 1}.\n\n`).join('')}Échéance assurance : 15/09/2026`, pageOffset: 0, origin: 'PASS_1' }] });
    expect(valider([decision({ reason: 'Frais de dossier inclus dans le règlement global.' })], loin, doc)[0].invalidReason).toBe('LINK_INCOHERENT');
    // Rattachement cohérent : le fait est voisin, ou le motif cite sa valeur.
    expect(valider([decision({})], undefined, doc)[0].invalidReason).toBeNull();
  });

  it('UNDETERMINED : motif contrôlé en présence seulement (jamais une justification)', () => {
    expect(rejet({ decision: 'UNDETERMINED', relatedFactIndexes: [], reason: 'Lecture incertaine du montant.' })).toBeNull();
  });
});

describe('L108K-U02 — §B : réconciliation par occurrence, pas par valeur', () => {
  const DEUX = ['Remplacement filtre : 120,00 €', 'Main-d’œuvre pose : 120,00 €', 'Total TTC : 240,00 €'].join('\n');
  const us = buildSourceUnits({ segments: [{ text: DEUX, pageOffset: 0, origin: 'PASS_1' }] });
  const filtre = uniteDe(us, 'filtre').sourceUnitId;
  const pose = uniteDe(us, 'pose').sourceUnitId;

  it('deux 120 € pour deux objets : traiter le premier ne masque pas l’omission du second', () => {
    const t1 = savoir({ 'AMOUNT:12000': { units: [filtre] }, 'AMOUNT:24000': { units: [uniteDe(us, 'Total').sourceUnitId], meta: true } }, [12000, 24000]);
    const i = ec.diagnoseExtractChain(entree({ units: extractUnits(us), t1, fullDetail: true }));
    expect(i.anomaly).toBe('FACT_OMITTED_COVERED_UNIT');
    expect(omis(i)).toEqual([expect.objectContaining({ unit: pose, values: [expect.objectContaining({ kind: 'AMOUNT', value: '12000' })] })]);
    // Historique (égalité de valeur à l'échelle du document) : l'omission était masquée.
    const ancien = { amounts: new Set([12000, 24000]), dates: new Set<string>(), identifiers: new Set<string>() };
    expect(ec.diagnoseExtractChain(entree({ units: extractUnits(us), t1: ancien })).verdict).toBe('CONSISTENT');
  });

  it('même total répété au même contexte (page 1 et récapitulatif) : aucun doublon artificiel', () => {
    const REP = ['Total TTC : 120,00 €', 'Conditions générales applicables.', '--- page 2 ---', 'Total TTC : 120,00 €'].join('\n');
    const ur = buildSourceUnits({ segments: [{ text: REP, pageOffset: 0, origin: 'PASS_1' }] });
    const totaux = ur.filter((u) => (v.unitTextOf(u) ?? '').includes('Total TTC'));
    expect(totaux.length).toBe(2);
    const i = ec.diagnoseExtractChain(entree({ units: extractUnits(ur), t1: savoir({ 'AMOUNT:12000': { units: [totaux[0].sourceUnitId] } }, [12000]) }));
    expect(i.verdict).toBe('CONSISTENT');
  });

  it('représentation non située : prudente pour un seul contexte, signalée (ambiguë) au-delà', () => {
    const unSeul = ec.diagnoseExtractChain(entree({ units: extractUnits(us).filter((u) => u.unitId !== pose), t1: savoir({ 'AMOUNT:12000': { unlocatedFacts: 1 }, 'AMOUNT:24000': { meta: true } }, [12000, 24000]) }));
    expect(unSeul.verdict).toBe('CONSISTENT');
    const deux = ec.diagnoseExtractChain(entree({ units: extractUnits(us), t1: savoir({ 'AMOUNT:12000': { unlocatedFacts: 1 }, 'AMOUNT:24000': { meta: true } }, [12000, 24000]) }));
    expect(deux.anomaly).toBe('FACT_OMITTED_COVERED_UNIT');
    expect(deux.detail).toMatchObject({ omissionTotals: { ambiguousRepresentation: 2 } });
  });

  it('situation d’un fait : provenance (cellule → ligne), sinon extrait retrouvé', () => {
    const eu = extractUnits(us);
    expect(ec.situerFait(['page:1:table:1:row:2:cell:3'], null, eu)).toEqual(['page:1:table:1:row:2']);
    expect(ec.situerFait(null, 'Main-d’œuvre pose : 120,00 €', eu)).toEqual([pose]);
    expect(ec.situerFait(null, '120 €', eu)).toEqual([]);
  });
});

describe('L108K-U03 — §C : sortie sans décisions ≠ sortie vide valide', () => {
  const lire = (brut: Record<string, unknown>, pruned: Array<{ path: string }> = []) => {
    const { output, report } = splitNormalisation(T1AnalyzeDocumentTolerantOutput.parse({ task: 'ANALYZE_DOCUMENT', document: {}, facts: [], ...brut }));
    return oc.valueDecisionsOutputStatus(output, report, pruned).status;
  };
  it('présent, vide, absent, mal formé, tronqué : jamais confondus', () => {
    expect(lire({})).toBe('ABSENT');
    expect(lire({ valueDecisions: [] })).toBe('EMPTY');
    expect(lire({ valueDecisions: [decision({})] })).toBe('PRESENT');
    expect(lire({ valueDecisions: 'aucune' })).toBe('MALFORMED');
    expect(lire({ valueDecisions: [] }, [{ path: '$.valueDecisions' }])).toBe('MALFORMED');
    expect(lire({ valueDecisions: Array.from({ length: 205 }, (_, k) => decision({ value: `${k + 1},00 €`, normalizedValue: null })) })).toBe('TRUNCATED');
  });

  it('constat : contrat porté et version concordante seulement ; ancien prompt / interrupteur : non évalué (compatible)', () => {
    const passes = [{ origin: 'PASS_1' as const, status: 'ABSENT' as const, decisions: 0, invalid: 0, truncated: 0 }];
    expect(oc.valueDecisionsOutputRecord({ contract: 'CARRIED', carried: true, effectiveVersion: 'v7', promptVersion: 'v7', passes })).toMatchObject({ status: 'ABSENT', conforming: false });
    expect(oc.valueDecisionsOutputRecord({ contract: 'MARKER_MISSING', carried: false, effectiveVersion: 'v6', promptVersion: 'v6', passes })).toMatchObject({ status: 'NOT_EVALUATED', conforming: true });
    expect(oc.valueDecisionsOutputRecord({ contract: 'DISABLED', carried: false, effectiveVersion: null, promptVersion: 'v7', passes })).toMatchObject({ status: 'NOT_EVALUATED', conforming: true });
    expect(oc.valueDecisionsOutputRecord({ contract: 'CARRIED', carried: true, effectiveVersion: 'v8', promptVersion: 'v7', passes })).toMatchObject({ status: 'NOT_EVALUATED', versionsMatch: false });
    expect(oc.valueDecisionsOutputRecord({ contract: 'CARRIED', carried: true, effectiveVersion: 'v7', promptVersion: 'v7', passes: [{ ...passes[0], status: 'EMPTY' }] })).toMatchObject({ status: 'EMPTY', conforming: true });
    // Lots de pages : le pire statut l'emporte.
    expect(oc.worstStatus([{ ...passes[0], status: 'PRESENT' }, { ...passes[0], status: 'ABSENT', origin: 'CHUNK' }])).toBe('ABSENT');
  });

  const sortie = (status: string, conforming: boolean) => ({ status, conforming, contract: 'CARRIED', promptVersion: 'v7', effectiveVersion: 'v7', versionsMatch: true, analysisRunId: 77, passes: 1 });
  const toutConnu = savoir({ 'AMOUNT:12000': { units: [uniteDe(UNITES, 'Total TTC').sourceUnitId] }, 'AMOUNT:3400': { units: [uniteDe(UNITES, '34,00').sourceUnitId] }, 'AMOUNT:1000000': { units: [uniteDe(UNITES, '10 000').sourceUnitId] }, 'DATE:2026-03-12': { units: [uniteDe(UNITES, 'Date').sourceUnitId] } }, [12000, 3400, 1000000], ['2026-03-12']);

  it('contrat porté + tableau absent : constat tracé avec provenance ; avec omissions : réexamen ciblé d’abord', () => {
    const seul = ec.diagnoseExtractChain(entree({ t1: toutConnu, decisions: new Map(), decisionContract: 'CARRIED', valueDecisionsOutput: sortie('ABSENT', false) }));
    expect(seul).toMatchObject({ verdict: 'FINDING', anomaly: 'T1_VALUE_DECISIONS_OUTPUT_MISSING', faultyLink: 'T1',
      observed: { status: 'ABSENT', extractionId: 1080, analysisRunId: 77, promptVersion: 'v7' },
      detail: expect.objectContaining({ qualification: 'OUTPUT_NONCONFORMITY', motive: 'OUTPUT_MISSING_NO_VALUE_TO_DECIDE' }) });
    expect(QUALIFICATION_LABELS.OUTPUT_NONCONFORMITY).toBeTruthy();
    const avecOmissions = ec.diagnoseExtractChain(entree({ decisions: new Map(), decisionContract: 'CARRIED', valueDecisionsOutput: sortie('ABSENT', false), reviewProgress: new Map() }));
    expect(avecOmissions).toMatchObject({ verdict: 'REPAIRABLE', detail: expect.objectContaining({ repair: 'DECISION_REVIEW', valueDecisionsOutput: expect.objectContaining({ status: 'ABSENT', conforming: false }) }) });
    expect((avecOmissions.detail!.diagnostics as Array<{ anomaly: string }>).map((d) => d.anomaly)).toContain('T1_VALUE_DECISIONS_OUTPUT_MISSING');
  });

  it('`[]` cohérent : valide (aucun constat) ; réexamen qui rend le tableau : récupéré ; qui l’omet encore : persistant', () => {
    expect(ec.diagnoseExtractChain(entree({ t1: toutConnu, decisions: new Map(), decisionContract: 'CARRIED', valueDecisionsOutput: sortie('EMPTY', true) })).verdict).toBe('CONSISTENT');
    const fp = (m: string) => v.unitFingerprint(v.unitTextOf(uniteDe(UNITES, m)))!;
    const recup = new Map([[uniteDe(UNITES, '34,00').sourceUnitId, { fingerprint: fp('34,00'), status: 'EXAMINED', outputStatus: 'PRESENT', attempts: 1 }]]);
    expect(ec.diagnoseExtractChain(entree({ t1: toutConnu, decisions: new Map(), decisionContract: 'CARRIED', valueDecisionsOutput: sortie('ABSENT', false), reviewProgress: recup })).verdict).toBe('CONSISTENT');
    const encore = new Map([[uniteDe(UNITES, '34,00').sourceUnitId, { fingerprint: fp('34,00'), status: 'EXAMINED', outputStatus: 'ABSENT', attempts: 1 }]]);
    expect(ec.diagnoseExtractChain(entree({ t1: toutConnu, decisions: new Map(), decisionContract: 'CARRIED', valueDecisionsOutput: sortie('ABSENT', false), reviewProgress: encore })).detail)
      .toMatchObject({ motive: 'OUTPUT_MISSING_PERSISTENT' });
    // Ancien prompt (contrat non porté) : aucun constat de sortie, constats d'avant.
    expect(ec.diagnoseExtractChain(entree({ t1: toutConnu, decisionContract: 'MARKER_MISSING', valueDecisionsOutput: sortie('ABSENT', false) })).verdict).toBe('CONSISTENT');
  });
});

describe('L108K-U04 — §D : toutes les unités au-delà des plafonds techniques', () => {
  it('> 60 unités et > 24 000 caractères : lots couvrant TOUTES les unités, unité géante seule, au-delà du plafond absolu en attente', () => {
    const units = [
      ...Array.from({ length: 130 }, (_, k) => ({ id: `u${k}`, chars: 150 })),
      { id: 'longue', chars: REVIEW_MAX_CHARS + 5_000 }, { id: 'geante', chars: 1_000_000 },
      ...Array.from({ length: 40 }, (_, k) => ({ id: `w${k}`, chars: 900 })),
    ];
    const p = planReviewBatches(units);
    const envoyees = p.batches.flat();
    expect(new Set([...envoyees, ...p.tooLarge]).size).toBe(units.length);
    expect(p.tooLarge).toEqual(['geante']);
    expect(p.batches.every((b) => b.length <= REVIEW_MAX_UNITS)).toBe(true);
    expect(p.batches.find((b) => b.includes('longue'))).toEqual(['longue']);
    expect(p.batches.length).toBeGreaterThanOrEqual(4);
    expect(reviewMaxBatchesPerPass({})).toBe(5);
    expect(reviewMaxBatchesPerPass({ COHERENCE_DECISION_REVIEW_BATCHES_MAX: '0' })).toBe(1);
  });

  // 75 lignes de montants distincts, unités couvertes, aucune décision.
  const LIGNES = Array.from({ length: 75 }, (_, k) => `Prestation ${String.fromCharCode(65 + (k % 26))}${k} : ${k + 1},50 €`).join('\n');
  const grandes = buildSourceUnits({ segments: [{ text: LIGNES, pageOffset: 0, origin: 'PASS_1' }] });
  const eu = extractUnits(grandes);

  it('> 20 unités omises : liste COMPLÈTE pour la reprise, totaux exacts, affichage borné déclaré', () => {
    const i = ec.diagnoseExtractChain(entree({ units: eu, decisions: new Map(), decisionContract: 'CARRIED', reviewProgress: new Map() }));
    expect(i.verdict).toBe('REPAIRABLE');
    expect((i.detail!.reviewUnits as string[]).length).toBe(eu.length);
    expect((i.observed as unknown[]).length).toBe(20);
    expect(i.detail).toMatchObject({ omissionTotals: { units: eu.length, values: eu.length, displayedUnits: 20, truncatedDisplay: true }, review: { units: eu.length, examined: 0, remaining: eu.length } });
  });

  it('progression : examinées retirées, reste demandé (en cours) ; jamais « revu » avec des unités en attente', () => {
    const prog = new Map<string, Prog>(eu.slice(0, 60).map((u): [string, Prog] => [u.unitId, { fingerprint: v.unitFingerprint(u.text)!, status: 'EXAMINED', outputStatus: 'PRESENT', attempts: 1 }]));
    const i = ec.diagnoseExtractChain(entree({ units: eu, decisions: new Map(), decisionContract: 'CARRIED', reviewProgress: prog, reviewAttempts: 1 }));
    expect(i).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'FACT_DECISION_REVIEW_IN_PROGRESS', detail: expect.objectContaining({ omissionAnomaly: 'FACT_OMITTED_COVERED_UNIT', review: expect.objectContaining({ examined: 60, remaining: eu.length - 60, attempts: 1 }) }) });
    expect((i.detail!.reviewUnits as string[])).toEqual(eu.slice(60).map((u) => u.unitId));
    // Une unité trop grande : réexamen INCOMPLET (raison d'arrêt), jamais DONE.
    const bloque = new Map<string, Prog>([...prog, ...eu.slice(60).map((u, k): [string, Prog] => [u.unitId, { fingerprint: v.unitFingerprint(u.text)!, status: k === 0 ? 'TOO_LARGE' : 'EXAMINED', outputStatus: k === 0 ? null : 'PRESENT', attempts: 1 }])]);
    const f = ec.diagnoseExtractChain(entree({ units: eu, decisions: new Map(), decisionContract: 'CARRIED', reviewProgress: bloque }));
    expect(f).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_COVERED_UNIT', detail: expect.objectContaining({ motive: 'REVIEW_INCOMPLETE', decisionReview: 'PARTIAL', review: expect.objectContaining({ blocked: 1, stopReasons: ['UNIT_TOO_LARGE'] }) }) });
    // Toutes examinées : revu (TRIED), omissions toujours signalées et qualifiées.
    const tout = new Map(eu.map((u) => [u.unitId, { fingerprint: v.unitFingerprint(u.text)!, status: 'EXAMINED', outputStatus: 'PRESENT', attempts: 1 }]));
    expect(ec.diagnoseExtractChain(entree({ units: eu, decisions: new Map(), decisionContract: 'CARRIED', reviewProgress: tout })).detail)
      .toMatchObject({ motive: 'NO_VALID_DECISION_AFTER_REVIEW', decisionReview: 'TRIED' });
    // Unité réécrite (nouvelle extraction) : à réexaminer.
    const reecrite = new Map([...tout].map(([k, r]) => [k, { ...r, fingerprint: 'ancienne' }]));
    expect(ec.diagnoseExtractChain(entree({ units: eu, decisions: new Map(), decisionContract: 'CARRIED', reviewProgress: reecrite })).verdict).toBe('REPAIRABLE');
  });
});

describe('L108K-U05 — §E : identifiants significatifs hors couples libellé / valeur', () => {
  it('tableau, texte libre, formulaire : identifiant désigné retrouvé, libellé conservé', () => {
    expect(text.cueIdentifiers('Désignation : Lave-linge | N° de série : SN-4471-AB90 | Qté : 1')).toEqual([expect.objectContaining({ normalized: 'SN4471AB90', context: expect.stringMatching(/s[ée]rie/) })]);
    expect(text.cueIdentifiers('Nous vous adressons la facture n° 2026001234 du 12/03/2026 relative à l’entretien.').map((x) => x.normalized)).toEqual(['2026001234']);
    expect(text.cueIdentifiers('☑ Contrat n° CT-889911 résilié').map((x) => x.normalized)).toEqual(['CT889911']);
    expect(text.cueIdentifiers('VIN : WVWZZZ1JZXW000001').map((x) => x.normalized)).toEqual(['WVWZZZ1JZXW000001']);
    expect(text.cueIdentifiers('IMEI 356938035643809').map((x) => x.normalized)).toEqual(['356938035643809']);
  });

  it('aucun faux positif : codes accessoires, quantités, adresses, téléphones, dates, montants, mots', () => {
    for (const t of ['Réf. article AB1234X | Qté : 12', 'Poids 12KG, tension 220V50HZ', '12 rue des Lilas 75001 Paris', 'Tél. client 01 23 45 67 89',
      'Facture du 12/03/2026', 'Contrat d’entretien annuel', 'Commande 3 articles', 'Facture 120,00 €', 'Code promo NOEL2026']) {
      expect(text.cueIdentifiers(t), t).toEqual([]);
    }
    expect(text.unitSignificantValues('Réf. article AB1234X', 'TABLE_ROW')).toEqual([]);
    // Couple libellé / valeur : comportement d'avant (tout jeton lettres + chiffres).
    expect(text.unitSignificantValues('Réf. article : AB1234X', 'LABEL_VALUE').map((x) => x.normalized)).toEqual(['AB1234X']);
  });

  it('contrôle : identifiant omis en texte libre détecté ; repris par T1 (même unité) : connu ; décision T1 validée sur cette valeur', () => {
    const t = 'Nous vous adressons la facture n° 2026001234 relative à l’entretien de la chaudière.';
    const us = buildSourceUnits({ segments: [{ text: t, pageOffset: 0, origin: 'PASS_1' }] });
    const eu = extractUnits(us);
    expect(eu[0].kind).toBe('TEXT_BLOCK');
    const i = ec.diagnoseExtractChain(entree({ units: eu, fullDetail: true }));
    expect(omis(i)).toEqual([expect.objectContaining({ unit: eu[0].unitId, values: [expect.objectContaining({ kind: 'IDENTIFIER' })] })]);
    expect(ec.diagnoseExtractChain(entree({ units: eu, t1: savoir({ 'IDENTIFIER:2026001234': { units: [eu[0].unitId] } }) })).verdict).toBe('CONSISTENT');
    const [d] = valider([decision({ value: '2026001234', kind: 'IDENTIFIER', normalizedValue: null, decision: 'NOT_RETAINED', relatedFactIndexes: [], evidence: { excerpt: 'facture n° 2026001234' },
      reason: 'Numéro de la facture elle-même : référence administrative, déjà portée par le titre du document entretien chaudière.' })], [], us);
    expect(d).toMatchObject({ validity: 'VALID', normalizedValue: '2026001234' });
  });
});

describe('L108K-U06 — incertitudes et reprises épuisées jamais acquittées', () => {
  it('UNDETERMINED / conflictual → FACT_DECISION_UNDETERMINED ; reprise épuisée → FACT_OMITTED_REPAIR_EXHAUSTED visible', () => {
    const toutConnu = savoir({ 'AMOUNT:12000': { units: [uniteDe(UNITES, 'Total TTC').sourceUnitId] }, 'AMOUNT:1000000': { units: [uniteDe(UNITES, '10 000').sourceUnitId] }, 'DATE:2026-03-12': { units: [uniteDe(UNITES, 'Date').sourceUnitId] } }, [12000, 1000000], ['2026-03-12']);
    for (const o of [{ decision: 'UNDETERMINED', relatedFactIndexes: [], reason: 'Lecture incertaine du montant des frais.' }, { confidence: 'conflictual' }]) {
      const i = ec.diagnoseExtractChain(entree({ t1: toutConnu, decisions: vues(valider([decision(o)])), decisionContract: 'CARRIED' }));
      expect(i).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_DECISION_UNDETERMINED' });
    }
    const us = extractUnits(UNITES, 'UNRESOLVED');
    const tout = new Map(us.map((u) => [u.unitId, { fingerprint: v.unitFingerprint(u.text)!, status: 'EXAMINED', outputStatus: 'PRESENT', attempts: 1 }]));
    const f = ec.diagnoseExtractChain(entree({ units: us, t1: toutConnu, decisions: new Map(), decisionContract: 'CARRIED', reviewProgress: tout }));
    expect(f).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_REPAIR_EXHAUSTED', detail: expect.objectContaining({ qualification: 'REPAIR_TECHNICAL', decisionReview: 'TRIED' }) });
  });

  it('registre : anomalies et sources déclarées, version de règles inchangée', () => {
    expect(ec.extractChainCheck.anomalies).toEqual(expect.arrayContaining(['FACT_DECISION_REVIEW_IN_PROGRESS', 'T1_VALUE_DECISIONS_OUTPUT_MISSING']));
    expect(ec.extractChainCheck.sources).toContain('document_value_review_units');
    expect(ec.extractChainCheck.version).toBe(1);
  });
});
