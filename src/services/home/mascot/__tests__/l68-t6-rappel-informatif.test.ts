/**
 * Lot 68 — ticket « [P2] Accueil / T6 — Alléger la bulle et distinguer rappel
 * informatif et action » : tests UNITAIRES (IA simulée, base simulée). Le
 * parcours est prouvé sur PostgreSQL 16 réel par
 * `src/test/e2e/scenarios/l68b-t6-rappel-informatif.e2e.ts` ; l'écran
 * (desktop / mobile, menu « Rappels ») par
 * `src/components/home/__tests__/l68-bulle-rappels.test.ts`.
 *
 * Contrat et chaîne T6
 *  T6-RAP-01  SHOW_NOW + INFORMATION + motif dédié, sans action, justifié et prouvé : accepté ;
 *             action toujours obligatoire pour ACTION_NOW / TO_ANTICIPATE (aucune conversion)
 *  T6-RAP-02  conversion et décision : INFORM, jamais ACT_NOW par défaut, jamais supprimé faute
 *             d'action ; seuil, exclusions, non-répétition et préférences inchangés
 *  T6-RAP-03  persistance (migration 0474, révision du contrat) et compatibilité des sorties existantes
 *  T6-RAP-04  renouvellement ciblé des évaluations et des formulations en cache
 * Composition
 *  T6-RAP-05  cas de la capture (rappel informatif) : une occurrence du sujet, du bien et de la date,
 *             aucune introduction, aucune préparation générique, aucun « Action à prévoir » — IA et secours
 *  T6-RAP-06  action concrète établie : visible, prioritaire, sans « À prévoir : » ; action artificielle retirée
 *  T6-RAP-07  zéro, un et deux sujets (IA et secours) : jamais « rien à signaler » si un sujet est
 *             affiché ou si l'évaluation est indisponible
 *  T6-RAP-08  rappel reporté, refusé ou devenu sans objet : ne réapparaît pas ; aucun sujet historique réintroduit
 *  T6-RAP-09  « À traiter », documents en cours et invitation Duo préservés
 *  T6-RAP-10  rapports et compteurs : rappel informatif, action, report, suppression distingués
 *  T6-RAP-11  messages IA et cache : formules mécaniques écartées (repli sujet par sujet)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
let configText: string | null = null;
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({ promptArchitecture: 'master', masterPromptText: configText, configVersionId: 3 }),
}));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));

const C = await import('../t6-contract');
const I = await import('../t6-interpellation');
const R = await import('../t6-runner');
const S = await import('../t6-interpellation.service');
const { buildCandidates } = await import('../signals');
const { selectSubjects, buildSecondaries } = await import('../selector');
const { buildPresentation } = await import('../presentation');
const { buildT6Input } = await import('../t6-contract');
const B = await import('../bubble');
type Raw = import('../signals').MascotRawData;
type Row = import('../signals').MascotAgendaRow;
type Dec = import('../t6-contract').T6EvaluateOutput['decisions'][number];
type Presentation = import('../types').MascotPresentation;

const TODAY = '2026-10-18';
const SEUIL = 60;
const MASTER = readFileSync(join(process.cwd(), 'src/services/ai/prompts/mascot/t6_master_v1.txt'), 'utf-8');

// ── Fabriques ────────────────────────────────────────────────────────────────

const candidat = (o: Partial<import('../t6-contract').T6EvaluationCandidate> = {}): import('../t6-contract').T6EvaluationCandidate => {
  const id = o.subjectId ?? 'C1';
  return {
    subjectId: id, title: 'Visite expert bois', description: null, assetName: 'Maison', assetCategory: 'IMMOBILIER',
    dueDate: '2026-10-22', dateLabel: '22 octobre 2026', daysUntilDue: 4, dateNature: 'confirmée', dateRole: 'SCHEDULED_EVENT',
    overdue: false, requiresQualification: false, recurring: false, documents: [], recentlyShownDays: 0,
    evidence: [{ ref: `${id}.title`, kind: 'TITLE' }, { ref: `${id}.dueDate`, kind: 'DUE_DATE' }],
    ...o,
  };
};
const entree = (cands: import('../t6-contract').T6EvaluationCandidate[]): import('../t6-contract').T6EvaluationInput =>
  ({ schemaVersion: 't6-evaluation-input-v1', today: TODAY, thresholdDays: SEUIL, candidates: cands });
const rappel = (subjectId = 'C1', o: Partial<Dec> = {}): Dec => ({
  subjectId, decision: 'SHOW_NOW', category: 'INFORMATION', reasonCode: 'INFORMATIVE_REMINDER',
  reason: 'La visite est prévue dans quelques jours : le rappel est utile, aucune démarche n’est attendue.',
  expectedAction: null, actionDeadline: null, suggestedReviewAt: null, priorityHint: 'LOW', evidenceRefs: [`${subjectId}.dueDate`], uncertainties: [], ...o,
});
const agir = (subjectId = 'C1', o: Partial<Dec> = {}): Dec => ({
  subjectId, decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON',
  reason: 'Une démarche est à engager avant la date limite.', expectedAction: 'Prendre rendez-vous pour le ramonage', actionDeadline: null,
  suggestedReviewAt: null, priorityHint: 'MEDIUM', evidenceRefs: [`${subjectId}.dueDate`], uncertainties: [], ...o,
});
const aucune = (subjectId = 'C1', o: Partial<Dec> = {}): Dec => ({
  subjectId, decision: 'SUPPRESS', category: 'INFORMATION', reasonCode: 'NO_ACTION_REQUIRED',
  reason: 'Échéance connue et suivie, aucune démarche à engager.', expectedAction: null, actionDeadline: null,
  suggestedReviewAt: null, priorityHint: null, evidenceRefs: [`${subjectId}.title`], uncertainties: [], ...o,
});
const sortie = (decisions: Dec[]) => ({ schemaVersion: 't6-evaluation-v1', decisions });

/** Évaluation conservée (cache), issue d'une décision VALIDÉE. */
const stocke = (d: Dec, fingerprint = 'fp1', o: Partial<import('../t6-interpellation').T6StoredAssessment> = {}): import('../t6-interpellation').T6StoredAssessment => ({
  ...I.assessmentFromDecision({ ...d, expectedAction: d.expectedAction ?? null }),
  fingerprint, assessedOn: TODAY, contractVersion: 't6-evaluation-v1', contractRevision: 2, ...o,
});
const cand = (o: Partial<import('../t6-interpellation').T6Candidate> = {}): import('../t6-interpellation').T6Candidate => ({
  subjectKey: 'agenda:1', agendaItemId: 1, occurrenceKey: 'agenda:1@2026-10-22', seriesKey: null, accountId: 7, assetId: 1,
  dueDate: '2026-10-22', state: 'ACTIVE', fingerprint: 'fp1', ...o,
});
const decide = (o: Partial<Parameters<typeof I.decideT6Interpellation>[0]> = {}) => I.decideT6Interpellation({
  candidate: cand(), today: TODAY, thresholdDays: SEUIL, aiCapable: true, assessment: null, preferences: [], ...o,
});

const VISITE: Row = {
  id: 1, title: 'Visite expert bois', date: '2026-10-22', forecast: false, requiresQualification: false,
  assetId: 1, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison', dateRole: 'SCHEDULED_EVENT', seriesKey: null,
};
const RAMONAGE: Row = {
  id: 2, title: 'Ramonage cheminée', date: '2026-11-04', forecast: false, requiresQualification: false,
  assetId: 1, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison', dateRole: 'DEADLINE', seriesKey: 'ramonage',
};
const raw = (agenda: Row[], over: Partial<Raw> = {}): Raw => ({
  accountId: 7, today: TODAY,
  processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 3 },
  toProcess: [], agenda, acknowledgments: [], overdueAgenda: [], ...over,
} as Raw);

type Decided = import('../signals').MascotDecidedAgenda;
const informe = (id: number): Decided => ({
  agendaItemId: id, interpellation: { mode: 'INFORM', priority: 'LOW', code: 'AI_INFORM', reasonCode: 'INFORMATIVE_REMINDER', category: 'INFORMATION' },
  action: null, reminder: { agendaItemId: id, suggestedDate: '2026-10-21', hasSeries: false },
});
const action = (id: number, a: string | null = 'Prendre rendez-vous pour le ramonage'): Decided => ({
  agendaItemId: id, interpellation: { mode: 'ACT_NOW', priority: 'MEDIUM', code: 'AI_ACT_NOW', reasonCode: 'ACTION_REQUIRED_SOON', category: 'ACTION_NOW' },
  action: a, reminder: { agendaItemId: id, suggestedDate: '2026-10-28', hasSeries: true },
});

/** Accueil composé comme `getMascotPresentation` (décisions → sujets → bulle), IA ou secours. */
function accueil(r: Raw, shown: Decided[], o: Partial<Parameters<typeof buildPresentation>[0]> & { ia?: (fallback: string) => string } = {}): Presentation {
  const c = buildCandidates(r, { interpellation: { shown } });
  const s = selectSubjects(c.candidates);
  const { ia, ...reste } = o;
  const messages = ia ? s.map((x) => ({ subjectId: x.subjectId, text: ia(x.fallbackText), highlight: null })) : null;
  return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages, today: TODAY, tiles: { unprovenOverdueIsQuestion: true }, ...reste });
}
const parler = (p: Presentation | null) => B.composeSpeech({ presentation: p, empty: false }).text;
const entete = (p: Presentation | null) => B.bubbleLead({ presentation: p, empty: false }).text;
/** Tout ce que la bulle AFFICHE : en-tête, blocs (badge, texte, actions), cartes. */
const affiche = (p: Presentation) => [
  entete(p),
  ...B.subjectBlocks(p).flatMap((b) => [b.badge ?? '', b.text, ...b.actions.map((a) => a.label), b.reminder ? 'Rappels' : '']),
  ...B.homeItems(p, false).flatMap((i) => [i.title, i.sub ?? '', i.cta]),
].filter(Boolean).join(' | ');
const compter = (texte: string, motif: RegExp) => (texte.match(new RegExp(motif.source, 'gi')) ?? []).length;
const MECANIQUE = /mérite votre attention|méritent votre attention|À prévoir :|Action à prévoir|préparer la visite/i;

beforeEach(() => {
  unsafe.mockReset(); unsafe.mockResolvedValue([]); configText = null;
  R.resetT6EvaluationState(); R.resetT6Breaker(); S.resetContractRevisionProbe();
});

// ── Contrat et chaîne T6 ─────────────────────────────────────────────────────

describe('Contrat et chaîne T6', () => {
  it('T6-RAP-01 — SHOW_NOW + INFORMATION + INFORMATIVE_REMINDER sans action : accepté ; ACTION_NOW / TO_ANTICIPATE exigent toujours leur action', () => {
    expect(C.T6_REASON_CODES.INFORMATIVE_REMINDER).toBe('SHOW_NOW');
    const e = entree([candidat()]);
    expect(C.validateT6Evaluation(e, sortie([rappel()]))).toMatchObject({ ok: true, rejected: [], accepted: [{ decision: 'SHOW_NOW', category: 'INFORMATION', reasonCode: 'INFORMATIVE_REMINDER', expectedAction: null }] });
    const v = (d: Dec, c = candidat()) => C.evaluationDecisionViolation(d, c, TODAY);
    // Justification, preuve, motif dédié, aucune action ni date pour agir, événement À VENIR.
    expect(v(rappel('C1', { evidenceRefs: [] }))).toBe('show_now_without_evidence');
    expect(v(rappel('C1', { reason: 'court' }))).toBe('reason_missing');
    expect(v(rappel('C1', { reasonCode: 'ACTION_REQUIRED_SOON' }))).toBe('show_now_information');
    expect(v(rappel('C1', { expectedAction: 'Préparer la visite' }))).toBe('information_with_action');
    expect(v(rappel('C1', { actionDeadline: '2026-10-20' }))).toBe('information_with_action');
    expect(v(rappel(), candidat({ dueDate: TODAY }))).toBe('information_not_upcoming');
    expect(v(rappel(), candidat({ dueDate: '2026-10-01', overdue: true }))).toBe('information_not_upcoming');
    expect(v(rappel(), candidat({ requiresQualification: true }))).toBe('information_not_upcoming');
    expect(v(rappel('C1', { decision: 'DEFER' }))).toBe('reason_code_mismatch');
    // ACTION_NOW / TO_ANTICIPATE : l'absence d'action REJETTE, jamais convertie en rappel.
    expect(v(agir('C1', { expectedAction: null }))).toBe('show_now_without_action');
    expect(v(agir('C1', { category: 'TO_ANTICIPATE', reasonCode: 'PREPARATION_NEEDED_NOW', expectedAction: null }))).toBe('show_now_without_action');
    expect(v(agir('C1', { reasonCode: 'INFORMATIVE_REMINDER' }))).toBe('reminder_category_mismatch');
    expect(v(agir('C1', { reasonCode: 'INFORMATIVE_REMINDER', expectedAction: null }))).toBe('reminder_category_mismatch');
    // Prompt livré cohérent avec le contrat : motif dédié et règle du rappel informatif.
    expect(MASTER).toContain('"INFORMATIVE_REMINDER"');
    expect(MASTER).toMatch(/jamais par défaut parce qu’aucune action n’est identifiée/);
    expect(MASTER).not.toContain('"SHOW_NOW" n’est jamais associé à "INFORMATION"');
    // Corpus P-T6-EV-04 : rappel accepté, action manquante et rappel avec action rejetés.
    const cas = JSON.parse(readFileSync(join(process.cwd(), 'src/services/home/mascot/__fixtures__/p-t6-ev-04-rappel-informatif.json'), 'utf8'));
    expect(C.evaluateT6EvaluationCorpusCase(cas.context, cas.recording.output, cas.expected)).toEqual([]);
  });

  it('T6-RAP-02 — conversion et décision : INFORM, jamais ACT_NOW par défaut ni supprimé faute d’action ; seuil, répétition, préférences inchangés', () => {
    const a = I.assessmentFromDecision(rappel());
    expect(a).toMatchObject({ interpellation: 'INFORM', actionNeeded: false, action: null, actionDate: null, exceptionReason: null, priority: 'LOW' });
    // Décision serveur : affiché comme RAPPEL, pas comme action.
    expect(decide({ assessment: stocke(rappel()) })).toMatchObject({ decision: 'SHOW_NOW', code: 'AI_INFORM', mode: 'INFORM', action: null, aiDecision: 'SHOW_NOW' });
    // Une action reste une action ; un « rien à faire » reste écarté.
    expect(decide({ assessment: stocke(agir()) })).toMatchObject({ decision: 'SHOW_NOW', mode: 'ACT_NOW', code: 'AI_ACT_NOW' });
    expect(decide({ assessment: stocke(aucune()) })).toMatchObject({ decision: 'SUPPRESS', code: 'AI_NO_INTERPELLATION' });
    // Seuil indicatif : un rappel lointain n'est jamais une exception (aucune démarche à engager avant).
    const loin = cand({ dueDate: '2027-03-01' });
    expect(decide({ candidate: loin, assessment: stocke(rappel()) })).toMatchObject({ decision: 'SUPPRESS', code: 'BEYOND_THRESHOLD', thresholdApplied: true });
    // Non-répétition : même pause qu'une action non prioritaire.
    expect(decide({ assessment: stocke(rappel()), history: { displayedDays: I.T6_REPEAT_MAX_DAYS } })).toMatchObject({ decision: 'DEFER', code: 'REPEAT_COOLDOWN' });
    // Préférences de l'utilisateur et sujet clos : toujours prioritaires.
    const report = { scope: 'OCCURRENCE' as const, decision: 'SNOOZED' as const, remindAt: '2026-10-21', contextFingerprint: 'fp1', agendaItemId: 1, seriesKey: null };
    const refus = { ...report, decision: 'DISMISSED' as const, remindAt: null };
    expect(decide({ assessment: stocke(rappel()), preferences: [report] })).toMatchObject({ decision: 'DEFER', code: 'USER_SNOOZED' });
    expect(decide({ assessment: stocke(rappel()), preferences: [refus] })).toMatchObject({ decision: 'SUPPRESS', code: 'USER_DISMISSED_OCCURRENCE' });
    expect(decide({ candidate: cand({ state: 'RESOLVED' }), assessment: stocke(rappel()) })).toMatchObject({ decision: 'SUPPRESS', code: 'SUBJECT_CLOSED' });
    // Sans IA : aucun rappel inventé (dégradation prudente inchangée).
    expect(decide({ aiCapable: false })).toMatchObject({ decision: 'DEFER', code: 'EVALUATION_UNAVAILABLE' });
    // Ordre : une action établie passe avant un rappel, même de priorité plus haute.
    const base = { dueDate: '2026-10-22' };
    const r1 = { ...decide({ assessment: stocke(rappel('C1', { priorityHint: 'HIGH' })) }), ...base };
    const a1 = { ...decide({ candidate: cand({ agendaItemId: 2, subjectKey: 'agenda:2', dueDate: '2026-11-04' }), assessment: stocke(agir()) }), dueDate: '2026-11-04' };
    expect([r1, a1].sort(I.compareShown).map((x) => x.mode)).toEqual(['ACT_NOW', 'INFORM']);
  });

  it('T6-RAP-03 — persistance (0474) : INFORM et révision 2 écrits ; colonne absente tolérée ; sorties existantes compatibles', async () => {
    const mig = readFileSync(join(process.cwd(), 'src/db/migrations/0474_t6_rappel_informatif.sql'), 'utf8');
    expect(mig).toContain("CHECK (interpellation IN ('ACT_NOW', 'ANTICIPATE', 'INFORM', 'LATER', 'NONE')) NOT VALID");
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS contract_revision SMALLINT NOT NULL DEFAULT 1/);
    expect(mig).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
    const refs = new Map([['C1', { subjectKey: 'agenda:1', agendaItemId: 1, fingerprint: 'fp1', daysUntilDue: 4 }]]);
    const [d] = (C.validateT6Evaluation(entree([candidat()]), sortie([rappel()])) as { accepted: import('../t6-contract').T6ValidatedDecision[] }).accepted;
    // Colonne présente (sonde) : révision écrite.
    unsafe.mockImplementation(async (q: string) => (/information_schema/.test(q) ? [{ ok: 1 }] : [{ id: 9 }]));
    expect(await S.persistT6Assessments(7, TODAY, refs, [d], { promptVersion: 'v', traceId: 't', contractRevision: 2 })).toBe(1);
    const ins = unsafe.mock.calls.find((c) => /INSERT INTO t6_interpellation_assessments/.test(c[0]))!;
    expect(ins[0]).toMatch(/contract_revision\)/);
    expect(ins[1]).toEqual(expect.arrayContaining(['INFORM', false, 'SHOW_NOW', 'INFORMATION', 'INFORMATIVE_REMINDER', 2]));
    expect((ins[1] as unknown[])[11]).toBeNull(); // action
    // Colonne absente (fenêtre de déploiement) : décision enregistrée sans elle.
    unsafe.mockReset(); S.resetContractRevisionProbe();
    unsafe.mockImplementation(async (q: string) => (/information_schema/.test(q) ? [] : [{ id: 9 }]));
    expect(await S.persistT6Assessments(7, TODAY, refs, [d], { promptVersion: 'v', traceId: null })).toBe(1);
    expect(unsafe.mock.calls.find((c) => /INSERT INTO/.test(c[0]))![0]).not.toMatch(/contract_revision/);
    // Lecture : révision absente → 1 (évaluations antérieures au lot 68).
    unsafe.mockReset();
    unsafe.mockResolvedValue([{ id: 3, agenda_item_id: 1, context_fingerprint: 'fp1', assessed_on: TODAY, interpellation: 'INFORM', action_needed: false, priority: 'LOW', reason: 'r', contract_version: 't6-evaluation-v1', decision: 'SHOW_NOW', category: 'INFORMATION', reason_code: 'INFORMATIVE_REMINDER', evidence_refs: ['C1.dueDate'], uncertainties: [], contract_revision: null }]);
    const lu = (await S.loadAssessments(7, [1])).get(1)!;
    expect(lu).toMatchObject({ interpellation: 'INFORM', contractRevision: 1 });
    expect(unsafe.mock.calls[0][0]).toMatch(/to_jsonb\(a\) -> 'contract_revision'/);
    // Sorties existantes (lot 61) toujours acceptées à l'identique.
    for (const f of ['p-t6-ev-01-decision-valide', 'p-t6-ev-02-ordre-inverse', 'p-t6-ev-03-show-now-injustifie']) {
      const c = JSON.parse(readFileSync(join(process.cwd(), `src/services/home/mascot/__fixtures__/${f}.json`), 'utf8'));
      expect(C.evaluateT6EvaluationCorpusCase(c.context, c.recording.output, c.expected)).toEqual([]);
    }
  });

  it('T6-RAP-04 — renouvellement ciblé : évaluations antérieures susceptibles de changer réévaluées, sans quitter l’accueil ; formulations en cache renouvelées', async () => {
    const ancienne = (d: Dec) => stocke(d, 'fp1', { contractRevision: 1 });
    // Prompt effectif porteur de la règle : SHOW_NOW et SUPPRESS « aucune action » sont revus…
    expect(I.assessmentStatus(ancienne(agir()), cand(), TODAY, SEUIL, { reminderCapable: true })).toBe('AGED');
    expect(I.assessmentStatus(ancienne(aucune()), cand(), TODAY, SEUIL, { reminderCapable: true })).toBe('AGED');
    // … les autres restent valables ; révision 2 ou prompt BO antérieur : rien à renouveler.
    expect(I.assessmentStatus(ancienne(aucune('C1', { reasonCode: 'ALREADY_HANDLED' })), cand(), TODAY, SEUIL, { reminderCapable: true })).toBe('FRESH');
    expect(I.assessmentStatus(ancienne(aucune('C1', { decision: 'DEFER', reasonCode: 'TOO_EARLY' })), cand(), TODAY, SEUIL, { reminderCapable: true })).toBe('FRESH');
    expect(I.assessmentStatus(stocke(agir()), cand(), TODAY, SEUIL, { reminderCapable: true })).toBe('FRESH');
    expect(I.assessmentStatus(ancienne(agir()), cand(), TODAY, SEUIL, { reminderCapable: false })).toBe('FRESH');
    // Pendant le renouvellement, l'action déjà retenue reste affichée et une réévaluation est demandée.
    expect(decide({ assessment: ancienne(agir()), reminderCapable: true })).toMatchObject({ decision: 'SHOW_NOW', needsAssessment: true, assessmentFresh: false });
    // Détection de la règle dans le prompt effectif.
    expect(R.promptSupportsInformativeReminder(null)).toBe(true);
    expect(R.promptSupportsInformativeReminder(MASTER)).toBe(true);
    expect(R.promptSupportsInformativeReminder(MASTER.replace(/"INFORMATIVE_REMINDER"/g, '"X"'))).toBe(false);
    configText = MASTER.replace(/"INFORMATIVE_REMINDER"/g, '"X"');
    expect(await R.t6ReminderAvailable()).toBe(false);
    configText = null;
    expect(await R.t6ReminderAvailable()).toBe(true);
    // Révision conservée avec les décisions : 2 si la version qui a évalué connaît la règle, sinon 1.
    for (const [capable, attendu] of [[true, 2], [false, 1]] as const) {
      R.resetT6EvaluationState();
      const persist = vi.fn(async (l: unknown[], _m: { contractRevision?: number }) => l.length);
      const bundle = { context: entree([candidat()]), refs: new Map([['C1', { subjectKey: 'agenda:1', agendaItemId: 1, fingerprint: 'fp1', daysUntilDue: 4 }]]), persist };
      await R.evaluateWithT6({ accountId: 7, bundle, mode: 'pregen' }, {
        available: async () => true, promptVersion: async () => `v${attendu}`, reminderCapable: async () => capable,
        execute: (async () => ({ data: sortie([rappel()]), model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 't' })) as never,
      });
      expect(persist.mock.calls[0][1]).toMatchObject({ contractRevision: attendu });
    }
    // Formulation en cache portant « À prévoir : » ou une introduction : ignorée (donc renouvelée).
    const input = buildT6Input([{ subjectId: 'S1', sourceCode: 'DATE-NEXT', intent: 'deadline', facts: { title: 'Ramonage', dateLabel: '4 novembre 2026', dateNature: 'confirmée' }, fallbackText: 'Le ramonage est à prévoir pour le 4 novembre 2026.', allowedHighlight: null } as never]);
    for (const [texte, servi] of [
      ['Le ramonage est à prévoir pour le 4 novembre 2026. À prévoir : prendre rendez-vous.', false],
      ['Un sujet mérite votre attention aujourd’hui : le ramonage, le 4 novembre 2026.', false],
      ['Le ramonage est à prévoir pour le 4 novembre 2026.', true],
    ] as const) {
      unsafe.mockResolvedValueOnce([{ messages: [{ subjectId: 'S1', text: texte, highlight: null }] }]);
      expect(!!(await R.readT6CacheEntry(7, 'k', input))).toBe(servi);
    }
  });
});

// ── Composition ──────────────────────────────────────────────────────────────

describe('Composition de la bulle', () => {
  it('T6-RAP-05 — cas de la capture (rappel informatif), IA et secours : sujet, bien et date une seule fois ; ni introduction, ni préparation, ni « Action à prévoir »', () => {
    const r = raw([VISITE]);
    for (const ia of [undefined, () => 'La visite de l’expert bois pour la maison est prévue le 22 octobre 2026.']) {
      const p = accueil(r, [informe(1)], { ia });
      const [b] = B.subjectBlocks(p);
      expect(B.subjectBlocks(p)).toHaveLength(1);
      expect(b.text).toBe(ia ? 'La visite de l’expert bois pour la maison est prévue le 22 octobre 2026.' : 'La visite expert bois de la maison est prévue le 22 octobre 2026.');
      expect(b.actions.map((a) => a.label)).toEqual(['Voir']);
      expect(b.reminder).toMatchObject({ agendaItemId: 1 });
      expect(b).toMatchObject({ informative: true, badge: null, tone: 'blue' });
      const tout = affiche(p);
      expect(compter(tout, /22 octobre 2026/)).toBe(1);
      expect(compter(tout, /maison/)).toBe(1);
      expect(compter(tout, /expert bois/)).toBe(1);
      expect(tout).not.toMatch(MECANIQUE);
      expect(entete(p)).toBe('');
      expect(B.homeItems(p, false)).toEqual([]);
      // Un rappel n'est pas une action prioritaire : ni compteur, ni pose « à traiter ».
      expect(p.state).toMatchObject({ kind: 'INFORMATION', actions: 0, information: 1 });
      expect(B.homePose(p, false)).toBe('neutral');
      expect(p.paragraphs[0].tile).toMatchObject({ attention: false, kind: 'info', status: '22 octobre 2026' });
    }
    // Faits transmis à FORMULATE : aucun « expectedAction », la nature « rappel informatif ».
    const c = buildCandidates(r, { interpellation: { shown: [informe(1)] } });
    const [s] = buildT6Input(selectSubjects(c.candidates)).subjects;
    expect(s).toMatchObject({ intent: 'inform', facts: { interpellation: 'rappel informatif', dateRole: 'SCHEDULED_EVENT' } });
    expect(s.facts).not.toHaveProperty('expectedAction');
    // Date à respecter (non planifiée) : fixée, jamais « à prévoir » ; estimée : dite estimée.
    const deadline = accueil(raw([{ ...VISITE, dateRole: 'DEADLINE' }]), [informe(1)]);
    expect(B.subjectBlocks(deadline)[0].text).toBe('La prochaine visite expert bois de la maison est fixée au 22 octobre 2026.');
    const estimee = accueil(raw([{ ...VISITE, forecast: true }]), [informe(1)]);
    expect(B.subjectBlocks(estimee)[0].text).toMatch(/estimée autour du 22 octobre 2026\.$/);
    expect(estimee.paragraphs[0].tile?.status).toBe('22 octobre 2026 (estimée)');
  });

  it('T6-RAP-06 — action concrète établie : visible, prioritaire, sans « À prévoir : » ; préparation artificielle retirée', () => {
    const r = raw([VISITE, RAMONAGE]);
    const p = accueil(r, [action(2), informe(1)]);
    const blocs = B.subjectBlocks(p);
    expect(blocs.map((b) => b.paragraph.reminder?.agendaItemId)).toEqual([2, 1]);
    expect(blocs[0]).toMatchObject({ informative: false, badge: 'Action à prévoir', tone: 'amber' });
    expect(blocs[0].text).toBe('Le prochain ramonage cheminée de la maison est à prévoir pour le 4 novembre 2026. Prendre rendez-vous pour le ramonage.');
    expect(blocs[1]).toMatchObject({ informative: true, badge: null });
    expect(p.state).toMatchObject({ kind: 'ACTIONS', actions: 1, information: 1 });
    expect(B.homePose(p, false)).toBe('reminder-bell');
    expect(parler(p)).not.toMatch(/À prévoir :|mérite/);
    // Action générique qui ne dit rien de plus que le sujet : retirée (texte et faits).
    const art = accueil(raw([{ ...VISITE, dateRole: 'DEADLINE', date: '2026-10-22' }]), [action(1, 'Préparer la visite expert bois pour la maison')]);
    expect(B.subjectBlocks(art)[0].text).toBe('La prochaine visite expert bois de la maison est à prévoir pour le 22 octobre 2026.');
    expect(art.paragraphs[0]).toBeDefined();
    const [s] = buildT6Input(selectSubjects(buildCandidates(raw([VISITE]), { interpellation: { shown: [action(1, 'Préparer la visite expert bois pour la maison')] } }).candidates)).subjects;
    expect(s.facts).not.toHaveProperty('expectedAction');
    // Primitives pures.
    expect(I.actionIsDistinct('Préparer la visite expert bois pour la maison', { title: 'Visite expert bois', assetName: 'Maison' })).toBe(false);
    expect(I.actionIsDistinct('Anticiper le ramonage', { title: 'Ramonage cheminée', assetName: 'Maison' })).toBe(false);
    expect(I.actionIsDistinct('Envoyer la demande de résiliation', { title: 'Échéance assurance auto', assetName: 'Clio' })).toBe(true);
    expect(I.actionSentence('à prévoir : comparer les offres')).toBe('Comparer les offres.');
    expect(I.actionSentence('EDF : relever le compteur')).toBe('EDF : relever le compteur.');
  });

  it('T6-RAP-07 — zéro, un et deux sujets, IA et secours : jamais « rien à signaler » si un sujet est affiché ou si l’évaluation est indisponible', () => {
    const r = raw([VISITE, RAMONAGE]);
    const zero = accueil(r, []);
    expect(entete(zero)).toBe(B.NOTHING_TO_REPORT_SPEECH);
    expect(B.subjectBlocks(zero)).toEqual([]);
    for (const ev of ['PENDING', 'UNAVAILABLE'] as const) {
      const p = accueil(r, [], { evaluation: ev });
      expect(entete(p)).toBe(ev === 'PENDING' ? B.EVALUATION_PENDING_SPEECH : B.EVALUATION_UNAVAILABLE_SPEECH);
      expect(entete(p)).not.toBe(B.NOTHING_TO_REPORT_SPEECH);
    }
    for (const ia of [undefined, (t: string) => t]) {
      for (const shown of [[informe(1)], [action(2)], [action(2), informe(1)]]) {
        const p = accueil(r, shown, { ia });
        expect(B.subjectBlocks(p)).toHaveLength(shown.length);
        expect(entete(p)).not.toBe(B.NOTHING_TO_REPORT_SPEECH);
        expect(parler(p)).not.toContain(B.NOTHING_TO_REPORT_SPEECH);
        expect(affiche(p)).not.toMatch(/mérite votre attention|méritent votre attention|À prévoir :/);
        // Évaluation encore indisponible pour une autre échéance : dit, jamais « rien à signaler ».
        const q = accueil(r, shown, { ia, evaluation: 'UNAVAILABLE' });
        expect(entete(q)).toBe(B.EVALUATION_UNAVAILABLE_SPEECH);
      }
    }
  });

  it('T6-RAP-08 — rappel reporté, refusé ou devenu sans objet : ne réapparaît pas ; aucune échéance historique réintroduite', async () => {
    // Préparation complète (lectures simulées) : évaluations, préférences de CET utilisateur.
    const evaluations = (revision: number) => [VISITE, RAMONAGE].map((x) => ({
      id: x.id, agenda_item_id: x.id, assessed_on: TODAY, priority: x.id === 1 ? 'LOW' : 'MEDIUM', reason: 'r',
      context_fingerprint: S.agendaFingerprint({ title: x.title, date: x.date, forecast: false, requiresQualification: false }),
      interpellation: x.id === 1 ? 'INFORM' : 'ACT_NOW', action_needed: x.id !== 1, action: x.id === 1 ? null : 'Prendre rendez-vous pour le ramonage',
      contract_version: 't6-evaluation-v1', decision: 'SHOW_NOW', category: x.id === 1 ? 'INFORMATION' : 'ACTION_NOW',
      reason_code: x.id === 1 ? 'INFORMATIVE_REMINDER' : 'ACTION_REQUIRED_SOON', evidence_refs: ['C1.dueDate'], uncertainties: [], contract_revision: revision,
    }));
    let prefs: unknown[] = [];
    unsafe.mockImplementation(async (q: string) => (/FROM t6_reminder_preferences/.test(q) ? prefs : /FROM t6_interpellation_assessments/.test(q) ? evaluations(2) : []));
    const deps = { aiCapable: async () => true, thresholdDays: async () => SEUIL, reminderCapable: async () => true };
    const prep = (r: Raw) => S.prepareT6Interpellation({ accountId: 7, userId: 5, raw: r }, deps);
    const tous = await prep(raw([VISITE, RAMONAGE]));
    expect(tous.shown.map((x) => [x.agendaItemId, x.interpellation.mode])).toEqual([[2, 'ACT_NOW'], [1, 'INFORM']]);
    expect(tous.bundle).toBeNull(); // décisions fraîches : aucune réévaluation
    // Reporté (occurrence) puis refusé (série) : retiré, jamais réintroduit par une question.
    prefs = [{ scope: 'OCCURRENCE', decision: 'SNOOZED', remind_at: '2026-10-21', context_fingerprint: null, agenda_item_id: 1, series_key: null }];
    let p = await prep(raw([VISITE, RAMONAGE]));
    expect(p.shown.map((x) => x.agendaItemId)).toEqual([2]);
    expect(p.userSilenced.has(1)).toBe(true);
    prefs = [{ scope: 'SERIES', decision: 'DISMISSED', remind_at: null, context_fingerprint: null, agenda_item_id: null, series_key: 'ramonage' }];
    p = await prep(raw([VISITE, RAMONAGE]));
    expect(p.shown.map((x) => x.agendaItemId)).toEqual([1]);
    expect(p.discarded.has(2)).toBe(true);
    // Devenu sans objet : date passée → le rappel n'est plus présenté (et le contrat le refuserait).
    prefs = [];
    p = await prep(raw([{ ...VISITE, date: '2026-10-10' }]));
    expect(p.shown).toEqual([]);
    expect(accueil(raw([{ ...VISITE, date: TODAY }]), [informe(1)]).paragraphs.filter((x) => x.sourceCode !== 'CLEAR')).toEqual([]);
    // Côté écran : retiré aussitôt du texte ET du bloc (`withoutSubjects`, MascotSpeaks).
    const { withoutSubjects } = await import('@/components/home/MascotSpeaks');
    const ecran = withoutSubjects(accueil(raw([VISITE, RAMONAGE]), [action(2), informe(1)]), new Set(['DATE-NEXT:1']))!;
    expect(B.subjectBlocks(ecran).map((b) => b.key)).toEqual(['DATE-NEXT:2']);
    expect(parler(ecran)).not.toMatch(/expert bois/);
    // Sans évaluation : aucune échéance proche, lointaine ou passée réintroduite d'office.
    unsafe.mockResolvedValue([]);
    const sansIa = await S.prepareT6Interpellation({ accountId: 7, userId: 5, raw: raw([VISITE, RAMONAGE, { ...RAMONAGE, id: 3, date: '2026-10-01' }, { ...RAMONAGE, id: 4, date: '2027-06-01' }]) },
      { aiCapable: async () => false, thresholdDays: async () => SEUIL });
    expect(sansIa.shown).toEqual([]);
    expect(sansIa.evaluation).toBe('UNAVAILABLE');
  });

  it('T6-RAP-09 — « À traiter », documents en cours et invitation Duo préservés à côté d’un rappel informatif', () => {
    const duo = { href: '/mon-compte?panneau=duo', title: 'Inviter quelqu’un', subtitle: 'Premium Duo', cta: 'Inviter' };
    const item = { todoId: 't1', actionKind: 'COMPLETE', priority: 'DO_FIRST', title: 'Numéro à compléter', subtitle: 'Maison', cta: 'Ouvrir', entityType: 'ASSET', actionType: 'OPEN_TODO_CARD', todoType: 'DATA', card: { question: 'Numéro ?' } } as never;
    const r = raw([VISITE], { processing: { uploads: [], analyses: [{ id: 5, title: 'Facture garage', at: '2026-10-18T08:00:00Z' }], exports: [] } });
    const p = accueil(r, [informe(1)], { todo: { total: 3, items: [item] }, duoInvite: duo });
    expect(B.homeItems(p, false).map((x) => x.kind)).toEqual(['duo-invite', 'todo']);
    expect(B.subjectBlocks(p).map((b) => b.paragraph.sourceCode)).toEqual(['PROC-DOC-ANALYSIS', 'DATE-NEXT']);
    // L'en-tête compte les « À traiter » affichés (MASC3), jamais le rappel.
    expect(entete(p)).toBe('Deux sujets nécessitent votre attention aujourd’hui.');
    expect(p.state).toMatchObject({ kind: 'ACTIONS', actions: 2, information: 2 });
    expect(B.homePose(p, false)).toBe('reminder-bell');
    // Document en cours : bloc « Voir » (tiroir du document).
    expect(B.subjectBlocks(p)[0].actions[0]).toMatchObject({ label: 'Voir', action: { target: { kind: 'drawer', drawer: 'document', id: 5 } } });
  });

  it('T6-RAP-10 — rapports et compteurs : rappel informatif, action, report et suppression distingués', () => {
    const trace = (d: ReturnType<typeof decide>, id: number) => ({ ...d, agendaItemId: id, dueDate: '2026-10-22', seriesKey: null, assessment: null, displayedDays: 0 });
    const report = { scope: 'OCCURRENCE' as const, decision: 'SNOOZED' as const, remindAt: '2026-10-21', contextFingerprint: 'fp1', agendaItemId: 1, seriesKey: null };
    const decisions = [
      trace(decide({ assessment: stocke(rappel()) }), 1),
      trace(decide({ assessment: stocke(agir()) }), 2),
      trace(decide({ assessment: stocke(rappel()), preferences: [report] }), 3),
      trace(decide({ assessment: stocke(rappel()), preferences: [{ ...report, decision: 'DISMISSED', remindAt: null }] }), 4),
      trace(decide({ assessment: stocke(aucune()) }), 5),
    ];
    expect(decisions.map(S.t6OutcomeOf)).toEqual(['INFORMATIVE_REMINDER', 'ACTION', 'USER_SNOOZED', 'USER_DISMISSED', 'SUPPRESSED']);
    expect(S.t6OutcomeCounters(decisions)).toEqual({ INFORMATIVE_REMINDER: 1, ACTION: 1, USER_SNOOZED: 1, USER_DISMISSED: 1, DEFERRED: 0, SUPPRESSED: 1 });
    const lignes = S.t6ReportEntries(decisions, SEUIL).filter((e) => e.section === 'INTERPELLATION');
    expect(lignes.map((l) => (l.value as { outcome: string }).outcome)).toEqual(['INFORMATIVE_REMINDER', 'ACTION', 'USER_SNOOZED', 'USER_DISMISSED', 'SUPPRESSED']);
    expect(lignes[0].value).toMatchObject({ decision: 'SHOW_NOW', mode: 'INFORM', code: 'AI_INFORM' });
    const ev = S.t6EvaluationEntries({
      status: 'generated', promptVersion: 'v', inputContract: 't6-evaluation-input-v1', outputContract: 't6-evaluation-v1', traceId: 't', error: null, persisted: 2,
      accepted: [{ subjectId: 'C1', decision: 'SHOW_NOW', category: 'INFORMATION', reasonCode: 'INFORMATIVE_REMINDER', priorityHint: 'LOW', evidenceRefs: ['C1.dueDate'] },
        { subjectId: 'C2', decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', priorityHint: 'MEDIUM', evidenceRefs: ['C2.dueDate'] }],
      rejected: [],
    }, new Map([['C1', { subjectKey: 'agenda:1', agendaItemId: 1, fingerprint: 'f', daysUntilDue: 4 }], ['C2', { subjectKey: 'agenda:2', agendaItemId: 2, fingerprint: 'f', daysUntilDue: 17 }]]));
    expect(ev.map((e) => (e.value as { informativeReminder: boolean }).informativeReminder)).toEqual([true, false]);
    expect(JSON.stringify([...lignes, ...ev])).not.toMatch(/expert bois|Maison|ramonage/i);
    // Compteurs du rapport (sources lues par le BO).
    const src = readFileSync(join(process.cwd(), 'src/services/home/mascot/t6-interpellation.service.ts'), 'utf8');
    for (const k of ['shownActions', 'shownInformativeReminders', 'userSnoozed', 'userDismissed', 'showNowInformation']) expect(src).toContain(k);
  });

  it('T6-RAP-11 — message IA porteur d’une formule mécanique : repli sur le texte de secours de CE sujet', () => {
    const r = raw([VISITE, RAMONAGE]);
    const c = buildCandidates(r, { interpellation: { shown: [action(2), informe(1)] } });
    const input = buildT6Input(selectSubjects(c.candidates));
    const ia = (t1: string, t2: string) => C.validateT6MasterOutput(input, {
      schemaVersion: 't6-output-v2', messages: [{ subjectId: input.subjects[0].subjectId, text: t1 }, { subjectId: input.subjects[1].subjectId, text: t2 }],
    });
    const ok2 = 'La visite de l’expert bois pour la maison est prévue le 22 octobre 2026.';
    // (« aujourd’hui » seul rejetterait toute la sortie : date relative, contrôle historique.)
    const v = ia('Un sujet mérite votre attention : le ramonage cheminée de la maison, le 4 novembre 2026.', ok2);
    expect(v).toMatchObject({ ok: true, fallbackSubjects: [0] });
    expect(v.ok && v.messages.map((m) => m.text)).toEqual([input.subjects[0].fallbackText, ok2]);
    expect(ia('Le ramonage cheminée de la maison est à prévoir pour le 4 novembre 2026. À prévoir : prendre rendez-vous.', ok2)).toMatchObject({ ok: true, fallbackSubjects: [0] });
    expect(C.mechanicalWording('Deux sujets méritent votre attention aujourd’hui.')).toBe(true);
    expect(C.mechanicalWording('Le ramonage est à prévoir pour le 4 novembre 2026.')).toBe(false);
    // Rappel informatif : la date confirmée n'est pas présentée comme estimée.
    expect(ia(input.subjects[0].fallbackText, 'La visite de l’expert bois est estimée autour du 22 octobre 2026.')).toMatchObject({ ok: true, fallbackSubjects: [1] });
  });
});
