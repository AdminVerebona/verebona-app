/**
 * Lot 105B — promotion automatique IA sur preuves (ticket P1 « IA
 * auto-amélioration »). Recette unitaire (pure, sans base) :
 *
 *  L105B-INV   référentiel d'inventaire attendu : tout manque bloque (pas seulement un
 *              affichage), exclusion motivée visible, jamais de suppression silencieuse,
 *              complétude T2 bloquante, cas non concluants bloquants (R1) ;
 *  L105B-T6    complément T6 v11 : t6_evaluate, t6_formulate et les 3 risques T6 sont
 *              des BLOCAGES A1 du corpus réel (§8) ;
 *  L105B-R8    surveillance post-activation : régression certifiée / contrôles serveur
 *              imputables → retour arrière ; données insuffisantes, anomalie non imputable,
 *              candidate remplacée → aucun retour arrière ; latence / coût → alerte seule ;
 *  L105B-ZIP   adaptateur JSONL + rapprochement 86 + 20 + 295, 15 stress, 110 paires sur
 *              échantillon SYNTHÉTIQUE ; doublons et doubles comptages détectés ; aucune
 *              approbation par import ;
 *  L105B-PAR   paramètres centralisés et bornés (aucune baisse d'exigence possible) ;
 *  L105B-SAN   santé fonctionnelle : « en attente du verrou A1 » distinct, jamais sain.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { assessA1, structuralBlockers } = await import('../../governance/master-corpus/certification/coverage');
const inv = await import('../../governance/master-corpus/certification/expected-inventory');
const { effectiveStatus, loadCorpusManifest } = await import('../../governance/master-corpus/certification/manifest');
const { oracleFingerprint } = await import('../../governance/master-corpus/certification/oracle');
const { oracleSchema, activeQualificationOperations } = await import('../../governance/master-corpus/certification/model');
const { assessPostActivation, certifiedRegressions, EMPTY_USAGE } = await import('../post-activation');
const { promotionParams, PROMOTION_PARAMS_DEFAULTS } = await import('../promotion-params');
const ad = await import('../../governance/master-corpus/certification/zip-jsonl-adapter');
const { convertImport } = await import('../../governance/master-corpus/certification/importer');
const { passHealth, passNote, EMPTY_PASS_SUMMARY } = await import('../../prompt-conformity/prerequisite');
const { DEFERRED_P2 } = await import('../promotion-status');

type Entry = import('../../governance/master-corpus/certification/model').ManifestEntry;

const oracle = oracleSchema.parse({ version: 1, requiredFacts: [{ key: 'k', kind: 'TEXT', value: 'v', critical: true, evidence: [{ source: 'pieces/x.pdf' }] }] });
function entry(over: Partial<Entry> & { id: string }): Entry {
  return {
    sourceCaseId: over.id, file: null, operationCode: 't6_formulate', treatment: 'T6', contract: null, schema: null, riskFamily: 'T6_ACTION_UTILE',
    difficulty: 'SIMPLE', critical: true, pair: null, provenance: 'ZIP_601', sourcePieces: [], inputMode: 'STRUCTURED', testType: 'QUALITE_MODELE',
    evaluationType: 'ORACLE', status: 'A_COMPLETER', reason: 'test', historicalClass: null, cdc35Category: null, expectedSummary: null, oracle,
    revisions: [{ revision: 1, at: '2026-11-02T00:00:00Z', by: 'test', reason: 'test', changes: ['*'], oracleFingerprint: oracleFingerprint(oracle) }],
    ...over,
  } as Entry;
}
const approve = (e: Entry) => ({ caseId: e.id, oracleFingerprint: oracleFingerprint(e.oracle)!, decision: 'APPROVED' as const, at: '2026-11-02T10:00:00Z', by: 'po' });
const pass = (id: string, decisions: string[] = ['show']) => ({ caseId: id, outcome: 'PASSED' as const, decisions, defects: [], criticalDefects: [], inconclusiveReason: null });
const T6_OPS = [
  { operationCode: 't6_formulate', treatment: 'T6' as const, task: 'FORMULATE', label: 'f' },
  { operationCode: 't6_evaluate', treatment: 'T6' as const, task: 'EVALUATE', label: 'e' },
];

/** Scène T6 entièrement couverte : 2 opérations × 3 risques × 4 difficultés, une paire A/B, cas obligatoires présents. */
function sceneT6(): Entry[] {
  const l: Entry[] = [];
  for (const op of T6_OPS) {
    for (const r of inv.EXPECTED_INVENTORY.perTreatment.T6.difficulties.flatMap((d) => (['T6_ACTION_UTILE', 'T6_INFORMATION_UTILE', 'T6_SOLLICITATION_INUTILE'] as const).map((x) => [d, x] as const))) {
      l.push(entry({ id: `S-${op.operationCode}-${r[0]}-${r[1]}`.toUpperCase().replace(/_/g, '-'), operationCode: op.operationCode, difficulty: r[0], riskFamily: r[1] }));
    }
  }
  l.push(entry({ id: 'H-P-T6-01-FORMULATION-FIDELE', operationCode: 't6_formulate' }));
  l.push(entry({ id: 'H-P-T6-EV-01-DECISION-VALIDE', operationCode: 't6_evaluate' }));
  l.push(entry({ id: 'PAIRE-T6-A', testType: 'PAIRE_ADVERSARIALE', pair: { id: 'P-T6', side: 'A', discriminantChangesDecision: true } }));
  l.push(entry({ id: 'PAIRE-T6-B', testType: 'PAIRE_ADVERSARIALE', pair: { id: 'P-T6', side: 'B', discriminantChangesDecision: true } }));
  return l;
}
const sansTotaux = { ...inv.EXPECTED_INVENTORY, totals: { historical: 0, toRevalidate: 0, newScenarios: 0, stress: 0, pairs: 0 } };

afterEach(() => inv.__setExpectedInventoryForTests(null));

describe('L105B-INV — référentiel d’inventaire attendu versionné : tout manque BLOQUE la promotion', () => {
  // Lot 113I (CDC V2 EC-03, COR-03, CORP-01, REC-039) — RÈGLE DÉLIBÉRÉMENT CHANGÉE : les totaux globaux du ZIP #601 sont
  // un INDICATEUR (exigences listées « non satisfaites ») et ne bloquent plus un traitement dont le périmètre est couvert.
  it('scène T6 complète, toutes approuvées et réussies : autorisée — avec les totaux #601 incomplets aussi (indicateur, plus de blocage croisé)', () => {
    const l = sceneT6();
    const approvals = l.map(approve);
    const statusOf = (e: Entry) => effectiveStatus(e, approvals).status;
    const results = new Map(l.map((e) => [e.id, pass(e.id, e.id === 'PAIRE-T6-B' ? ['hide'] : ['show'])]));
    const ok = assessA1({ treatments: ['T6'], entries: l, statusOf, results, operations: T6_OPS, inventory: sansTotaux });
    expect(ok.blockers).toEqual([]);
    expect(ok.allowed).toBe(true);
    const avecTotaux = assessA1({ treatments: ['T6'], entries: l, statusOf, results, operations: T6_OPS });
    expect(avecTotaux.allowed).toBe(true);
    expect(avecTotaux.blockers.filter((b) => b.code === 'INVENTORY_INCOMPLETE')).toEqual([]);
    expect(structuralBlockers(avecTotaux).length).toBe(0);
    // L'incomplétude reste VISIBLE (exigences non satisfaites), jamais masquée.
    expect(avecTotaux.inventory!.requirements.filter((r) => r.id.startsWith('totals.') && !r.met).map((r) => r.id).sort()).toEqual(['totals.historical', 'totals.newScenarios', 'totals.pairs', 'totals.stress', 'totals.toRevalidate']);
  });

  it('difficulté, type de test, paire, cas obligatoire absents → blocages structurels distincts ; cas non approuvé → CASE_NOT_APPROVED', () => {
    const l = sceneT6().filter((e) => e.difficulty !== 'ADVERSARIAL' && !e.pair && e.id !== 'H-P-T6-EV-01-DECISION-VALIDE');
    l.push(entry({ id: 'NON-APPROUVE', operationCode: 't6_evaluate', critical: false }));
    const approvals = l.filter((e) => e.id !== 'NON-APPROUVE').map(approve);
    const a = assessA1({ treatments: ['T6'], entries: l, statusOf: (e) => effectiveStatus(e, approvals).status, results: new Map(l.map((e) => [e.id, pass(e.id)])), operations: T6_OPS, inventory: sansTotaux });
    const codes = a.blockers.map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(['DIFFICULTY_NOT_COVERED', 'TEST_TYPE_NOT_COVERED', 'PAIRS_MISSING', 'REQUIRED_CASE_MISSING', 'CASE_NOT_APPROVED']));
    expect(a.blockers.find((b) => b.code === 'REQUIRED_CASE_MISSING')?.caseId).toBe('H-P-T6-EV-01-DECISION-VALIDE');
    expect(a.blockers.every((b) => b.structural)).toBe(true);
  });

  it('cas approuvé non exécuté / non concluant sur la candidate → CASE_NOT_CONCLUSIVE (non structurel : un nouvel essai peut le lever)', () => {
    const l = sceneT6().map((e) => (e.id.startsWith('S-T6-EVALUATE-SIMPLE') ? { ...e, critical: false } : e));
    const approvals = l.map(approve);
    const results = new Map(l.filter((e) => !e.id.startsWith('S-T6-EVALUATE-SIMPLE')).map((e) => [e.id, pass(e.id, e.id === 'PAIRE-T6-B' ? ['hide'] : ['show'])]));
    const a = assessA1({ treatments: ['T6'], entries: l, statusOf: (e) => effectiveStatus(e, approvals).status, results, operations: T6_OPS, inventory: sansTotaux });
    const b = a.blockers.find((x) => x.code === 'CASE_NOT_CONCLUSIVE')!;
    expect(b).toMatchObject({ operationCode: 't6_evaluate', structural: false });
    expect(structuralBlockers(a)).toEqual([]);
  });

  it('exclusion MOTIVÉE dans le référentiel : l’exigence reste listée « exclue (motif) », jamais supprimée en silence', () => {
    const l = sceneT6().filter((e) => !e.pair);
    const approvals = l.map(approve);
    const avec = { ...sansTotaux, exclusions: [{ requirement: 'pairs.T6', reason: 'le ZIP ne contient aucune paire T6 (à confirmer)', decidedBy: 'PO', at: '2026-11-02' }] };
    const a = assessA1({ treatments: ['T6'], entries: l, statusOf: (e) => effectiveStatus(e, approvals).status, results: new Map(l.map((e) => [e.id, pass(e.id)])), operations: T6_OPS, inventory: avec });
    expect(a.blockers.some((b) => b.code === 'PAIRS_MISSING')).toBe(false);
    expect(a.inventory?.waived.map((w) => [w.id, w.waived?.reason])).toEqual([['pairs.T6', 'le ZIP ne contient aucune paire T6 (à confirmer)']]);
    expect(a.inventory?.requirements.find((r) => r.id === 'pairs.T6')).toMatchObject({ met: false });
  });

  it('T2 : complétude CDC 4 §35.3 intégrée à la décision bloquante (catégories, précision ≥ 95 %)', () => {
    const ops = [{ operationCode: 't2_answer', treatment: 'T2' as const, task: 'ANSWER', label: 'a' }];
    const e = entry({ id: 'T2-1', operationCode: 't2_answer', treatment: 'T2', riskFamily: 'T2_RECHERCHE', cdc35Category: 'dates' });
    const a = assessA1({ treatments: ['T2'], entries: [e], statusOf: (x) => effectiveStatus(x, [approve(e)]).status, results: new Map([[e.id, pass(e.id)]]), operations: ops, inventory: sansTotaux });
    expect(a.blockers.find((b) => b.code === 'T2_INCOMPLETE')?.message).toMatch(/complétude CDC 4 §35 insuffisante/);
  });

  it('identifiants d’exigence stables (exclusion exacte) ; version du référentiel exposée', () => {
    const ids = inv.requirementIds(inv.EXPECTED_INVENTORY, activeQualificationOperations());
    expect(ids).toEqual(expect.arrayContaining(['totals.stress', 'pairs.T6', 'difficulty.T1.ADVERSARIAL', 'case.H-P-T6-01-FORMULATION-FIDELE', 'approval.t6_evaluate', 't2.completeness']));
    expect(inv.EXPECTED_INVENTORY.version).toMatch(/^inventaire-attendu-v\d+$/);
    expect(inv.EXPECTED_INVENTORY.totals.historical + inv.EXPECTED_INVENTORY.totals.toRevalidate + inv.EXPECTED_INVENTORY.totals.newScenarios).toBe(401);
  });
});

describe('L105B-T6 — complément T6 v11 : manques T6 présentés comme BLOCAGES A1 (corpus réel)', () => {
  it('t6_evaluate et t6_formulate sans référence approuvée, 3 risques T6 non couverts, cas critiques sans oracle approuvé : blocages structurels', () => {
    const m = loadCorpusManifest();
    const a = assessA1({ treatments: ['T6'], entries: m.entries, statusOf: (e) => effectiveStatus(e, []).status, results: null });
    expect(a.allowed).toBe(false);
    expect(a.blockers.filter((b) => b.code === 'OPERATION_NOT_COVERED').map((b) => b.operationCode).sort()).toEqual(['t6_evaluate', 't6_formulate']);
    expect(a.blockers.filter((b) => b.code === 'RISK_NOT_COVERED').map((b) => b.message).join(' ')).toMatch(/action utile.*information utile.*sollicitation inutile/);
    expect(a.blockers.filter((b) => b.code === 'CRITICAL_WITHOUT_APPROVED_ORACLE').map((b) => b.caseId)).toEqual(expect.arrayContaining(['H-P-T6-01-FORMULATION-FIDELE', 'H-P-T6-EV-01-DECISION-VALIDE']));
    expect(structuralBlockers(a).length).toBeGreaterThanOrEqual(5);
  });
  it('« Tester avec le corpus » : libellé BO = rejeu sans appel modèle, distinct de la qualification et de la preuve A1', async () => {
    const { readFileSync } = await import('node:fs');
    const ui = readFileSync('src/app/admin/ai-config/_components/MasterPrompts.tsx', 'utf8');
    expect(ui).toContain('Tester avec le corpus');
    expect(ui).toContain('rejoue les scénarios de référence sans appeler le modèle');
    expect(ui).toMatch(/ni la qualification IA réelle[\s\S]*ni la preuve de couverture A1/);
  });
});

describe('L105B-R8 — surveillance post-activation : retour arrière seulement si la dégradation imputable est démontrée', () => {
  const w = PROMOTION_PARAMS_DEFAULTS.watch;
  const usage = (calls: number, invalid = 0, providerErrors = 0, p95Ms: number | null = 1000, costPerValid: number | null = 100) => ({ calls, success: calls - invalid - providerErrors, invalid, providerErrors, p95Ms, costPerValid });
  const regression = { operationCode: 't3_operation_match', caseId: 'corpus:P-T3-08', defects: ['INCORRECT_VALUE : Opération fusionnée à tort'] };

  it('JSON valide mais régression métier certifiée (cas réussi par l’ancienne version, en échec avec la candidate) → retour arrière', () => {
    const a = assessPostActivation({ before: usage(50), after: usage(50), replay: { campaignId: 9, status: 'COMPLETED', regressions: [regression], reason: null }, candidateActive: true, params: w });
    expect(a).toMatchObject({ verdict: 'DEGRADED_IMPUTABLE', rollback: true });
    expect(a.reasons.join(' ')).toMatch(/régression\(s\) certifiée\(s\).*P-T3-08/);
  });
  it('contrôles serveur : hausse imputable des sorties refusées (appels attribués à la candidate) → retour arrière', () => {
    expect(assessPostActivation({ before: usage(100, 1), after: usage(100, 12), replay: null, candidateActive: true, params: w })).toMatchObject({ verdict: 'DEGRADED_IMPUTABLE', rollback: true });
  });
  it('absence de preuve (trop peu d’appels, rejeu non concluant) → aucun retour arrière abusif', () => {
    const a = assessPostActivation({ before: usage(3), after: usage(2, 2), replay: { campaignId: null, status: 'REFUSED', regressions: null, reason: 'compte technique' }, candidateActive: true, params: w });
    expect(a).toMatchObject({ verdict: 'INSUFFICIENT_DATA', rollback: false });
  });
  it('candidate remplacée par un humain → non imputable, aucun retour arrière', () => {
    expect(assessPostActivation({ before: usage(100), after: usage(100, 50), replay: null, candidateActive: false, params: w })).toMatchObject({ verdict: 'NOT_IMPUTABLE', rollback: false });
  });
  it('latence / coût dégradés seuls → ALERTE, jamais un retour arrière', () => {
    const a = assessPostActivation({ before: usage(100, 0, 0, 1000, 100), after: usage(100, 0, 0, 2000, 200), replay: null, candidateActive: true, params: w });
    expect(a).toMatchObject({ verdict: 'ALERT', rollback: false });
    expect(a.signals.filter((s) => s.outcome === 'ALERT').map((s) => s.code).sort()).toEqual(['COST', 'LATENCY']);
  });
  it('un défaut commun aux deux versions n’est jamais une régression certifiée imputable', () => {
    const cmp = (ref: string, cand: string) => ({ caseId: 'c', source: 'CORPUS_FIXTURE', mandatory: true, reference: ref, candidate: cand, defects: [], inconclusive: null });
    const op = { operationCode: 'o', referenceVerdict: null, candidateVerdict: null, cases: { total: 0, mandatory: 0, verifiableMandatory: 0, candidatePassed: 0, referencePassed: 0 }, improvements: [], inconclusive: [], defects: [], cost: { referencePerValid: null, candidatePerValid: null, ratio: null }, reasons: [], decision: 'REFUSED' as const };
    const both = { decision: 'REFUSED' as const, operations: [{ ...op, regressions: [] }], coverage: { required: null, matchingCases: [], passed: [], ok: true }, refusalReasons: [], blockingReasons: [] };
    expect(certifiedRegressions(both as never)).toEqual([]);
    const reelle = { ...both, operations: [{ ...op, regressions: [cmp('PASSED', 'FAILED'), cmp('PASSED', 'INCONCLUSIVE')] }] };
    expect(certifiedRegressions(reelle as never)).toHaveLength(1);
    expect(assessPostActivation({ before: EMPTY_USAGE, after: EMPTY_USAGE, replay: null, candidateActive: true, params: w }).rollback).toBe(false);
  });
});

describe('L105B-ZIP — adaptateur JSONL et rapprochement (échantillon SYNTHÉTIQUE, ZIP #601 non disponible)', () => {
  const m = loadCorpusManifest();
  const hist = m.entries.filter((e) => e.provenance === 'HISTORIQUE_86');
  function livraison(): Map<string, Buffer> {
    const lignes = (l: Array<Record<string, unknown>>) => Buffer.from(l.map((x) => JSON.stringify(x)).join('\n'));
    const historiques = hist.map((e, i) => ({ case_id: `ZH-${i}`, lot: 'historique', historical_id: e.sourceCaseId ?? e.id, operation: e.operationCode }));
    const revalider = Array.from({ length: 20 }, (_, i) => ({ case_id: `ZR-${i}`, lot: 'à revalider', operation: 't3_operation_match' }));
    const nouveaux = Array.from({ length: 295 }, (_, i) => ({
      case_id: `ZN-${i}`, lot: 'nouveau', operation: 't4_classify_event', status: i === 0 ? 'RÉFÉRENCE_APPROUVÉE' : 'à compléter',
      ...(i < 220 ? { pair_id: `ZP-${Math.floor(i / 2)}`, pair_side: i % 2 ? 'B' : 'A', discriminant_changes_decision: true } : {}),
    }));
    const stress = Array.from({ length: 15 }, (_, i) => ({ case_id: `ZS-${i}`, description: `stress ${i}` }));
    return new Map([
      ['livraison/historique.jsonl', lignes(historiques)], ['livraison/revalider.jsonl', lignes(revalider)],
      ['livraison/nouveaux.jsonl', lignes(nouveaux)], ['livraison/stress.jsonl', lignes(stress)],
    ]);
  }
  it('86 historiques + 20 à revalider + 295 nouveaux = 401, 15 stress, 110 paires : rapprochement conforme, chaque entrée comptée une fois', () => {
    expect(hist.length).toBe(86);
    const src = { name: 'synthetique.zip', files: livraison() };
    const r = ad.reconcileInventory({ lines: ad.readJsonl(src), manifest: m, expected: inv.EXPECTED_INVENTORY.totals });
    expect(r.delivered).toEqual({ historical: 86, toRevalidate: 20, newScenarios: 295, stress: 15, pairs: 110, total: 401 });
    expect(r.unmatchedHistorical).toEqual([]);
    expect(r.ok).toBe(true);
    expect(ad.reconcileReportText(r)).toMatch(/CONFORME/);
  });
  it('doublons, historique revendiqué deux fois, stress compté aussi comme scénario, ligne illisible : listés, jamais comptés deux fois', () => {
    const files = livraison();
    files.set('livraison/zz-extra.jsonl', Buffer.from([
      JSON.stringify({ case_id: 'ZN-1', lot: 'nouveau' }),
      JSON.stringify({ case_id: 'ZH-X', lot: 'historique', historical_id: hist[0].sourceCaseId ?? hist[0].id }),
      JSON.stringify({ case_id: 'ZS-3', lot: 'nouveau' }),
      JSON.stringify({ case_id: hist[1].id, lot: 'nouveau' }),
      '{ pas du json',
    ].join('\n')));
    const r = ad.reconcileInventory({ lines: ad.readJsonl({ name: 'x', files }), manifest: m, expected: inv.EXPECTED_INVENTORY.totals });
    const extra = r.lines.filter((l) => l.file.endsWith('zz-extra.jsonl')).map((l) => l.outcome);
    expect(extra).toEqual(['DUPLICATE', 'DOUBLE_COUNT', 'DOUBLE_COUNT', 'DOUBLE_COUNT', 'UNREADABLE']);
    expect(r.delivered).toMatchObject({ historical: 86, newScenarios: 295, stress: 15 });
    expect(r.ok).toBe(false);
  });
  it('adaptateur → format documenté de l’importeur : groupe d’inventaire porté, stress séparés ; aucune approbation par import', async () => {
    const files = new Map([...livraison().entries()].map(([k, v]) => [k.replace('livraison/', ''), v]));
    const a = ad.adaptJsonl({ name: 'synthetique', files });
    expect(a.errors).toEqual([]);
    const cases = JSON.parse(a.source.files.get('cases.json')!.toString('utf8')) as Array<Record<string, unknown>>;
    const stress = JSON.parse(a.source.files.get('stress.json')!.toString('utf8')) as Array<Record<string, unknown>>;
    expect(cases).toHaveLength(401);
    expect(stress).toHaveLength(15);
    expect(cases.filter((c) => c.inventoryGroup === 'NOUVEAU')).toHaveLength(295);
    // Conversion sur un échantillon (premier nouveau, statut « approuvé » fourni) : refusé, jamais RÉFÉRENCE_APPROUVÉE.
    const un = { name: 'un', files: new Map([['cases.json', Buffer.from(JSON.stringify(cases.filter((c) => c.id === 'ZN-0')))]]) };
    const conv = await convertImport(un, m, { liveVariables: async () => null, at: '2026-11-02T00:00:00Z' });
    expect(conv.report.lines[0]).toMatchObject({ approvalRefused: true });
    const e = conv.manifest.entries.find((x) => x.sourceCaseId === 'ZN-0');
    expect(e?.status).not.toBe('REFERENCE_APPROUVEE');
    expect(e?.inventoryGroup).toBe('NOUVEAU');
  });
});

describe('L105B-PAR / SAN — paramètres bornés, santé fonctionnelle, P2 différé', () => {
  it('surcharges hors bornes ignorées (défaut conservé) ; aucune surcharge ne touche le verrou A1 ni les seuils de qualité', () => {
    const p = promotionParams({ AI_PROMOTION_WATCH_HOURS: '0', AI_PROMOTION_WATCH_MIN_CALLS: 'abc', AI_PROMOTION_MAX_A1_RELAUNCHES: '999', AI_PROMOTION_REPLAY_AFTER_HOURS: '6' });
    expect(p.watch.windowMs).toBe(PROMOTION_PARAMS_DEFAULTS.watch.windowMs);
    expect(p.watch.minCalls).toBe(PROMOTION_PARAMS_DEFAULTS.watch.minCalls);
    expect(p.relaunch.maxPerCandidate).toBe(PROMOTION_PARAMS_DEFAULTS.relaunch.maxPerCandidate);
    expect(p.watch.replayAfterMs).toBe(6 * 3_600_000);
    expect(Object.keys(p)).toEqual(['version', 'gate', 'relaunch', 'watch']);
  });
  it('« en attente du verrou A1 » : jamais présenté sain, cause explicite, compteur distinct dans la note', () => {
    const s = { ...EMPTY_PASS_SUMMARY, detected: 2, eligible: 2, waitingA1: 2 };
    const h = passHealth({ summary: s, mode: 'auto', maxPerPass: 1, corpus: null });
    expect(h).toMatchObject({ code: 'NO_PROGRESS', healthy: false });
    expect(h.cause).toMatch(/verrou A1/);
    expect(passNote(h, s)).toMatch(/2 en attente du verrou A1/);
  });
  it('P2 différé listé explicitement avec ce qui serait nécessaire', () => {
    expect(DEFERRED_P2.map((d) => d.title).join(' ')).toMatch(/prompts[\s\S]*paramètres/);
    expect(DEFERRED_P2.every((d) => d.needs.length >= 3)).toBe(true);
  });
});
