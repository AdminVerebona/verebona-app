/**
 * Lot 100B — certification du corpus de qualification IA (ticket #601 ;
 * arbitrages PO A1, C2, C5). Recette bloquante, cas GÉNÉRIQUES (le ZIP n'est
 * pas encore livré) :
 *
 *  L100B-R1   un montant omis fait échouer T1 même si la sortie JSON est valide ;
 *  L100B-R2   deux contrats similaires mais distincts ne sont pas fusionnés (paire adversariale) ;
 *  L100B-R7   une opération non couverte (y compris une NOUVELLE opération active) ou un côté
 *             de paire en échec / absent interdit la promotion ;
 *  L100B-R8   après modification d'un oracle, l'approbation tombe et la qualification
 *             ancienne est invalidée (signature du couple → obsolète) ;
 *  L100B-R9   modèle plus rapide mais erroné sur un risque critique : refus, même avec un
 *             excellent score global ;
 *  L100B-R10  rapports : mutation, import ligne par ligne, stress, CSV ;
 *  L100B-M    manifeste versionné : 86 historiques reclassés (règles vérifiées), aucune
 *             approbation déclarée, aucune suppression, oracle modifié sans révision refusé ;
 *  L100B-MUT  tests de mutation : variantes erronées rejetées, réponses équivalentes acceptées ;
 *  L100B-IMP  importeur : format documenté, aucune approbation par import, causes ligne par ligne ;
 *  L100B-T2   vue T2 (CDC 4 §35) : couverture suffisante / insuffisante / non mesurée ;
 *  L100B-LIM  limites techniques de relance configurables, bornées.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { evaluateOracle, oracleApprovalProblems, oracleFingerprint, observeOutput } = await import('../oracle');
const { runMutationSuite, mutationFailures } = await import('../mutations');
const { assessPair, assessPairs } = await import('../pairs');
const { assessA1, a1Notices, t2SearchView, T2_MIN_CASES_PER_CATEGORY } = await import('../coverage');
const { effectiveStatus, certificationFingerprint, validateManifest, reviseEntry, loadCorpusManifest } = await import('../manifest');
const { oracleSchema } = await import('../model');
const { classifyHistoricalCase, expectedContradictions, unsupportedExpected, claimsFileWithoutPiece } = await import('../historical');
const { convertImport, importReportText, parseCsv } = await import('../importer');
const { runStressScenario, stressReportText } = await import('../stress');
const { readRepoCorpus, fixturesOnDisk, updateManifest } = await import('../generate');
const { coupleSignature } = await import('../../../../qualification/signature');
const { stateOfCouple } = await import('../../../../qualification/states');
const { withRuntimeLimits } = await import('../../../../qualification/limits');
const { QUALIFICATION_THRESHOLDS } = await import('../../../../qualification/thresholds');
const { T1AnalyzeDocumentOutput } = await import('../../../../source-analysis/master/t1-contract');
const { readFileSync } = await import('node:fs');
const { join } = await import('node:path');

type Entry = import('../model').ManifestEntry;
type Oracle = import('../model').Oracle;
type CaseResult = import('../coverage').CaseResult;

const T1_749 = JSON.parse(readFileSync(join(process.cwd(), 'src/services/ai/source-analysis/__fixtures__/t1/t1-03-montant-749.json'), 'utf8')).recording.output;
const oracle = (o: Partial<import('zod').input<typeof oracleSchema>>): Oracle => oracleSchema.parse({ version: 1, ...o });
const preuve = [{ source: 'pieces/facture.pdf', excerpt: 'TOTAL TTC 749,00 €' }];

function entry(over: Partial<Entry> & { id: string }): Entry {
  const o = over.oracle === undefined ? oracle({ requiredFacts: [{ key: 'f', kind: 'TEXT', value: 'x', critical: true, evidence: preuve }] }) : over.oracle;
  return {
    sourceCaseId: over.id, file: null, operationCode: 't3_operation_match', treatment: 'T3', contract: null, schema: null, riskFamily: 'T3_IDENTITE_ECONOMIQUE',
    difficulty: 'SIMPLE', critical: true, pair: null, provenance: 'ZIP_601', sourcePieces: [], inputMode: 'STRUCTURED', testType: 'QUALITE_MODELE',
    evaluationType: 'ORACLE', status: 'A_COMPLETER', reason: 'test', historicalClass: null, cdc35Category: null, expectedSummary: null,
    revisions: [{ revision: 1, at: '2026-10-29T00:00:00Z', by: 'test', reason: 'test', changes: ['*'], oracleFingerprint: oracleFingerprint(o) }],
    ...over, oracle: o,
  } as Entry;
}
const approve = (e: Entry) => ({ caseId: e.id, oracleFingerprint: oracleFingerprint(e.oracle)!, decision: 'APPROVED' as const, at: '2026-10-29T10:00:00Z', by: 'po' });
const res = (id: string, outcome: CaseResult['outcome'], defects: CaseResult['defects'] = [], decisions: string[] = []): CaseResult => ({ caseId: id, outcome, defects, criticalDefects: defects, decisions });

afterEach(() => { delete process.env.AI_QUALIF_MAX_RETRIES; delete process.env.AI_QUALIF_CONCURRENCY; });

// ══════════════════════════════════════════════════════════════════════════
describe('L100B-R1 — T1 : un montant omis fait échouer, même avec un JSON valide', () => {
  const o = oracle({
    requiredFacts: [
      { key: 'acquisitionPrice', kind: 'AMOUNT', value: 749, unit: 'EUR', critical: true, evidenceRequired: true, entity: '184', evidence: preuve },
      { key: 'frais_livraison', kind: 'AMOUNT', value: 12.5, unit: 'EUR', critical: true, evidenceRequired: true, evidence: [{ source: 'pieces/facture.pdf', excerpt: 'Livraison 12,50 €' }] },
    ],
  });
  it('la sortie enregistrée est conforme au contrat T1 (JSON valide) mais omet un montant : ÉCHEC, omission critique', () => {
    expect(T1AnalyzeDocumentOutput.safeParse(T1_749).success).toBe(true);
    const r = evaluateOracle(o, T1_749);
    expect(r.defects.map((d) => d.category)).toEqual(['OMISSION']);
    expect(r.criticalDefects[0].message).toMatch(/frais_livraison.*12\.5.*omis/);
  });
  it('tous les montants présents AVEC leur preuve : réussi ; formats équivalents (centimes, « 749,00 € ») acceptés', () => {
    const complet = structuredClone(T1_749);
    complet.facts.push({ ...complet.facts[0], canonicalKey: null, label: 'Livraison', rawValue: '12,50 €', normalizedValue: 12.5, evidence: { excerpt: 'Livraison 12,50 €', page: 1 } });
    expect(T1AnalyzeDocumentOutput.safeParse(complet).success).toBe(true);
    expect(evaluateOracle(o, complet).defects).toEqual([]);
    expect(observeOutput(complet).amounts.map((a) => a.eur)).toEqual(expect.arrayContaining([749, 12.5]));
  });
  it('montant présent SANS preuve : refusé (fait non étayé) ; montant d’un autre bien : mauvais rattachement', () => {
    const sansPreuve = structuredClone(T1_749);
    sansPreuve.facts.push({ ...sansPreuve.facts[0], canonicalKey: null, rawValue: '12,50 €', normalizedValue: 12.5, evidence: {} });
    expect(evaluateOracle(o, sansPreuve).defects.map((d) => d.message).join(' ')).toMatch(/frais_livraison.*sans preuve/);
    const autreBien = structuredClone(T1_749);
    autreBien.facts[0].target.entityId = 999;
    autreBien.facts.push({ ...T1_749.facts[0], canonicalKey: null, rawValue: '12,50 €', normalizedValue: 12.5, evidence: { excerpt: 'Livraison 12,50 €' } });
    autreBien.document.amountCents.value = 74900;
    const r = evaluateOracle(o, autreBien);
    expect(r.defects.some((d) => d.category === 'ATTRIBUTION' && /acquisitionPrice/.test(d.message))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('L100B-MUT — tests de mutation par fait crucial', () => {
  it('T1 : montant faux, omission, contradiction, mauvais bien rejetés ; ordre et format équivalents acceptés', () => {
    const o = oracle({ requiredFacts: [{ key: 'acquisitionPrice', kind: 'AMOUNT', value: 749, unit: 'EUR', critical: true, evidenceRequired: true, evidence: preuve }], entities: { expected: [184], forbidden: [185] } });
    const r = runMutationSuite('T1-749', o, T1_749);
    expect(r.referencePasses).toBe(true);
    const k = (m: string) => r.rows.find((x) => x.mutation === m);
    for (const m of ['WRONG_AMOUNT', 'OMISSION', 'CONTRADICTION', 'WRONG_ENTITY']) expect(k(m), m).toMatchObject({ outcome: 'REJECTED', ok: true });
    expect(k('REORDERED')).toMatchObject({ outcome: 'ACCEPTED', ok: true });
    expect(k('INVENTED_SOURCE')).toMatchObject({ outcome: 'NOT_APPLICABLE' });
    expect(mutationFailures([r])).toEqual([]);
  });
  it('T2 (P-T2-09) : source inventée et omission rejetées ; montant reformulé (« 18500.00 EUR ») accepté', () => {
    const f = JSON.parse(readFileSync(join(process.cwd(), 'src/services/ai/governance/master-corpus/fixtures/p-t2-09-achat-et-cumul.json'), 'utf8'));
    const o = oracle({
      requiredFacts: [{ key: 'prix_achat', kind: 'AMOUNT', value: 18500, unit: 'EUR', critical: true, evidence: [{ source: 'asset_field:20:acquisitionPrice' }] }],
      absentFacts: [{ key: 'total_additionne', kind: 'AMOUNT', value: 20100, reason: 'prix d’achat et dépenses jamais additionnés' }],
      allowedSources: f.context.sources.map((s: { id: string }) => s.id), abstention: { expected: 'ANSWER' },
    });
    const r = runMutationSuite('P-T2-09', o, f.recording.output);
    expect(r.referencePasses).toBe(true);
    const k = (m: string) => r.rows.find((x) => x.mutation === m);
    expect(k('INVENTED_SOURCE')).toMatchObject({ outcome: 'REJECTED', ok: true });
    expect(k('OMISSION')).toMatchObject({ outcome: 'REJECTED', ok: true });
    expect(k('WRONG_AMOUNT')).toMatchObject({ outcome: 'REJECTED', ok: true });
    expect(k('REFORMATTED_AMOUNT')).toMatchObject({ outcome: 'ACCEPTED', ok: true });
    // Total additionné affiché : interdit.
    const fautif = structuredClone(f.recording.output);
    fautif.claims.push({ text: 'Au total 20 100,00 €.', sourceIds: ['expenses:all:20'], derivation: 'direct', factual: true });
    expect(evaluateOracle(o, fautif).defects.map((d) => d.message).join(' ')).toMatch(/interdite.*total_additionne/);
    // Abstention alors qu'une réponse fiable existe : refusée.
    expect(evaluateOracle(o, { ...f.recording.output, status: 'insufficient_sources', claims: [] }).defects.map((d) => d.field)).toEqual(expect.arrayContaining(['abstention', 'prix_achat']));
  });
  it('mauvais statut rejeté ; valeur équivalente déclarée acceptée', () => {
    const sortie = { task: 'CLASSIFY_EVENT', agendaDecision: 'accept', recurrenceDecision: 'not_applicable', homeCategory: 'action', reason: 'r' };
    const o = oracle({
      requiredFacts: [{ key: 'agendaDecision', kind: 'STATUS', value: 'accept', critical: true, evidence: preuve }],
      decisions: { allowed: ['accept'], forbidden: ['reject'] }, equivalences: [{ key: 'agendaDecision', values: ['accept', 'accepted'] }],
    });
    const r = runMutationSuite('T4', o, sortie);
    expect(r.rows.filter((x) => x.mutation === 'WRONG_STATUS').every((x) => x.ok && x.outcome === 'REJECTED')).toBe(true);
    expect(r.rows.find((x) => x.mutation === 'DECLARED_EQUIVALENT')).toMatchObject({ outcome: 'ACCEPTED', ok: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('L100B-R2 / R7 — paires adversariales : deux contrats similaires mais distincts', () => {
  const A = entry({ id: 'P-CONTRAT-A', pair: { id: 'PAIRE-CONTRATS', side: 'A', discriminantChangesDecision: true, discriminant: 'numéro de contrat différent' } });
  const B = entry({ id: 'P-CONTRAT-B', pair: { id: 'PAIRE-CONTRATS', side: 'B', discriminantChangesDecision: true, discriminant: 'numéro de contrat différent' } });
  const oracleB = oracle({ decisions: { allowed: ['NEW_OPERATION', 'distinct'], forbidden: ['same', 'ATTACH', 'MERGE'] } });
  it('côté B : la fusion des deux contrats distincts est rejetée par l’oracle', () => {
    expect(evaluateOracle(oracleB, { task: 'OPERATION_MATCH', verdict: 'same', operationId: 7 }).defects.map((d) => d.message).join(' ')).toMatch(/décision interdite : same/);
    expect(evaluateOracle(oracleB, { task: 'OPERATION_MATCH', verdict: 'distinct', operationId: null }).defects).toEqual([]);
  });
  it('A et B réussis, décisions différentes : paire valide ; même décision des deux côtés : discriminant non respecté', () => {
    const ok = new Map([[A.id, res(A.id, 'PASSED', [], ['same'])], [B.id, res(B.id, 'PASSED', [], ['distinct'])]]);
    expect(assessPair('PAIRE-CONTRATS', [A, B], ok).verdict).toBe('VALID');
    const fusion = new Map([[A.id, res(A.id, 'PASSED', [], ['same'])], [B.id, res(B.id, 'PASSED', [], ['same'])]]);
    expect(assessPair('PAIRE-CONTRATS', [A, B], fusion).verdict).toBe('INVALID_DISCRIMINANT');
  });
  it('un côté en échec ou absent invalide la paire et INTERDIT la promotion (A1)', () => {
    const echec = new Map([[A.id, res(A.id, 'PASSED')], [B.id, res(B.id, 'FAILED', [{ category: 'INCORRECT_VALUE', message: 'fusion' }])]]);
    expect(assessPair('PAIRE-CONTRATS', [A, B], echec).verdict).toBe('INVALID_SIDE_FAILED');
    const seul = new Map([[A.id, res(A.id, 'PASSED')]]);
    expect(assessPair('PAIRE-CONTRATS', [A, B], seul).verdict).toBe('INVALID_SIDE_MISSING');
    expect(assessPairs([A], new Map()).map((p) => p.verdict)).toEqual(['INVALID_SIDE_MISSING']);
    const approved = [A, B].map(approve);
    const a1 = assessA1({
      treatments: ['T3'], entries: [A, B], statusOf: (e) => effectiveStatus(e, approved).status, results: seul,
      operations: [{ operationCode: 't3_operation_match', treatment: 'T3', task: 'OPERATION_MATCH', label: 'match' }],
    });
    expect(a1.allowed).toBe(false);
    expect(a1.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['PAIR_INVALID', 'CRITICAL_NOT_CONCLUSIVE']));
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('L100B-R7 — verrou A1 : opérations actives recalculées depuis le registre', () => {
  const ops = [
    { operationCode: 't3_operation_match', treatment: 'T3' as const, task: 'OPERATION_MATCH', label: 'match' },
    { operationCode: 't3_nouvelle_operation', treatment: 'T3' as const, task: 'NOUVELLE', label: 'nouvelle opération active' },
  ];
  const e1 = entry({ id: 'C-1' });
  it('une NOUVELLE opération active sans référence approuvée interdit la promotion, même si tout le reste réussit', () => {
    const a = assessA1({ treatments: ['T3'], entries: [e1], statusOf: (e) => effectiveStatus(e, [approve(e1)]).status, results: new Map([[e1.id, res(e1.id, 'PASSED')]]), operations: ops });
    expect(a.allowed).toBe(false);
    expect(a.blockers.find((b) => b.code === 'OPERATION_NOT_COVERED')?.operationCode).toBe('t3_nouvelle_operation');
    expect(a1Notices(a).join(' ')).toMatch(/activation manuelle reste possible/);
  });
  it('registre réel : 17 opérations IA actives (T1 à T6, jamais T5), dont les 15 annoncées par le PO', async () => {
    const { activeQualificationOperations } = await import('../model');
    const l = activeQualificationOperations().map((o) => o.operationCode);
    for (const op of ['t1_group_upload', 't1_analyze_document', 't2_understand', 't2_answer', 't2_revalidate', 't3_value_conflict', 't3_link_ambiguity', 't3_operation_match',
      't3_document_naming', 't3_knowledge_query', 't4_classify_event', 't4_verify_completion', 't4_temporal_ambiguity', 't6_formulate', 't6_evaluate']) expect(l).toContain(op);
    expect(l.some((x) => x.startsWith('t5'))).toBe(false);
    expect(l.length).toBeGreaterThanOrEqual(15);
  });
  it('un cas critique sans oracle approuvé, non concluant ou en omission interdit la promotion ; une garde n’est jamais exigée', () => {
    const g = entry({ id: 'G-1', status: 'GARDE_SERVEUR', testType: 'GARDE_SERVEUR', evaluationType: 'GARDE_SERVEUR', critical: false, oracle: null });
    const e2 = entry({ id: 'C-2' });
    const a = assessA1({ treatments: ['T3'], entries: [e1, e2, g], statusOf: (e) => effectiveStatus(e, [approve(e1)]).status,
      results: new Map([[e1.id, res(e1.id, 'FAILED', [{ category: 'OMISSION', message: 'montant omis' }])]]), operations: ops.slice(0, 1) });
    expect(a.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['CRITICAL_WITHOUT_APPROVED_ORACLE', 'CRITICAL_OMISSION']));
    expect(a.blockers.some((b) => b.caseId === 'G-1')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('L100B-R9 — plus rapide mais erroné sur un risque critique : refus', () => {
  it('gain de délai établi + un cas critique en échec : FASTER_BUT_WRONG, malgré 99 cas réussis', () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry({ id: `C-${i}` }));
    const approvals = entries.map(approve);
    const results = new Map(entries.map((e, i) => [e.id, i === 42 ? res(e.id, 'FAILED', [{ category: 'INCORRECT_VALUE', message: 'Opération fusionnée à tort' }]) : res(e.id, 'PASSED')]));
    const a = assessA1({
      treatments: ['T3'], entries, statusOf: (e) => effectiveStatus(e, approvals).status, results,
      gains: [{ operationCode: 't3_operation_match', outcome: 'GAIN' }], operations: [{ operationCode: 't3_operation_match', treatment: 'T3', task: 'X', label: 'x' }],
    });
    expect(a.allowed).toBe(false);
    expect(a.blockers.find((b) => b.code === 'FASTER_BUT_WRONG')?.message).toMatch(/plus rapide.*erroné.*C-42/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('L100B-R8 — modification d’un oracle : approbation caduque, qualification ancienne invalidée', () => {
  it('approbation sur l’empreinte exacte ; oracle modifié (nouvelle révision) → À_COMPLÉTER, empreinte de certification changée → couple OBSOLÈTE', () => {
    const e = entry({ id: 'C-ORACLE', operationCode: 't3_operation_match' });
    const appr = [approve(e)];
    expect(effectiveStatus(e, appr).status).toBe('REFERENCE_APPROUVEE');
    const m1 = { version: 1, generatedAt: 'x', reference: { ticket: '#601', announcedScenarios: 401, announcedStress: 15, zipReceived: false }, entries: [e], ledger: [e.id] };
    const fp1 = certificationFingerprint(m1, 't3_operation_match', appr);
    const modifie = reviseEntry(e, { oracle: oracle({ requiredFacts: [{ key: 'f', kind: 'TEXT', value: 'y', critical: true, evidence: preuve }] }) }, 'dev', 'oracle corrigé');
    expect(modifie.revisions).toHaveLength(2);
    const eff = effectiveStatus(modifie, appr);
    expect(eff.status).toBe('A_COMPLETER');
    expect(eff.reason).toMatch(/oracle modifié depuis l’approbation/);
    const fp2 = certificationFingerprint({ ...m1, entries: [modifie] }, 't3_operation_match', appr);
    expect(fp2).not.toBe(fp1);
    const parts = (corpus: string) => ({ operationCode: 't3_operation_match', rank: 0, model: 'm', profile: {}, promptFingerprint: 'p', contractFingerprint: 'c', corpusFingerprint: corpus, evaluatorFingerprint: 'e', capabilitiesSha256: 's', thresholdsVersion: 'v' });
    const avant = parts(fp1);
    const s = stateOfCouple({ evidences: [{ id: 1, verdict: 'ADMISSIBLE', signature: coupleSignature(avant), parts: avant, createdAt: '2026-10-29' }], current: { signature: coupleSignature(parts(fp2)), parts: parts(fp2) } });
    expect(s.state).toBe('OBSOLETE');
    expect(s.changed).toContain('corpus');
  });
  it('un oracle modifié SANS révision est refusé par la validation du manifeste (CI)', () => {
    const e = entry({ id: 'C-SILENCE' });
    const triche = { ...e, oracle: oracle({ requiredFacts: [{ key: 'f', kind: 'TEXT', value: 'z', critical: true, evidence: preuve }] }) };
    const m = { version: 1, generatedAt: 'x', reference: { ticket: '#601', announcedScenarios: 401, announcedStress: 15, zipReceived: false }, entries: [triche], ledger: [e.id] };
    expect(validateManifest(m).join(' ')).toMatch(/oracle modifié sans révision/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('L100B-M — manifeste versionné et reclassement des 86 fixtures historiques', () => {
  it('le manifeste du dépôt est conforme et à jour (aucune fixture sans entrée, aucune suppression)', async () => {
    const corpus = await readRepoCorpus();
    const m = loadCorpusManifest();
    expect(validateManifest(m, fixturesOnDisk(corpus.cases))).toEqual([]);
    expect((await updateManifest(m, corpus)).added).toEqual([]);
    expect(m.ledger.length).toBe(m.entries.length);
  });
  it('86 historiques (base lot 88) + 13 ajouts (lots 97-99) reclassés par règles ; aucune référence approuvée déclarée', () => {
    const m = loadCorpusManifest();
    const h = m.entries.filter((e) => e.provenance === 'HISTORIQUE_86');
    expect(h).toHaveLength(86);
    expect(m.entries.filter((e) => e.provenance === 'AJOUT_LOTS_97_99')).toHaveLength(13);
    const n = (c: string) => h.filter((e) => e.historicalClass === c).length;
    expect(n('GARDE') + n('REPONSE_UTILISABLE') + n('A_CORRIGER') + n('VARIANTE_CONTRAT') + n('NON_REJOUABLE')).toBe(86);
    expect(m.entries.every((e) => (e.status as string) !== 'REFERENCE_APPROUVEE')).toBe(true);
    expect(m.entries.filter((e) => e.status === 'GARDE_SERVEUR').every((e) => !e.critical && e.testType === 'GARDE_SERVEUR')).toBe(true);
    // Aucun cas n'est approuvé sans approbation humaine.
    expect(m.entries.filter((e) => effectiveStatus(e, []).status === 'REFERENCE_APPROUVEE')).toEqual([]);
  });
  it('identifiant dupliqué corrigé (T1-02) ; variantes de contrat liées à leur version ; multimodal sans fichier non rejouable', () => {
    const m = loadCorpusManifest();
    const piece = m.entries.find((e) => e.file?.endsWith('t1-02-achat-piece.json'))!;
    expect(piece.sourceCaseId).toBe('T1-02-ACHAT-PIECE');
    expect(piece.reason).toMatch(/identifiant dupliqué corrigé/);
    const v2 = m.entries.find((e) => e.sourceCaseId === 'P-T4-07')!;
    expect(v2).toMatchObject({ historicalClass: 'VARIANTE_CONTRAT', status: 'HISTORIQUE', contract: 't4_output_v2' });
    const p2 = m.entries.find((e) => e.sourceCaseId === 'P-T1-02')!;
    expect(p2).toMatchObject({ historicalClass: 'NON_REJOUABLE', inputMode: 'FILE', status: 'HISTORIQUE' });
  });
  it('règles de reclassement : contradiction, attendu non étayé, fichier prétendu sans pièce', () => {
    expect(expectedContradictions({ outcome: 'MERGE', neverOutcomes: ['MERGE'] })).toHaveLength(1);
    expect(unsupportedExpected({ context: { sources: [{ content: 'prix 18 500,00 €' }] }, expected: { answerContains: '19 000,00 €' } } as never)[0]).toMatch(/19000 € absent/);
    expect(unsupportedExpected({ context: { sources: [{ content: 'prix 18 500,00 €' }] }, expected: { answerContains: '18 500,00 €', answerNotContains: ['20 100'] } } as never)).toEqual([]);
    expect(claimsFileWithoutPiece({ operationCode: 't1_analyze_document', context: { mimeTypes: ['image/jpeg'], extractedContent: 'transcription parfaite' } } as never)).toBe(true);
    const k = classifyHistoricalCase({ id: 'X', description: '', file: 'x.json', operationCode: 't3_operation_match', masterPromptCode: 't3_master_v1', task: 'OPERATION_MATCH', taskField: 'task', outputSchema: 'T3OperationMatchOutput', context: {}, output: {}, expected: { outcome: 'A', neverOutcomes: ['A'] }, qualificationRole: 'answer' },
      { replayable: true, duplicates: [], allCaseIds: new Set() });
    expect(k).toMatchObject({ cls: 'A_CORRIGER', status: 'A_COMPLETER' });
  });
  it('approbation impossible pour un oracle vide, une preuve tirée d’une sortie de modèle, une contradiction', () => {
    expect(oracleApprovalProblems(null)[0]).toMatch(/aucun oracle/);
    expect(oracleApprovalProblems(oracle({})).join(' ')).toMatch(/oracle vide/);
    expect(oracleApprovalProblems(oracle({ requiredFacts: [{ key: 'a', kind: 'AMOUNT', value: 1, critical: true, evidence: [{ source: 'recording.output' }] }] })).join(' ')).toMatch(/sortie de modèle/);
    expect(oracleApprovalProblems(oracle({ requiredFacts: [{ key: 'a', kind: 'AMOUNT', value: 1, critical: true, evidence: preuve }], absentFacts: [{ key: 'b', kind: 'AMOUNT', value: 1 }] })).join(' ')).toMatch(/contradiction/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('L100B-IMP — importeur (format documenté, aucune approbation par import)', () => {
  const m0 = { version: 3, generatedAt: 'x', reference: { ticket: '#601', announcedScenarios: 401, announcedStress: 15, zipReceived: false }, entries: [] as Entry[], ledger: [] as string[] };
  const ctxT3 = { operationMatch: { subject: { id: 1 }, candidates: [{ id: 2 }], candidate: {}, operations: [], plausible: [2] } };
  const src = (files: Record<string, string | Buffer>) => ({ name: 'livraison-test', files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)])) });
  const csv = [
    'identifiant;opération;traitement;famille_risque;niveau;critique;paire;côté;discriminant_change_decision;statut;motif;pièces;mode_entree',
    'Z-001;t3_operation_match;T3;T3_IDENTITE_ECONOMIQUE;difficile;oui;P-1;A;oui;RÉFÉRENCE_APPROUVÉE;;;',
    'Z-002;t5_prompt_control;T5;;;;;;;;;;',
    'Z-003;t3_operation_match;T3;;simple;oui;P-1;B;oui;;;;',
    'Z-004;t1_analyze_document;T1;T1_MULTIMODAL;simple;oui;;;;;;scan-absent.jpg;FILE',
  ].join('\n');
  const deps = { liveVariables: async (c: { context: Record<string, unknown> }) => (c.context.operationMatch ? { SUBJECT_CONTEXT: 'x' } : null), at: '2026-10-29T12:00:00Z', by: 'dev' };
  it('rapport ligne par ligne : approbation refusée, T5 non convertible, contexte absent, fichier manquant non rejouable', async () => {
    const r = await convertImport(src({
      'livraison/cases.csv': csv, 'livraison/contexts/Z-001.json': JSON.stringify(ctxT3),
      'livraison/oracles/Z-001.json': JSON.stringify({ decisions: { allowed: ['same'], forbidden: [] }, serverExpected: { outcome: 'ATTACH_EXISTING' } }),
    }), m0, deps as never);
    const l = (id: string) => r.report.lines.find((x) => x.sourceId === id)!;
    expect(l('Z-001')).toMatchObject({ outcome: 'IMPORTED', status: 'A_COMPLETER', approvalRefused: true });
    expect(l('Z-002')).toMatchObject({ outcome: 'NOT_CONVERTIBLE' });
    expect(l('Z-002').causes.join(' ')).toMatch(/inconnue du registre|T5/);
    expect(l('Z-003')).toMatchObject({ outcome: 'NOT_CONVERTIBLE' });
    expect(l('Z-003').causes.join(' ')).toMatch(/contexte d’entrée absent/);
    expect(l('Z-004').causes.join(' ')).toMatch(/pièce source « scan-absent.jpg » absente/);
    expect(r.manifest.entries.find((e) => e.id === 'Z-004')?.status).toBe('HISTORIQUE');
    expect(r.manifest.entries.every((e) => (e.status as string) !== 'REFERENCE_APPROUVEE')).toBe(true);
    // Aucune perte : chaque ligne est au manifeste (spécification conservée), registre complet.
    expect(r.manifest.entries.map((e) => e.id).sort()).toEqual(['Z-001', 'Z-002', 'Z-003', 'Z-004']);
    expect(r.manifest.version).toBe(4);
    const fixture = JSON.parse(r.writes.get('src/services/ai/governance/master-corpus/corpus-601/z-001.json')!.toString());
    expect(fixture).toMatchObject({ case: 'Z-001', qualification: { role: 'answer' }, recording: { operationCode: 't3_operation_match', task: 'OPERATION_MATCH' }, expected: { outcome: 'ATTACH_EXISTING' } });
    expect(fixture.recording.output).toBeUndefined();
    expect(importReportText(r.report)).toMatch(/approbation refusée/);
  });
  it('réimport identique : inchangé ; oracle modifié : RÉVISÉ (historique conservé) ; stress : E2E_MÉTIER', async () => {
    const files = { 'cases/Z-001.json': JSON.stringify({ id: 'Z-001', operation: 't3_operation_match', context: ctxT3, oracle: { decisions: { allowed: ['same'] } }, expected: { outcome: 'ATTACH_EXISTING' } }),
      'stress/S-01.json': JSON.stringify({ id: 'S-01', title: 'Mensualités Homiris rattachées sans omission' }) };
    const r1 = await convertImport(src(files), m0, deps as never);
    const r2 = await convertImport(src(files), r1.manifest, deps as never);
    expect(r2.report.lines.find((x) => x.sourceId === 'Z-001')?.outcome).toBe('UNCHANGED');
    expect(r1.manifest.entries.find((e) => e.id === 'S-01')).toMatchObject({ status: 'E2E_METIER', testType: 'E2E_METIER', evaluationType: 'E2E', critical: false });
    const modif = { ...files, 'cases/Z-001.json': JSON.stringify({ id: 'Z-001', operation: 't3_operation_match', context: ctxT3, oracle: { decisions: { allowed: ['same', 'probable'] } }, expected: { outcome: 'ATTACH_EXISTING' } }) };
    const r3 = await convertImport(src(modif), r2.manifest, deps as never);
    const l = r3.report.lines.find((x) => x.sourceId === 'Z-001')!;
    expect(l.outcome).toBe('REVISED');
    expect(l.warnings.join(' ')).toMatch(/oracle modifié/);
    expect(r3.manifest.entries.find((e) => e.id === 'Z-001')!.revisions).toHaveLength(2);
    expect(validateManifest(r3.manifest, null, r2.manifest)).toEqual([]);
  });
  it('lecture du ZIP (racine commune) et CSV avec guillemets', async () => {
    const JSZip = (await import('jszip')).default;
    const z = new JSZip();
    z.file('verebona_corpus/cases.json', JSON.stringify([{ id: 'Z-9', operation: 't3_operation_match', context: ctxT3 }]));
    const { readZipSource } = await import('../importer');
    const s = await readZipSource('l.zip', Buffer.from(await z.generateAsync({ type: 'uint8array' })));
    expect([...s.files.keys()]).toEqual(['cases.json']);
    expect(parseCsv('a;b\n"x;1";"di ""guillemets"""\n')).toEqual([['a', 'b'], ['x;1', 'di "guillemets"']]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('L100B-T2 — vue dédiée T2 (CDC 4 §35, réponse PO C5)', () => {
  const t2 = (i: number, cat: string) => entry({ id: `T2-${cat}-${i}`, operationCode: 't2_answer', treatment: 'T2', riskFamily: 'T2_RECHERCHE', cdc35Category: cat });
  it('avant import : insuffisante (catégories sans référence approuvée), jamais « suffisante » par défaut', () => {
    const v = t2SearchView([t2(1, 'recherche')], (e) => effectiveStatus(e, []).status, null);
    expect(v.verdict).toBe('INSUFFISANTE');
    expect(v.gaps.join(' ')).toMatch(/recherche simple.*0 référence/);
  });
  it('après import et approbation : suffisante si chaque catégorie est couverte et la précision mesurée ≥ 95 %', async () => {
    const { T2_SEARCH_CATEGORIES } = await import('../coverage');
    const entries = T2_SEARCH_CATEGORIES.flatMap((c) => Array.from({ length: T2_MIN_CASES_PER_CATEGORY }, (_, i) => t2(i, c.code)));
    const approvals = entries.map(approve);
    const statusOf = (e: Entry) => effectiveStatus(e, approvals).status;
    expect(t2SearchView(entries, statusOf, null).verdict).toBe('NON_MESUREE');
    const tous = new Map(entries.map((e) => [e.id, res(e.id, 'PASSED')]));
    expect(t2SearchView(entries, statusOf, tous)).toMatchObject({ verdict: 'SUFFISANTE', precision: { measured: 1 } });
    const fautes = new Map(entries.map((e, i) => [e.id, res(e.id, i % 10 === 0 ? 'FAILED' : 'PASSED')]));
    const v = t2SearchView(entries, statusOf, fautes);
    expect(v.verdict).toBe('INSUFFISANTE');
    expect(v.gaps.join(' ')).toMatch(/précision de recherche mesurée .* < 95/);
  });
  it('corpus actuel : vue T2 insuffisante (aucune catégorie §35.1 encore couverte) — manques listés', () => {
    const m = loadCorpusManifest();
    const v = t2SearchView(m.entries, (e) => effectiveStatus(e, []).status, null);
    expect(v.verdict).toBe('INSUFFISANTE');
    expect(v.categories).toHaveLength(9);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('L100B-R10 / LIM — rapports, harnais E2E, limites de relance', () => {
  it('harnais de stress : une étape serveur en erreur est attribuée au SERVEUR, jamais à une réponse IA', async () => {
    const r = await runStressScenario({
      id: 'S-X', title: 'exemple', setup: async () => undefined,
      steps: [{ label: 'rattachement', run: async () => { throw new Error('contrainte violée'); } }],
      assertions: [{ label: 'aucune omission', layer: 'IA', check: async () => null }],
    }, {});
    expect(r.passed).toBe(false);
    expect(r.steps[1]).toMatchObject({ ok: false, layer: 'SERVEUR' });
    expect(r.assertions[0]).toMatchObject({ ok: false, detail: 'non évaluée : scénario interrompu' });
    expect(stressReportText(r)).toMatch(/ÉCHEC — S-X/);
  });
  it('limites techniques (A4 : aucun plafond mensuel) : relances et concurrence réglables, bornées, sans changer la version des seuils', () => {
    process.env.AI_QUALIF_MAX_RETRIES = '2';
    process.env.AI_QUALIF_CONCURRENCY = '1';
    const th = withRuntimeLimits(QUALIFICATION_THRESHOLDS);
    expect(th.transientRetries).toBe(2);
    expect(th.concurrency.synchronousSimultaneous).toBe(1);
    expect(th.version).toBe(QUALIFICATION_THRESHOLDS.version);
    process.env.AI_QUALIF_MAX_RETRIES = '50';
    expect(withRuntimeLimits(QUALIFICATION_THRESHOLDS).transientRetries).toBe(QUALIFICATION_THRESHOLDS.transientRetries);
  });
});
