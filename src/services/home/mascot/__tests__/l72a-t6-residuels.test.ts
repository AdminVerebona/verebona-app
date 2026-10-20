/**
 * Lot 72A — ticket « [P1] T6 — Corriger les écarts résiduels du contrat
 * EVALUATE et fiabiliser la bulle d'accueil » : tests UNITAIRES (base et IA
 * simulées). L'écriture réelle (transaction, colonne de signature, rapport)
 * est prouvée sur PostgreSQL 16 par `src/test/e2e/scenarios/l72a-t6-residuels.e2e.ts`.
 *
 *  AC01  modification documentaire significative (description, pièce ajoutée,
 *        supprimée, renommée ou rattachée ailleurs) : ancienne décision jamais
 *        réutilisée, nouvelle évaluation ; relecture sans changement : aucun appel
 *  AC02  version effective du prompt EVALUATE / configuration déterminante :
 *        invalidation STRICTE ; FORMULATE seule changée, contexte inchangé :
 *        aucune réévaluation ; évaluation seulement vieillissante : utilisable
 *  AC03  source indisponible signalée même avec une action, un document ou Duo ;
 *        états distincts (source partielle, PENDING, UNAVAILABLE, rafraîchissement)
 *  AC04  présentation conservée après une erreur : jamais présentée comme actualisée
 *  AC05  persistance : échec total et partiel distingués, jamais « réussite »,
 *        transaction du lot accepté, reprise bornée
 *  AC06  suggestions : échéance écartée / reportée / refusée jamais réintroduite
 *        comme incitation (référence structurée, agrégats, libellés)
 *  AC07  propriétés inconnues EVALUATE rejetées explicitement ; FORMULATE inchangé
 *  AC08  reporting : statut réel, persistées, motifs de rejet, mode d'exécution
 *  AC09  non-régression (rappel informatif, deux sujets, actions, états neutres)
 *  ATP-FIX-17  échéance portée ou réglée par « À traiter » : aucune relance T6
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
type Tx = { unsafe: (s: string, p?: unknown[]) => Promise<unknown[]> };
const begin = vi.fn(async (f: (tx: Tx) => Promise<unknown>) => f({ unsafe: (s, p) => unsafe(s, p) }));
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p), begin: (f: (tx: Tx) => Promise<unknown>) => begin(f) } }));
let configText: string | null = null;
let model = 'gemini-a';
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({
    promptArchitecture: 'master', masterPromptText: configText, configVersionId: 3, masterPromptVersionId: configText ? 12 : null, primaryModel: model,
  }),
}));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));
const writeReport = vi.fn(async (..._a: unknown[]) => 1);
vi.mock('@/services/ai/execution-report/repository', () => ({
  executionReportsReady: async () => true,
  writeExecutionReport: (...a: unknown[]) => writeReport(...a),
}));

const I = await import('../t6-interpellation');
const S = await import('../t6-interpellation.service');
const C = await import('../t6-contract');
const R = await import('../t6-runner');
const Q = await import('../t6-suggestions');
const B = await import('../bubble');
const { buildCandidates } = await import('../signals');
const { selectSubjects, buildSecondaries } = await import('../selector');
const { buildPresentation } = await import('../presentation');
const { mascotRefreshState } = await import('@/components/home/useMascotPresentation');
const { resolveOutput } = await import('@/services/ai/gateway/output-resolution/resolve-output');
type Raw = import('../signals').MascotRawData;
type Row = import('../signals').MascotAgendaRow;
type Decided = import('../signals').MascotDecidedAgenda;
type Evidence = import('../t6-interpellation.service').T6ItemEvidence;
type Stored = import('../t6-interpellation').T6StoredAssessment;
type Presentation = import('../types').MascotPresentation;
type Dec = import('../t6-contract').T6EvaluateOutput['decisions'][number];

const TODAY = '2026-10-19';
const MASTER = readFileSync(join(process.cwd(), 'src/services/ai/prompts/mascot/t6_master_v1.txt'), 'utf8');
const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const ligne = (id: number, date: string, o: Partial<Row> = {}): Row => ({
  id, title: `Échéance ${id}`, date, forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison', ...o,
});
const raw = (agenda: Row[], o: Partial<Raw> = {}): Raw => ({
  accountId: 7, today: TODAY, processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 1 },
  toProcess: [], toProcessTotal: 0, agenda, acknowledgments: [], toProcessAgendaIds: [], toProcessSettledAgendaIds: [], overdueAgenda: [],
  ...o,
});
const vide = (): Evidence => ({ description: null, endDate: null, originFieldKey: null, documents: [], facts: [] });
const evaluation = (agendaItemId: number, fingerprint: string, o: Partial<Stored> = {}): Stored => ({
  fingerprint, assessedOn: TODAY, contractVersion: I.T6_ASSESSMENT_CONTRACT, contractRevision: 2,
  decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', evidenceRefs: ['C1.dueDate'], uncertainties: [],
  interpellation: 'ACT_NOW', actionNeeded: true, action: 'Prendre rendez-vous', reason: 'Une démarche est nécessaire.', consequence: null,
  actionDate: null, priority: 'MEDIUM', uncertainty: null, exceptionReason: null, reevaluateOn: null, id: agendaItemId, ...o,
});
const deps = (loaders: Partial<import('../t6-interpellation.service').T6Loaders>, o: Partial<import('../t6-interpellation.service').PrepareDeps> = {}) => ({
  aiCapable: async () => true, thresholdDays: async () => 60, loaders: { dueReminders: async () => new Map<number, string>(), ...loaders }, ...o,
});
const fp = (r: Row, e: Evidence | undefined) => S.fingerprintWithEvidence({ title: r.title, date: r.date, forecast: r.forecast, requiresQualification: r.requiresQualification }, e);
const preparer = (r: Row[], loaders: Parameters<typeof deps>[0], o: Parameters<typeof deps>[1] = {}, rawO: Partial<Raw> = {}) =>
  S.prepareT6Interpellation({ accountId: 7, userId: null, raw: raw(r, rawO) }, deps(loaders, o));

const candidat = (o: Partial<import('../t6-contract').T6EvaluationCandidate> = {}): import('../t6-contract').T6EvaluationCandidate => {
  const id = o.subjectId ?? 'C1';
  return {
    subjectId: id, title: 'Entretien chaudière', description: null, assetName: 'Maison', assetCategory: 'LOGEMENT',
    dueDate: '2026-11-08', dateLabel: '8 novembre 2026', daysUntilDue: 20, dateNature: 'confirmée', dateRole: 'DEADLINE',
    overdue: false, requiresQualification: false, recurring: false, documents: [], recentlyShownDays: 0,
    evidence: [{ ref: `${id}.title`, kind: 'TITLE' }, { ref: `${id}.dueDate`, kind: 'DUE_DATE' }], ...o,
  };
};
const entree = (cands: import('../t6-contract').T6EvaluationCandidate[]): import('../t6-contract').T6EvaluationInput =>
  ({ schemaVersion: 't6-evaluation-input-v1', today: TODAY, thresholdDays: 60, candidates: cands });
const agir = (subjectId = 'C1', o: Partial<Dec> = {}): Dec => ({
  subjectId, decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON',
  reason: 'Une démarche est à engager avant la date limite.', expectedAction: 'Prendre rendez-vous', actionDeadline: null,
  suggestedReviewAt: null, priorityHint: 'MEDIUM', evidenceRefs: [`${subjectId}.dueDate`], uncertainties: [], ...o,
});
const aucune = (subjectId = 'C1'): Dec => ({
  subjectId, decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED',
  reason: 'Échéance connue et suivie, aucune démarche à engager.', expectedAction: null, actionDeadline: null,
  suggestedReviewAt: null, priorityHint: null, evidenceRefs: [`${subjectId}.title`], uncertainties: [],
});
const sortie = (decisions: unknown[]) => ({ schemaVersion: 't6-evaluation-v1', decisions });
const reponse = (data: unknown, o: Record<string, unknown> = {}) => ({ data, model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 't', ...o });
const lot = (n: number, persist: import('../t6-interpellation').T6InterpellationBundle['persist']) => {
  const ids = Array.from({ length: n }, (_, k) => `C${k + 1}`);
  return {
    context: entree(ids.map((subjectId) => candidat({ subjectId }))),
    refs: new Map(ids.map((s, k) => [s, { subjectKey: `agenda:${k + 1}`, agendaItemId: k + 1, fingerprint: `fp${k + 1}`, daysUntilDue: 20 }])),
    persist,
  };
};
const evalDeps = (execute: (r: unknown) => unknown, o: Record<string, unknown> = {}) => ({
  available: async () => true, promptVersion: async () => 't6_master_v1@file|cfg:3', execute: execute as never, ...o,
});

function accueil(r: Raw, shown: Decided[], o: Partial<Parameters<typeof buildPresentation>[0]> = {}): Presentation {
  const c = buildCandidates(r, { interpellation: { shown } });
  const s = selectSubjects(c.candidates);
  return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages: null, today: TODAY, tiles: { unprovenOverdueIsQuestion: true }, ...o });
}
const montre = (id: number, o: Partial<Decided['interpellation']> = {}): Decided => ({
  agendaItemId: id, interpellation: { mode: 'ACT_NOW', priority: 'MEDIUM', code: 'AI_ACT_NOW', reasonCode: 'ACTION_REQUIRED_SOON', category: 'ACTION_NOW', ...o },
  action: 'Prendre rendez-vous', reminder: { agendaItemId: id, suggestedDate: '2026-10-22', hasSeries: false },
});
const todo = { todoId: 't1', actionKind: 'COMPLETE', priority: 'DO_FIRST', title: 'Numéro à compléter', subtitle: 'Maison', cta: 'Compléter', entityType: 'ASSET', actionType: 'OPEN_TODO_CARD', todoType: 'DATA', card: { question: 'Numéro ?' } } as never;
const lead = (p: Presentation | null, failed = false) => B.bubbleLead({ presentation: p, empty: false, failed }).text;
const parler = (p: Presentation | null, failed = false) => B.composeSpeech({ presentation: p, empty: false, failed }).text;

beforeEach(() => {
  unsafe.mockReset(); unsafe.mockImplementation(async () => []);
  begin.mockClear(); writeReport.mockClear();
  configText = null; model = 'gemini-a';
  R.resetT6EvaluationState(); S.resetContractRevisionProbe();
});

// ── AC01 ─────────────────────────────────────────────────────────────────────

describe('AC01 — invalidation documentaire', () => {
  const r = ligne(1, '2026-11-08');
  const doc = (fileId: number, title: string) => ({ fileId, title, origin: false });

  it('AC01 — description modifiée : ancienne décision jamais réutilisée, nouvelle évaluation demandée', async () => {
    const avant = { ...vide(), description: 'Entretien annuel de la chaudière.' };
    const apres = { ...vide(), description: 'Entretien annuel ; le contrat d’entretien a été résilié.' };
    const p = await preparer([r], { assessments: async () => new Map([[1, evaluation(1, fp(r, avant))]]), evidence: async () => new Map([[1, apres]]) });
    expect(p.decisions[0]).toMatchObject({ decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', needsAssessment: true, reevaluationReason: 'CONTEXT_CHANGED', aiDecision: null });
    expect(p.shown).toEqual([]);
    expect(p.bundle!.refs.get('C1')).toMatchObject({ fingerprint: fp(r, apres), reevaluationReason: 'CONTEXT_CHANGED' });
    expect(p.bundle!.context.candidates[0].description).toContain('résilié');
    // Relecture sans modification : décision réutilisée, aucun appel IA.
    const q = await preparer([r], { assessments: async () => new Map([[1, evaluation(1, fp(r, avant))]]), evidence: async () => new Map([[1, avant]]) });
    expect(q.decisions[0]).toMatchObject({ decision: 'SHOW_NOW', needsAssessment: false, assessmentFresh: true });
    expect(q.bundle).toBeNull();
  });

  it('AC01 — pièce justificative ajoutée, supprimée, renommée ou rattachée ailleurs : nouvelle décision, sans réutilisation', async () => {
    const base = { ...vide(), documents: [doc(10, 'Contrat entretien')] };
    const variantes: Evidence[] = [
      { ...vide(), documents: [doc(10, 'Contrat entretien'), doc(11, 'Avenant 2026')] }, // ajout
      vide(), // suppression
      { ...vide(), documents: [doc(10, 'Attestation de ramonage')] }, // modification (intitulé retenu)
      { ...vide(), documents: [doc(12, 'Contrat entretien')] }, // autre pièce
    ];
    for (const e of variantes) {
      expect(fp(r, e)).not.toBe(fp(r, base));
      const p = await preparer([r], { assessments: async () => new Map([[1, evaluation(1, fp(r, base))]]), evidence: async () => new Map([[1, e]]) });
      expect(p.decisions[0]).toMatchObject({ decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', reevaluationReason: 'CONTEXT_CHANGED' });
      expect(p.bundle).not.toBeNull();
    }
    // Rattachement déplacé de l'échéance 1 vers l'échéance 2 : les deux contextes changent.
    const r2 = ligne(2, '2026-11-09');
    expect(fp(r, vide())).not.toBe(fp(r, base));
    expect(fp(r2, base)).not.toBe(fp(r2, vide()));
    // Réextraction identique (même contenu, nouvelle version) : inchangé.
    expect(fp(r, { ...base, documents: [doc(10, '  contrat ENTRETIEN ')] })).toBe(fp(r, base));
  });
});

// ── AC02 ─────────────────────────────────────────────────────────────────────

describe('AC02 — version effective du prompt EVALUATE et configuration', () => {
  const r = ligne(1, '2026-11-08');
  const e = vide();
  const cfg = (signature: string, masterVersion = 't6_master_v1@pv12:bbbbbbbbbbbb') => async () => ({ signature, masterVersion });

  it('AC02 — signature différente : décision invalidée strictement (jamais affichée), nouvelle évaluation', async () => {
    const a = evaluation(1, fp(r, e), { evaluationSignature: 'sig-A', promptVersion: 't6_master_v1@pv11:aaaaaaaaaaaa|cfg:3' });
    const p = await preparer([r], { assessments: async () => new Map([[1, a]]), evidence: async () => new Map([[1, e]]) }, { evaluationConfig: cfg('sig-B') });
    expect(p.decisions[0]).toMatchObject({ decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', needsAssessment: true, reevaluationReason: 'CONFIG_CHANGED', aiDecision: null });
    expect(p.shown).toEqual([]);
    expect(p.evaluation).toBe('PENDING');
    // Même signature : réutilisée, aucune nouvelle évaluation.
    const q = await preparer([r], { assessments: async () => new Map([[1, { ...a, evaluationSignature: 'sig-B' }]]), evidence: async () => new Map([[1, e]]) }, { evaluationConfig: cfg('sig-B') });
    expect(q.decisions[0]).toMatchObject({ decision: 'SHOW_NOW', needsAssessment: false });
    expect(q.bundle).toBeNull();
  });

  it('AC02 — décisions antérieures sans signature : version du master comparée ; inconnue : conservée', () => {
    const c = { subjectKey: 'agenda:1', agendaItemId: 1, occurrenceKey: 'agenda:1@x', seriesKey: null, accountId: 7, assetId: 1, dueDate: '2026-11-08', state: 'ACTIVE' as const, fingerprint: 'v2:f' };
    const conf = { signature: 'sig-B', masterVersion: 't6_master_v1@pv12:bbbbbbbbbbbb' };
    const f = (o: Partial<Stored>) => I.assessmentFreshness(evaluation(1, 'v2:f', o), c, TODAY, 60, { evaluation: conf });
    expect(f({ promptVersion: 't6_master_v1@pv12:bbbbbbbbbbbb|cfg:3' })).toEqual({ status: 'FRESH', reason: null });
    expect(f({ promptVersion: 't6_master_v1@pv11:aaaaaaaaaaaa|cfg:3' })).toEqual({ status: 'CONFIG_CHANGED', reason: 'CONFIG_CHANGED' });
    expect(f({ promptVersion: null })).toEqual({ status: 'FRESH', reason: null });
    // Configuration courante illisible : jamais d'invalidation de masse.
    expect(I.assessmentFreshness(evaluation(1, 'v2:f', { evaluationSignature: 'sig-A' }), c, TODAY, 60, { evaluation: null }).status).toBe('FRESH');
    // Évaluation seulement vieillissante : utilisable pendant son renouvellement (≠ invalidée).
    const vieille = evaluation(1, 'v2:f', { evaluationSignature: 'sig-B', assessedOn: '2026-09-30' });
    expect(I.assessmentFreshness(vieille, c, TODAY, 60, { evaluation: conf })).toEqual({ status: 'AGED', reason: 'AGED' });
    expect(I.decideT6Interpellation({ candidate: c, today: TODAY, thresholdDays: 60, aiCapable: true, assessment: vieille, preferences: [], evaluationConfig: conf }))
      .toMatchObject({ decision: 'SHOW_NOW', needsAssessment: true, reevaluationReason: 'AGED' });
  });

  it('AC02 — activation d’une nouvelle version : seule la section EVALUATE, le modèle et le seuil comptent', async () => {
    const d0 = R.t6EvaluateSectionDigest(MASTER);
    expect(R.t6EvaluateSectionDigest(MASTER.replace('R12 — Questions suggérées.', 'R12 — Questions suggérées (révisée).'))).toBe(d0);
    expect(R.t6EvaluateSectionDigest(MASTER.replace(/\n/g, '\r\n'))).toBe(d0);
    expect(R.t6EvaluateSectionDigest(MASTER.replace('E5 —', 'E5 (révisée) —'))).not.toBe(d0);
    const fichier = await R.t6EvaluationConfig(60);
    expect(fichier).toMatchObject({ signature: expect.any(String), masterVersion: 't6_master_v1@file' });
    // Version BO activée, branche EVALUATE identique au texte livré : aucune invalidation.
    configText = MASTER.replace('R12 — Questions suggérées.', 'R12 — Questions suggérées (révisée).');
    const bo = await R.t6EvaluationConfig(60);
    expect(bo!.signature).toBe(fichier!.signature);
    expect(bo!.masterVersion).toMatch(/^t6_master_v1@pv12:/);
    // Branche EVALUATE modifiée : nouvelle signature (décisions invalidées).
    configText = MASTER.replace('E5 —', 'E5 (révisée) —');
    expect((await R.t6EvaluationConfig(60))!.signature).not.toBe(fichier!.signature);
    configText = null;
    expect((await R.t6EvaluationConfig(30))!.signature).not.toBe(fichier!.signature);
    model = 'gemini-b';
    expect((await R.t6EvaluationConfig(60))!.signature).not.toBe(fichier!.signature);
  });

  it('AC02 — la signature est conservée avec la décision (colonne 0510) et reprise par la préparation', async () => {
    const p = await preparer([r], { assessments: async () => new Map(), evidence: async () => new Map([[1, e]]) }, { evaluationConfig: cfg('sig-B') });
    unsafe.mockImplementation(async (sql: string) => (/information_schema/.test(sql) ? [{ '?column?': 1 }] : /INSERT INTO t6_interpellation_assessments/.test(sql) ? [{ id: 1 }] : []));
    const v = C.validateT6Evaluation(p.bundle!.context, sortie([agir('C1')]));
    const n = await p.bundle!.persist(v.ok ? v.accepted : [], { promptVersion: 't6_master_v1@file|cfg:3', traceId: 't' });
    expect(n).toMatchObject({ persisted: 1 });
    const insert = unsafe.mock.calls.find(([s]) => /INSERT INTO t6_interpellation_assessments/.test(s))!;
    expect(insert[0]).toMatch(/evaluation_signature/);
    expect(insert[1]).toContain('sig-B');
    expect(begin).toHaveBeenCalledTimes(1);
    expect(lire('src/db/migrations/0510_l72a_t6_evaluation_signature.sql')).toMatch(/ADD COLUMN IF NOT EXISTS evaluation_signature/);
  });
});

// ── AC03 / AC04 ──────────────────────────────────────────────────────────────

describe('AC03 — états dégradés propagés et distincts', () => {
  it('AC03 — panne de lecture T6 avec action prioritaire, document en analyse ou invitation Duo : défaillance signalée', () => {
    const avecTodo = accueil(raw([]), [], { todo: { total: 1, items: [todo] }, deadlinesDegraded: true });
    expect(avecTodo.state).toMatchObject({ kind: 'ACTIONS', degraded: true, degradedSources: ['deadlines'] });
    expect(lead(avecTodo)).toBe(B.PARTIAL_DATA_SPEECH);
    const duo = accueil(raw([]), [], { duoInvite: { title: 'Inviter quelqu’un', subtitle: 'Duo', cta: 'Inviter', href: '/compte' } as never, deadlinesDegraded: true });
    expect(lead(duo)).toBe(B.PARTIAL_DATA_SPEECH);
    const doc = accueil(raw([], { processing: { uploads: [], analyses: [{ id: 5, title: 'Facture', at: '2026-10-19T08:00:00Z' }], exports: [] } }), [], { deadlinesDegraded: true });
    expect(lead(doc)).toBe(B.PARTIAL_DATA_SPEECH);
    // Source MÉTIER partielle (collecteur) avec une action affichée : signalée aussi.
    const metier = accueil(raw([], { toProcess: null }), [], { todo: { total: 1, items: [todo] } });
    expect(metier.state).toMatchObject({ degraded: true, degradedSources: ['business'] });
    expect(lead(metier)).toBe(B.PARTIAL_DATA_SPEECH);
    // Rien d'autre : jamais « Rien de particulier » quand l'examen n'a pas pu se faire.
    const seul = accueil(raw([]), [], { deadlinesDegraded: true });
    expect(parler(seul)).not.toBe(B.NOTHING_TO_REPORT_SPEECH);
    expect(parler(seul)).toBe(B.PARTIAL_DATA_SPEECH);
    expect(B.homePose(seul, false)).toBe('neutral');
    // Sans panne : en-tête inchangé (cartes seules).
    expect(lead(accueil(raw([]), [], { todo: { total: 1, items: [todo] } }))).toBe('');
  });

  it('AC03 — quatre états distincts : source partielle, évaluation en cours, indisponible, rafraîchissement échoué', () => {
    const textes = [B.PARTIAL_DATA_SPEECH, B.EVALUATION_PENDING_SPEECH, B.EVALUATION_UNAVAILABLE_SPEECH, B.STALE_SPEECH];
    expect(new Set(textes).size).toBe(4);
    const avec = (o: Partial<Parameters<typeof buildPresentation>[0]>) => lead(accueil(raw([]), [montre(1)].slice(0, 0), { todo: { total: 1, items: [todo] }, ...o }));
    expect(avec({ evaluation: 'PENDING' })).toBe(B.EVALUATION_PENDING_SPEECH);
    expect(avec({ evaluation: 'UNAVAILABLE' })).toBe(B.EVALUATION_UNAVAILABLE_SPEECH);
    expect(avec({ evaluation: 'UNAVAILABLE', deadlinesDegraded: true })).toBe(`${B.PARTIAL_DATA_SPEECH} ${B.EVALUATION_UNAVAILABLE_SPEECH}`);
  });

  it('AC03 — la préparation T6 et l’orchestration propagent la panne indépendamment des sources métier', async () => {
    const p = await preparer([ligne(1, '2026-11-08')], { evidence: async () => { throw new Error('base'); }, assessments: async () => new Map() });
    expect(p).toMatchObject({ degraded: true, failedSources: ['evidence'] });
    const svc = lire('src/services/home/mascot/mascot.service.ts');
    expect(svc).toMatch(/deadlinesDegraded: interpellation\.degraded/);
  });
});

describe('AC04 — rafraîchissement en échec', () => {
  it('AC04 — présentation conservée après une erreur : signalée comme non actualisée, jamais « rien à signaler »', () => {
    const p = accueil(raw([ligne(1, '2026-11-08')]), [montre(1)]);
    expect(lead(p)).toBe('');
    expect(lead(p, true)).toBe(B.STALE_SPEECH);
    expect(parler(p, true)).toContain(B.STALE_SPEECH);
    const clear = accueil(raw([]), []);
    expect(lead(clear)).toBe(B.NOTHING_TO_REPORT_SPEECH);
    expect(lead(clear, true)).toBe(B.STALE_SPEECH);
    expect(B.homePose(clear, false)).toBe('success-check');
    expect(B.homePose(clear, false, true)).toBe('neutral');
    // Aucune présentation et échec : message dégradé historique.
    expect(lead(null, true)).toBe(B.DEGRADED_SPEECH);
  });

  it('AC04 — état du hook : chargement, à jour, conservée non actualisée, échec', () => {
    const p = accueil(raw([]), []);
    expect(mascotRefreshState(null, false)).toBe('loading');
    expect(mascotRefreshState(p, false)).toBe('fresh');
    expect(mascotRefreshState(p, true)).toBe('stale');
    expect(mascotRefreshState(null, true)).toBe('failed');
  });
});

// ── AC05 / AC08 ──────────────────────────────────────────────────────────────

describe('AC05 — persistance des décisions EVALUATE', () => {
  it('AC05 — échec total d’écriture : jamais « generated », disjoncteur et reprise bornée, rapport FAILED', async () => {
    const persist = vi.fn(async () => { throw new Error('écriture refusée'); });
    const execute = vi.fn(async () => reponse(sortie([agir('C1')])));
    const report = vi.fn();
    const b = lot(1, persist);
    const o = await R.evaluateWithT6({ accountId: 7, bundle: b, mode: 'pregen' }, evalDeps(execute, { report }));
    expect(o).toMatchObject({ status: 'persist_failed', persisted: 0, accepted: [{ subjectId: 'C1' }], notPersisted: [{ subjectId: 'C1', reason: 'write_failed' }] });
    expect(R.t6EvaluationRecentlyFailed(7)).toBe(true);
    // Le rapport reçoit l'issue RÉELLE (après l'écriture).
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ status: 'persist_failed', persisted: 0 });
    // Reprise bornée : même entrée, pas de nouvel appel avant le délai.
    const o2 = await R.evaluateWithT6({ accountId: 7, bundle: b, mode: 'pregen' }, evalDeps(execute));
    expect(o2.status).toBe('skipped');
    expect(execute).toHaveBeenCalledTimes(1);
    await S.writeT6EvaluationReport({ accountId: 7, mode: 'pregen', bundle: b, trace: S.t6EvaluationTraceOf(o) });
    const [rapport, lignes] = writeReport.mock.calls[0] as [Record<string, unknown>, Array<Record<string, unknown>>];
    expect(rapport).toMatchObject({ status: 'FAILED', counters: { accepted: 1, persisted: 0, notPersisted: 1 } });
    expect(lignes[0]).toMatchObject({ writeResult: 'NOT_PERSISTED', recordStatus: 'NOT_PERSISTED' });
  });

  it('AC05 — échec partiel : distingué de la réussite, lignes non enregistrées identifiées', async () => {
    const persist = vi.fn(async () => ({ persisted: 1, persistedSubjectIds: ['C1'] }));
    const o = await R.evaluateWithT6({ accountId: 7, bundle: lot(2, persist), mode: 'pregen' }, evalDeps(async () => reponse(sortie([agir('C1'), agir('C2')]))));
    expect(o).toMatchObject({ status: 'partially_persisted', persisted: 1, persistedSubjectIds: ['C1'], notPersisted: [{ subjectId: 'C2', reason: 'not_written' }] });
    await S.writeT6EvaluationReport({ accountId: 7, mode: 'pregen', bundle: lot(2, persist), trace: S.t6EvaluationTraceOf(o) });
    const [rapport, lignes] = writeReport.mock.calls[0] as [Record<string, unknown>, Array<Record<string, unknown>>];
    expect(rapport).toMatchObject({ status: 'PARTIAL', counters: { persisted: 1, notPersisted: 1 } });
    expect(lignes.map((l) => l.writeResult)).toEqual(['WRITTEN', 'NOT_PERSISTED']);
    // Rétrocompatibilité : une persistance qui rend un nombre reste admise.
    const n = await R.evaluateWithT6({ accountId: 8, bundle: lot(1, async (l) => l.length), mode: 'pregen' }, evalDeps(async () => reponse(sortie([agir('C1')]))));
    expect(n).toMatchObject({ status: 'generated', persisted: 1 });
  });

  it('AC05 — zéro décision enregistrée sans erreur (échéances disparues) : jamais une réussite', async () => {
    const o = await R.evaluateWithT6({ accountId: 7, bundle: lot(1, async () => ({ persisted: 0, persistedSubjectIds: [] })), mode: 'display' }, evalDeps(async () => reponse(sortie([agir('C1')]))));
    expect(o.status).toBe('persist_failed');
  });

  it('AC05 — lot accepté écrit dans UNE transaction : une ligne en échec annule tout, rien n’est compté', async () => {
    let n = 0;
    unsafe.mockImplementation(async (sql: string) => {
      if (/information_schema/.test(sql)) return [{ x: 1 }];
      if (/INSERT INTO t6_interpellation_assessments/.test(sql)) { n += 1; if (n === 2) throw new Error('violation de contrainte'); return [{ id: n }]; }
      return [];
    });
    const refs = lot(2, async () => 0).refs;
    const v = C.validateT6Evaluation(entree([candidat(), candidat({ subjectId: 'C2' })]), sortie([agir('C1'), agir('C2')]));
    await expect(S.persistT6AssessmentsDetailed(7, TODAY, refs, v.ok ? v.accepted : [], { promptVersion: 'v', traceId: null })).rejects.toThrow(/contrainte/);
    expect(begin).toHaveBeenCalledTimes(1);
  });
});

describe('AC08 — traçabilité', () => {
  it('AC08 — mode d’appel transmis à la passerelle pour t6_evaluate (affichage / pré-génération)', async () => {
    const execute = vi.fn(async (_r: unknown) => reponse(sortie([aucune('C1')])));
    const a = await R.evaluateWithT6({ accountId: 7, bundle: lot(1, async (l) => l.length), mode: 'display' }, evalDeps(execute));
    R.resetT6EvaluationState();
    const b = await R.evaluateWithT6({ accountId: 7, bundle: lot(1, async (l) => l.length), mode: 'pregen' }, evalDeps(execute));
    expect(execute.mock.calls.map(([r]) => (r as { callerMode?: string }).callerMode)).toEqual(['displayed', 'pregeneration']);
    expect([a.callerMode, b.callerMode]).toEqual(['displayed', 'pregeneration']);
  });

  it('AC08 — rapport EVALUATE : statut réel, persistées, rejets motivés, mode d’exécution', async () => {
    const b = lot(2, async (l) => l.length);
    const o = await R.evaluateWithT6({ accountId: 7, bundle: b, mode: 'display' }, evalDeps(async () => reponse(sortie([agir('C1'), agir('C2', { expectedAction: null })]))));
    expect(o).toMatchObject({ status: 'generated', persisted: 1, rejected: [{ subjectId: 'C2', reason: 'show_now_without_action' }] });
    await S.writeT6EvaluationReport({ accountId: 7, mode: 'display', bundle: b, trace: S.t6EvaluationTraceOf(o) });
    const [rapport, lignes] = writeReport.mock.calls[0] as [Record<string, unknown> & { steps: Array<Record<string, unknown>> }, Array<Record<string, unknown>>];
    expect(rapport).toMatchObject({
      status: 'PARTIAL', triggerCode: 'evaluate:display',
      counters: { accepted: 1, rejected: 1, persisted: 1, notPersisted: 0 },
      sources: { mode: 'EVALUATE', callerMode: 'displayed', executionMode: 'DISPLAY' },
    });
    expect(rapport.steps.map((s) => [s.step, s.status])).toEqual([['evaluate', 'OK'], ['persist', 'OK']]);
    expect(lignes.map((l) => [l.recordStatus, l.writeResult, l.reasonCode])).toEqual([
      ['SHOW_NOW', 'WRITTEN', 'ACTION_REQUIRED_SOON'], ['REJECTED', 'NOT_PERSISTED', 'VALIDATION:show_now_without_action'],
    ]);
    // Évaluation indisponible : tracée comme telle (jamais « validée »).
    writeReport.mockClear();
    const ko = await R.evaluateWithT6({ accountId: 9, bundle: lot(1, async (l) => l.length), mode: 'pregen' }, evalDeps(async () => { throw new Error('fournisseur'); }));
    await S.writeT6EvaluationReport({ accountId: 9, mode: 'pregen', bundle: lot(1, async (l) => l.length), trace: S.t6EvaluationTraceOf(ko) });
    const [r2, l2] = writeReport.mock.calls[0] as [Record<string, unknown>, Array<Record<string, unknown>>];
    expect(r2).toMatchObject({ status: 'FAILED', triggerCode: 'evaluate:pregen', sources: { callerMode: 'pregeneration', executionMode: 'PREGENERATION' } });
    expect(l2[0]).toMatchObject({ recordStatus: 'UNAVAILABLE', writeResult: 'NOT_PERSISTED' });
  });
});

// ── AC06 ─────────────────────────────────────────────────────────────────────

describe('AC06 — suggestions T2 fondées sur des références structurées', () => {
  const ct = ligne(1, '2026-11-02', { title: 'Contrôle technique', assetId: 1 });
  const ramonage = ligne(2, '2027-03-01', { title: 'Ramonage', assetId: 1 });
  const assurance = ligne(3, '2026-11-05', { title: 'Assurance habitation', assetId: 1 });
  const bundle = (structuredRefs = true) => Q.buildT6SuggestionContext({
    speech: 'Le contrôle technique est à prévoir pour le 2 novembre 2026.', attentionToday: true,
    state: { documentsTotal: 2, deadlinesUpcoming: 3, deadlinesSoon: 2 }, operations: 0,
    assets: [{ id: 1, name: 'Maison', documents: 2, deadlines: 2 }],
    agenda: [ct, ramonage], excluded: [assurance], signaledIds: new Set([1]), today: TODAY, structuredRefs,
    labelOf: (x) => x.title, formatDate: (d) => d,
  });

  it('AC06 — sorties contradictoires : échéance écartée, rattachement inconnu ou incitation sur un sujet non signalé : écartées', () => {
    const b = bundle();
    expect(b.context.schemaVersion).toBe('t6-suggestions-v2');
    expect(b.context.nextDeadlines).toEqual([
      { ref: 'D1', label: 'Contrôle technique', assetRef: 'A1', dateLabel: '2026-11-02', dateNature: 'confirmée', signaled: true },
      { ref: 'D2', label: 'Ramonage', assetRef: 'A1', dateLabel: '2027-03-01', dateNature: 'confirmée', signaled: false },
    ]);
    // Jamais l'échéance écartée ni un identifiant de base dans le contexte transmis.
    expect(JSON.stringify(b.context)).not.toMatch(/Assurance|"id"|agendaItemId/);
    const v = Q.validateT6Suggestions([
      { question: 'Comment préparer le renouvellement de l’assurance habitation ?', assetRef: null, deadlineRef: null, purpose: null },
      { question: 'Que dois-je préparer pour le contrôle technique ?', assetRef: 'A1', deadlineRef: 'D1', purpose: 'PREPARE' },
      { question: 'Que dois-je préparer pour le ramonage ?', assetRef: null, deadlineRef: 'D2', purpose: 'PREPARE' },
      { question: 'Quand est prévu le ramonage ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' },
      { question: 'Quand est prévue la vidange ?', assetRef: null, deadlineRef: 'D9', purpose: 'CONSULT' },
      { question: 'Le ramonage est-il bientôt dû ?', assetRef: null, deadlineRef: null, purpose: null },
      { question: 'Quelles sont mes prochaines échéances ?', assetRef: null, deadlineRef: null, purpose: null },
    ], b.assetIds, b);
    expect(v.map((x) => x.question)).toEqual([
      'Que dois-je préparer pour le contrôle technique ?', 'Quand est prévu le ramonage ?', 'Quelles sont mes prochaines échéances ?',
    ]);
    expect(v[0]).toMatchObject({ deadlineRef: 'D1', purpose: 'PREPARE', assetId: 1 });
    // Référence sans finalité : cohérence non établie.
    expect(Q.validateT6Suggestions([{ question: 'Quand est prévu le ramonage ?', deadlineRef: 'D2' }], b.assetIds, b)).toEqual([]);
  });

  it('AC06 — agrégats du compte : jamais fondés sur des échéances écartées', () => {
    const seuleEcartee = Q.buildT6SuggestionContext({
      speech: '', attentionToday: false, state: { documentsTotal: 1, deadlinesUpcoming: 1, deadlinesSoon: 1 }, operations: 0,
      assets: [{ id: 1, name: 'Maison', documents: 1, deadlines: 1 }], agenda: [], excluded: [assurance], signaledIds: new Set(), today: TODAY,
      labelOf: (x) => x.title, formatDate: (d) => d,
    });
    expect(seuleEcartee.context.account.hasDeadlinesNext30Days).toBe(false);
    expect(seuleEcartee.context.assets[0].hasDeadlinesNext30Days).toBe(false);
    // Consultation libre : l'existence d'échéances reste connue.
    expect(seuleEcartee.context.account.hasUpcomingDeadlines).toBe(true);
    expect(bundle().context.account.hasDeadlinesNext30Days).toBe(true);
  });

  it('AC06 — version du prompt sans références (R12 v1) : contexte inchangé, exclusion par libellé toujours appliquée', () => {
    const b = bundle(false);
    expect(b.context.schemaVersion).toBe('t6-suggestions-v1');
    expect(b.context.nextDeadlines[0]).toEqual({ label: 'Contrôle technique', assetRef: 'A1', dateLabel: '2026-11-02', dateNature: 'confirmée' });
    const v = Q.validateT6Suggestions([
      { question: 'Comment préparer le renouvellement de l’assurance habitation ?', assetRef: null },
      { question: 'Quand est prévu le ramonage ?', assetRef: null },
    ], b.assetIds, b);
    expect(v.map((x) => x.question)).toEqual(['Quand est prévu le ramonage ?']);
    expect(Q.promptSupportsSuggestionRefs(null)).toBe(true);
    expect(Q.promptSupportsSuggestionRefs(MASTER)).toBe(true);
    expect(Q.promptSupportsSuggestionRefs('… {{SUGGESTION_CONTEXT}} … "assetRef":null …')).toBe(false);
  });

  it('AC06 — sélection : écartées, reportées, refusées exclues ; signalées = retenues ; discours et blocs sans sujet écarté', async () => {
    const r1 = ligne(1, '2026-11-02'); const r2 = ligne(2, '2026-11-03'); const r3 = ligne(3, '2026-11-04');
    const prefs = [{ scope: 'OCCURRENCE' as const, decision: 'SNOOZED' as const, remindAt: '2026-12-01', contextFingerprint: null, agendaItemId: 3, seriesKey: null }];
    const p = await S.prepareT6Interpellation({ accountId: 7, userId: 4, raw: raw([r1, r2, r3]) }, deps({
      preferences: async () => prefs,
      assessments: async () => new Map([
        [1, evaluation(1, fp(r1, vide()))],
        [2, evaluation(2, fp(r2, vide()), { decision: 'DEFER', reasonCode: 'TOO_EARLY', interpellation: 'LATER', reevaluateOn: '2026-10-30' })],
      ]),
      evidence: async () => new Map([[1, vide()], [2, vide()], [3, vide()]]),
    }));
    const sel = Q.suggestionAgendaOf([r1, r2, r3], p);
    expect(sel.agenda.map((x) => x.id)).toEqual([1]);
    expect(sel.excluded.map((x) => x.id)).toEqual([2, 3]);
    expect([...sel.signaledIds]).toEqual([1]);
    const pres = accueil(raw([r1, r2, r3]), p.shown);
    expect(B.subjectBlocks(pres).map((x) => x.key)).toEqual([expect.stringContaining(':1')]);
    expect(parler(pres)).not.toMatch(/Échéance 2|Échéance 3/);
  });

  it('AC06 — runner : questions revalidées avec les références COURANTES (génération et relecture du cache)', async () => {
    const run = lire('src/services/home/mascot/t6-runner.ts');
    expect(run).toMatch(/validateT6Suggestions\(r\[0\]\.suggestions, bundle\.assetIds, bundle\)/);
    expect(run).toMatch(/p\.suggestions\.assetIds, p\.suggestions\)/);
    expect(run).toMatch(/deadlineRef: x\.deadlineRef \?\? null, purpose: x\.purpose \?\? null/);
    // R12 v2 livrée dans le texte du dépôt (activation BO requise), compatible v1.
    expect(MASTER).toMatch(/"deadlineRef":null,"purpose":null/);
    expect(MASTER).toMatch(/"PREPARE"[^\n]*`signaled`/);
  });
});

// ── AC07 ─────────────────────────────────────────────────────────────────────

describe('AC07 — contrat EVALUATE strict', () => {
  const e = entree([candidat()]);
  it('AC07 — propriété inconnue à la racine ou dans une décision : rejet COMPLET explicite', () => {
    expect(C.validateT6Evaluation(e, { ...sortie([agir('C1')]), confidence: 0.9 })).toEqual({ ok: false, reason: 'schema:unknown_property:$.confidence' });
    expect(C.validateT6Evaluation(e, sortie([{ ...agir('C1'), urgency: 'HIGH' }]))).toEqual({ ok: false, reason: 'schema:unknown_property:$.decisions[0].urgency' });
    // Sortie conforme : inchangée.
    expect(C.validateT6Evaluation(e, sortie([agir('C1')]))).toMatchObject({ ok: true, accepted: [{ subjectId: 'C1' }] });
    // Incohérence métier : rejet INDIVIDUEL conservé.
    expect(C.validateT6Evaluation(e, sortie([agir('C1', { expectedAction: null })]))).toMatchObject({ ok: true, rejected: [{ reason: 'show_now_without_action' }] });
  });

  it('AC07 — passerelle : la clé inconnue n’est plus retirée en silence (sortie non conforme)', () => {
    const r = resolveOutput({ raw: JSON.stringify(sortie([{ ...agir('C1'), urgency: 'HIGH' }])), schema: C.T6EvaluateOutput, operationCode: 't6_evaluate', allowPruning: false });
    expect(r.ok).toBe(false);
    const racine = resolveOutput({ raw: JSON.stringify({ ...sortie([agir('C1')]), extra: 1 }), schema: C.T6EvaluateOutput, operationCode: 't6_evaluate', allowPruning: true });
    expect(racine.ok).toBe(false);
  });

  it('AC07 — sortie élaguée ou réparée par la passerelle : rejet explicite, rien de conservé', async () => {
    for (const rep of [
      { stage: 'field_pruning', rule: 'array_element_pruned', path: '$.decisions[*]', detail: 'Unrecognized key: "urgency"' },
      { stage: 'ai_repair', rule: 'targeted_repair', path: '$', detail: '1 chemin(s) repris de la réparation' },
    ]) {
      R.resetT6EvaluationState();
      const persist = vi.fn(async (l: unknown[]) => l.length);
      const o = await R.evaluateWithT6({ accountId: 7, bundle: lot(1, persist), mode: 'pregen' }, evalDeps(async () => reponse(sortie([agir('C1')]), { outputRepairs: [rep] })));
      expect(o).toMatchObject({ status: 'validation_failed', persisted: 0, error: `schema:${rep.rule}:${rep.path}` });
      expect(persist).not.toHaveBeenCalled();
    }
    // Normalisation sans perte (casse d'une énumération) : admise.
    const o = await R.evaluateWithT6({ accountId: 8, bundle: lot(1, async (l) => l.length), mode: 'pregen' }, evalDeps(async () => reponse(sortie([agir('C1')]), { outputRepairs: [{ stage: 'normalization', rule: 'enum_case', path: '$.decisions[0].decision' }] })));
    expect(o.status).toBe('generated');
  });

  it('AC07 — FORMULATE inchangé : schéma non strict, empreinte de contrat identique', async () => {
    const { schemaHash } = await import('@/services/ai/gateway/output-resolution/contracts');
    expect(schemaHash(C.T6FormulateOutput)).toBe('a21e46f3abe5');
    expect(C.T6FormulateOutput.safeParse({ schemaVersion: 't6-output-v2', messages: [], inconnu: 1 }).success).toBe(true);
  });
});

// ── AC09 / ATP-FIX-17 ────────────────────────────────────────────────────────

describe('AC09 — non-régression', () => {
  it('AC09 — rappel informatif, deux sujets au plus, actions « Voir » / « C’est fait » / « Rappels », état neutre', () => {
    const p = accueil(raw([ligne(1, '2026-11-02'), ligne(2, '2026-11-03'), ligne(3, '2026-11-04', { title: 'Visite expert' })]),
      [montre(1), montre(2), montre(3, { mode: 'INFORM', code: 'AI_INFORM', reasonCode: 'INFORMATIVE_REMINDER', category: 'INFORMATION' })]);
    const blocs = B.subjectBlocks(p);
    expect(blocs).toHaveLength(2);
    expect(blocs.every((b) => b.reminder != null && b.actions.some((a) => a.label === 'Voir'))).toBe(true);
    expect(p.state).toMatchObject({ degraded: false, degradedSources: [] });
    expect(lead(p)).toBe('');
    expect(lead(accueil(raw([]), []))).toBe(B.NOTHING_TO_REPORT_SPEECH);
  });
});

describe('ATP-FIX-17 — échéance portée ou réglée par « À traiter »', () => {
  const passee = ligne(1, '2026-10-10', { requiresQualification: true });
  it('ATP-FIX-17 — réglée dans « À traiter » (même « à préciser », IA indisponible) : aucune relance contradictoire', async () => {
    for (const aiCapable of [true, false]) {
      const p = await preparer([passee], { assessments: async () => new Map(), evidence: async () => new Map() }, { aiCapable: async () => aiCapable }, { toProcessSettledAgendaIds: [1] });
      expect(p.decisions[0]).toMatchObject({ decision: 'SUPPRESS', code: 'SUBJECT_CLOSED' });
      expect(p.shown).toEqual([]);
      expect(p.bundle).toBeNull();
    }
  });
  it('ATP-FIX-17 — portée par une action « À traiter » ouverte : jamais candidate', async () => {
    const p = await preparer([ligne(1, '2026-11-02')], { assessments: async () => new Map(), evidence: async () => new Map() }, {}, { toProcessAgendaIds: [1] });
    expect(p.decisions).toEqual([]);
  });
  it('ATP-FIX-17 — décisions « À traiter » illisibles : aucune relance, indisponibilité signalée', async () => {
    const future = ligne(2, '2026-11-02');
    const p = await preparer([passee, future], {
      assessments: async () => new Map([[2, evaluation(2, fp(future, vide()))]]), evidence: async () => new Map([[1, vide()], [2, vide()]]),
    }, { aiCapable: async () => false }, { toProcessSettledAgendaIds: null });
    expect(p.decisions.find((d) => d.agendaItemId === 1)).toMatchObject({ decision: 'DEFER', code: 'TO_PROCESS_UNAVAILABLE' });
    expect(p.failedSources).toContain('toProcessSettled');
    expect(p.evaluation).toBe('UNAVAILABLE');
    const q = await preparer([future], { assessments: async () => new Map([[2, evaluation(2, fp(future, vide()))]]), evidence: async () => new Map([[2, vide()]]) }, {}, { toProcessAgendaIds: null });
    expect(q.decisions[0]).toMatchObject({ decision: 'DEFER', code: 'TO_PROCESS_UNAVAILABLE' });
    expect(q.shown).toEqual([]);
  });
});
