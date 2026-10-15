/**
 * Lot 60 — ticket « [P2] T6 — Améliorer la décision d'interpellation et
 * implémenter la gestion intelligente des rappels » : tests UNITAIRES (T6
 * simulé, aucun appel réseau, base simulée). Les mêmes critères sont prouvés
 * sur PostgreSQL 16 réel par `src/test/e2e/scenarios/l60b-t6-interpellation.e2e.ts`.
 *
 * Sélection intelligente
 *  T6-INT-01  assurance à 78 jours sans démarche identifiée : aucune interpellation
 *  T6-INT-02  au-delà de 60 jours, action réellement nécessaire maintenant : interpellation motivée
 *  T6-INT-03  échéance à 20 jours sans action nécessaire : aucune interpellation automatique
 *  T6-INT-04  échéance dépassée sans action restante : aucune interpellation
 *  T6-INT-05  échéance dépassée nécessitant une démarche : interpellation adaptée
 *  T6-INT-06  ni date ni contexte suffisant : aucun délai inventé
 * Gestion des rappels
 *  T6-INT-07  « Me le rappeler plus tard » masque jusqu'à la date enregistrée
 *  T6-INT-08  à la date, réévaluation : un sujet devenu sans objet n'est pas rappelé
 *  T6-INT-09  « Ne plus me rappeler » : durable, jamais annulé par une nouvelle évaluation
 *  T6-INT-11  occurrences récurrentes : portée occurrence / série respectée
 * Affichage et supervision
 *  T6-INT-14  résumé et cartes construits sur les mêmes décisions (aucune contradiction)
 *  T6-INT-15  événements distincts : une carte et des actions par échéance
 *  T6-INT-16  aucun libellé concaténé « X et Y »
 *  T6-INT-17  reporting : sujets affichés ET écartés, motif, seuil, rappel ; aucune donnée personnelle recopiée
 * Contrat IA
 *  T6-INT-19  R13 : prompt livré, variable facultative, version BO antérieure → décision prudente
 *  T6-INT-20  anti-répétition sans évolution du contexte
 *  T6-INT-22  évaluations du même appel T6 validées et persistées (y compris si les textes sont rejetés)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
let configText: string | null = null;
let t6Ouvert = true;
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({ promptArchitecture: 'master', masterPromptText: configText, configVersionId: 3 }),
}));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => t6Ouvert }));

const I = await import('../t6-interpellation');
const R = await import('../t6-runner');
const { buildCandidates, decidedAgendaSubjects } = await import('../signals');
const { selectSubjects, buildSecondaries } = await import('../selector');
const { buildPresentation } = await import('../presentation');
const { buildT6Input, T6FormulateOutput, T6_MASTER_OPERATION_SPEC } = await import('../t6-contract');
const { composeSpeech, homeItems, NOTHING_PRIORITY } = await import('../bubble');
const { t6ReportEntries, t6Candidates, agendaFingerprint, preferencesFor } = await import('../t6-interpellation.service');
const { renderMasterPrompt, isOptionalMasterVariable } = await import('@/services/ai/prompts/prompt-loader');
const { getOperation } = await import('@/services/ai/registry/operations');
type Raw = import('../signals').MascotRawData;
type Row = import('../signals').MascotAgendaRow;
type Cand = import('../t6-interpellation').T6Candidate;
type Assess = import('../t6-interpellation').T6StoredAssessment;

const TODAY = '2026-10-15';
const SEUIL = 60;

const cand = (o: Partial<Cand> = {}): Cand => ({
  subjectKey: 'agenda:1', agendaItemId: 1, occurrenceKey: 'agenda:1@2027-01-01', seriesKey: null, accountId: 7, assetId: null,
  dueDate: '2027-01-01', state: 'ACTIVE', fingerprint: 'fp1', ...o,
});
const ia = (o: Partial<Assess> = {}): Assess => ({
  interpellation: 'NONE', actionNeeded: false, action: null, reason: 'Information suivie.', consequence: null,
  actionDate: null, priority: 'LOW', uncertainty: null, exceptionReason: null, reevaluateOn: null,
  fingerprint: 'fp1', assessedOn: TODAY, ...o,
});
const decide = (o: Partial<Parameters<typeof I.decideT6Interpellation>[0]> = {}) => I.decideT6Interpellation({
  candidate: cand(), today: TODAY, thresholdDays: SEUIL, aiCapable: true, assessment: null, preferences: [], ...o,
});

const assurance = (id: number, date: string, o: Partial<Row> = {}): Row => ({
  id, title: `Échéance assurance habitation ${id}`, date, forecast: false, requiresQualification: false,
  assetId: 1, assetName: 'Maison', assetCategory: 'HOUSING', assetSubtype: 'Maison', dateRole: 'DEADLINE', seriesKey: null, ...o,
});
const raw = (agenda: Row[], over: Partial<Raw> = {}): Raw => ({
  accountId: 7, today: TODAY,
  processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 3 },
  toProcess: [], agenda, acknowledgments: [], overdueAgenda: [],
  ...over,
} as Raw);

beforeEach(() => { unsafe.mockReset(); unsafe.mockResolvedValue([]); configText = null; t6Ouvert = true; });

// ── Sélection intelligente ──────────────────────────────────────────────────

describe('Sélection intelligente', () => {
  it('T6-INT-01 — assurance à 78 jours sans démarche : aucune interpellation (IA « NONE », IA en attente, sans IA)', () => {
    const c = cand({ dueDate: '2027-01-01' });
    expect(I.daysBetween(TODAY, '2027-01-01')).toBe(78);
    const aucune = decide({ candidate: c, assessment: ia() });
    expect(aucune).toMatchObject({ decision: 'SUPPRESS', code: 'AI_NO_INTERPELLATION' });
    // Même si l'IA hésitait (ACT_NOW) sans motif concret ni date d'action : seuil appliqué.
    const sansMotif = decide({ candidate: c, assessment: ia({ interpellation: 'ACT_NOW', actionNeeded: true, priority: 'MEDIUM' }) });
    expect(sansMotif).toMatchObject({ decision: 'SUPPRESS', code: 'BEYOND_THRESHOLD', thresholdApplied: true, nextReevaluationAt: '2026-11-02' });
    // Évaluation en attente : rien n'est affiché d'office.
    expect(decide({ candidate: c })).toMatchObject({ decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', needsAssessment: true, deferredBy: 'SYSTEM' });
    // Sans IA (T6 coupé, prompt BO antérieur) : jamais d'interpellation lointaine.
    expect(decide({ candidate: c, aiCapable: false })).toMatchObject({ decision: 'SUPPRESS', code: 'NO_AI_BEYOND_THRESHOLD' });
  });

  it('T6-INT-02 — au-delà de 60 jours, démarche à engager avant (motif concret, date dans le seuil) : interpellation justifiée', () => {
    const d = decide({ assessment: ia({
      interpellation: 'ACT_NOW', actionNeeded: true, priority: 'HIGH', action: 'Envoyer la lettre de résiliation',
      exceptionReason: 'La description indique un préavis de deux mois avant l’échéance.', actionDate: '2026-11-01',
    }) });
    expect(d).toMatchObject({ decision: 'SHOW_NOW', code: 'THRESHOLD_EXCEPTION', thresholdException: true, mode: 'ACT_NOW', priority: 'HIGH' });
    // Date d'action hors du seuil : pas d'exception.
    expect(decide({ assessment: ia({ interpellation: 'ACT_NOW', actionNeeded: true, exceptionReason: 'Préavis.', actionDate: '2026-12-30' }) }).code).toBe('BEYOND_THRESHOLD');
  });

  it('T6-INT-03 — échéance à 20 jours sans action nécessaire : aucune interpellation automatique', () => {
    const c = cand({ dueDate: '2026-11-04' });
    expect(decide({ candidate: c, assessment: ia() })).toMatchObject({ decision: 'SUPPRESS', code: 'AI_NO_INTERPELLATION' });
    expect(decide({ candidate: c })).toMatchObject({ decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING' });
    // « Plus tard » : différé avec réévaluation planifiée, pas affiché.
    expect(decide({ candidate: c, assessment: ia({ interpellation: 'LATER', actionNeeded: true, reevaluateOn: '2026-10-28' }) }))
      .toMatchObject({ decision: 'DEFER', code: 'AI_LATER', nextReevaluationAt: '2026-10-28' });
  });

  it('T6-INT-04 — échéance dépassée sans action restante : aucune interpellation', () => {
    const c = cand({ dueDate: '2026-10-01' });
    expect(decide({ candidate: c, assessment: ia({ fingerprint: 'fp1', assessedOn: TODAY }) })).toMatchObject({ decision: 'SUPPRESS', code: 'AI_NO_INTERPELLATION' });
    // « C'est fait » déclaré (sujet résolu) : écarté sans même interroger l'IA.
    expect(decide({ candidate: { ...c, state: 'RESOLVED' } })).toMatchObject({ decision: 'SUPPRESS', code: 'SUBJECT_CLOSED', needsAssessment: false });
  });

  it('T6-INT-05 — échéance dépassée nécessitant une démarche : interpellation adaptée (démarche dite, « C’est fait » proposé)', () => {
    const d = decide({ candidate: cand({ dueDate: '2026-10-01' }), assessment: ia({ interpellation: 'ACT_NOW', actionNeeded: true, priority: 'MEDIUM', action: 'Prendre rendez-vous pour le ramonage' }) });
    expect(d).toMatchObject({ decision: 'SHOW_NOW', code: 'AI_ACT_NOW', mode: 'ACT_NOW' });
    const r = raw([assurance(5, '2026-10-01', { title: 'Ramonage cheminée' })]);
    const [s] = decidedAgendaSubjects(r, [{ agendaItemId: 5, interpellation: { mode: 'ACT_NOW', priority: 'MEDIUM', code: 'AI_ACT_NOW' }, action: d.action, reminder: { agendaItemId: 5, suggestedDate: '2026-10-22', hasSeries: false } }]);
    expect(s.sourceCode).toBe('MASC-EXT-ACTION');
    expect(s.fallbackText).toContain('À prévoir : prendre rendez-vous pour le ramonage.');
    expect(s.facts.expectedAction).toBe('Prendre rendez-vous pour le ramonage');
    expect(s.actions.map((a) => a.label)).toEqual(['Voir', 'C’est fait']);
  });

  it('T6-INT-06 — ni date d’échéance ni date pour agir : aucun délai inventé', () => {
    const c = cand({ dueDate: null });
    expect(decide({ candidate: c, assessment: ia({ interpellation: 'ACT_NOW', actionNeeded: true, priority: 'HIGH' }) }))
      .toMatchObject({ decision: 'SUPPRESS', code: 'INSUFFICIENT_CONTEXT', priority: 'LOW' });
    expect(decide({ candidate: c, aiCapable: false })).toMatchObject({ decision: 'SUPPRESS', code: 'INSUFFICIENT_CONTEXT' });
    // Une date pour agir mal formée rendue par l'IA est ignorée (jamais une date supposée).
    const [v] = I.validateT6Assessments([{ ref: 'C1', interpellation: 'act_now', reason: 'x', actionDate: '1er janvier', priority: 'HIGH' }], new Set(['C1']), TODAY);
    expect(v).toMatchObject({ interpellation: 'ACT_NOW', actionDate: null });
  });
});

// ── Gestion des rappels ─────────────────────────────────────────────────────

describe('Gestion des rappels', () => {
  const montre = ia({ interpellation: 'ACT_NOW', actionNeeded: true, priority: 'MEDIUM' });
  const proche = cand({ dueDate: '2026-11-04' });

  it('T6-INT-07 — « Me le rappeler plus tard » masque le sujet jusqu’à la date enregistrée (report utilisateur, distinct du système)', () => {
    const report = { scope: 'OCCURRENCE' as const, decision: 'SNOOZED' as const, remindAt: '2026-10-25', contextFingerprint: 'fp1', agendaItemId: 1, seriesKey: null };
    const d = decide({ candidate: proche, assessment: montre, preferences: [report] });
    expect(d).toMatchObject({ decision: 'DEFER', code: 'USER_SNOOZED', deferredBy: 'USER', nextReevaluationAt: '2026-10-25', userPreference: { decision: 'SNOOZED' } });
    expect(decide({ candidate: proche, assessment: montre, preferences: [report], today: '2026-10-24' }).decision).toBe('DEFER');
    // Élément nouveau ET significatif (date avancée) jugé prioritaire : rappel anticipé, tracé.
    const avance = decide({ candidate: { ...proche, fingerprint: 'fp2' }, assessment: ia({ interpellation: 'ACT_NOW', actionNeeded: true, priority: 'HIGH', fingerprint: 'fp2' }), preferences: [report] });
    expect(avance).toMatchObject({ decision: 'SHOW_NOW', code: 'SNOOZE_OVERRIDDEN_SIGNIFICANT_CHANGE' });
    // Proposition de date : selon le contexte, toujours modifiable, entre demain et un an.
    expect(I.suggestReminderDate({ today: TODAY, dueDate: '2026-11-04' })).toBe('2026-10-28');
    expect(I.suggestReminderDate({ today: TODAY, dueDate: '2026-11-04', assessment: { actionDate: '2026-10-20', reevaluateOn: null } })).toBe('2026-10-20');
    expect(I.suggestReminderDate({ today: TODAY, dueDate: '2026-10-01' })).toBe('2026-10-22');
    expect(I.suggestReminderDate({ today: TODAY, dueDate: '2026-10-16' })).toBe('2026-10-16');
  });

  it('T6-INT-08 — à la date choisie, le sujet est RÉÉVALUÉ : devenu sans objet, il n’est pas rappelé', () => {
    const report = { scope: 'OCCURRENCE' as const, decision: 'SNOOZED' as const, remindAt: '2026-10-25', contextFingerprint: 'fp1', agendaItemId: 1, seriesKey: null };
    const jour = '2026-10-25';
    // Évaluation antérieure à la date de rappel : insuffisante.
    expect(decide({ candidate: proche, assessment: montre, preferences: [report], today: jour }))
      .toMatchObject({ decision: 'DEFER', code: 'AWAITING_REEVALUATION_AFTER_SNOOZE', deferredBy: 'SYSTEM', needsAssessment: true });
    // Réévalué à la date : plus rien à faire → écarté.
    expect(decide({ candidate: proche, assessment: ia({ assessedOn: jour }), preferences: [report], today: jour }))
      .toMatchObject({ decision: 'SUPPRESS', code: 'AI_NO_INTERPELLATION' });
    // Réévalué et toujours utile → réaffiché.
    expect(decide({ candidate: proche, assessment: { ...montre, assessedOn: jour }, preferences: [report], today: jour }).decision).toBe('SHOW_NOW');
    // Échéance réalisée entre-temps : jamais rappelée.
    expect(decide({ candidate: { ...proche, state: 'RESOLVED' }, preferences: [report], today: jour }).code).toBe('SUBJECT_CLOSED');
  });

  it('T6-INT-09 — « Ne plus me rappeler » : durable, jamais annulé par une nouvelle exécution ni une évaluation prioritaire', () => {
    const refus = { scope: 'OCCURRENCE' as const, decision: 'DISMISSED' as const, remindAt: null, contextFingerprint: 'fp1', agendaItemId: 1, seriesKey: null };
    for (const a of [null, montre, ia({ interpellation: 'ACT_NOW', actionNeeded: true, priority: 'HIGH', fingerprint: 'fp9' })]) {
      expect(decide({ candidate: proche, assessment: a, preferences: [refus] })).toMatchObject({ decision: 'SUPPRESS', code: 'USER_DISMISSED_OCCURRENCE', needsAssessment: false });
    }
    expect(decide({ candidate: proche, preferences: [refus], aiCapable: false }).code).toBe('USER_DISMISSED_OCCURRENCE');
  });

  it('T6-INT-11 — échéances récurrentes : « cette occurrence » ou « toute la série »', () => {
    const occ = { scope: 'OCCURRENCE' as const, decision: 'DISMISSED' as const, remindAt: null, contextFingerprint: null, agendaItemId: 1, seriesKey: null };
    const serie = { scope: 'SERIES' as const, decision: 'DISMISSED' as const, remindAt: null, contextFingerprint: null, agendaItemId: null, seriesKey: 'S-ramonage' };
    // Occurrence refusée : la suivante de la série reste rappelée.
    expect(preferencesFor([occ], 2, 'S-ramonage')).toEqual([]);
    expect(decide({ candidate: cand({ agendaItemId: 2, subjectKey: 'agenda:2', seriesKey: 'S-ramonage', dueDate: '2026-11-04' }), assessment: montre, preferences: [] }).decision).not.toBe('SUPPRESS');
    // Série refusée : toutes les occurrences, présentes et futures.
    const d = decide({ candidate: cand({ agendaItemId: 2, subjectKey: 'agenda:2', seriesKey: 'S-ramonage', dueDate: '2026-11-04' }), assessment: montre, preferences: preferencesFor([serie, occ], 2, 'S-ramonage') });
    expect(d).toMatchObject({ decision: 'SUPPRESS', code: 'USER_DISMISSED_SERIES', userPreference: { scope: 'SERIES' } });
  });

  it('T6-INT-20 — anti-répétition : déjà présenté plusieurs jours sans évolution, priorité non haute → pause tracée', () => {
    expect(decide({ candidate: proche, assessment: montre, history: { displayedDays: I.T6_REPEAT_MAX_DAYS } }))
      .toMatchObject({ decision: 'DEFER', code: 'REPEAT_COOLDOWN', nextReevaluationAt: '2026-10-22', deferredBy: 'SYSTEM' });
    expect(decide({ candidate: proche, assessment: { ...montre, priority: 'HIGH' }, history: { displayedDays: 9 } }).decision).toBe('SHOW_NOW');
    expect(decide({ candidate: proche, assessment: montre, history: { displayedDays: 2 } }).decision).toBe('SHOW_NOW');
  });

  it('modification significative : une évaluation d’un AUTRE contexte n’est jamais réutilisée ; une évaluation ancienne est revue', () => {
    expect(I.assessmentStatus(ia({ fingerprint: 'autre' }), proche, TODAY, SEUIL)).toBe('CONTEXT_CHANGED');
    expect(I.assessmentStatus(ia({ assessedOn: '2026-09-20' }), proche, TODAY, SEUIL)).toBe('AGED');
    // Franchissement du seuil depuis l'évaluation : réévaluation obligatoire.
    expect(I.assessmentStatus(ia({ assessedOn: '2026-08-01' }), cand({ dueDate: '2026-12-01' }), TODAY, SEUIL)).toBe('CONTEXT_CHANGED');
    expect(decide({ candidate: proche, assessment: ia({ fingerprint: 'autre', interpellation: 'ACT_NOW', actionNeeded: true }) }).code).toBe('AI_ASSESSMENT_PENDING');
  });
});

// ── Affichage et supervision ─────────────────────────────────────────────────

describe('Affichage et supervision', () => {
  const rappel = (id: number) => ({ agendaItemId: id, suggestedDate: '2026-10-22', hasSeries: false });
  const presentation = (r: Raw, shown: Parameters<typeof decidedAgendaSubjects>[1], overdue?: Set<number>) => {
    const c = buildCandidates(r, { interpellation: { shown } });
    const s = selectSubjects(c.candidates);
    return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: false, messages: null, today: TODAY, overdueDeadlines: overdue ? 0 : undefined });
  };

  it('T6-INT-14 — résumé et cartes reposent sur les mêmes décisions : un sujet écarté n’est ni dit ni montré ; aucune contradiction', () => {
    const r = raw([assurance(1, '2027-01-01'), assurance(2, '2027-01-01'), assurance(3, '2026-11-04', { title: 'Révision chaudière' })]);
    // Rien de retenu : ni « mérite votre attention », ni carte, ni assurance dans le texte.
    const vide = presentation(r, []);
    const t0 = composeSpeech({ presentation: vide, empty: false }).text;
    expect(t0).not.toMatch(/assurance|janvier 2027|mérite/i);
    expect(homeItems(vide, false)).toEqual([]);
    // Un sujet retenu (chaudière) : il est dit ET montré, comme sujet d'attention.
    const un = presentation(r, [{ agendaItemId: 3, interpellation: { mode: 'ANTICIPATE', priority: 'MEDIUM', code: 'AI_ANTICIPATE' }, action: 'Prendre rendez-vous', reminder: rappel(3) }]);
    const t1 = composeSpeech({ presentation: un, empty: false }).text;
    expect(t1).toMatch(/^Un sujet mérite votre attention aujourd’hui/);
    expect(t1).not.toContain(NOTHING_PRIORITY);
    expect(t1).not.toMatch(/assurance/i);
    const items = homeItems(un, false);
    expect(items.map((x) => x.kind)).toEqual(['subject']);
    expect(items[0].sub).toContain('À anticiper');
    // Pas de « Tout est à jour » devant une interpellation affichée.
    expect(t1).not.toMatch(/Tout est à jour/);
  });

  it('T6-INT-15 / T6-INT-16 — deux échéances du même jour : deux cartes, deux rappels distincts, aucun libellé « X et Y »', () => {
    const r = raw([assurance(1, '2026-11-20', { title: 'Échéance assurance habitation' }), assurance(2, '2026-11-20', { title: 'Échéance assurance auto', assetName: 'Clio', assetId: 2 })]);
    // Chemin historique : sujet composé, titre concaténé (le constat).
    const avant = buildCandidates(r).candidates.find((s) => s.sourceCode === 'DATE-NEXT-2');
    expect(avant?.tileTitle).toMatch(/ et /);
    const p = presentation(r, [1, 2].map((id) => ({ agendaItemId: id, interpellation: { mode: 'ACT_NOW' as const, priority: 'MEDIUM' as const, code: 'AI_ACT_NOW' }, action: null, reminder: rappel(id) })));
    expect(p.paragraphs.map((x) => x.sourceCode)).toEqual(['DATE-NEXT', 'DATE-NEXT']);
    const items = homeItems(p, false).filter((x) => x.kind === 'subject');
    expect(items).toHaveLength(2);
    for (const it of items) expect(it.title).not.toMatch(/ et /);
    const cibles = items.map((it) => (it.kind === 'subject' ? it.tile.paragraph.reminder?.agendaItemId : null));
    expect(cibles).toEqual([1, 2]);
    const voir = items.map((it) => (it.kind === 'subject' ? it.tile.paragraph.actions.map((a) => (a.target.kind === 'drawer' ? a.target.id : null)) : []));
    expect(voir).toEqual([[1], [2]]);
  });

  it('T6-INT-14 — « échéances dépassées à vérifier » ne réintroduit jamais une échéance écartée par la décision', async () => {
    const { openOverdueCount } = await import('../signals');
    const r = raw([], { overdueAgenda: [{ id: 4, date: '2026-10-01' }, { id: 5, date: '2026-09-20' }] });
    expect(openOverdueCount(r)).toBe(2);
    expect(openOverdueCount(r, new Set([4, 5]))).toBe(0);
  });

  it('T6-INT-17 — reporting : chaque candidat (affiché, différé, écarté), motif, seuil, rappel ; justification IA référencée, aucun titre recopié', () => {
    const base = { agendaItemId: 1, dueDate: '2027-01-01', seriesKey: null, displayedDays: 0 };
    const a = { ...ia(), id: 42, reason: 'Le contrat Maison se renouvelle tacitement.' };
    const entries = t6ReportEntries([
      { ...decide({ assessment: a }), ...base, assessment: a },
      { ...decide({ candidate: cand({ agendaItemId: 2, subjectKey: 'agenda:2', dueDate: '2026-11-04' }), assessment: ia({ interpellation: 'ACT_NOW', actionNeeded: true }) }), ...base, agendaItemId: 2, dueDate: '2026-11-04', assessment: null },
    ], SEUIL);
    const lignes = entries.filter((e) => e.section === 'INTERPELLATION');
    expect(lignes.map((e) => [e.entityId, e.recordStatus, e.reasonCode])).toEqual([[1, 'SUPPRESS', 'AI_NO_INTERPELLATION'], [2, 'SHOW_NOW', 'AI_ACT_NOW']]);
    expect(lignes[0].value).toMatchObject({ threshold: { days: 60, applied: true }, userPreference: null, dates: { dueDate: '2027-01-01' } });
    const ref = entries.find((e) => e.section === 'INTERPELLATION_AI')!;
    expect(ref).toMatchObject({ tableName: 't6_interpellation_assessments', recordId: 42, columnPath: 'reason', writeResult: 'OBSERVED' });
    expect(JSON.stringify(entries)).not.toMatch(/Maison|tacitement|assurance/);
  });
});

// ── Candidats et identifiants stables ───────────────────────────────────────

describe('Candidats', () => {
  it('identifiants stables (jamais dérivés d’un texte IA) ; empreinte = champs significatifs ; exclusions historiques conservées', () => {
    const r = raw([
      assurance(1, '2027-01-01', { seriesKey: 'S1' }),
      assurance(2, '2026-08-01'), // dépassée depuis plus de 60 jours : hors candidats (agenda)
      assurance(3, '2026-10-10', { forecast: true }), // prévision dépassée : hors candidats
      assurance(4, '2026-11-01', { requiresQualification: true }), // à préciser, à venir : hors candidats
      assurance(5, '2026-10-10'),
    ], { acknowledgments: [{ occurrenceKey: 'MASC-EXT-ACTION:agenda:5', cycleKey: '2026-10-10' }] });
    const c = t6Candidates(r);
    expect(c.map((x) => [x.candidate.subjectKey, x.candidate.state, x.candidate.seriesKey])).toEqual([['agenda:1', 'ACTIVE', 'S1'], ['agenda:5', 'RESOLVED', null]]);
    expect(agendaFingerprint({ title: 'A', date: '2027-01-01', forecast: false, requiresQualification: false }))
      .toBe(agendaFingerprint({ title: ' A ', date: '2027-01-01', forecast: false, requiresQualification: false }));
    expect(agendaFingerprint({ title: 'A', date: '2027-01-02', forecast: false, requiresQualification: false }))
      .not.toBe(agendaFingerprint({ title: 'A', date: '2027-01-01', forecast: false, requiresQualification: false }));
  });
});

// ── Contrat IA (R13) ─────────────────────────────────────────────────────────

describe('Contrat IA', () => {
  const MASTER = readFileSync(join(process.cwd(), 'src/services/ai/prompts/mascot/t6_master_v1.txt'), 'utf-8');

  it('T6-INT-19 — prompt maître livré : R13, emplacement FACULTATIF ; version BO antérieure ou T6 coupé → décision prudente', async () => {
    expect(MASTER).toContain('{{INTERPELLATION_CONTEXT}}');
    expect(MASTER).toContain('R13 — Évaluation d’interpellation.');
    expect(MASTER).toContain('"assessments":[');
    expect(MASTER).toMatch(/N’invente jamais de délai contractuel, réglementaire ou administratif/);
    expect(MASTER).not.toMatch(/assurance|garantie|entretien/i);
    expect(isOptionalMasterVariable('t6_master_v1', 'INTERPELLATION_CONTEXT')).toBe(true);
    expect(T6_MASTER_OPERATION_SPEC.promptVariables).toContain('INTERPELLATION_CONTEXT');
    expect(getOperation('t6_formulate').promptVariables).toContain('INTERPELLATION_CONTEXT');
    const ancien = MASTER.replace(/\nCandidats d’interpellation à évaluer : \{\{INTERPELLATION_CONTEXT\}\}\n/, '\n');
    expect(renderMasterPrompt(ancien, { masterPromptCode: 't6_master_v1', task: 'FORMULATE', allowedTasks: ['FORMULATE'], variables: { INPUT_JSON: '{}', SUGGESTION_CONTEXT: null, INTERPELLATION_CONTEXT: '{"zz":1}' } }))
      .not.toContain('{"zz":1}');
    configText = 'MODE = {{MODE}} {{INPUT_JSON}} {{SUGGESTION_CONTEXT}}';
    expect(await R.t6InterpellationAvailable()).toBe(false);
    configText = null;
    expect(await R.t6InterpellationAvailable()).toBe(true);
    t6Ouvert = false;
    expect(await R.t6InterpellationAvailable()).toBe(false);
    // La sortie conserve `assessments` (non retirée par le schéma).
    const out = T6FormulateOutput.parse({ schemaVersion: 't6-output-v2', messages: [], assessments: [{ ref: 'C1' }] });
    expect(out.assessments).toEqual([{ ref: 'C1' }]);
  });

  it('validation structurelle des évaluations : référence connue, une par candidat, valeurs fermées, textes bornés', () => {
    const refs = new Set(['C1', 'C2']);
    const v = I.validateT6Assessments([
      { ref: 'C1', interpellation: 'NONE', reason: 'Simple information.', priority: 'low' },
      { ref: 'C1', interpellation: 'ACT_NOW', reason: 'doublon' },
      { ref: 'C9', interpellation: 'ACT_NOW', reason: 'inconnu' },
      { ref: 'C2', interpellation: 'PEUT-ÊTRE', reason: 'x' },
      { ref: 'C2', interpellation: 'ANTICIPATE', reason: '', priority: 'HIGH' },
    ], refs, TODAY);
    expect(v).toEqual([expect.objectContaining({ ref: 'C1', interpellation: 'NONE', actionNeeded: false, priority: 'LOW' })]);
    expect(I.validateT6Assessments('pas une liste', refs, TODAY)).toEqual([]);
    const [r] = I.validateT6Assessments([{ ref: 'C2', interpellation: 'LATER', reason: 'r', reevaluateOn: '2026-10-01' }], refs, TODAY);
    expect(r.reevaluateOn).toBeNull(); // dans le passé : ignorée
  });

  it('T6-INT-22 — évaluations du MÊME appel T6 : contexte transmis, clé de cache distincte, persistées même si les textes sont rejetés', async () => {
    R.resetT6Breaker();
    const persist = vi.fn(async (l: unknown[], _m: unknown) => l.length);
    const bundle: import('../t6-interpellation').T6InterpellationBundle = {
      context: { schemaVersion: I.T6_INTERPELLATION_CONTEXT_SCHEMA, today: TODAY, thresholdDays: 60, candidates: [{ ref: 'C1' } as never] },
      refs: new Map([['C1', { subjectKey: 'agenda:1', agendaItemId: 1, fingerprint: 'fp1' }]]),
      persist,
    };
    const execute = vi.fn(async (_r: unknown) => ({
      data: { schemaVersion: 't6-output-v2', messages: [{ subjectId: 'x', text: 'invalide' }], assessments: [{ ref: 'C1', interpellation: 'NONE', reason: 'Rien à faire.' }] },
      model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 'trace-1',
    }));
    const input = buildT6Input([]);
    const o = await R.formulateWithT6({ accountId: 7, input, contextHash: 'h', mode: 'pregen', interpellation: bundle }, {
      treatmentAvailable: async () => true, promptVersion: async () => 'v', previousBubbles: async () => [], execute: execute as never, displayWaitMs: () => 6_000,
    });
    const req = execute.mock.calls[0][0] as { promptVariables: Record<string, unknown> };
    expect(JSON.parse(String(req.promptVariables.INTERPELLATION_CONTEXT))).toMatchObject({ today: TODAY, thresholdDays: 60 });
    expect(o.status).toBe('validation_failed');
    expect(persist).toHaveBeenCalledWith([expect.objectContaining({ ref: 'C1', interpellation: 'NONE' })], { promptVersion: 'v', traceId: 'trace-1' });
    const sans = R.t6CacheKey({ accountId: 7, input, promptVersion: 'v', outputSchema: 't6-output-v2' });
    const avec = R.t6CacheKey({ accountId: 7, input, promptVersion: 'v', outputSchema: 't6-output-v2', interpellationContext: bundle.context });
    expect(avec).not.toBe(sans);
  });
});
