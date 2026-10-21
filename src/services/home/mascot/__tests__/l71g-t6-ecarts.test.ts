/**
 * Lot 71G — ticket « [P1] T6 — Corriger les écarts de décision
 * d'interpellation et fiabiliser les rappels » : tests UNITAIRES (base et IA
 * simulées). Le parcours complet est prouvé sur PostgreSQL 16 réel par
 * `src/test/e2e/scenarios/l71g-t6-ecarts.e2e.ts`.
 *
 *  T6-01  empreinte enrichie : clause documentaire nouvelle → contexte changé ;
 *         casse, accents, ponctuation, réextraction identique → inchangé ;
 *         évaluations et reports antérieurs (empreinte historique) relus
 *  T6-02  échéance dépassée depuis plus de 60 jours : candidate seulement avec
 *         une action identifiable (lecture T6), jamais d'office
 *  T6-03  plus de 8 candidats : sélection priorisée, reprise comptée ;
 *         lointaine documentée évaluée, lointaine sans preuve jamais transmise
 *  T6-04  preuves transmises : faits pertinents (extrait, document, provenance,
 *         statut), documents choisis par pertinence ; exception fondée sur un fait
 *  T6-05  report échu : réévaluation demandée avant tout affichage ; date
 *         d'action d'une démarche prématurée atteinte : réévaluation système
 *  T6-06  panne de lecture : préférences jamais prises pour une absence de
 *         refus ; évaluations en panne : refus toujours appliqué ; traçage
 *  T6-07  occurrence : replanification conservée, nouveau cycle non hérité
 *  T6-08  dates civiles réelles, bornes Europe/Paris partagées, fenêtre
 *         fermée seulement après confirmation du serveur
 *  Lot 68 libellé « Actifs » et rappel informatif hors actions ; reporting
 *         (décisions provisoires, motif de réévaluation, preuves)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));

const I = await import('../t6-interpellation');
const S = await import('../t6-interpellation.service');
const C = await import('../t6-contract');
type Raw = import('../signals').MascotRawData;
type Row = import('../signals').MascotAgendaRow;
type Evidence = import('../t6-interpellation.service').T6ItemEvidence;
type Stored = import('../t6-interpellation').T6StoredAssessment;

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
const fait = (o: Partial<import('../t6-interpellation.service').T6DocumentFact> = {}): import('../t6-interpellation.service').T6DocumentFact => ({
  id: 1, fileId: 10, extractionId: 100, key: 'terminationNotice', canonicalKey: null, label: 'Préavis de résiliation', value: '1 mois',
  confidence: 'certain', provenance: 'T1_EXTRACTION', excerpt: 'Résiliation avec un préavis d’un mois.', ...o,
});
const evaluation = (agendaItemId: number, fingerprint: string, o: Partial<Stored> = {}): Stored => ({
  fingerprint, assessedOn: TODAY, contractVersion: I.T6_ASSESSMENT_CONTRACT, contractRevision: 2,
  decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', evidenceRefs: ['C1.dueDate'], uncertainties: [],
  interpellation: 'ACT_NOW', actionNeeded: true, action: 'Prendre rendez-vous', reason: 'Une démarche est nécessaire.', consequence: null,
  actionDate: null, priority: 'MEDIUM', uncertainty: null, exceptionReason: null, reevaluateOn: null, id: agendaItemId, ...o,
});
const deps = (loaders: Partial<import('../t6-interpellation.service').T6Loaders>, o: Partial<import('../t6-interpellation.service').PrepareDeps> = {}) => ({
  aiCapable: async () => true, thresholdDays: async () => 60, loaders, ...o,
});
const fp = (r: Row, e: Evidence | undefined) => S.fingerprintWithEvidence({ title: r.title, date: r.date, forecast: r.forecast, requiresQualification: r.requiresQualification }, e);

beforeEach(() => { unsafe.mockReset(); unsafe.mockImplementation(async () => []); });

describe('T6-01 — réévaluer après modification des données significatives', () => {
  const base = { title: 'Fin du contrat', date: '2026-11-28', forecast: false, requiresQualification: false };
  it('T6-01 — une clause documentaire nouvelle change l’empreinte, titre et date inchangés', () => {
    const avant = I.t6FingerprintParts({ ...base, documents: [{ fileId: 10, title: 'Contrat' }] });
    const apres = I.t6FingerprintParts({ ...base, documents: [{ fileId: 10, title: 'Contrat' }], facts: [{ fileId: 10, key: 'terminationNotice', value: '1 mois', confidence: 'certain' }] });
    expect(apres).not.toBe(avant);
    // Document supprimé : contexte utile changé.
    expect(I.t6FingerprintParts({ ...base })).not.toBe(avant);
  });
  it('T6-01 — modifications cosmétiques et réextraction identique : empreinte inchangée (aucun appel IA)', () => {
    const a = I.t6FingerprintParts({ ...base, description: 'Entretien annuel obligatoire.', facts: [{ fileId: 10, key: 'k', value: 'Annuelle', confidence: 'certain' }] });
    const b = I.t6FingerprintParts({ ...base, description: '  entretien ANNUEL obligatoire ', facts: [{ fileId: 10, key: 'k', value: 'annuelle', confidence: 'certain' }, { fileId: 10, key: 'k', value: 'annuelle ', confidence: 'certain' }] });
    expect(b).toBe(a);
    expect(I.normalizeForFingerprint('Révision : chaudière !')).toBe('revision chaudiere');
    // Changement métier de la description : nouvelle empreinte.
    expect(I.t6FingerprintParts({ ...base, description: 'Entretien biennal obligatoire.' })).not.toBe(I.t6FingerprintParts({ ...base, description: 'Entretien annuel obligatoire.' }));
  });
  it('T6-01 — évaluation antérieure (empreinte historique) : relue, renouvelée seulement si l’échéance est documentée ; report historique relu', () => {
    const legacy = S.agendaFingerprint(base);
    const c = { subjectKey: 'agenda:1', agendaItemId: 1, occurrenceKey: 'agenda:1@x', seriesKey: null, accountId: 7, assetId: 1, dueDate: base.date, state: 'ACTIVE' as const,
      fingerprint: S.t6Fingerprint(base), legacyFingerprint: legacy, hasEvidence: false };
    const a = evaluation(1, legacy);
    expect(I.assessmentFreshness(a, c, TODAY, 60)).toEqual({ status: 'FRESH', reason: null });
    expect(I.assessmentFreshness(a, { ...c, hasEvidence: true }, TODAY, 60)).toEqual({ status: 'AGED', reason: 'LEGACY_FINGERPRINT' });
    expect(I.assessmentFreshness(evaluation(1, 'v2:autre'), c, TODAY, 60)).toEqual({ status: 'CONTEXT_CHANGED', reason: 'CONTEXT_CHANGED' });
    expect(I.sameT6Context(legacy, c)).toBe(true);
    expect(I.sameT6Context(c.fingerprint, c)).toBe(true);
    // Preuves illisibles : l'évaluation reste utilisable (jamais de réévaluation sur un contexte incomplet).
    expect(I.assessmentFreshness(evaluation(1, 'v2:autre'), { ...c, fingerprintUnavailable: true }, TODAY, 60).status).toBe('FRESH');
  });
  it('T6-01 — préparation : l’empreinte enrichie remplace l’historique ; contexte changé → réévaluation, préférences intactes', async () => {
    const r = ligne(1, '2026-11-28');
    const e = { ...vide(), documents: [{ fileId: 10, title: 'Contrat', origin: false }], facts: [fait()] };
    const prefs = [{ scope: 'OCCURRENCE' as const, decision: 'DISMISSED' as const, remindAt: null, contextFingerprint: null, agendaItemId: 1, seriesKey: null }];
    const p = await S.prepareT6Interpellation({ accountId: 7, userId: 3, raw: raw([r]) }, deps({
      preferences: async () => prefs, assessments: async () => new Map([[1, evaluation(1, fp(r, vide()))]]),
      evidence: async () => new Map([[1, e]]),
    }));
    // Lot 76A : empreinte du contexte transmis (`v4:`, représentation commune).
    expect(p.decisions[0]).toMatchObject({ code: 'USER_DISMISSED_OCCURRENCE', fingerprint: S.t6ContextFingerprint(r, e) });
    // Sans préférence (pré-génération) : nouvelle évaluation, motif tracé.
    const q = await S.prepareT6Interpellation({ accountId: 7, userId: null, raw: raw([r]) }, deps({
      assessments: async () => new Map([[1, evaluation(1, fp(r, vide()))]]), evidence: async () => new Map([[1, e]]), dueReminders: async () => new Map(),
    }));
    expect(q.decisions[0]).toMatchObject({ needsAssessment: true, reevaluationReason: 'CONTEXT_CHANGED' });
    expect(q.bundle!.refs.get('C1')).toMatchObject({ reevaluationReason: 'CONTEXT_CHANGED', fingerprint: S.t6ContextFingerprint(r, e) });
  });
});

describe('T6-02 — échéances anciennes', () => {
  it('T6-02 — dépassée de 90 jours : candidate seulement si la lecture T6 a établi une action restante', () => {
    const vieille = ligne(1, I.addDays(TODAY, -90));
    expect(S.t6Candidates(raw([vieille])).map((c) => c.candidate.agendaItemId)).toEqual([]);
    expect(S.t6Candidates(raw([], { t6Agenda: [{ ...vieille, t6LongOverdue: true }] })).map((c) => c.candidate.agendaItemId)).toEqual([1]);
    // Prévision passée : jamais (une date prévue dépassée ne prouve rien).
    expect(S.t6Candidates(raw([], { t6Agenda: [{ ...vieille, forecast: true, t6LongOverdue: true }] }))).toEqual([]);
    // Doublon lecture principale / lecture T6 : un seul candidat.
    expect(S.t6Candidates(raw([ligne(2, I.addDays(TODAY, 5))], { t6Agenda: [ligne(2, I.addDays(TODAY, 5))] }))).toHaveLength(1);
  });
  it('T6-02 — la lecture T6 exige un signal d’action (jamais la seule date) et reste bornée', () => {
    const src = lire('src/services/home/mascot/collector.ts');
    expect(src).toMatch(/c\."assessmentDecision" IN \('SHOW_NOW', 'DEFER'\) OR c\.snoozed/);
    // Lot 75E (B) : une ligne de plus pour détecter une file d'examen plus longue que la lecture.
    expect(src).toMatch(/LIMIT \$\{T6_AGENDA_EXTRA_LIMIT \+ 1\}/);
    expect(src).toMatch(/NOT EXISTS \(SELECT 1 FROM to_process_actions x/);
  });
});

describe('T6-03 — anticipations lointaines et sélection priorisée', () => {
  it('T6-03 — plus de 8 candidats : 8 par appel, priorisés (proches, puis documentés), reprise comptée', async () => {
    const lignes = Array.from({ length: 12 }, (_, k) => ligne(k + 1, I.addDays(TODAY, 100 + k)));
    lignes.push(ligne(50, I.addDays(TODAY, 400)), ligne(60, I.addDays(TODAY, 10)), ligne(70, I.addDays(TODAY, 240)));
    const ev = new Map<number, Evidence>([[50, { ...vide(), documents: [{ fileId: 9, title: 'Bail', origin: false }], facts: [fait({ fileId: 9 })] }]]);
    const p = await S.prepareT6Interpellation({ accountId: 7, userId: null, raw: raw(lignes) }, deps({
      assessments: async () => new Map(), evidence: async () => ev, dueReminders: async () => new Map(),
    }));
    const transmis = p.bundle!.context.candidates.map((c) => c.title);
    expect(transmis).toHaveLength(8);
    expect(transmis.slice(0, 2)).toEqual(['Échéance 60', 'Échéance 50']);
    // 240 jours sans aucune preuve : jamais transmise (hors horizon, sans démarche documentée).
    expect(transmis).not.toContain('Échéance 70');
    expect(p.pendingAssessments).toBe(14 - 8); // 12 dans l'horizon + documentée + proche ; la lointaine sans preuve n'est jamais comptée
  });
  it('T6-03 — 240 jours : exception motivée par un fait extrait et une date d’action dans le seuil', () => {
    const d = { subjectId: 'C1', decision: 'SHOW_NOW', category: 'TO_ANTICIPATE', reasonCode: 'NOTICE_PERIOD_RUNNING', reason: 'La clause de préavis impose d’agir avant la date limite.',
      expectedAction: 'Envoyer la lettre de résiliation', actionDeadline: I.addDays(TODAY, 5), suggestedReviewAt: null, priorityHint: 'HIGH',
      evidenceRefs: ['C1.fact1'], uncertainties: [] } as const;
    const a = I.assessmentFromDecision({ ...d, evidenceRefs: [...d.evidenceRefs], uncertainties: [] });
    expect(a.exceptionReason).toMatch(/préavis/);
    // Titre et date seuls : aucune exception (jamais une obligation tirée du seul intitulé).
    expect(I.assessmentFromDecision({ ...d, evidenceRefs: ['C1.title'], uncertainties: [] }).exceptionReason).toBeNull();
    const c = { subjectKey: 'agenda:1', agendaItemId: 1, occurrenceKey: 'k', seriesKey: null, accountId: 7, assetId: 1, dueDate: I.addDays(TODAY, 240), state: 'ACTIVE' as const, fingerprint: 'v2:x' };
    const r = I.decideT6Interpellation({ candidate: c, today: TODAY, thresholdDays: 60, aiCapable: true, assessment: { ...evaluation(1, 'v2:x'), ...a }, preferences: [] });
    expect(r).toMatchObject({ decision: 'SHOW_NOW', code: 'THRESHOLD_EXCEPTION', actionDate: I.addDays(TODAY, 5) });
  });
});

describe('T6-04 — preuves transmises à EVALUATE', () => {
  it('T6-04 — faits pertinents choisis par pertinence, avec extrait, document source, provenance et statut', () => {
    const e: Evidence = {
      ...vide(), originFieldKey: 'renewalDate',
      documents: [
        { fileId: 1, title: 'A – sans fait', origin: false }, { fileId: 2, title: 'B – sans fait', origin: false }, { fileId: 3, title: 'C – sans fait', origin: false },
        { fileId: 4, title: 'Z – contrat', origin: false },
      ],
      facts: [
        fait({ id: 5, fileId: 4, key: 'warranty', label: 'Garantie', confidence: 'probable', excerpt: 'Garantie deux ans.' }),
        fait({ id: 6, fileId: 4, key: 'renewalDate', label: 'Renouvellement', confidence: 'conflictual', provenance: 'T2_REVALIDATION', excerpt: 'Reconduction tacite.' }),
      ],
    };
    const r = S.evaluationEvidenceOf('C1', e);
    // Le document porteur des faits passe AVANT les trois premiers titres alphabétiques.
    expect(r.documents[0]).toBe('Z – contrat');
    expect(r.facts).toEqual([
      expect.objectContaining({ ref: 'C1.fact1', document: 'C1.doc1', label: 'Renouvellement', status: 'UNCERTAIN', provenance: 'T2_REVALIDATION', excerpt: 'Reconduction tacite.' }),
      expect.objectContaining({ ref: 'C1.fact2', document: 'C1.doc1', status: 'DEDUCED' }),
    ]);
    expect(r.refs).toEqual(expect.arrayContaining([{ ref: 'C1.fact1', kind: 'DOCUMENT_FACT' }, { ref: 'C1.doc1', kind: 'DOCUMENT' }]));
    // Lot 75E (C) : le statut du fait accompagne sa version (exception au seuil, reporting).
    expect(r.versions.get('C1.fact1')).toEqual({ ref: 'C1.fact1', kind: 'DOCUMENT_FACT', fileId: 4, extractionId: 100, factId: 6, factKey: 'renewalDate', provenance: 'T2_REVALIDATION', status: 'UNCERTAIN' });
    expect(I.evidenceSnapshotOf(['C1.fact1'], r.versions, 'v2:fp')).toEqual({ version: 1, fingerprint: 'v2:fp', refs: [r.versions.get('C1.fact1')] });
  });
  it('T6-04 — faits non pertinents écartés ; référence de fait acceptée par la validation (contrat inchangé)', () => {
    expect(I.isT6RelevantFact({ key: 'heatingPowerKw', label: 'Puissance' })).toBe(false);
    expect(I.isT6RelevantFact({ key: 'x', label: 'Préavis de résiliation' })).toBe(true);
    const cand = {
      subjectId: 'C1', title: 'Fin du contrat', description: null, assetName: null, assetCategory: null, dueDate: I.addDays(TODAY, 40), dateLabel: null,
      daysUntilDue: 40, dateNature: 'confirmée' as const, dateRole: null, overdue: false, requiresQualification: false, recurring: false, documents: ['Contrat'],
      recentlyShownDays: 0, evidence: [{ ref: 'C1.title', kind: 'TITLE' as const }, { ref: 'C1.fact1', kind: 'DOCUMENT_FACT' as const }],
    };
    const v = C.validateT6Evaluation({ schemaVersion: 't6-evaluation-input-v1', today: TODAY, thresholdDays: 60, candidates: [cand] }, {
      schemaVersion: 't6-evaluation-v1', decisions: [{ subjectId: 'C1', decision: 'SHOW_NOW', category: 'TO_ANTICIPATE', reasonCode: 'NOTICE_PERIOD_RUNNING',
        reason: 'La clause de préavis extraite impose d’agir.', expectedAction: 'Envoyer la résiliation', actionDeadline: I.addDays(TODAY, 10),
        suggestedReviewAt: null, priorityHint: 'HIGH', evidenceRefs: ['C1.fact1'], uncertainties: [] }],
    });
    expect(v).toMatchObject({ ok: true, accepted: [{ evidenceRefs: ['C1.fact1'] }] });
    // Prompt maître inchangé (contrat EVALUATE / FORMULATE) : aucun ajout obligatoire.
    expect(lire('src/services/ai/prompts/mascot/t6_master_v1.txt')).not.toMatch(/DOCUMENT_FACT/);
  });
});

describe('T6-05 — rappels à leur date effective', () => {
  const c = { subjectKey: 'agenda:1', agendaItemId: 1, occurrenceKey: 'k', seriesKey: null, accountId: 7, assetId: 1, dueDate: I.addDays(TODAY, 20), state: 'ACTIVE' as const, fingerprint: 'v2:x' };
  const report = { scope: 'OCCURRENCE' as const, decision: 'SNOOZED' as const, remindAt: TODAY, contextFingerprint: 'v2:x', agendaItemId: 1, seriesKey: null };
  it('T6-05 — report arrivé à sa date : réévalué avant tout affichage (rappel utilisateur ≠ réévaluation système)', () => {
    const a = { ...evaluation(1, 'v2:x'), assessedOn: I.addDays(TODAY, -1) };
    expect(I.decideT6Interpellation({ candidate: c, today: TODAY, thresholdDays: 60, aiCapable: true, assessment: a, preferences: [report] }))
      .toMatchObject({ decision: 'DEFER', code: 'AWAITING_REEVALUATION_AFTER_SNOOZE', deferredBy: 'SYSTEM', needsAssessment: true, reevaluationReason: 'SNOOZE_DUE' });
    // Réévalué depuis : affiché seulement si l'IA confirme la pertinence.
    expect(I.decideT6Interpellation({ candidate: c, today: TODAY, thresholdDays: 60, aiCapable: true, assessment: evaluation(1, 'v2:x'), preferences: [report] }).decision).toBe('SHOW_NOW');
    expect(I.decideT6Interpellation({ candidate: c, today: TODAY, thresholdDays: 60, aiCapable: true, preferences: [report],
      assessment: evaluation(1, 'v2:x', { decision: 'SUPPRESS', interpellation: 'NONE', actionNeeded: false, reasonCode: 'ALREADY_HANDLED' }) }).decision).toBe('SUPPRESS');
  });
  it('T6-05 — pré-génération du compte : report échu d’un utilisateur → réévaluation demandée sans visite', async () => {
    const r = ligne(1, I.addDays(TODAY, 20));
    const p = await S.prepareT6Interpellation({ accountId: 7, userId: null, raw: raw([r]) }, deps({
      assessments: async () => new Map([[1, { ...evaluation(1, fp(r, vide())), assessedOn: I.addDays(TODAY, -1) }]]),
      evidence: async () => new Map([[1, vide()]]), dueReminders: async () => new Map([[1, TODAY]]),
    }));
    expect(p.decisions[0]).toMatchObject({ needsAssessment: true, reevaluationReason: 'SNOOZE_DUE' });
    expect(p.bundle!.refs.get('C1')?.reevaluationReason).toBe('SNOOZE_DUE');
  });
  it('T6-05 — démarche jugée prématurée dont la date d’action est atteinte : réévaluation système', () => {
    const a = evaluation(1, 'v2:x', { decision: 'DEFER', interpellation: 'LATER', actionDate: TODAY, assessedOn: I.addDays(TODAY, -3) });
    expect(I.assessmentFreshness(a, c, TODAY, 60)).toEqual({ status: 'AGED', reason: 'REVIEW_DATE' });
  });
  it('T6-05 — planification durable : tâche horaire du catalogue, idempotente', () => {
    const cat = lire('src/services/scheduling/scheduled-tasks.catalog.ts');
    expect(cat).toMatch(/code: 'mascot-t6-reevaluations'[\s\S]{0,400}everyMs: HOUR[\s\S]{0,600}enqueueT6DueReevaluations/);
    const q = lire('src/services/home/mascot/pregen-queue.ts');
    expect(q).toMatch(/a\.assessed_on < p\.remind_at/);
    expect(q).toMatch(/ON CONFLICT \(account_id\) DO UPDATE/);
  });
});

describe('T6-06 — préférences respectées en mode dégradé', () => {
  const r = ligne(1, I.addDays(TODAY, 10));
  const fresh = () => new Map([[1, evaluation(1, fp(r, vide()))]]);
  it('T6-06 — préférences illisibles : aucun sujet réintroduit, jamais « rien à signaler », source tracée', async () => {
    const p = await S.prepareT6Interpellation({ accountId: 7, userId: 3, raw: raw([r]) }, deps({
      preferences: async () => { throw new Error('panne'); }, assessments: async () => fresh(), evidence: async () => new Map([[1, vide()]]),
    }));
    expect(p.shown).toEqual([]);
    expect(p.decisions[0]).toMatchObject({ decision: 'DEFER', code: 'PREFERENCES_UNAVAILABLE', deferredBy: 'SYSTEM' });
    expect(p.evaluation).toBe('UNAVAILABLE');
    expect(p.failedSources).toEqual(['preferences']);
    expect(p.degraded).toBe(true);
    const [entree] = S.t6ReportEntries(p.decisions, 60);
    expect(entree.value).toMatchObject({ final: false, failure: 'preferences', aiDecision: 'SHOW_NOW', divergence: true });
  });
  it('T6-06 — évaluations illisibles : préférences conservées, refus toujours appliqué, échéance « à préciser » refusée non réintroduite', async () => {
    const q = ligne(2, I.addDays(TODAY, -3), { requiresQualification: true });
    const prefs = [{ scope: 'OCCURRENCE' as const, decision: 'DISMISSED' as const, remindAt: null, contextFingerprint: null, agendaItemId: 2, seriesKey: null }];
    const p = await S.prepareT6Interpellation({ accountId: 7, userId: 3, raw: raw([r, q]) }, deps({
      preferences: async () => prefs, assessments: async () => { throw new Error('panne'); }, evidence: async () => new Map(),
    }));
    expect(p.shown).toEqual([]);
    expect(p.decisions.find((d) => d.agendaItemId === 2)).toMatchObject({ code: 'USER_DISMISSED_OCCURRENCE' });
    expect(p.decisions.find((d) => d.agendaItemId === 1)).toMatchObject({ code: 'EVALUATION_UNAVAILABLE' });
    expect(p.evaluation).toBe('UNAVAILABLE');
    expect(p.failedSources).toEqual(['assessments']);
    expect(p.bundle).toBeNull();
  });
  it('T6-06 — preuves illisibles : décision conservée, aucune réévaluation sur un contexte incomplet', async () => {
    const p = await S.prepareT6Interpellation({ accountId: 7, userId: null, raw: raw([r]) }, deps({
      assessments: async () => new Map([[1, evaluation(1, 'v2:ancienne')]]), evidence: async () => { throw new Error('panne'); }, dueReminders: async () => new Map(),
    }));
    expect(p.decisions[0].decision).toBe('SHOW_NOW');
    expect(p.bundle).toBeNull();
    expect(p.failedSources).toEqual(['evidence']);
  });
});

describe('T6-07 — identité des occurrences récurrentes', () => {
  // Lot 75E (D) : l'écart de 183 jours est remplacé par l'identité persistante du cycle (voir l75e-t6-residuels.test.ts).
  it('T6-07 — replanification conservée ; nouveau cycle non hérité ; série toujours appliquée (identité de cycle, lot 75E)', () => {
    const occ = { scope: 'OCCURRENCE' as const, cycleKey: 'agenda:1#0' };
    expect(I.preferenceAppliesToCycle(occ, 'agenda:1#0')).toBe(true);
    expect(I.preferenceAppliesToCycle(occ, 'agenda:1#1')).toBe(false);
    expect(I.preferenceAppliesToCycle({ scope: 'OCCURRENCE', cycleKey: null }, 'agenda:1#1')).toBe(true); // antérieure : prudence
    expect(I.preferenceAppliesToCycle({ scope: 'SERIES', cycleKey: 'x' }, 'agenda:1#1')).toBe(true);
    const prefs = [
      { scope: 'OCCURRENCE' as const, decision: 'DISMISSED' as const, remindAt: null, contextFingerprint: null, agendaItemId: 1, seriesKey: null, occurrenceDate: '2026-11-08', cycleKey: 'agenda:1#0' },
      { scope: 'SERIES' as const, decision: 'DISMISSED' as const, remindAt: null, contextFingerprint: null, agendaItemId: null, seriesKey: 's' },
    ];
    expect(S.preferencesFor(prefs, 1, null, 'agenda:1#1')).toEqual([]);
    expect(S.preferencesFor(prefs, 1, 's', 'agenda:1#1')).toEqual([prefs[1]]);
    expect(S.preferencesFor(prefs, 1, null, 'agenda:1#0')).toEqual([prefs[0]]);
  });
  it('T6-07 — un refus de série n’est plus retiré par la seule absence d’occurrence (lot 75E) ; migration 0507 rejouable', () => {
    const svc = lire('src/services/home/mascot/t6-reminders.service.ts');
    expect(svc).not.toMatch(/SERIES_ORPHAN_RETENTION_DAYS\}/);
    expect(svc).toMatch(/p\.series_asset_id IS NOT NULL AND \$\{sansSerie\}/);
    const mig = lire('src/db/migrations/0507_l71g_t6_ecarts.sql');
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS occurrence_date DATE/);
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS evidence_snapshot\s+JSONB/);
    expect(lire('src/db/migrations/0507_l71g_t6_ecarts_idx_1.sql')).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS/m);
  });
});

describe('T6-08 — confirmations de rappel', () => {
  it('T6-08 — dates civiles réelles et bornes Europe/Paris partagées par l’interface et l’API', async () => {
    expect(I.isDay('2027-02-30')).toBe(false);
    expect(I.isDay('2028-02-29')).toBe(true);
    expect(I.snoozeDateError('2027-13-01', TODAY)).toMatch(/n’existe pas/);
    expect(I.snoozeDateError(TODAY, TODAY)).toMatch(/demain/);
    expect(I.snoozeDateError(I.addDays(TODAY, 731), TODAY)).toMatch(/deux/);
    expect(I.snoozeDateError(I.addDays(TODAY, 730), TODAY)).toBeNull();
    // 23 h 30 à Paris le 19 octobre = 21 h 30 UTC : demain reste le 20 (et non l'heure de l'appareil).
    expect(I.parisDayOf(new Date('2026-10-19T21:30:00Z'))).toBe('2026-10-19');
    expect(I.parisDayOf(new Date('2026-10-19T22:30:00Z'))).toBe('2026-10-20');
    const svc = lire('src/services/home/mascot/t6-reminders.service.ts');
    expect(svc).toMatch(/const erreur = snoozeDateError\(p\.remindAt, today\)/);
  });
  it('T6-08 — échec HTTP : la confirmation rend l’erreur (fenêtre ouverte), jamais un succès', async () => {
    const { confirmReminder, snoozeBounds } = await import('@/components/home/T6ReminderControls');
    expect(await confirmReminder(async () => { throw Object.assign(new Error('Choisissez une date à partir de demain.'), { status: 400 }); }, 'défaut')).toBe('Choisissez une date à partir de demain.');
    expect(await confirmReminder(async () => { throw {}; }, 'Votre choix n’a pas pu être enregistré.')).toBe('Votre choix n’a pas pu être enregistré.');
    expect(await confirmReminder(async () => ({ ok: true }), 'défaut')).toBeNull();
    expect(snoozeBounds(new Date('2026-10-19T22:30:00Z'))).toEqual({ today: '2026-10-20', min: '2026-10-21', max: I.addDays('2026-10-20', 730) });
    const src = lire('src/components/home/T6ReminderControls.tsx');
    // La fenêtre ne se ferme que si la confirmation rend null ; l'erreur s'affiche dedans (accessible).
    expect(src).toMatch(/if \(e\) setErreur\(e\);\s*else onOpenChange\(false\);/g);
    expect((src.match(/if \(e\) setErreur\(e\);\s*else onOpenChange\(false\);/g) ?? []).length).toBe(2);
    expect(src).toMatch(/role="alert" className="text-sm text-\[color:var\(--danger\)\]"/);
    expect(src).not.toMatch(/await onConfirm\([^)]*\); onOpenChange\(false\)/);
    // Succès annoncé et sujet masqué APRÈS confirmation seulement.
    expect(src).toMatch(/if \(erreur\) return erreur;\s*onDone\('snoozed'\);/);
    expect(src).toMatch(/if \(erreur\) return erreur;\s*onDone\('dismissed'\);/);
  });
});

describe('Lot 68 — libellés et reporting', () => {
  it('Lot 68 — libellé « Actifs » : actions ET rappels informatifs', async () => {
    const { reminderStatusLabel } = await import('@/components/home/T6ReminderControls');
    expect(reminderStatusLabel({ occurrence: null, series: null })).toBe('Actifs : Verebona vous sollicite quand une démarche est utile ou qu’un rappel vous sera utile');
  });
  it('Reporting — décisions provisoires distinguées, motif de réévaluation et preuves (références seules)', () => {
    const d = {
      ...I.decideT6Interpellation({ candidate: { subjectKey: 'agenda:1', agendaItemId: 1, occurrenceKey: 'k', seriesKey: null, accountId: 7, assetId: 1, dueDate: I.addDays(TODAY, 5), state: 'ACTIVE', fingerprint: 'v2:abcdef0123456789xyz' },
        today: TODAY, thresholdDays: 60, aiCapable: true, assessment: null, preferences: [] }),
      agendaItemId: 1, dueDate: I.addDays(TODAY, 5), seriesKey: null, assessment: null, displayedDays: 0, fingerprint: 'v2:abcdef0123456789xyz',
    };
    const [e] = S.t6ReportEntries([d], 60);
    expect(e.value).toMatchObject({ final: false, reevaluationReason: 'FIRST_ASSESSMENT', contextFingerprint: 'v2:abcdef0123456', evidence: null });
    const a = evaluation(1, 'v2:x', { evidenceSnapshot: { version: 1, fingerprint: 'v2:x', refs: [{ ref: 'C1.fact1', kind: 'DOCUMENT_FACT', fileId: 4, extractionId: 9, factId: 3 }] }, reevaluationReason: 'CONTEXT_CHANGED' });
    const [f] = S.t6ReportEntries([{ ...d, code: 'AI_ACT_NOW', decision: 'SHOW_NOW', assessment: a }], 60);
    expect(f.value).toMatchObject({ final: true, evidence: { refs: [{ ref: 'C1.fact1', fileId: 4, extractionId: 9, factId: 3 }], reevaluationReason: 'CONTEXT_CHANGED' } });
    expect(JSON.stringify(f.value)).not.toMatch(/préavis|Prendre/);
  });
});
