/**
 * Lot 75E — ticket « [P1] T6 — Corriger les écarts résiduels de sélection,
 * preuves et rappels » : tests UNITAIRES (base et IA simulées). Exécution
 * réelle sur PostgreSQL 16 : `src/test/e2e/scenarios/l75e-t6-residuels.e2e.ts`.
 *
 *  L75E-T6-A  réexamen après SUPPRESS : données changées → réévaluée (jamais
 *             réaffichée avant décision IA) ; inchangées → aucun appel répété
 *  L75E-T6-B  sélection progressive : curseur d'examen persistant (examens
 *             achevés enregistrés, en attente d'évaluation jamais retirés de la file)
 *  L75E-T6-C  empreinte du contenu probant ; exception au seuil jamais fondée
 *             sur un intitulé de document, un fait incertain ou une preuve disparue
 *  L75E-T6-D  identité persistante du cycle (plus d'écart de 183 jours) ;
 *             refus de série non retiré par la seule absence d'occurrence
 *  L75E-T6-E  préférences : lecture ciblée (compte, utilisateur, candidats),
 *             lecture incomplète détectée → dégradation prudente tracée
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));
const writeReport = vi.fn(async (..._a: unknown[]) => 1);
vi.mock('@/services/ai/execution-report/repository', () => ({
  executionReportsReady: async () => true,
  writeExecutionReport: (...a: unknown[]) => writeReport(...a),
}));

const I = await import('../t6-interpellation');
const S = await import('../t6-interpellation.service');
const C = await import('../t6-contract');
type Raw = import('../signals').MascotRawData;
type Row = import('../signals').MascotAgendaRow;
type Evidence = import('../t6-interpellation.service').T6ItemEvidence;
type Stored = import('../t6-interpellation').T6StoredAssessment;
type Fact = import('../t6-interpellation.service').T6DocumentFact;

const TODAY = '2026-10-19';
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
const fait = (o: Partial<Fact> = {}): Fact => ({
  id: 1, fileId: 9, extractionId: 100, key: 'terminationNotice', canonicalKey: null, label: 'Préavis de résiliation',
  value: '1 mois', confidence: 'certain', provenance: 'T1_EXTRACTION', excerpt: 'Résiliation avec un préavis d’un mois avant l’échéance.', ...o,
});
const contrat = (...facts: Fact[]): Evidence => ({ ...vide(), documents: [{ fileId: 9, title: 'Contrat d’entretien', origin: false }], facts });
const evaluation = (fingerprint: string, o: Partial<Stored> = {}): Stored => ({
  fingerprint, assessedOn: TODAY, contractVersion: I.T6_ASSESSMENT_CONTRACT, contractRevision: 2,
  decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', evidenceRefs: ['C1.dueDate'], uncertainties: [],
  interpellation: 'ACT_NOW', actionNeeded: true, action: 'Prendre rendez-vous', reason: 'Une démarche est nécessaire.', consequence: null,
  actionDate: null, priority: 'MEDIUM', uncertainty: null, exceptionReason: null, reevaluateOn: null, id: 1, ...o,
});
const SUPPRIMEE = (fp: string, o: Partial<Stored> = {}) => evaluation(fp, {
  decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED', interpellation: 'NONE', actionNeeded: false, action: null, priority: 'LOW', ...o,
});
const fp = (r: Row, e: Evidence | undefined) => S.fingerprintWithEvidence({ title: r.title, date: r.date, forecast: r.forecast, requiresQualification: r.requiresQualification }, e);
const deps = (loaders: Partial<import('../t6-interpellation.service').T6Loaders>, o: Partial<import('../t6-interpellation.service').PrepareDeps> = {}) => ({
  aiCapable: async () => true, thresholdDays: async () => 60,
  loaders: { dueReminders: async () => new Map<number, string>(), examinations: async () => 0, cycles: async () => new Map<number, string>(), ...loaders }, ...o,
});
const preparer = (r: Row[], loaders: Parameters<typeof deps>[0], userId: number | null = null, rawO: Partial<Raw> = {}) =>
  S.prepareT6Interpellation({ accountId: 7, userId, raw: raw(r, rawO) }, deps(loaders));

beforeEach(() => { unsafe.mockReset(); unsafe.mockImplementation(async () => []); writeReport.mockClear(); });

// ── A ───────────────────────────────────────────────────────────────────────

describe('L75E-T6-A — réexamen après SUPPRESS', () => {
  // Dépassée depuis 90 jours, lue par la lecture complémentaire (longOverdue).
  const r = ligne(1, I.addDays(TODAY, -90), { t6LongOverdue: true, t6Due: true, t6SelectionSignature: 'sig-2' });

  it('L75E-T6-A-01 — écartée il y a 3 semaines, clause pertinente ajoutée : réévaluée, JAMAIS réaffichée avant la décision IA', async () => {
    const avant = contrat();
    const apres = contrat(fait());
    const a = SUPPRIMEE(fp(r, avant), { assessedOn: I.addDays(TODAY, -21) });
    const marks: unknown[] = [];
    const p = await preparer([], { assessments: async () => new Map([[1, a]]), evidence: async () => new Map([[1, apres]]), examinations: async (_a, m) => { marks.push(...m); return m.length; } }, null, { t6Agenda: [r] });
    expect(p.decisions[0]).toMatchObject({ decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', needsAssessment: true, reevaluationReason: 'CONTEXT_CHANGED' });
    expect(p.shown).toEqual([]);
    expect(p.bundle!.context.candidates.map((c) => c.subjectId)).toEqual(['C1']);
    expect(p.bundle!.context.candidates[0].facts?.[0]).toMatchObject({ ref: 'C1.fact1', status: 'PROVEN' });
    // En attente d'évaluation : reste dans la file d'examen (aucun examen enregistré).
    expect(marks).toEqual([]);
  });

  it('L75E-T6-A-02 — écartée, données inchangées, décision ancienne : aucune réévaluation répétée ; sortie de la file jusqu’au prochain changement', async () => {
    const e = contrat(fait());
    const a = SUPPRIMEE(fp(r, e), { assessedOn: I.addDays(TODAY, -40) });
    const marks: Array<{ recheckOn: string | null; selectionSignature: string }> = [];
    const p = await preparer([], { assessments: async () => new Map([[1, a]]), evidence: async () => new Map([[1, e]]), examinations: async (_a, m) => { marks.push(...m); return m.length; } }, null, { t6Agenda: [r] });
    expect(p.decisions[0]).toMatchObject({ decision: 'SUPPRESS', needsAssessment: false });
    expect(p.bundle).toBeNull();
    // Examen achevé : réexaminée seulement si ses données changent (aucune date de réexamen).
    expect(marks).toEqual([expect.objectContaining({ agendaItemId: 1, selectionSignature: 'sig-2', recheckOn: null })]);
  });

  it('L75E-T6-A-03 — la lecture complémentaire relit une échéance écartée dont les données ont changé (signature), pas les autres', () => {
    const src = lire('src/services/home/mascot/collector.ts');
    expect(src).toMatch(/c\."assessmentDecision" = 'SUPPRESS' AND c\."examinedSignature" IS DISTINCT FROM c\."selectionSignature"/);
    expect(src).toMatch(/md5\(concat_ws\('\|', i\.title, i\.start_date::text/);
  });
});

// ── B ───────────────────────────────────────────────────────────────────────

describe('L75E-T6-B — sélection progressive, reprise persistante', () => {
  it('L75E-T6-B-01 — examens achevés enregistrés ; candidats en attente (plafond de 8) jamais retirés de la file ; lointain sans preuve : réexamen à son entrée dans l’horizon', async () => {
    const lignes: Row[] = Array.from({ length: 12 }, (_, k) => ligne(k + 1, I.addDays(TODAY, 300 + k), { t6Due: true, t6SelectionSignature: `s${k + 1}` }));
    const ev = new Map<number, Evidence>(lignes.slice(0, 10).map((l) => [l.id, contrat(fait({ id: l.id }))]));
    const marks: Array<{ agendaItemId: number; recheckOn: string | null }> = [];
    const p = await preparer([], {
      assessments: async () => new Map(), evidence: async () => ev, examinations: async (_a, m) => { marks.push(...m); return m.length; },
    }, null, { t6Agenda: lignes, t6AgendaBacklog: true });
    expect(p.bundle!.context.candidates).toHaveLength(8);
    expect(p.pendingAssessments).toBe(2);
    expect(p.selectionBacklog).toBe(true);
    // 8 transmis + 2 en attente : restent dans la file ; 2 sans preuve au-delà de l'horizon : examen achevé.
    const horizon = I.assessmentHorizonDays(60);
    expect(marks).toEqual([
      expect.objectContaining({ agendaItemId: 11, recheckOn: I.addDays(I.addDays(TODAY, 310), -horizon) }),
      expect.objectContaining({ agendaItemId: 12, recheckOn: I.addDays(I.addDays(TODAY, 311), -horizon) }),
    ]);
    expect(p.examined).toBe(2);
  });

  it('L75E-T6-B-02 — affichage (utilisateur) : aucun examen enregistré (décisions personnelles) ; IA indisponible : aucun non plus', async () => {
    const l = [ligne(1, I.addDays(TODAY, 400), { t6Due: true, t6SelectionSignature: 's' })];
    const spy = vi.fn(async () => 1);
    await preparer([], { assessments: async () => new Map(), evidence: async () => new Map(), preferences: async () => [], examinations: spy }, 5, { t6Agenda: l });
    await S.prepareT6Interpellation({ accountId: 7, userId: null, raw: raw([], { t6Agenda: l }) }, { ...deps({ assessments: async () => new Map(), evidence: async () => new Map(), examinations: spy }), aiCapable: async () => false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('L75E-T6-B-03 — lecture : file d’examen DUE d’abord (priorités, puis moins récemment examinée), décidées « à présenter » à part ; reprise si progrès', () => {
    const src = lire('src/services/home/mascot/collector.ts');
    expect(src).toMatch(/WHEN "snoozeDue" THEN 0\s+WHEN "longOverdue" THEN 1\s+WHEN sd <= \$2::date \+ \$7::int THEN 2\s+WHEN "hasDocs" THEN 3 ELSE 4 END,\s+"examinedAt" ASC NULLS FIRST/);
    expect(src).toMatch(/LIMIT \$\{T6_AGENDA_SHOWN_LIMIT\}/);
    const svc = lire('src/services/home/mascot/mascot.service.ts');
    expect(svc).toMatch(/const progres = o\.persisted > 0 \|\| examines \+ \(interpellation\.examined \?\? 0\) > 0;/);
    expect(svc).toMatch(/if \(progres && \(interpellation\.pendingAssessments > 0 \|\| interpellation\.selectionBacklog\)\)/);
    // Affichage d'un compte en reprise : pré-génération du compte demandée (durable, temporisée).
    expect(svc).toMatch(/if \(mode !== 'pregen' && interpellation\.selectionBacklog\) scheduleMascotPregeneration\(accountId, PREGEN_DEBOUNCE_MS, 't6-selection'\)/);
  });
});

// ── C ───────────────────────────────────────────────────────────────────────

describe('L75E-T6-C — empreinte du contenu probant', () => {
  const r = ligne(1, I.addDays(TODAY, 40));
  it('L75E-T6-C-01 — clause modifiée sans changement de titre, date ni valeur : empreinte changée', () => {
    const a = contrat(fait({ excerpt: 'Résiliation avec un préavis d’un mois avant l’échéance.' }));
    const b = contrat(fait({ excerpt: 'Résiliation avec un préavis d’un mois après l’échéance, sans frais.' }));
    expect(fp(r, a)).not.toBe(fp(r, b));
    // Le lot 71G ne le voyait pas (valeur inchangée) : cause racine.
    const v2 = (e: Evidence) => S.fingerprintV2WithEvidence({ title: r.title, date: r.date, forecast: false, requiresQualification: false }, e);
    expect(v2(a)).toBe(v2(b));
  });
  it('L75E-T6-C-02 — confiance ou provenance changée : empreinte changée ; réextraction reformulée ou cosmétique : inchangée', () => {
    const base = contrat(fait({ excerpt: 'Entretien annuel.' }));
    expect(fp(r, contrat(fait({ excerpt: 'Entretien annuel.', confidence: 'conflictual' })))).not.toBe(fp(r, base));
    expect(fp(r, contrat(fait({ excerpt: 'Entretien annuel.', provenance: 'T3_CONSOLIDATION' })))).not.toBe(fp(r, base));
    expect(fp(r, contrat(fait({ excerpt: 'L’entretien est annuel.', id: 77, extractionId: 300 })))).toBe(fp(r, base));
    expect(fp(r, contrat(fait({ excerpt: '  ENTRETIEN  annuel !' })))).toBe(fp(r, base));
    expect(I.probativeContent('Préavis de trois mois')).not.toBe(I.probativeContent('Préavis d’un mois'));
    expect(I.probativeContent('Résiliation possible')).not.toBe(I.probativeContent('Résiliation impossible'));
    expect(I.probativeContent('Ne pas résilier')).not.toBe(I.probativeContent('Résilier'));
  });
  it('L75E-T6-C-03 — décision antérieure (empreinte v2 du lot 71G), contexte inchangé : réutilisée, aucune réévaluation de masse', async () => {
    const e = contrat(fait());
    const v2 = S.fingerprintV2WithEvidence({ title: r.title, date: r.date, forecast: false, requiresQualification: false }, e);
    expect(v2.startsWith('v2:')).toBe(true);
    const p = await preparer([r], { assessments: async () => new Map([[1, evaluation(v2)]]), evidence: async () => new Map([[1, e]]) });
    expect(p.decisions[0]).toMatchObject({ decision: 'SHOW_NOW', needsAssessment: false, assessmentFresh: true });
    expect(p.bundle).toBeNull();
  });
});

describe('L75E-T6-C — exception au seuil : preuve établie et réellement disponible', () => {
  const versions = new Map<string, import('../t6-interpellation').T6EvidenceVersion>([
    ['C1.doc1', { ref: 'C1.doc1', kind: 'DOCUMENT', fileId: 9 }],
    ['C1.fact1', { ref: 'C1.fact1', kind: 'DOCUMENT_FACT', fileId: 9, factId: 1, factKey: 'terminationNotice', status: 'PROVEN' }],
    ['C1.fact2', { ref: 'C1.fact2', kind: 'DOCUMENT_FACT', fileId: 9, factId: 2, factKey: 'renewal', status: 'UNCERTAIN' }],
  ]);
  const decision = (evidenceRefs: string[]): import('../t6-contract').T6ValidatedDecision => ({
    subjectId: 'C1', decision: 'SHOW_NOW', category: 'TO_ANTICIPATE', reasonCode: 'NOTICE_PERIOD_RUNNING', reason: 'Le préavis impose d’agir avant la date limite.',
    expectedAction: 'Envoyer la lettre de résiliation', actionDeadline: I.addDays(TODAY, 5), suggestedReviewAt: null, priorityHint: 'HIGH', evidenceRefs, uncertainties: [],
  });

  it('L75E-T6-C-04 — un préavis extrait (fait établi) fonde l’exception ; un intitulé de document seul ou un fait incertain, jamais', () => {
    expect(I.assessmentFromDecision(decision(['C1.fact1']), versions).exceptionReason).not.toBeNull();
    expect(I.assessmentFromDecision(decision(['C1.doc1']), versions).exceptionReason).toBeNull();
    expect(I.assessmentFromDecision(decision(['C1.doc1', 'C1.title']), versions).exceptionReason).toBeNull();
    expect(I.assessmentFromDecision(decision(['C1.fact2']), versions).exceptionReason).toBeNull();
    expect(I.assessmentFromDecision(decision(['C1.description']), versions).exceptionReason).not.toBeNull();
    // Sans versions (appelant antérieur) : l'intitulé de document ne suffit plus pour autant.
    expect(I.assessmentFromDecision(decision(['C1.doc1'])).exceptionReason).toBeNull();
  });

  it('L75E-T6-C-05 — exception conservée : vérifiée contre les preuves DISPONIBLES (fait disparu, devenu incertain, réextrait)', () => {
    const snap = { version: 1, fingerprint: 'v3:x', refs: [versions.get('C1.fact1')!] };
    const a = { evidenceRefs: ['C1.fact1'], evidenceSnapshot: snap };
    const f = (o: Partial<Fact> = {}) => ({ ...fait(o), canonicalKey: o.canonicalKey ?? null });
    expect(I.exceptionEvidenceGrounded(a, { description: null, facts: [f()] })).toBe(true);
    expect(I.exceptionEvidenceGrounded(a, { description: null, facts: [] })).toBe(false); // disparu
    expect(I.exceptionEvidenceGrounded(a, { description: null, facts: [f({ confidence: 'conflictual' })] })).toBe(false); // devenu incertain
    expect(I.exceptionEvidenceGrounded(a, { description: null, facts: [f({ id: 55 })] })).toBe(true); // réextrait (même clé, même document)
    expect(I.exceptionEvidenceGrounded({ evidenceRefs: ['C1.doc1', 'C1.title'], evidenceSnapshot: { refs: [versions.get('C1.doc1')!] } }, { description: 'x', facts: [f()] })).toBe(false);
    expect(I.exceptionEvidenceGrounded({ evidenceRefs: ['C1.fact1'], evidenceSnapshot: null }, { description: null, facts: [f()] })).toBe(false); // instantané absent
    expect(I.exceptionEvidenceGrounded({ evidenceRefs: ['C1.description'], evidenceSnapshot: null }, { description: 'Préavis de 3 mois', facts: [] })).toBe(true);
  });

  it('L75E-T6-C-06 — décision : exception sans preuve disponible → THRESHOLD_EXCEPTION_UNPROVEN, jamais affichée ; avec preuve → THRESHOLD_EXCEPTION', async () => {
    const r = ligne(1, I.addDays(TODAY, 240));
    const e = contrat(fait());
    const base = evaluation(fp(r, e), {
      category: 'TO_ANTICIPATE', interpellation: 'ANTICIPATE', reasonCode: 'NOTICE_PERIOD_RUNNING', priority: 'HIGH', actionDate: I.addDays(TODAY, 5),
      exceptionReason: 'Le préavis impose d’agir avant la date limite.', evidenceRefs: ['C1.fact1'],
      evidenceSnapshot: { version: 1, fingerprint: fp(r, e), refs: [versions.get('C1.fact1')!] },
    });
    const ok = await preparer([r], { assessments: async () => new Map([[1, base]]), evidence: async () => new Map([[1, e]]) });
    expect(ok.decisions[0]).toMatchObject({ decision: 'SHOW_NOW', code: 'THRESHOLD_EXCEPTION' });
    // Décision antérieure au lot 75E fondée sur le seul intitulé du document.
    const titre = { ...base, evidenceRefs: ['C1.doc1'], evidenceSnapshot: { version: 1, fingerprint: fp(r, e), refs: [versions.get('C1.doc1')!] } };
    const ko = await preparer([r], { assessments: async () => new Map([[1, titre]]), evidence: async () => new Map([[1, e]]) });
    expect(ko.decisions[0]).toMatchObject({ decision: 'SUPPRESS', code: 'THRESHOLD_EXCEPTION_UNPROVEN', thresholdApplied: true });
    expect(ko.shown).toEqual([]);
    // Tracé au reporting.
    expect(S.t6ReportEntries(ko.decisions, 60)[0].value).toMatchObject({ failure: 'exception_evidence' });
  });

  it('L75E-T6-C-07 — contrat EVALUATE : un fait incertain, seule preuve concrète d’une démarche certaine, est rejeté (incertitude non déclarée)', () => {
    const cand = {
      subjectId: 'C1', title: 'Fin du contrat', description: null, assetName: null, assetCategory: null, dueDate: I.addDays(TODAY, 40), dateLabel: null,
      daysUntilDue: 40, dateNature: 'confirmée' as const, dateRole: null, overdue: false, requiresQualification: false, recurring: false, documents: ['Contrat'],
      facts: [
        { ref: 'C1.fact1', document: 'C1.doc1', label: 'Préavis', value: '1 mois', excerpt: 'préavis', status: 'UNCERTAIN' as const, provenance: 'T1_EXTRACTION' },
        { ref: 'C1.fact2', document: 'C1.doc1', label: 'Préavis', value: '1 mois', excerpt: 'préavis', status: 'PROVEN' as const, provenance: 'T1_EXTRACTION' },
      ],
      recentlyShownDays: 0,
      evidence: [{ ref: 'C1.title', kind: 'TITLE' as const }, { ref: 'C1.dueDate', kind: 'DUE_DATE' as const }, { ref: 'C1.doc1', kind: 'DOCUMENT' as const },
        { ref: 'C1.fact1', kind: 'DOCUMENT_FACT' as const }, { ref: 'C1.fact2', kind: 'DOCUMENT_FACT' as const }],
    };
    const d = (evidenceRefs: string[], uncertainties: string[] = []) => ({
      subjectId: 'C1', decision: 'SHOW_NOW' as const, category: 'ACTION_NOW' as const, reasonCode: 'ACTION_REQUIRED_SOON' as const, reason: 'La démarche doit être engagée maintenant.',
      expectedAction: 'Envoyer la résiliation', actionDeadline: null, suggestedReviewAt: null, priorityHint: 'HIGH' as const, evidenceRefs, uncertainties,
    });
    expect(C.evaluationDecisionViolation(d(['C1.fact1']), cand as never, TODAY)).toBe('uncertain_evidence_as_certain');
    expect(C.evaluationDecisionViolation(d(['C1.fact1', 'C1.title']), cand as never, TODAY)).toBe('uncertain_evidence_as_certain');
    expect(C.evaluationDecisionViolation(d(['C1.fact1'], ['Durée du préavis à confirmer']), cand as never, TODAY)).toBeNull();
    expect(C.evaluationDecisionViolation(d(['C1.fact1', 'C1.fact2']), cand as never, TODAY)).toBeNull();
    // Le jugement reste celui de l'IA : titre et date seuls, sous le seuil, inchangé.
    expect(C.evaluationDecisionViolation(d(['C1.dueDate']), cand as never, TODAY)).toBeNull();
  });
});

// ── D ───────────────────────────────────────────────────────────────────────

describe('L75E-T6-D — identité persistante du cycle', () => {
  it('L75E-T6-D-01 — replanification (quel que soit l’écart, toutes périodicités) : refus conservé ; cycle suivant : non hérité', async () => {
    const refus = { scope: 'OCCURRENCE' as const, decision: 'DISMISSED' as const, remindAt: null, contextFingerprint: null, agendaItemId: 1, seriesKey: null, cycleKey: I.t6CycleKey(1, 0) };
    // Mensuelle (+20 j), trimestrielle (+60 j), annuelle (+200 j), pluriannuelle (+400 j) : même occurrence T4.
    for (const decalage of [20, 60, 200, 400]) {
      const r = ligne(1, I.addDays(TODAY, 10 + decalage));
      const p = await preparer([r], { assessments: async () => new Map(), evidence: async () => new Map(), preferences: async () => [refus], cycles: async () => new Map([[1, I.t6CycleKey(1, 0)]]) }, 5);
      expect(p.decisions[0].code, `+${decalage} j`).toBe('USER_DISMISSED_OCCURRENCE');
    }
    // Occurrence réalisée puis rouverte (cycle suivant de la même ligne) : refus non transmis.
    const p = await preparer([ligne(1, I.addDays(TODAY, 20))], { assessments: async () => new Map(), evidence: async () => new Map(), preferences: async () => [refus], cycles: async () => new Map([[1, I.t6CycleKey(1, 1)]]) }, 5);
    expect(p.decisions[0].code).not.toMatch(/USER_DISMISSED/);
    // Cycle illisible : refus appliqué (prudence), lecture tracée.
    const q = await preparer([ligne(1, I.addDays(TODAY, 20))], { assessments: async () => new Map(), evidence: async () => new Map(), preferences: async () => [refus], cycles: async () => { throw new Error('panne'); } }, 5);
    expect(q.decisions[0].code).toBe('USER_DISMISSED_OCCURRENCE');
    expect(q.failedSources).toContain('cycles');
  });

  it('L75E-T6-D-02 — refus de série : appliqué à toute occurrence de la série, nouvelles comprises', async () => {
    const serie = { scope: 'SERIES' as const, decision: 'DISMISSED' as const, remindAt: null, contextFingerprint: null, agendaItemId: null, seriesKey: 's-pac' };
    const p = await preparer([ligne(9, I.addDays(TODAY, 30), { seriesKey: 's-pac' })], { assessments: async () => new Map(), evidence: async () => new Map(), preferences: async () => [serie] }, 5);
    expect(p.decisions[0].code).toBe('USER_DISMISSED_SERIES');
  });

  it('L75E-T6-D-03 — plus d’écart de 183 jours ni de retrait à 365 jours ; cycle = expression partagée (décision, rappels, nettoyage, migration)', () => {
    const t6 = lire('src/services/home/mascot/t6-interpellation.ts');
    const rem = lire('src/services/home/mascot/t6-reminders.service.ts');
    expect(t6).not.toMatch(/export const T6_NEW_CYCLE_MIN_DAYS/);
    expect(rem).not.toMatch(/T6_NEW_CYCLE_MIN_DAYS|SERIES_ORPHAN_RETENTION_DAYS\}/);
    expect(rem).toMatch(/\$\{t6CycleKeySql\('i'\)\} AS cycle_key/);
    expect(rem).toMatch(/\$\{t6CycleKeySql\('i'\)\} <> p\.cycle_key/);
    const mig = lire('src/db/migrations/0551_l75e_t6_cycles_selection.sql');
    expect(mig).toMatch(/e\.event_type = 'STATUS_AUTO_COMPLETED'/);
    expect(I.t6CycleKeySql('i')).toMatch(/e\.event_type = 'STATUS_CHANGED' AND e\.detail_json ->> 'manualStatus' = 'realise'/);
    expect(I.t6CycleKey(42, 2)).toBe('agenda:42#2');
  });
});

// ── E ───────────────────────────────────────────────────────────────────────

describe('L75E-T6-E — préférences : lecture ciblée, incomplète ou indisponible', () => {
  it('L75E-T6-E-01 — lecture CIBLÉE : compte, utilisateur, occurrences et séries des candidats ; borne + 1 pour détecter l’incomplétude', async () => {
    unsafe.mockResolvedValueOnce([]);
    await S.loadUserPreferences(7, 5, { agendaIds: [1, 2], seriesKeys: ['s'] });
    const [sql, params] = unsafe.mock.calls[0];
    expect(sql).toMatch(/WHERE p\.account_id = \$1 AND p\.user_id = \$2/);
    expect(sql).toMatch(/p\.agenda_item_id = ANY\(\$3::int\[\]\)/);
    expect(sql).toMatch(/p\.series_key = ANY\(\$4::text\[\]\)/);
    expect(sql).toMatch(new RegExp(`LIMIT ${S.T6_PREFERENCES_READ_LIMIT + 1}`));
    expect(params).toEqual([7, 5, [1, 2], ['s']]);
  });

  it('L75E-T6-E-02 — lecture qui atteint sa borne : INCOMPLÈTE (jamais un résultat tronqué pris pour exhaustif)', async () => {
    unsafe.mockResolvedValueOnce(Array.from({ length: 4 }, () => ({ scope: 'OCCURRENCE', decision: 'DISMISSED', agenda_item_id: 1 })));
    await expect(S.loadUserPreferences(7, 5, { agendaIds: [1], seriesKeys: [] }, 3)).rejects.toBeInstanceOf(S.T6PreferencesIncompleteError);
    unsafe.mockResolvedValueOnce(Array.from({ length: 3 }, () => ({ scope: 'OCCURRENCE', decision: 'DISMISSED', agenda_item_id: 1 })));
    await expect(S.loadUserPreferences(7, 5, { agendaIds: [1], seriesKeys: [] }, 3)).resolves.toHaveLength(3);
  });

  it('L75E-T6-E-03 — incomplète : aucun sujet réintroduit (évaluation fraîche SHOW_NOW comprise), état explicite, tracé au reporting', async () => {
    const r = ligne(1, I.addDays(TODAY, 20));
    const p = await preparer([r], {
      assessments: async () => new Map([[1, evaluation(fp(r, vide()))]]), evidence: async () => new Map([[1, vide()]]),
      preferences: async () => { throw new S.T6PreferencesIncompleteError(2000); },
    }, 5);
    expect(p.decisions[0]).toMatchObject({ decision: 'DEFER', code: 'PREFERENCES_UNAVAILABLE' });
    expect(p.shown).toEqual([]);
    expect(p.failedSources).toEqual(['preferences_incomplete']);
    expect(p.evaluation).toBe('UNAVAILABLE');
    await S.writeT6InterpellationReport({ accountId: 7, userId: 5, mode: 'display', prep: p });
    const [entete] = writeReport.mock.calls[0] as [{ steps: Array<{ step: string; error: string | null; detail: Record<string, unknown> }> }];
    const etape = entete.steps.find((s) => s.step === 'decision')!;
    expect(etape.error).toMatch(/preferences_incomplete/);
    expect(etape.detail).toMatchObject({ preferencesUnverified: true });
  });

  it('L75E-T6-E-04 — Premium Duo : préférences lues pour CET utilisateur seulement (portée transmise au chargeur)', async () => {
    const vus: unknown[] = [];
    await preparer([ligne(1, I.addDays(TODAY, 20), { seriesKey: 's' })], {
      assessments: async () => new Map(), evidence: async () => new Map(),
      preferences: async (a, u, scope) => { vus.push([a, u, scope]); return []; },
    }, 42);
    expect(vus).toEqual([[7, 42, { agendaIds: [1], seriesKeys: ['s'] }]]);
  });
});
