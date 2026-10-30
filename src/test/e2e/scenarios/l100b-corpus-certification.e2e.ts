/**
 * Lot 100B sur PostgreSQL 16 réel — certification du corpus de qualification
 * IA (ticket #601 ; arbitrages PO A1, C2, C5). Migration 0870. Fournisseur
 * SIMULÉ : aucun appel modèle (les promotions sont jugées sur des
 * observations construites).
 *
 *   L100B-E01  tables 0870 créées, migration rejouable, classées au diagnostic
 *              global, conservées à la restauration ; colonnes de coût (cache)
 *   L100B-E02  BO : vue d'ensemble (manifeste, matrice, verrou A1, vue T2) ;
 *              approbation INDIVIDUELLE sur sources vérifiées (desktop / mobile),
 *              jamais en masse, jamais d'une garde, jamais sans sources, oracle
 *              affiché = oracle approuvé ; révocation / rejet motivés ;
 *              routes réservées aux administrateurs
 *   L100B-E03  recette 8 : approuver ou révoquer un oracle change l'empreinte du
 *              corpus de l'opération → les qualifications antérieures deviennent
 *              obsolètes ; l'oracle approuvé s'ajoute aux contrôles du cas
 *   L100B-E04  recettes 7 et 9 : verrou A1 journalisé ; opération non couverte,
 *              côté de paire en échec, plus rapide mais erroné → promotion
 *              refusée ; activation automatique sans jeton A1 refusée
 *              (A1_COVERAGE_LOCK) ; activation manuelle (#345) : manques affichés
 *   L100B-E05  recette 10 : coûts mesurés (fournisseur réel / cache) par
 *              campagne × modèle ; rapports CSV et JSON exportables
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin-l100b@e2e.test', role: 'ADMIN' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => { if (session.role !== 'ADMIN') throw Object.assign(new Error('forbidden'), { status: 403 }); return session.adminId; },
    getSession: async () => ({ userId: session.adminId, email: session.email, role: session.role }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

type Json = Record<string, any>;

scenario('L100B', 'Certification du corpus de qualification IA (#601, verrou A1)', ({ sql, make }) => {
  let adminId = 0;
  const route = () => import('@/app/api/admin/ai/corpus/route');
  async function get(q = ''): Promise<{ status: number; body: Json }> {
    const { NextRequest } = await import('next/server');
    const res = await (await route()).GET(new NextRequest(`http://app.test/api/admin/ai/corpus${q}`) as never);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  async function post(body: Json): Promise<{ status: number; body: Json }> {
    const { NextRequest } = await import('next/server');
    const res = await (await route()).POST(new NextRequest('http://app.test/api/admin/ai/corpus', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) as never);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  beforeAll(async () => {
    const admin = await make.user({ role: 'ADMIN', email: session.email });
    adminId = admin.id;
    session.adminId = admin.id;
    await sql`DELETE FROM ai_corpus_oracle_approvals`;
    await sql`DELETE FROM ai_corpus_case_decisions`;
    await sql`DELETE FROM ai_corpus_a1_assessments`;
  });
  afterAll(async () => {
    (await import('@/services/ai/governance/master-corpus/certification/manifest')).__setCorpusManifestForTests(null);
    (await import('@/services/ai/qualification/context')).__resetQualificationContextForTests();
  });

  it('L100B-E01 — tables 0870, migration rejouable, diagnostic global, restauration', async () => {
    for (const t of ['ai_corpus_oracle_approvals', 'ai_corpus_case_decisions', 'ai_corpus_a1_assessments']) {
      const [r] = await sql<Json[]>`SELECT to_regclass(${t}) AS t`;
      expect(r.t, t).toBe(t);
    }
    const cols = (await sql<Json[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_qualification_cases'`).map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['from_cache', 'attempts', 'manifest_case_id']));
    await sql.begin(async (tx) => { await tx.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations/0870_l100b_certification_corpus.sql'), 'utf8')); });
    const { DIAG_TABLE_COVERAGE } = await import('@/services/admin/diagnostics-export/coverage');
    const { RECETTE_EXCLUDED } = await import('@/services/admin/diagnostics-export/recette-catalog');
    const { RESTORE_KEEP_CURRENT_TABLES } = await import('@/services/backup/schema-signature');
    for (const t of ['ai_corpus_oracle_approvals', 'ai_corpus_case_decisions', 'ai_corpus_a1_assessments']) {
      expect(DIAG_TABLE_COVERAGE[t]?.transversal, t).toBeTruthy();
      expect(RECETTE_EXCLUDED[t], t).toMatch(/qualification IA/);
      expect(RESTORE_KEEP_CURRENT_TABLES).toContain(t);
    }
    // Une approbation sans source est impossible même en SQL direct (contrainte).
    await expect(sql`INSERT INTO ai_corpus_oracle_approvals (case_id, manifest_version, oracle_fingerprint, decision, sources, admin_label) VALUES ('X', 1, 'f', 'APPROVED', '[]'::jsonb, 'a')`).rejects.toThrow();
  });

  const CAS = 'H-P-T3-08-OPERATION-MATCH-MEME-CERTAIN';

  it('L100B-E02 — BO : approbation individuelle sur sources, jamais en masse ; révocation et rejet motivés', async () => {
    const o = await get();
    expect(o.status).toBe(200);
    expect(o.body.manifest.entries).toBeGreaterThan(100);
    expect(o.body.activeOperations.length).toBeGreaterThanOrEqual(15);
    expect(o.body.a1.every((a: Json) => a.allowed === false)).toBe(true);
    expect(o.body.t2.verdict).toBe('INSUFFISANTE');
    const cas = o.body.entries.find((e: Json) => e.id === CAS);
    expect(cas).toMatchObject({ status: 'A_COMPLETER', approvable: true });
    // En masse : refusé.
    expect((await post({ action: 'approve', caseIds: [CAS, 'H-P-T3-12-OPERATION-MATCH-AMBIGU-SANS-IMPACT'], caseId: CAS })).body.error).toBe('ONE_CASE_ONLY');
    // Sans source : refusé ; garde : jamais une référence ; oracle différent de celui affiché : refusé.
    expect((await post({ action: 'approve', caseId: CAS, oracleFingerprint: cas.oracleFingerprint, sources: [] })).body.error).toBe('SOURCES_REQUIRED');
    const garde = o.body.entries.find((e: Json) => e.status === 'GARDE_SERVEUR');
    expect((await post({ action: 'approve', caseId: garde.id, oracleFingerprint: garde.oracleFingerprint ?? 'x', sources: ['s'] })).body.error).toBe('NOT_APPROVABLE');
    expect((await post({ action: 'approve', caseId: CAS, oracleFingerprint: 'autre', sources: cas.sourceChoices })).status).toBe(409);
    // Approbation (mobile) : tracée, statut calculé RÉFÉRENCE_APPROUVÉE.
    const a = await post({ action: 'approve', caseId: CAS, oracleFingerprint: cas.oracleFingerprint, sources: cas.sourceChoices, comment: 'relu sur le contexte', channel: 'mobile' });
    expect(a.status).toBe(200);
    const [row] = await sql<Json[]>`SELECT * FROM ai_corpus_oracle_approvals WHERE id = ${a.body.approvalId}`;
    expect(row).toMatchObject({ case_id: CAS, decision: 'APPROVED', channel: 'mobile', admin_user_id: adminId, oracle_fingerprint: cas.oracleFingerprint });
    const apres = (await get('?treatment=T3')).body.entries.find((e: Json) => e.id === CAS);
    expect(apres).toMatchObject({ status: 'REFERENCE_APPROUVEE', approval: { by: session.email } });
    expect((await post({ action: 'approve', caseId: CAS, oracleFingerprint: cas.oracleFingerprint, sources: cas.sourceChoices })).body.error).toBe('ALREADY_APPROVED');
    // Révocation et rejet : motif obligatoire, rien n'est supprimé.
    expect((await post({ action: 'revoke', caseId: CAS, reason: '' })).body.error).toBe('REASON_REQUIRED');
    expect((await post({ action: 'reject', caseId: 'H-P-T3-12-OPERATION-MATCH-AMBIGU-SANS-IMPACT', reason: 'attendu à revoir (test)' })).status).toBe(200);
    const rej = (await get('?treatment=T3')).body;
    expect(rej.entries.find((e: Json) => e.id === 'H-P-T3-12-OPERATION-MATCH-AMBIGU-SANS-IMPACT')).toMatchObject({ status: 'REJETEE' });
    expect(rej.exclusions.some((x: Json) => x.id === 'H-P-T3-12-OPERATION-MATCH-AMBIGU-SANS-IMPACT')).toBe(true);
    expect((await post({ action: 'restore', caseId: 'H-P-T3-12-OPERATION-MATCH-AMBIGU-SANS-IMPACT', reason: 'attendu revu (test)' })).status).toBe(200);
    // Audit du geste.
    const [audit] = await sql<Json[]>`SELECT count(*)::int AS n FROM ai_admin_audit_log WHERE action_type = 'ai_corpus_oracle_approved'`;
    expect(audit.n).toBeGreaterThanOrEqual(1);
    session.role = 'USER';
    try { expect((await get()).status).toBe(401); } finally { session.role = 'ADMIN'; }
  });

  it('L100B-E03 — recette 8 : approbation / révocation / modification d’oracle → empreinte du corpus changée, qualification ancienne obsolète', async () => {
    const { buildCaseSet } = await import('@/services/ai/qualification/cases');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const { __resetQualificationContextForTests } = await import('@/services/ai/qualification/context');
    __resetQualificationContextForTests();
    const avec = await buildCaseSet('t3_operation_match', { readMasterFile: readMasterFileFromRepo });
    const c = avec.cases.find((x) => x.caseId === 'corpus:P-T3-08')!;
    expect(c).toMatchObject({ manifestCaseId: CAS, expectedSource: 'REFERENCE' });
    // La sortie enregistrée (bonne réponse) passe l'oracle approuvé et les contrôles serveur.
    const f = JSON.parse(readFileSync(join(process.cwd(), 'src/services/ai/reconciliation/master/__fixtures__/p-t3-08-operation-match-meme-certain.json'), 'utf8'));
    expect((await c.evaluate(f.recording.output, { masterText: readMasterFileFromRepo })).defects).toEqual([]);
    // Révocation : empreinte changée.
    expect((await post({ action: 'revoke', caseId: CAS, reason: 'nouvelle relecture demandée' })).status).toBe(200);
    const sans = await buildCaseSet('t3_operation_match', { readMasterFile: readMasterFileFromRepo });
    expect(sans.corpusFingerprint).not.toBe(avec.corpusFingerprint);
    // Oracle modifié (révision du manifeste) : empreinte encore différente, approbation antérieure caduque.
    const mf = await import('@/services/ai/governance/master-corpus/certification/manifest');
    const m = mf.loadCorpusManifest();
    const e = m.entries.find((x) => x.id === CAS)!;
    const revu = mf.reviseEntry(e, { oracle: { ...e.oracle!, version: 2, notes: 'oracle précisé (e2e)' } }, 'e2e', 'oracle modifié');
    mf.__setCorpusManifestForTests({ ...m, version: m.version + 1, entries: m.entries.map((x) => (x.id === CAS ? revu : x)) });
    try {
      const modifie = await buildCaseSet('t3_operation_match', { readMasterFile: readMasterFileFromRepo });
      expect(modifie.corpusFingerprint).not.toBe(sans.corpusFingerprint);
      const st = (await get('?treatment=T3')).body.entries.find((x: Json) => x.id === CAS);
      expect(st.status).toBe('A_COMPLETER');
      expect(st.oracle.version).toBe(2);
      // Une qualification signée avec l'ancienne empreinte est obsolète.
      const { stateOfCouple } = await import('@/services/ai/qualification/states');
      const { coupleSignature } = await import('@/services/ai/qualification/signature');
      const parts = (corpus: string) => ({ operationCode: 't3_operation_match', rank: 0, model: 'm', profile: {}, promptFingerprint: 'p', contractFingerprint: 'c', corpusFingerprint: corpus, evaluatorFingerprint: 'e', capabilitiesSha256: null, thresholdsVersion: 'v' });
      const s = stateOfCouple({ evidences: [{ id: 1, verdict: 'ADMISSIBLE', signature: coupleSignature(parts(avec.corpusFingerprint)), parts: parts(avec.corpusFingerprint), createdAt: new Date().toISOString() }], current: { signature: coupleSignature(parts(modifie.corpusFingerprint)), parts: parts(modifie.corpusFingerprint) } });
      expect(s).toMatchObject({ state: 'OBSOLETE', changed: ['corpus'] });
    } finally {
      mf.__setCorpusManifestForTests(null);
    }
  });

  it('L100B-E04 — recettes 7 et 9 : verrou A1 journalisé ; activation automatique sans jeton refusée ; activation manuelle informée', async () => {
    const promo = await import('@/services/ai/governance/master-corpus/certification/promotion');
    const { getAiEnvironment } = await import('@/services/ai/config/environment');
    const env = getAiEnvironment();
    // Corpus réel : T3 non couvert (références non approuvées) → refus, journal.
    const r0 = await promo.assessPromotion({ context: 'AUTO_CANDIDATE', environment: env, treatments: ['T3'], observations: [], campaignId: null, candidateVersionId: null });
    expect(r0.token).toBeNull();
    expect(r0.assessment.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['OPERATION_NOT_COVERED', 'CRITICAL_WITHOUT_APPROVED_ORACLE']));
    const [j] = await sql<Json[]>`SELECT * FROM ai_corpus_a1_assessments ORDER BY id DESC LIMIT 1`;
    expect(j).toMatchObject({ context: 'AUTO_CANDIDATE', allowed: false, treatments: ['T3'] });
    // Corpus de scène entièrement approuvé : promotion permise si tout réussit ; refusée si un côté de paire échoue,
    // ou si le modèle plus rapide se trompe sur un risque critique.
    const mf = await import('@/services/ai/governance/master-corpus/certification/manifest');
    const { oracleFingerprint } = await import('@/services/ai/governance/master-corpus/certification/oracle');
    const { activeQualificationOperations, RISK_FAMILIES } = await import('@/services/ai/governance/master-corpus/certification/model');
    const ops = activeQualificationOperations().filter((o) => o.treatment === 'T6');
    const oracle = { version: 1, requiredFacts: [{ key: 'k', kind: 'TEXT' as const, value: 'v', critical: true, evidenceRequired: false, evidence: [{ source: 'pieces/x.pdf' }] }], absentFacts: [], entities: { expected: [], forbidden: [] }, decisions: { allowed: [], forbidden: [] }, abstention: { expected: 'EITHER' as const }, allowedSources: [], equivalences: [], amountTolerance: 0 };
    const entries = ops.flatMap((o, i) => RISK_FAMILIES.T6.map((r, k) => ({
      id: `S-${i}-${k}`, sourceCaseId: `S-${i}-${k}`, file: null, operationCode: o.operationCode, treatment: 'T6' as const, contract: null, schema: null, riskFamily: r, difficulty: 'SIMPLE' as const,
      critical: true, pair: k === 0 ? { id: `PAIRE-${i}`, side: (i % 2 ? 'B' : 'A') as 'A' | 'B', discriminantChangesDecision: false } : null, provenance: 'ZIP_601' as const, sourcePieces: [], inputMode: 'STRUCTURED' as const,
      testType: 'QUALITE_MODELE' as const, evaluationType: 'ORACLE' as const, status: 'A_COMPLETER' as const, reason: 'scène', historicalClass: null, cdc35Category: null, oracle, expectedSummary: null,
      revisions: [{ revision: 1, at: '2026-10-29T00:00:00Z', by: 'e2e', reason: 'scène', changes: ['*'], oracleFingerprint: oracleFingerprint(oracle) }],
    })));
    // Paire complète : PAIRE-0 côté A (op 0) et côté B porté par l'op 1.
    entries.find((e) => e.id === 'S-1-0')!.pair = { id: 'PAIRE-0', side: 'B', discriminantChangesDecision: false };
    mf.__setCorpusManifestForTests({ version: 99, generatedAt: 'x', reference: { ticket: '#601', announcedScenarios: 401, announcedStress: 15, zipReceived: true }, entries, ledger: entries.map((e) => e.id) });
    try {
      for (const e of entries) {
        await sql`INSERT INTO ai_corpus_oracle_approvals (case_id, manifest_version, oracle_version, oracle_fingerprint, decision, sources, admin_user_id, admin_label)
                  VALUES (${e.id}, 99, 1, ${oracleFingerprint(oracle)}, 'APPROVED', '["pieces/x.pdf"]'::jsonb, ${adminId}, 'e2e')`;
      }
      const obs = (fail: string | null) => entries.map((e) => ({
        caseId: `corpus:${e.id}`, manifestCaseId: e.id, source: 'CORPUS_FIXTURE' as const, expectedSource: 'REFERENCE' as const, mandatory: true, observation: 1,
        outcome: e.id === fail ? 'FAILED' as const : 'PASSED' as const, defects: e.id === fail ? [{ category: 'INCORRECT_VALUE' as const, message: 'sollicitation inutile conservée' }] : [],
        inconclusiveReason: null, durationMs: 10, timeoutMs: 1000, costMicros: 1, servedModel: 'm', traceId: e.id, decisions: ['show'],
      }));
      const ok = await promo.assessPromotion({ context: 'AUTO_CANDIDATE', environment: env, treatments: ['T6'], observations: obs(null), campaignId: null, candidateVersionId: null });
      expect(ok.assessment.blockers).toEqual([]);
      expect(ok.token).toMatchObject({ allowed: true });
      const paire = await promo.assessPromotion({ context: 'AUTO_CANDIDATE', environment: env, treatments: ['T6'], observations: obs('S-1-0'), campaignId: null, candidateVersionId: null });
      expect(paire.assessment.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['PAIR_INVALID', 'CRITICAL_FAILED']));
      const rapide = await promo.assessPromotion({ context: 'AUTO_CANDIDATE', environment: env, treatments: ['T6'], observations: obs('S-0-2'), gains: [{ operationCode: entries[0].operationCode, outcome: 'GAIN' }], campaignId: null, candidateVersionId: null });
      expect(rapide.token).toBeNull();
      expect(rapide.assessment.blockers.map((b) => b.code)).toContain('FASTER_BUT_WRONG');
    } finally {
      mf.__setCorpusManifestForTests(null);
      await sql`DELETE FROM ai_corpus_oracle_approvals WHERE case_id LIKE 'S-%'`;
    }
    // Activation automatique d'une candidate sans jeton A1 : refusée (la garde est dans activateQualifiedCandidate).
    const svc = await import('@/services/ai/config/config-version.service');
    const v = await svc.createConfigVersion(adminId, { label: 'e2e-l100b référence' });
    await svc.activate(v.id, adminId);
    const cand = await svc.createAutomaticCandidate({ treatment: 'T6', primaryModel: 'gemini-3.5-flash', key: `l100b-${Date.now()}`, reason: 'e2e l100b', campaignId: null });
    await sql`UPDATE ai_config_versions SET candidate_state = 'QUALIFIED' WHERE id = ${cand.id}`;
    await expect(svc.activateQualifiedCandidate(cand.id)).rejects.toMatchObject({ code: 'A1_COVERAGE_LOCK' });
    expect((await sql<Json[]>`SELECT status FROM ai_config_versions WHERE id = ${cand.id}`)[0].status).not.toBe('ACTIVE');
    // Activation manuelle (#345) : manques affichés, jamais bloquants.
    const { NextRequest } = await import('next/server');
    const a1 = await (await import('@/app/api/admin/ai/corpus/a1/route')).GET(new NextRequest('http://app.test/api/admin/ai/corpus/a1?treatment=T3') as never);
    const body = await a1.json();
    expect(body.allowed).toBe(false);
    expect(body.notices[0]).toMatch(/activation manuelle reste possible/);
  });

  it('L100B-E05 — recette 10 : coûts mesurés (fournisseur / cache) et rapports exportables', async () => {
    const [camp] = await sql<Json[]>`INSERT INTO ai_qualification_campaigns (kind, environment, trigger, status, thresholds_version, request, summary)
      VALUES ('MANUAL', 'local', 'admin', 'COMPLETED', 'qualif-seuils-v1', '{}'::jsonb, '{}'::jsonb) RETURNING id`;
    const [ev] = await sql<Json[]>`INSERT INTO ai_qualification_evidence (campaign_id, environment, treatment, operation_code, model, rank, role, signature, verdict, thresholds_version)
      VALUES (${camp.id}, 'local', 'T3', 't3_operation_match', 'gemini-3.5-flash', 0, 'REFERENCE', 'sig-l100b', 'INCONCLUSIVE', 'qualif-seuils-v1') RETURNING id`;
    await sql`INSERT INTO ai_qualification_cases (evidence_id, case_id, source, expected_source, outcome, cost_micros, served_model, duration_ms, from_cache, attempts, manifest_case_id)
      VALUES (${ev.id}, 'corpus:P-T3-08', 'CORPUS_FIXTURE', 'REFERENCE', 'PASSED', 1200, 'gemini-3.5-flash', 900, false, 2, ${CAS}),
             (${ev.id}, 'corpus:P-T3-12', 'CORPUS_FIXTURE', 'REFERENCE', 'INCONCLUSIVE', 0, 'gemini-3.5-flash', NULL, true, 1, NULL)`;
    const { costRows } = await import('@/services/ai/governance/master-corpus/certification/repository');
    const c = (await costRows()).find((x) => x.campaignId === Number(camp.id))!;
    expect(c).toMatchObject({ calls: 2, cacheHits: 1, providerCostMicros: 1200, attempts: 3, operationCode: 't3_operation_match', kind: 'MANUAL' });
    const { NextRequest } = await import('next/server');
    const rep = await import('@/app/api/admin/ai/corpus/report/route');
    const csv = await rep.GET(new NextRequest('http://app.test/api/admin/ai/corpus/report?format=csv') as never);
    expect(csv.headers.get('content-disposition')).toMatch(/corpus-qualification-.*\.csv/);
    const texte = await csv.text();
    expect(texte.split('\n')[0]).toMatch(/^﻿?id;cas_origine;operation;traitement/);
    expect(texte).toContain(CAS);
    const json = await (await rep.GET(new NextRequest('http://app.test/api/admin/ai/corpus/report?format=json') as never)).json();
    expect(json).toMatchObject({ manifest: { reference: { ticket: '#601' } }, t2: { verdict: 'INSUFFISANTE' } });
    expect(json.exclusions.length).toBeGreaterThan(0);
    expect(JSON.stringify(json)).not.toMatch(/"oracle":\{/);
  });
});
