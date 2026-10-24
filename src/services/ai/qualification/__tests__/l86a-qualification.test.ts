/**
 * Lot 86A — qualification par couple (CDC Pilotage IA V2 P5), tests PURS.
 *
 *   L86A-U01  seuils de la décision PO 14 portés et versionnés dans le code
 *   L86A-U02  verdict : admissible / refusée (défaut métier, délai, P95) / non concluante
 *   L86A-U03  ordre des garde-fous (DEC-01) : refus confirmé > doute ; préalables manquants
 *   L86A-U04  concurrence : perte / attribution incorrecte refusées ; charge non atteinte non concluante
 *   L86A-U05  gain établi (OPT-01, DEC-02, R07, R50) et choix de candidate
 *   L86A-U06  états calculés : jamais testé / admissible / obsolète (parties changées) / en test
 *   L86A-U07  signature : chaque empreinte invalide la preuve (QUAL-07, R12, R44)
 *   L86A-U08  défauts : comparateur T1 et contrôles serveur → catégories
 *   L86A-U09  exécution bornée : bornes respectées, pertes / doublons / attributions relevés
 *   L86A-U10  rejeu : variables reconstituées depuis la capture ; exclusions motivées
 *   L86A-U11  exécution d'un couple : secours, cache, erreur transitoire, sortie invalide, refus de requête
 *   L86A-U12  cas de référence T1 absorbés (C-Q9) : aplatissement et variables de production
 *   L86A-U13  source de la vérité attendue d'un cas du corpus (QUAL-09) : rôle déclaré par l'équipe IA
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { QUALIFICATION_THRESHOLDS, DEFECT_CATEGORIES, describeThresholds, isSynchronousTreatment, optimizationPriority } from '../thresholds';
import { chooseCandidate, decideCoupleVerdict, establishedGain, percentile, type CaseObservation, type ConcurrencyReport } from '../verdict';
import { stateOfCouple, manualChoiceLabel, supportsAutomaticDecision } from '../states';
import { canonicalJson, changedParts, coupleSignature, type CoupleSignatureParts } from '../signature';
import { classifyEvaluatorMessage, countDefects, defectsFromComparison } from '../defects';
import { runBounded } from '../concurrency';
import { fixtureExpectation, markerOf, replayExclusion, resolveCapturedVariables, type CaptureRow, type QualificationCase } from '../cases';
import { failureCodeOf, runCoupleCases } from '../runner';
import type { CoupleDescriptor } from '../couples';
import { aplatir, htmlToPlainText } from '../t1-reference';
import { createHash } from 'node:crypto';

const obs = (o: Partial<CaseObservation> = {}): CaseObservation => ({
  caseId: 'c1', source: 'CORPUS_FIXTURE', expectedSource: 'REFERENCE', mandatory: true, observation: 1, outcome: 'PASSED', defects: [],
  inconclusiveReason: null, durationMs: 1000, timeoutMs: 30_000, costMicros: 100, servedModel: 'm', traceId: `t-${Math.random()}`, ...o,
});
const conc = (o: Partial<ConcurrencyReport> = {}): ConcurrencyReport => ({ mode: 'QUEUED', target: 2, limit: 2, maxObserved: 2, submitted: 2, completed: 2, duplicates: 0, lost: 0, misattributed: 0, ...o });

describe('L86A-U01 — seuils de qualification (décision PO 14) dans le code, versionnés', () => {
  it('qualité éliminatoire : 0 dans chaque catégorie, 100 % des cas obligatoires validés', () => {
    expect(QUALIFICATION_THRESHOLDS.version).toBe('qualif-seuils-v1');
    for (const c of DEFECT_CATEGORIES) expect(QUALIFICATION_THRESHOLDS.quality.maxDefects[c]).toBe(0);
    expect(DEFECT_CATEGORIES).toEqual(['INVENTION', 'OMISSION', 'INCORRECT_VALUE', 'ATTRIBUTION', 'DATE_WITHOUT_PROOF', 'UNJUSTIFIED_CHANGE', 'SCHEMA', 'BUSINESS_CHECK']);
    expect(QUALIFICATION_THRESHOLDS.quality.mandatoryValidatedRatio).toBe(1);
  });
  it('délai : 100 % sous plafond, P95 au plus +20 % ; concurrence 3 par worker dont 2 par traitement, T2 et T6 à 3 simultanés', () => {
    expect(QUALIFICATION_THRESHOLDS.latency).toEqual({ withinCapRatio: 1, maxP95Degradation: 0.2, percentile: 95 });
    expect(QUALIFICATION_THRESHOLDS.concurrency).toMatchObject({ queuedPerWorker: 3, queuedPerTreatment: 2, synchronousSimultaneous: 3, synchronousTreatments: ['T2', 'T6'] });
    expect(isSynchronousTreatment('T2')).toBe(true);
    expect(isSynchronousTreatment('T1')).toBe(false);
    expect(QUALIFICATION_THRESHOLDS.transientRetries).toBe(1);
    expect(Object.isFrozen(QUALIFICATION_THRESHOLDS)).toBe(true);
  });
  it('lecture BO : seuils exposés en lecture (source code), priorités OPT-02', () => {
    const d = describeThresholds();
    expect(d.source).toBe('code');
    expect(d.latency.maxDegradationPercent).toBe(20);
    expect(optimizationPriority('t2_answer')).toBe('LATENCY');
    expect(optimizationPriority('t6_formulate')).toBe('LATENCY');
    expect(optimizationPriority('t6_evaluate')).toBe('COST');
    expect(optimizationPriority('t1_analyze_document')).toBe('COST');
  });
});

describe('L86A-U02 — verdict d’un couple', () => {
  const ok = { reference: { p95Ms: 1000, isSelf: false }, concurrency: conc() };
  it('admissible : cas obligatoires vérifiables validés, délai et concurrence conformes', () => {
    const v = decideCoupleVerdict({ observations: [obs(), obs({ caseId: 'c2' })], ...ok });
    expect(v.verdict).toBe('ADMISSIBLE');
    expect(v.reasons.every((r) => r.outcome === 'OK')).toBe(true);
    expect(v.metrics.cases).toMatchObject({ mandatory: 2, verifiableMandatory: 2, validatedMandatory: 2 });
  });
  it('refusée : un seul défaut métier (0 invention, 0 omission…)', () => {
    const v = decideCoupleVerdict({ observations: [obs(), obs({ caseId: 'c2', outcome: 'FAILED', defects: [{ category: 'OMISSION', message: 'x' }] })], ...ok });
    expect(v.verdict).toBe('REFUSED');
    expect(v.reasons.find((r) => r.outcome === 'BLOCKING')).toMatchObject({ step: 'QUALITY', code: 'BUSINESS_DEFECTS' });
    expect(v.metrics.defects.OMISSION).toBe(1);
  });
  it('refusée : un appel conclu au-delà du plafond de l’opération', () => {
    const v = decideCoupleVerdict({ observations: [obs({ durationMs: 31_000 }), obs({ caseId: 'c2' })], ...ok });
    expect(v.verdict).toBe('REFUSED');
    expect(v.reasons.find((r) => r.code === 'OVER_OPERATION_CAP')?.outcome).toBe('BLOCKING');
  });
  it('P95 : +20 % accepté, au-delà refusé ; référence non mesurée → non concluant', () => {
    const at = (d: number) => decideCoupleVerdict({ observations: [obs({ durationMs: d }), obs({ caseId: 'c2', durationMs: d })], reference: { p95Ms: 1000, isSelf: false }, concurrency: conc() });
    expect(at(1200).verdict).toBe('ADMISSIBLE');
    expect(at(1201).verdict).toBe('REFUSED');
    expect(at(1201).reasons.find((r) => r.code === 'P95_DEGRADED')).toBeTruthy();
    const sans = decideCoupleVerdict({ observations: [obs()], reference: { p95Ms: null, isSelf: false }, concurrency: conc() });
    expect(sans.verdict).toBe('INCONCLUSIVE');
    expect(sans.reasons.find((r) => r.code === 'REFERENCE_NOT_MEASURED')).toBeTruthy();
    // La référence elle-même : comparaison à soi (pas de dégradation).
    expect(decideCoupleVerdict({ observations: [obs()], reference: { p95Ms: null, isSelf: true }, concurrency: conc() }).verdict).toBe('ADMISSIBLE');
  });
  it('non concluante : aucun cas vérifiable (non vérifiable = non concluant) ; cas obligatoire non exécuté (erreur transitoire)', () => {
    const nv = decideCoupleVerdict({ observations: [obs({ expectedSource: 'INVARIANTS', outcome: 'INCONCLUSIVE', inconclusiveReason: 'non vérifiable' })], ...ok });
    expect(nv.verdict).toBe('INCONCLUSIVE');
    expect(nv.reasons.find((r) => r.code === 'NO_VERIFIABLE_CASE')).toBeTruthy();
    const tr = decideCoupleVerdict({ observations: [obs(), obs({ caseId: 'c2', outcome: 'INCONCLUSIVE', durationMs: null, inconclusiveReason: 'erreur fournisseur transitoire' })], ...ok });
    expect(tr.verdict).toBe('INCONCLUSIVE');
    expect(tr.reasons.find((r) => r.code === 'MANDATORY_CASES_NOT_VALIDATED')?.message).toMatch(/transitoire/);
  });
  it('percentile au rang le plus proche', () => {
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19);
    expect(percentile([], 95)).toBeNull();
  });
});

describe('L86A-U03 — ordre des garde-fous (DEC-01)', () => {
  it('préalables manquants (point de restauration, compte) : non concluant, rien d’autre n’est jugé', () => {
    const v = decideCoupleVerdict({ observations: [], preconditions: ['point de restauration absent'], reference: { p95Ms: null, isSelf: true }, concurrency: null });
    expect(v.verdict).toBe('INCONCLUSIVE');
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toMatchObject({ step: 'INTEGRITY', outcome: 'INCONCLUSIVE' });
  });
  it('incompatibilité technique : refusée, même sans autre mesure', () => {
    const v = decideCoupleVerdict({ observations: [], technicalRefusal: { parameter: 'generationConfig.thinkingConfig.thinkingLevel', message: 'niveau refusé' }, reference: { p95Ms: null, isSelf: true }, concurrency: null });
    expect(v.verdict).toBe('REFUSED');
    expect(v.reasons.find((r) => r.step === 'TECHNICAL')?.outcome).toBe('BLOCKING');
  });
  it('une erreur métier confirmée l’emporte sur un doute ailleurs ; un bon délai ne compense jamais', () => {
    const v = decideCoupleVerdict({
      observations: [obs({ outcome: 'FAILED', defects: [{ category: 'INVENTION', message: 'montant inventé' }], durationMs: 10 }), obs({ caseId: 'c2', outcome: 'INCONCLUSIVE', durationMs: null })],
      reference: { p95Ms: 5000, isSelf: false }, concurrency: conc(),
    });
    expect(v.verdict).toBe('REFUSED');
  });
});

describe('L86A-U04 — concurrence (décision 14)', () => {
  const base = { observations: [obs(), obs({ caseId: 'c2' })], reference: { p95Ms: 1000, isSelf: false } };
  it('perte, doublon ou attribution incorrecte : refusée', () => {
    for (const c of [conc({ lost: 1 }), conc({ duplicates: 1 }), conc({ misattributed: 1 })]) expect(decideCoupleVerdict({ ...base, concurrency: c }).verdict).toBe('REFUSED');
  });
  it('simultanéité visée non atteinte, borne dépassée ou essai absent : non concluante', () => {
    expect(decideCoupleVerdict({ ...base, concurrency: conc({ maxObserved: 1 }) }).verdict).toBe('INCONCLUSIVE');
    expect(decideCoupleVerdict({ ...base, concurrency: conc({ maxObserved: 4, limit: 3 }) }).verdict).toBe('INCONCLUSIVE');
    expect(decideCoupleVerdict({ ...base, concurrency: null }).verdict).toBe('INCONCLUSIVE');
  });
});

describe('L86A-U05 — gain établi et choix de candidate (OPT-01/02, DEC-02, R07, R50)', () => {
  const m = (caseId: string, durationMs: number, costMicros = 100) => ({ caseId, durationMs, costMicros, outcome: 'PASSED' as const });
  it('gain faible mais établi (toutes les observations meilleures) : GAIN', () => {
    expect(establishedGain([m('a', 1000), m('a', 1010)], [m('a', 990), m('a', 995)], 'LATENCY').outcome).toBe('GAIN');
  });
  it('appel isolé (une observation) : jamais un gain établi', () => {
    expect(establishedGain([m('a', 1000)], [m('a', 100)], 'LATENCY').outcome).toBe('NONE');
  });
  it('fluctuation : aucun gain ; dégradation établie : LOSS', () => {
    expect(establishedGain([m('a', 1000), m('a', 1200)], [m('a', 900), m('a', 1100)], 'LATENCY').outcome).toBe('NONE');
    expect(establishedGain([m('a', 100, 50), m('a', 100, 60)], [m('a', 100, 70), m('a', 100, 80)], 'COST').outcome).toBe('LOSS');
  });
  it('cas non comparables (périmètre différent) : NOT_COMPARABLE (R50)', () => {
    expect(establishedGain([m('a', 1000), m('a', 1000), m('b', 1000), m('b', 1000)], [m('a', 10), m('a', 10)], 'LATENCY').outcome).toBe('NOT_COMPARABLE');
  });
  it('choix : admissible + gain établi ; refusée, non concluante, perte, égalité → choix courant conservé', () => {
    const r = chooseCandidate([
      { key: 'refusee', verdicts: ['REFUSED'], gains: [{ operationCode: 'x', outcome: 'GAIN' }], score: 0.1 },
      { key: 'egale', verdicts: ['ADMISSIBLE'], gains: [{ operationCode: 'x', outcome: 'NONE' }], score: 0.9 },
      { key: 'faible', verdicts: ['ADMISSIBLE', 'ADMISSIBLE'], gains: [{ operationCode: 'x', outcome: 'GAIN' }, { operationCode: 'y', outcome: 'NONE' }], score: 0.98 },
      { key: 'perte', verdicts: ['ADMISSIBLE'], gains: [{ operationCode: 'x', outcome: 'GAIN' }, { operationCode: 'y', outcome: 'LOSS' }], score: 0.5 },
    ]);
    expect(r.chosen).toBe('faible');
    expect(r.reasons.refusee).toMatch(/refusée/);
    expect(r.reasons.egale).toMatch(/aucun gain/);
    expect(r.reasons.perte).toMatch(/perte/);
    expect(chooseCandidate([{ key: 'nc', verdicts: ['INCONCLUSIVE'], gains: [{ operationCode: 'x', outcome: 'GAIN' }], score: 0.1 }]).chosen).toBeNull();
  });
});

const parts = (o: Partial<CoupleSignatureParts> = {}): CoupleSignatureParts => ({
  operationCode: 't3_link_ambiguity', rank: 0, model: 'gemini-3.5-flash', profile: { params: { temperature: 0 }, timeoutMs: 30_000 },
  promptFingerprint: 'p1', contractFingerprint: 'c1', corpusFingerprint: 'k1', evaluatorFingerprint: 'e1', capabilitiesSha256: 's1', thresholdsVersion: 'qualif-seuils-v1', ...o,
});

describe('L86A-U06 — états calculés (jamais écrits)', () => {
  const cur = parts();
  const sig = coupleSignature(cur);
  it('jamais testé sans preuve (MIG-02 : aucune qualification fictive) ; choix manuel « non testé »', () => {
    const s = stateOfCouple({ evidences: [], current: { signature: sig, parts: cur } });
    expect(s.state).toBe('NEVER_TESTED');
    expect(manualChoiceLabel(s)).toBe('Choix manuel · non testé');
    expect(supportsAutomaticDecision(s)).toBe(false);
  });
  it('admissible sur signature identique ; obsolète si le prompt a changé (parties nommées)', () => {
    const e = { id: 1, verdict: 'ADMISSIBLE' as const, signature: sig, parts: cur, createdAt: '2026-10-20T10:00:00.000Z' };
    expect(stateOfCouple({ evidences: [e], current: { signature: sig, parts: cur } }).state).toBe('ADMISSIBLE');
    const p2 = parts({ promptFingerprint: 'p2' });
    const s = stateOfCouple({ evidences: [e], current: { signature: coupleSignature(p2), parts: p2 } });
    expect(s.state).toBe('OBSOLETE');
    expect(s.changed).toEqual(['prompt']);
    expect(manualChoiceLabel(s)).toBe('Choix manuel · non testé (obsolète)');
    expect(supportsAutomaticDecision(s)).toBe(false);
  });
  it('la dernière preuve de MÊME signature fait foi ; en test l’emporte', () => {
    const vieux = { id: 1, verdict: 'ADMISSIBLE' as const, signature: sig, parts: cur, createdAt: '2026-10-20T10:00:00.000Z' };
    const autre = { id: 2, verdict: 'REFUSED' as const, signature: 'x', parts: parts({ model: 'autre' }), createdAt: '2026-10-21T10:00:00.000Z' };
    expect(stateOfCouple({ evidences: [vieux, autre], current: { signature: sig, parts: cur } }).state).toBe('ADMISSIBLE');
    expect(stateOfCouple({ evidences: [vieux], current: { signature: sig, parts: cur }, testing: true }).state).toBe('TESTING');
  });
});

describe('L86A-U07 — signature : chaque empreinte invalide la preuve', () => {
  it('modèle, rang, profil, prompt, contrat, corpus, évaluateur, capacités, seuils', () => {
    const base = coupleSignature(parts());
    const variantes: Array<Partial<CoupleSignatureParts>> = [
      { model: 'x' }, { rank: 1 }, { profile: { params: { temperature: 0, maxOutputTokens: 10 }, timeoutMs: 30_000 } }, { promptFingerprint: 'p2' },
      { contractFingerprint: 'c2' }, { corpusFingerprint: 'k2' }, { evaluatorFingerprint: 'e2' }, { capabilitiesSha256: 's2' }, { thresholdsVersion: 'qualif-seuils-v2' },
    ];
    for (const v of variantes) expect(coupleSignature(parts(v)), JSON.stringify(v)).not.toBe(base);
    expect(changedParts(parts(), parts({ capabilitiesSha256: 's2', contractFingerprint: 'c9' }))).toEqual(['contractFingerprint', 'capabilitiesSha256']);
  });
  it('JSON canonique : l’ordre des clés ne change rien', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } })).toBe(canonicalJson({ a: { c: [1, { e: 2, f: 1 }], d: 2 }, b: 1 }));
  });
});

describe('L86A-U08 — défauts métier par catégorie', () => {
  it('comparateur T1 : manquant = omission, présent sans attendu = invention (date = date sans preuve), bien étranger = rattachement', () => {
    const d = defectsFromComparison({
      schemaValid: true, documentTypeCorrect: false, leakedAssets: ['autre-bien'], missedAssets: [],
      fields: [
        { field: 'prixAchat', verdict: 'missing', expected: 1, observed: null },
        { field: 'valeurRachat', verdict: 'unexpected', expected: null, observed: 5 },
        { field: 'dateEcheance', verdict: 'unexpected', expected: null, observed: '2026-01-01' },
        { field: 'surface', verdict: 'mismatch', expected: 78.4, observed: 82 },
        { field: 'ok', verdict: 'match', expected: 1, observed: 1 },
      ],
    });
    expect(countDefects(d)).toMatchObject({ OMISSION: 1, INVENTION: 1, DATE_WITHOUT_PROOF: 1, INCORRECT_VALUE: 2, ATTRIBUTION: 1 });
  });
  it('contrôles serveur : classement indicatif, à défaut « contrôle métier »', () => {
    expect(classifyEvaluatorMessage('candidat 12 établi sans preuve')).toBe('INVENTION');
    expect(classifyEvaluatorMessage('date d’échéance sans preuve')).toBe('DATE_WITHOUT_PROOF');
    expect(classifyEvaluatorMessage('regroupement inattendu')).toBe('INVENTION');
    expect(classifyEvaluatorMessage('3 candidat(s) retenu(s) ≠ 2')).toBe('INCORRECT_VALUE');
    expect(classifyEvaluatorMessage('verdict ABSTAIN attendu')).toBe('BUSINESS_CHECK');
  });
});

describe('L86A-U09 — exécution bornée', () => {
  it('3 au plus par worker, 2 par traitement ; aucune perte', async () => {
    let actifs = 0;
    const tache = (key: string, group: string) => ({ key, group, run: async () => { actifs += 1; await new Promise((r) => setTimeout(r, 5)); actifs -= 1; return key; } });
    const r = await runBounded([tache('a', 'T1'), tache('b', 'T1'), tache('c', 'T1'), tache('d', 'T3'), tache('e', 'T3'), tache('f', 'T4')], { limit: 3, groupLimit: 2, keyOf: (x) => String(x) });
    expect(r.maxObserved).toBe(3);
    expect(r.maxObservedByGroup.T1).toBe(2);
    expect(r).toMatchObject({ submitted: 6, completed: 6, lost: 0, duplicates: 0, misattributed: 0 });
    expect(actifs).toBe(0);
  });
  it('attribution incorrecte (résultat d’un autre essai) et erreurs conservées', async () => {
    const r = await runBounded([
      { key: 'a', group: 'T2', run: async () => 'b' },
      { key: 'b', group: 'T2', run: async () => { throw new Error('panne'); } },
    ], { limit: 3, groupLimit: 3, keyOf: (x) => String(x) });
    expect(r.misattributed).toBe(1);
    expect(r.results.get('b')).toMatchObject({ ok: false });
  });
});

describe('L86A-U10 — rejeu des données existantes', () => {
  const long = 'x'.repeat(3000);
  const prompt = `AVANT ${long} APRÈS`;
  const ref = { $ref: 'prompt', offset: prompt.indexOf(long), length: long.length, sha256: createHash('sha256').update(long).digest('hex') };
  it('variables reconstituées sans perte depuis le prompt capturé (empreinte vérifiée)', () => {
    expect(resolveCapturedVariables({ A: ref, B: 'court' }, prompt)).toEqual({ A: long, B: 'court' });
    expect(resolveCapturedVariables({ A: { ...ref, sha256: 'faux' } }, prompt)).toBeNull();
    expect(resolveCapturedVariables({ A: ref }, null)).toBeNull();
  });
  it('exclusions motivées : contenu masqué, pièce jointe, résultat historique absent', () => {
    const c: CaptureRow = { id: 1, accountId: 2, operationCode: 'x', promptText: 'p', promptStatus: 'CAPTURED', responseStatus: 'CAPTURED', variables: {}, attachments: [], masking: null, parsedOutput: { a: 1 } };
    expect(replayExclusion(c)).toBeNull();
    expect(replayExclusion({ ...c, promptStatus: 'MASKED' })).toMatch(/masqué/);
    expect(replayExclusion({ ...c, attachments: [{ index: 0 }] })).toMatch(/pièce jointe/);
    expect(replayExclusion({ ...c, parsedOutput: null })).toMatch(/historique/);
    expect(markerOf({ a: 'court', b: { c: 'une valeur nettement plus longue' } })).toBe('une valeur nettement plus longue');
  });
});

describe('L86A-U11 — exécution d’un couple (passerelle simulée)', () => {
  const couple = { treatment: 'T3', operationCode: 't3_link_ambiguity', rank: 0, slot: 'primaryModel', model: 'gemini-3.5-flash', versionId: 1, revisionId: 1,
    profile: { reasoning: null, reasoningOrigin: null, maxOutputTokens: null, timeoutMs: 30_000, timeoutOrigin: null, params: {} },
    technicalRefusal: null, parts: parts(), signature: 'sig' } as unknown as CoupleDescriptor;
  const cas = (o: Partial<QualificationCase> = {}): QualificationCase => ({
    caseId: 'corpus:a', operationCode: 't3_link_ambiguity', treatment: 'T3', source: 'CORPUS_FIXTURE', expectedSource: 'REFERENCE', mandatory: true, advisory: false,
    accountId: null, captureId: null, variables: { X: 1 }, outputSchema: z.any(), acceptedOutputSchemas: [], historicalOutput: { v: 1 }, marker: null,
    evaluate: async () => ({ defects: [], inconclusive: null }), ...o,
  });
  const reponse = (o: Record<string, unknown> = {}) => ({ data: { v: 1 }, provider: 'fake', model: 'gemini-3.5-flash', promptVersion: 'p', usedFallback: false, inputTokens: 1, outputTokens: 1, costMicros: 10, durationMs: 50, traceId: `tr-${Math.random()}`, fromCache: false, ...o });
  const run = (call: never, cases = [cas(), cas({ caseId: 'corpus:b' })]) => runCoupleCases({ couple, cases, observations: 1, campaignId: 9, technicalAccountId: 5, masterText: () => '', call });

  it('requête forcée : rang, une tentative, révision épinglée, déclencheur qualification, clé unique, hors plafond', async () => {
    const vus: Array<{ req: Record<string, unknown>; ctx: Record<string, unknown> }> = [];
    const r = await run((async (req: never, ctx: never) => { vus.push({ req, ctx }); return reponse(); }) as never);
    expect(r.observations.map((o) => o.outcome)).toEqual(['PASSED', 'PASSED']);
    expect(r.observations[0].matchesHistorical).toBe(true);
    expect(vus[0].req).toMatchObject({ firstModelIndex: 0, maxModelAttempts: 1, costCapExempt: true, triggerCode: 'qualification', accountId: 5 });
    expect(vus[0].ctx).toMatchObject({ configVersionId: 1, configRevisionId: 1, triggerCode: 'qualification', jobId: null });
    expect(new Set(vus.map((v) => v.req.idempotencyKey)).size).toBe(2);
    expect(r.concurrency).toMatchObject({ mode: 'QUEUED', target: 2, maxObserved: 2, lost: 0, misattributed: 0 });
  });
  it('un secours ou une réponse en cache ne qualifient jamais le candidat', async () => {
    const r = await run((async () => reponse({ model: 'autre-modele', usedFallback: true })) as never);
    expect(r.observations.every((o) => o.outcome === 'INCONCLUSIVE' && /autre modèle/.test(o.inconclusiveReason!))).toBe(true);
    const c = await run((async () => reponse({ fromCache: true })) as never);
    expect(c.observations.every((o) => /cache/.test(o.inconclusiveReason!))).toBe(true);
  });
  it('erreur transitoire : un nouvel essai puis non concluant ; sortie invalide : défaut SCHEMA ; refus de requête relevé', async () => {
    let n = 0;
    const r = await run((async () => { n += 1; if (n === 1) throw Object.assign(new Error('503'), { code: 'ALL_MODELS_FAILED', lastFailureCode: 'PROVIDER_UNAVAILABLE' }); return reponse(); }) as never, [cas()]);
    // 1 cas + observation supplémentaire pour atteindre la simultanéité visée (2).
    expect(r.observations).toHaveLength(2);
    expect(r.observations.filter((o) => o.outcome === 'PASSED')).toHaveLength(2);
    const t = await run((async () => { throw Object.assign(new Error('503'), { code: 'ALL_MODELS_FAILED', lastFailureCode: 'TIMEOUT' }); }) as never, [cas()]);
    expect(t.observations[0].inconclusiveReason).toMatch(/transitoire/);
    const s = await run((async () => { throw Object.assign(new Error('JSON invalide'), { code: 'ALL_MODELS_FAILED', lastFailureCode: 'INVALID_OUTPUT' }); }) as never, [cas()]);
    expect(s.observations[0]).toMatchObject({ outcome: 'FAILED', defects: [{ category: 'SCHEMA' }] });
    const q = await run((async () => { throw Object.assign(new Error('thinking refusé'), { code: 'ALL_MODELS_FAILED', lastFailureCode: 'PROVIDER_REQUEST_REJECTED' }); }) as never, [cas()]);
    expect(q.requestRejected).toMatchObject({ message: expect.stringMatching(/thinking/) });
    expect(failureCodeOf({ code: 'TIMEOUT' })).toBe('TIMEOUT');
  });
  it('non vérifiable (aucun attendu) : non concluant ; défaut d’évaluateur : échoué ; compte technique absent : non concluant', async () => {
    const r = await run((async () => reponse()) as never, [cas({ expectedSource: 'INVARIANTS' }), cas({ caseId: 'corpus:b', evaluate: async () => ({ defects: [{ category: 'ATTRIBUTION', message: 'mauvais bien' }], inconclusive: null }) })]);
    expect(r.observations[0].inconclusiveReason).toMatch(/non vérifiable/);
    expect(r.observations[1].outcome).toBe('FAILED');
    const sans = await runCoupleCases({ couple, cases: [cas(), cas({ caseId: 'corpus:b' })], observations: 1, campaignId: 9, technicalAccountId: null, masterText: () => '', call: (async () => reponse()) as never });
    expect(sans.observations.every((o) => /compte technique/.test(o.inconclusiveReason!))).toBe(true);
  });
  it('T2 / T6 (synchrones) : 3 appels simultanés visés', async () => {
    const t2 = { ...couple, treatment: 'T2', operationCode: 't2_answer' } as CoupleDescriptor;
    const r = await runCoupleCases({ couple: t2, cases: [cas({ treatment: 'T2', operationCode: 't2_answer' })], observations: 1, campaignId: 9, technicalAccountId: 5, masterText: () => '',
      call: (async () => { await new Promise((x) => setTimeout(x, 5)); return reponse(); }) as never });
    expect(r.concurrency).toMatchObject({ mode: 'SYNCHRONOUS', target: 3, maxObserved: 3, submitted: 3 });
  });
});

describe('L86A-U12 — cas de référence T1 (harnais historique absorbé, C-Q9)', () => {
  const sortie = {
    task: 'ANALYZE_DOCUMENT',
    document: { title: { value: 'Facture Pneus Clio' }, documentDate: { value: '2026-03-14' }, supplier: { name: 'Garage Martin' }, amountCents: { value: 42000 } },
    facts: [
      { canonicalKey: 'mileage', normalizedValue: 78000 }, { canonicalKey: null, rawKey: 'immatriculation', normalizedValue: 'AB-123-CD' },
      { canonicalKey: null, rawKey: 'title', normalizedValue: 'Titre explicite' }, { canonicalKey: 'x', normalizedValue: null },
    ],
  } as never;
  it('faits sous leur clé canonique, à défaut la clé lue ; un fait explicite l’emporte sur la tête', () => {
    const c = aplatir(sortie);
    expect(c).toMatchObject({ mileage: 78000, immatriculation: 'AB-123-CD', title: 'Titre explicite', dateFacture: '2026-03-14', supplier: 'Garage Martin', amountCents: 42000 });
    expect(c).not.toHaveProperty('x');
  });
  it('texte brut d’un document HTML (aucune structure explicite transmise)', () => {
    expect(htmlToPlainText('<table><tr><td>A</td><td>B&nbsp;&amp;</td></tr></table><p>x</p>')).toBe('A\tB &\nx');
  });
  it('variables construites par la fonction de PRODUCTION, cas consultatifs (non bloquants) jusqu’à validation IA', async () => {
    const { buildCaseSet } = await import('../cases');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { T1_PROMPT_VARIABLES } = await import('@/services/ai/source-analysis/master/prompt-context');
    const set = await buildCaseSet('t1_analyze_document', { readMasterFile: readMasterFileFromRepo });
    const ref = set.cases.filter((c) => c.source === 'T1_REFERENCE');
    expect(ref.length).toBeGreaterThanOrEqual(20);
    expect(ref.every((c) => c.advisory && !c.mandatory)).toBe(true);
    for (const v of T1_PROMPT_VARIABLES) expect(Object.keys(ref[0].variables)).toContain(v);
    const corpus = set.cases.filter((c) => c.source === 'CORPUS_FIXTURE');
    expect(corpus.length).toBeGreaterThan(0);
    expect(corpus.every((c) => c.mandatory && !c.advisory)).toBe(true);
    expect(set.corpusFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('L86A-U13 — source de la vérité attendue d’un cas du corpus (QUAL-09)', () => {
  it('réponse de référence déclarée : REFERENCE ; garde : écarté ; non déclaré : contrôles serveur seuls (non concluant)', () => {
    expect(fixtureExpectation({ expected: { decision: 'ABSTAIN' }, qualificationRole: 'answer' }, true)).toEqual({ use: 'REFERENCE', reason: null });
    expect(fixtureExpectation({ expected: { valid: false }, qualificationRole: 'guard' }, true).use).toBe('SKIP');
    expect(fixtureExpectation({ expected: { valid: false }, qualificationRole: null }, true)).toMatchObject({ use: 'INVARIANTS', reason: expect.stringMatching(/non déclaré/) });
    expect(fixtureExpectation({ expected: null, qualificationRole: 'answer' }, false).use).toBe('NONE');
  });
  it('corpus du dépôt : aucun rôle déclaré aujourd’hui → aucun cas REFERENCE (demande à l’équipe IA), cas exécutables quand même', async () => {
    const { buildCaseSet } = await import('../cases');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const set = await buildCaseSet('t3_link_ambiguity', { readMasterFile: readMasterFileFromRepo });
    expect(set.cases.length).toBeGreaterThan(0);
    expect(set.cases.every((c) => c.expectedSource !== 'REFERENCE' || c.source !== 'CORPUS_FIXTURE')).toBe(true);
  });
});
