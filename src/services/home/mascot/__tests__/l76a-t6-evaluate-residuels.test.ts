/**
 * Lot 76A — ticket « [P1] T6 — Compléter l’invalidation EVALUATE et empêcher
 * les suggestions contradictoires » : tests UNITAIRES (base et IA simulées).
 * Exécution réelle sur PostgreSQL 16 : `src/test/e2e/scenarios/l76a-t6-evaluate-residuels.e2e.ts`.
 *
 *  AC01  extrait justificatif changé (valeur et confiance identiques) : décision invalidée
 *  AC02  décision invalidée jamais utilisée pour interpeller avant sa réévaluation
 *  AC03  relecture, réextraction identique, variation cosmétique : aucun appel
 *  AC04  modèles de repli, ordre, niveaux de raisonnement, limite de sortie : invalidation
 *  AC05  FORMULATE seule, réglage administratif ou de reporting : aucune réévaluation
 *  AC06  question sur une échéance exclue, même avec une référence autorisée : rejetée
 *  AC07  assetRef incompatible avec l'échéance référencée : rejetée
 *  AC08  finalité ou rattachement invérifiable : jamais de contournement
 *  AC09  contrôles identiques après mise en cache et avec une ancienne version du prompt
 *  AC10  transition compatible (empreintes v2/v3, signatures e1 enregistrées), états
 *        dégradés et JSON EVALUATE strict préservés
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
let configText: string | null = null;
let gen: Record<string, unknown> = {};
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({
    promptArchitecture: 'master', masterPromptText: configText, configVersionId: 3, masterPromptVersionId: configText ? 12 : null,
    primaryModel: 'gemini-a', fallbackModels: ['gemini-b', 'gemini-c'], reasoningByRank: ['low', null, 'high'], maxOutputTokens: 4096,
    promptPreamble: null, ...gen,
  }),
}));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));
vi.mock('@/services/ai/execution-report/repository', () => ({ executionReportsReady: async () => true, writeExecutionReport: async () => 1 }));

const I = await import('../t6-interpellation');
const S = await import('../t6-interpellation.service');
const R = await import('../t6-runner');
const Q = await import('../t6-suggestions');
type Raw = import('../signals').MascotRawData;
type Row = import('../signals').MascotAgendaRow;
type Evidence = import('../t6-interpellation.service').T6ItemEvidence;
type Fact = import('../t6-interpellation.service').T6DocumentFact;
type Stored = import('../t6-interpellation').T6StoredAssessment;

const TODAY = '2026-10-21';
const MASTER = readFileSync(join(process.cwd(), 'src/services/ai/prompts/mascot/t6_master_v1.txt'), 'utf8');

const ligne = (id: number, o: Partial<Row> = {}): Row => ({
  id, title: 'Entretien chaudière', date: '2026-11-20', forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison', assetCategory: 'LOGEMENT', ...o,
});
const raw = (agenda: Row[]): Raw => ({
  accountId: 7, today: TODAY, processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 1 },
  toProcess: [], toProcessTotal: 0, agenda, acknowledgments: [], toProcessAgendaIds: [], toProcessSettledAgendaIds: [], overdueAgenda: [],
});
const fait = (o: Partial<Fact> = {}): Fact => ({
  id: 1, fileId: 9, extractionId: 100, key: 'maintenanceFrequency', canonicalKey: null, label: 'Périodicité de l’entretien',
  value: 'Annuel', confidence: 'certain', provenance: 'T1_EXTRACTION', excerpt: 'Entretien déjà pris en charge par le prestataire.', ...o,
});
const preuves = (facts: Fact[], o: Partial<Evidence> = {}): Evidence => ({
  description: null, endDate: null, originFieldKey: null, documents: [{ fileId: 9, title: 'Contrat d’entretien', origin: false }], facts, ...o,
});
const evaluation = (fingerprint: string, o: Partial<Stored> = {}): Stored => ({
  fingerprint, assessedOn: TODAY, contractVersion: I.T6_ASSESSMENT_CONTRACT, contractRevision: 2,
  decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', evidenceRefs: ['C1.dueDate'], uncertainties: [],
  interpellation: 'ACT_NOW', actionNeeded: true, action: 'Prendre rendez-vous', reason: 'Une démarche est nécessaire.', consequence: null,
  actionDate: null, priority: 'MEDIUM', uncertainty: null, exceptionReason: null, reevaluateOn: null, id: 1, ...o,
});
const rebase = vi.fn(async (..._a: unknown[]) => 0);
const deps = (loaders: Partial<import('../t6-interpellation.service').T6Loaders>, o: Partial<import('../t6-interpellation.service').PrepareDeps> = {}) => ({
  aiCapable: async () => true, thresholdDays: async () => 60,
  loaders: {
    dueReminders: async () => new Map<number, string>(), examinations: async () => 0, cycles: async () => new Map<number, string>(),
    rebaseFingerprints: rebase, ...loaders,
  } as Partial<import('../t6-interpellation.service').T6Loaders>, ...o,
});
const preparer = (rows: Row[], loaders: Parameters<typeof deps>[0], o: Parameters<typeof deps>[1] = {}) =>
  S.prepareT6Interpellation({ accountId: 7, userId: null, raw: raw(rows) }, deps(loaders, o));

/** Empreinte que porterait une décision prise sur ce contexte (celle transmise avec le candidat). */
async function empreinteDecidee(r: Row, e: Evidence): Promise<string> {
  const p = await preparer([r], { assessments: async () => new Map(), evidence: async () => new Map([[r.id, e]]) });
  return p.bundle!.refs.get('C1')!.fingerprint;
}
/** Préparation avec une décision prise sur `avant`, contexte courant `apres`. */
async function apres(r0: Row, avant: Evidence, r1: Row, maintenant: Evidence) {
  const fp = await empreinteDecidee(r0, avant);
  return preparer([r1], { assessments: async () => new Map([[r1.id, evaluation(fp)]]), evidence: async () => new Map([[r1.id, maintenant]]) });
}

beforeEach(() => {
  unsafe.mockReset(); unsafe.mockImplementation(async () => []);
  rebase.mockClear(); configText = null; gen = {};
  R.resetT6EvaluationState(); S.resetContractRevisionProbe(); R.resetT6EvaluationBaselines();
});

// ── P1 — empreinte des preuves ───────────────────────────────────────────────

describe('L76A-T6 P1 — empreinte des preuves transmises à EVALUATE', () => {
  const r = ligne(1);

  it('AC01 — cas du ticket : extrait changé, valeur « Annuel » et confiance inchangées → décision invalidée', async () => {
    const p = await apres(r, preuves([fait()]), r, preuves([fait({ excerpt: 'Entretien à organiser par le client ; aucune prise en charge.' })]));
    expect(p.decisions[0]).toMatchObject({ decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', needsAssessment: true, reevaluationReason: 'CONTEXT_CHANGED', aiDecision: null });
    expect(p.bundle!.context.candidates[0].facts![0].excerpt).toBe('Entretien à organiser par le client ; aucune prise en charge.');
  });

  it('AC01 — l’ordre des mots porte le sens : « à la charge du client et non du prestataire » ≠ l’inverse', async () => {
    const a = preuves([fait({ excerpt: 'Entretien à la charge du client et non du prestataire.' })]);
    const b = preuves([fait({ excerpt: 'Entretien à la charge du prestataire et non du client.' })]);
    const p = await apres(r, a, r, b);
    expect(p.decisions[0]).toMatchObject({ code: 'AI_ASSESSMENT_PENDING', reevaluationReason: 'CONTEXT_CHANGED' });
    expect(I.probativeSequence('à la charge du client et non du prestataire')).not.toBe(I.probativeSequence('à la charge du prestataire et non du client'));
  });

  it('AC01 — autres attributs transmis : intitulé du fait, rôle de la date, récurrence → invalidation', async () => {
    const base = preuves([fait()]);
    for (const [r1, e1] of [
      [r, preuves([fait({ label: 'Entretien à la charge du locataire' })])],
      [ligne(1, { dateRole: 'SCHEDULED_EVENT' }), base],
      [ligne(1, { seriesKey: 'serie-1' }), base],
    ] as Array<[Row, Evidence]>) {
      const p = await apres(r, base, r1, e1);
      expect(p.decisions[0]).toMatchObject({ code: 'AI_ASSESSMENT_PENDING', reevaluationReason: 'CONTEXT_CHANGED' });
    }
  });

  it('AC01 — rattachement : échéance rattachée à un autre bien, document d’origine changeant les preuves transmises → invalidation', async () => {
    const base = preuves([fait()]);
    const autreBien = await apres(r, base, ligne(1, { assetId: 2, assetName: 'Voiture', assetCategory: 'VEHICULE' }), base);
    expect(autreBien.decisions[0]).toMatchObject({ code: 'AI_ASSESSMENT_PENDING', reevaluationReason: 'CONTEXT_CHANGED' });
    // 9 faits pertinents sur deux documents : seuls 8 sont transmis ; le document
    // d'origine (lien changé) fait entrer un autre fait dans le contexte transmis.
    const faits = (n: number, fileId: number, depuis: number) => Array.from({ length: n }, (_, k) => fait({
      id: depuis + k, fileId, key: `delai${depuis + k}`, excerpt: `Délai numéro ${depuis + k} de préavis.`, value: `${depuis + k} jours`,
    }));
    const docs = (origine: number | null) => [9, 10].map((fileId) => ({ fileId, title: `Contrat ${fileId}`, origin: fileId === origine }));
    const avant = preuves([...faits(8, 9, 1), ...faits(1, 10, 50)], { documents: docs(null) });
    const origine = preuves([...faits(8, 9, 1), ...faits(1, 10, 50)], { documents: docs(10) });
    const p = await apres(r, avant, r, origine);
    expect(p.decisions[0]).toMatchObject({ code: 'AI_ASSESSMENT_PENDING', reevaluationReason: 'CONTEXT_CHANGED' });
  });

  it('AC02 — décision invalidée : jamais utilisée pour interpeller, même vieillissante ou sous report échu', async () => {
    const p = await apres(r, preuves([fait()]), r, preuves([fait({ excerpt: 'Aucun entretien n’est prévu au contrat.' })]));
    expect(p.shown).toEqual([]);
    expect(p.decisions[0].assessmentFresh).toBe(false);
    expect(p.evaluation).toBe('PENDING');
    expect(p.bundle!.refs.get('C1')!.reevaluationReason).toBe('CONTEXT_CHANGED');
  });

  it('AC03 — relecture, réextraction identique (nouveaux identifiants), variation cosmétique, ordre de lecture : aucun appel', async () => {
    const base = preuves([fait(), fait({ id: 2, key: 'noticePeriod', label: 'Préavis', value: '1 mois', excerpt: 'Préavis d’un mois.' })]);
    const variantes: Evidence[] = [
      base,
      // Réextraction : nouveaux identifiants de faits et d'extraction, même contenu.
      preuves([fait({ id: 31, extractionId: 300 }), fait({ id: 32, extractionId: 300, key: 'noticePeriod', label: 'Préavis', value: '1 mois', excerpt: 'Préavis d’un mois.' })]),
      // Cosmétique : casse, accents, ponctuation, espaces, article.
      preuves([fait({ excerpt: '  ENTRETIEN deja pris en charge par le prestataire !' }), fait({ id: 2, key: 'noticePeriod', label: 'préavis', value: '1 MOIS', excerpt: 'Le préavis d’un mois' })]),
      // Ordre de lecture inversé.
      preuves([fait({ id: 2, key: 'noticePeriod', label: 'Préavis', value: '1 mois', excerpt: 'Préavis d’un mois.' }), fait()]),
      // Document réimporté (identifiant technique différent, même intitulé).
      preuves([fait({ fileId: 19 }), fait({ id: 2, fileId: 19, key: 'noticePeriod', label: 'Préavis', value: '1 mois', excerpt: 'Préavis d’un mois.' })], { documents: [{ fileId: 19, title: 'Contrat d’entretien', origin: false }] }),
    ];
    for (const v of variantes) {
      const p = await apres(r, base, r, v);
      expect(p.decisions[0]).toMatchObject({ decision: 'SHOW_NOW', needsAssessment: false, assessmentFresh: true });
      expect(p.bundle).toBeNull();
    }
  });

  it('AC03 — représentation commune : un fait NON transmis (au-delà des 8) ne déclenche aucun appel', async () => {
    const faits = Array.from({ length: 9 }, (_, k) => fait({ id: k + 1, key: `delai${k}`, value: `${k} jours`, excerpt: `Délai ${k} de préavis.`, confidence: k < 8 ? 'certain' : 'conflictual' }));
    const avant = preuves(faits);
    const neuvieme = preuves([...faits.slice(0, 8), { ...faits[8], excerpt: 'Clause illisible modifiée.' }]);
    const p = await apres(r, avant, r, neuvieme);
    expect(p.bundle).toBeNull();
    expect(p.decisions[0]).toMatchObject({ decision: 'SHOW_NOW', needsAssessment: false });
  });

  it('AC10 — transition : décisions v3 (lot 75E) et v2 (lot 71G) relues sans réévaluation de masse, puis rebasées', async () => {
    const e = preuves([fait()]);
    const ligneFp = { title: r.title, date: r.date, forecast: false, requiresQualification: false };
    const v3 = S.fingerprintWithEvidence(ligneFp, e);
    const v2 = S.fingerprintV2WithEvidence(ligneFp, e);
    expect(v3.startsWith('v3:')).toBe(true);
    for (const ancien of [v3, v2]) {
      rebase.mockClear();
      const p = await preparer([r], { assessments: async () => new Map([[1, evaluation(ancien)]]), evidence: async () => new Map([[1, e]]) });
      expect(p.decisions[0]).toMatchObject({ decision: 'SHOW_NOW', needsAssessment: false, assessmentFresh: true });
      expect(p.bundle).toBeNull();
      // Rebasée sur l'empreinte courante (v4) : un changement ULTÉRIEUR sera vu.
      expect(rebase).toHaveBeenCalledWith(7, [{ agendaItemId: 1, from: ancien, to: p.decisions[0].fingerprint }]);
      expect(p.decisions[0].fingerprint!.startsWith('v4:')).toBe(true);
    }
    // Ancienne empreinte qui ne correspond plus : jamais rebasée (invalidée).
    rebase.mockClear();
    const q = await preparer([r], { assessments: async () => new Map([[1, evaluation(v3)]]), evidence: async () => new Map([[1, preuves([fait({ excerpt: 'Aucun entretien.' })])]]) });
    expect(q.decisions[0]).toMatchObject({ code: 'AI_ASSESSMENT_PENDING', reevaluationReason: 'CONTEXT_CHANGED' });
    expect(rebase).not.toHaveBeenCalled();
    // Rebasage en échec : sans effet sur la décision (jamais bloquant).
    const panne = await preparer([r], { assessments: async () => new Map([[1, evaluation(v3)]]), evidence: async () => new Map([[1, e]]), rebaseFingerprints: async () => { throw new Error('base'); } });
    expect(panne.decisions[0]).toMatchObject({ decision: 'SHOW_NOW', needsAssessment: false });
  });

  it('AC10 — traçabilité BO : invalidations par motif, rebasages et signature courante dans le rapport T6', async () => {
    const writes: unknown[][] = [];
    const repo = await import('@/services/ai/execution-report/repository');
    vi.spyOn(repo, 'writeExecutionReport').mockImplementation(async (...a: unknown[]) => { writes.push(a); return 1; });
    rebase.mockImplementation(async () => 1);
    const e = preuves([fait()]);
    const v3 = S.fingerprintWithEvidence({ title: r.title, date: r.date, forecast: false, requiresQualification: false }, e);
    const p = await preparer([r, ligne(2)], {
      assessments: async () => new Map([[1, evaluation(v3)], [2, evaluation('v4:autre', { id: 2 })]]),
      evidence: async () => new Map([[1, e], [2, e]]),
    }, { evaluationConfig: async () => ({ signature: 'e2:courante', masterVersion: null }) });
    await S.writeT6InterpellationReport({ accountId: 7, userId: null, mode: 'pregen', prep: p });
    const [rapport] = writes[0] as [{ counters: Record<string, number>; steps: Array<{ step: string; detail: Record<string, unknown> }> }];
    expect(rapport.counters).toMatchObject({ invalidatedContext: 1, invalidatedConfig: 0, rebased: 1 });
    expect(rapport.steps.find((s) => s.step === 'decision')!.detail).toMatchObject({ evaluationSignature: 'e2:courante' });
    rebase.mockImplementation(async () => 0);
  });

  it('AC10 — preuves illisibles : empreinte inconnue, ni réévaluation ni rebasage', async () => {
    const p = await preparer([r], { assessments: async () => new Map([[1, evaluation('v3:x')]]), evidence: async () => { throw new Error('panne'); } });
    expect(p.bundle).toBeNull();
    expect(rebase).not.toHaveBeenCalled();
    expect(p.failedSources).toContain('evidence');
  });
});

// ── P1 — signature de configuration EVALUATE ────────────────────────────────

describe('L76A-T6 P1 — signature de configuration EVALUATE complète', () => {
  const sig = async () => (await R.t6EvaluationConfig(60))!.signature;

  it('AC04 — modèle de repli, ordre des replis, niveau de raisonnement, limite de sortie : signature changée', async () => {
    const s0 = await sig();
    for (const o of [
      { fallbackModels: ['gemini-b'] }, { fallbackModels: ['gemini-b', 'gemini-d'] }, { fallbackModels: ['gemini-c', 'gemini-b'] },
      { reasoningByRank: ['high', null, 'high'] }, { reasoningByRank: ['low', 'medium', 'high'] }, { maxOutputTokens: 2048 },
    ]) {
      gen = o;
      expect(await sig()).not.toBe(s0);
    }
    gen = {};
    expect(await sig()).toBe(s0);
  });

  it('AC04 — valeurs RÉSOLUES par la passerelle : profil de génération partagé', async () => {
    const { effectiveGenerationProfile } = await import('@/services/ai/gateway/generation-profile');
    expect(effectiveGenerationProfile({}, { primaryModel: 'a', fallbackModels: ['b', 'c'], reasoningByRank: ['low', null, 'high'], maxOutputTokens: 4096 }))
      .toEqual({ models: [{ model: 'a', reasoning: 'low' }, { model: 'b', reasoning: null }, { model: 'c', reasoning: 'high' }], maxOutputTokens: 4096 });
    // Plancher d'opération appliqué comme par la passerelle.
    expect(effectiveGenerationProfile({ minOutputTokens: 8000 }, { primaryModel: 'a', maxOutputTokens: 4096 }).maxOutputTokens).toBe(8000);
    const gw = readFileSync(join(process.cwd(), 'src/services/ai/gateway/ai-gateway.ts'), 'utf8');
    expect(gw).toMatch(/plafonnerSortie\(baseMaxOutputTokens\(op, configuration\), req\.maxOutputTokensCap\)/);
    // Lot 85C : la passerelle résout chaque rang par le même module (`rankSettings` → `rankProfile`, profil d'opération compris).
    expect(gw).toMatch(/rankSettings\(op, configuration, i \+ premierRang\)/);
  });

  it('AC05 — FORMULATE seule, version administrative, préambule : aucune invalidation', async () => {
    const s0 = await sig();
    configText = MASTER.replace('R12 — Questions suggérées.', 'R12 — Questions suggérées (révisée).');
    const bo = await sig();
    configText = null;
    expect(bo).toBe(s0);
    gen = { configVersionId: 99, configRevisionId: 5, visibleNumber: 42, promptPreamble: 'Préambule' };
    expect(await sig()).toBe(s0);
    // Décision prise sous la même signature : réutilisée.
    const c = { subjectKey: 'agenda:1', agendaItemId: 1, occurrenceKey: 'agenda:1@x', seriesKey: null, accountId: 7, assetId: 1, dueDate: '2026-11-20', state: 'ACTIVE' as const, fingerprint: 'v4:f' };
    const cfg = await R.t6EvaluationConfig(60);
    expect(I.assessmentFreshness(evaluation('v4:f', { evaluationSignature: s0 }), c, TODAY, 60, { evaluation: cfg }).status).toBe('FRESH');
  });

  it('AC04 — décision sous une autre chaîne de modèles : invalidée strictement, jamais affichée', async () => {
    const r = ligne(1);
    const e = preuves([fait()]);
    const s0 = await sig();
    const fp = await empreinteDecidee(r, e);
    gen = { fallbackModels: ['gemini-c', 'gemini-b'] };
    const p = await preparer([r], { assessments: async () => new Map([[1, evaluation(fp, { evaluationSignature: s0 })]]), evidence: async () => new Map([[1, e]]) }, { evaluationConfig: R.t6EvaluationConfig });
    expect(p.decisions[0]).toMatchObject({ decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', reevaluationReason: 'CONFIG_CHANGED', aiDecision: null });
    expect(p.shown).toEqual([]);
  });

  it('AC10 — transition : signature e1 (lot 72A) — configuration de référence inchangée : aucune invalidation ; changée depuis : invalidée', async () => {
    const cfg = (await R.t6EvaluationConfig(60))!;
    expect(cfg.signature!.startsWith('e2:')).toBe(true);
    expect(cfg.legacySignature!.startsWith('e1:')).toBe(true);
    const c = { subjectKey: 'agenda:1', agendaItemId: 1, occurrenceKey: 'agenda:1@x', seriesKey: null, accountId: 7, assetId: 1, dueDate: '2026-11-20', state: 'ACTIVE' as const, fingerprint: 'v4:f' };
    const f = (stored: string, conf: import('../t6-interpellation').T6EvaluationConfig) => I.assessmentFreshness(evaluation('v4:f', { evaluationSignature: stored }), c, TODAY, 60, { evaluation: conf }).status;
    // Référence (première observation après déploiement) = configuration courante.
    expect(f(cfg.legacySignature!, { ...cfg, legacyBaseline: cfg.signature })).toBe('FRESH');
    // Référence inconnue (table absente, lecture en échec) : prudence de coût, comme le lot 72A.
    expect(f(cfg.legacySignature!, { ...cfg, legacyBaseline: null })).toBe('FRESH');
    // Replis / raisonnement changés depuis la référence : invalidée.
    expect(f(cfg.legacySignature!, { ...cfg, legacyBaseline: 'e2:autre' })).toBe('CONFIG_CHANGED');
    // Prompt EVALUATE, modèle principal ou seuil changés (signature e1 différente) : invalidée, comme au lot 72A.
    expect(f('e1:autre', { ...cfg, legacyBaseline: cfg.signature })).toBe('CONFIG_CHANGED');
    // Signature e1 inchangée (calcul du lot 72A conservé) : le modèle principal et le seuil y restent.
    gen = { fallbackModels: [] };
    expect((await R.t6EvaluationConfig(60))!.legacySignature).toBe(cfg.legacySignature);
    gen = { primaryModel: 'gemini-z' };
    expect((await R.t6EvaluationConfig(60))!.legacySignature).not.toBe(cfg.legacySignature);
  });

  it('AC10 — référence de transition : enregistrée une fois (idempotent), relue, jamais bloquante', async () => {
    const appels: string[] = [];
    unsafe.mockImplementation(async (sql: string, p?: unknown[]) => {
      appels.push(sql);
      if (/to_regclass\('t6_evaluation_signature_baselines'\)/.test(sql)) return [{ ok: true }];
      if (/INSERT INTO t6_evaluation_signature_baselines/.test(sql)) { expect(sql).toMatch(/ON CONFLICT \(legacy_signature\) DO NOTHING/); return []; }
      if (/FROM t6_evaluation_signature_baselines/.test(sql)) return [{ signature: `e2:reference-${String((p as unknown[])[0]).slice(0, 3)}` }];
      return [];
    });
    const cfg = (await R.t6EvaluationConfig(60))!;
    expect(cfg.legacyBaseline).toBe('e2:reference-e1:');
    // Mémorisée : aucune nouvelle lecture.
    const n = appels.length;
    await R.t6EvaluationConfig(60);
    expect(appels.length).toBe(n);
    // Panne : configuration rendue, référence inconnue.
    R.resetT6EvaluationBaselines();
    unsafe.mockImplementation(async () => { throw new Error('base indisponible'); });
    const panne = await R.t6EvaluationConfig(60);
    expect(panne).toMatchObject({ signature: cfg.signature, legacyBaseline: null });
  });
});

// ── P2 — suggestions T2 ─────────────────────────────────────────────────────

describe('L76A-T6 P2 — contrôle des suggestions avec deadlineRef', () => {
  const ct = ligne(1, { title: 'Contrôle technique', date: '2026-11-02', assetId: 2, assetName: 'Clio' });
  const ramonage = ligne(2, { title: 'Ramonage', date: '2027-03-01', assetId: 1 });
  const assurance = ligne(3, { title: 'Assurance habitation', date: '2026-11-05', assetId: 1 });
  const bundle = (structuredRefs = true, o: Partial<Parameters<typeof Q.buildT6SuggestionContext>[0]> = {}) => Q.buildT6SuggestionContext({
    speech: 'Le contrôle technique de la Clio est à prévoir pour le 2 novembre 2026.', attentionToday: true,
    state: { documentsTotal: 2, deadlinesUpcoming: 3, deadlinesSoon: 2 }, operations: 0,
    assets: [{ id: 1, name: 'Maison', documents: 2, deadlines: 2 }, { id: 2, name: 'Clio', documents: 1, deadlines: 1 }],
    agenda: [ct, ramonage], excluded: [assurance], signaledIds: new Set([1]), today: TODAY, structuredRefs,
    labelOf: (x) => x.title, formatDate: (d) => d, ...o,
  });
  const valider = (items: unknown[], b = bundle()) => Q.validateT6Suggestions(items, b.assetIds, b).map((x) => x.question);

  it('AC06 — cas du ticket : question sur l’assurance habitation (exclue) avec deadlineRef D1 autorisé → rejetée', () => {
    expect(valider([{ question: 'Comment préparer le renouvellement de l’assurance habitation ?', assetRef: null, deadlineRef: 'D1', purpose: 'PREPARE' }])).toEqual([]);
    expect(valider([{ question: 'Quand est prévue l’assurance habitation ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' }])).toEqual([]);
    // La question légitime sur D1 reste proposée.
    expect(valider([{ question: 'Que dois-je préparer pour le contrôle technique ?', assetRef: 'A2', deadlineRef: 'D1', purpose: 'PREPARE' }]))
      .toEqual(['Que dois-je préparer pour le contrôle technique ?']);
  });

  it('AC07 — assetRef incompatible avec l’échéance référencée, ou bien cité d’un autre bien : rejetée', () => {
    const b = bundle();
    expect(b.context.nextDeadlines[0]).toMatchObject({ ref: 'D1', assetRef: 'A2' });
    expect(valider([{ question: 'Que dois-je préparer pour le contrôle technique ?', assetRef: 'A1', deadlineRef: 'D1', purpose: 'PREPARE' }])).toEqual([]);
    expect(valider([{ question: 'Que dois-je préparer pour le contrôle technique de la Maison ?', assetRef: null, deadlineRef: 'D1', purpose: 'PREPARE' }])).toEqual([]);
    // Échéance sans bien : aucune référence de bien n'est cohérente.
    const sansBien = bundle(true, { agenda: [ligne(4, { title: 'Taxe foncière', date: '2026-11-10', assetId: null, assetName: null })], signaledIds: new Set([4]) });
    expect(valider([{ question: 'Comment préparer la taxe foncière ?', assetRef: 'A1', deadlineRef: 'D1', purpose: 'PREPARE' }], sansBien)).toEqual([]);
    expect(valider([{ question: 'Comment préparer la taxe foncière ?', assetRef: null, deadlineRef: 'D1', purpose: 'PREPARE' }], sansBien)).toEqual(['Comment préparer la taxe foncière ?']);
    // Cohérent : bien de l'échéance, par référence ou par son nom.
    expect(valider([{ question: 'Quand passer le contrôle technique de la Clio ?', assetRef: 'A2', deadlineRef: 'D1', purpose: 'CONSULT' }])).toHaveLength(1);
  });

  it('AC08 — incitation à agir déclarée à tort CONSULT sur une échéance non signalée : rejetée', () => {
    expect(valider([{ question: 'Comment préparer le ramonage ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' }])).toEqual([]);
    expect(valider([{ question: 'Dois-je anticiper le ramonage ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' }])).toEqual([]);
    expect(valider([{ question: 'Faut-il organiser le ramonage ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' }])).toEqual([]);
    // Consultation libre conservée.
    expect(valider([{ question: 'Quand est prévu le ramonage ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' }])).toEqual(['Quand est prévu le ramonage ?']);
  });

  it('AC08 — paraphrase sans rattachement vérifiable (libellé de l’échéance référencée absent) : rejetée', () => {
    expect(valider([{ question: 'Quand dois-je passer le CT de ma voiture ?', assetRef: 'A2', deadlineRef: 'D1', purpose: 'PREPARE' }])).toEqual([]);
    expect(valider([{ question: 'Quand est prévue la révision ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' }])).toEqual([]);
    // Texte d'une AUTRE échéance transmise sous la référence D1 : contradiction.
    expect(valider([{ question: 'Que préparer pour le contrôle technique et le ramonage ?', assetRef: null, deadlineRef: 'D1', purpose: 'PREPARE' }])).toEqual([]);
    // Finalité absente, inconnue, référence inconnue : jamais acceptée.
    expect(valider([
      { question: 'Quand est prévu le ramonage ?', deadlineRef: 'D2' },
      { question: 'Quand est prévu le ramonage ?', deadlineRef: 'D2', purpose: 'INFORM' },
      { question: 'Quand est prévu le ramonage ?', deadlineRef: 'D7', purpose: 'CONSULT' },
    ])).toEqual([]);
  });

  it('AC08 — questions générales pertinentes conservées', () => {
    expect(valider([
      { question: 'Quelles sont mes prochaines échéances ?', assetRef: null, deadlineRef: null, purpose: null },
      { question: 'Quels documents sont rattachés à la Clio ?', assetRef: 'A2', deadlineRef: null, purpose: null },
    ])).toEqual(['Quelles sont mes prochaines échéances ?', 'Quels documents sont rattachés à la Clio ?']);
  });

  it('AC09 — revalidation après changement d’éligibilité (relecture du cache) : questions de l’échéance devenue exclue écartées', () => {
    const avant = bundle();
    const q = { question: 'Quand est prévu le ramonage ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' };
    expect(valider([q], avant)).toHaveLength(1);
    // Le ramonage est désormais écarté (décision T6, report, refus) : contexte courant.
    const apresEcart = bundle(true, { agenda: [ct], excluded: [assurance, ramonage] });
    expect(valider([q], apresEcart)).toEqual([]);
    // Même relecture avec la référence D1 recopiée par erreur : rattachement non établi.
    expect(valider([{ ...q, deadlineRef: 'D1' }], apresEcart)).toEqual([]);
  });

  it('AC09 — ancienne version du prompt (R12 v1, sans références) : omission prudente des questions invérifiables', () => {
    const v1 = bundle(false);
    expect(v1.context.schemaVersion).toBe('t6-suggestions-v1');
    expect(valider([
      { question: 'Comment préparer le renouvellement de l’assurance habitation ?', assetRef: null },
      // Incitation sur une échéance transmise mais NON signalée : invérifiable en v1, omise.
      { question: 'Comment préparer le ramonage ?', assetRef: null },
      { question: 'Quand est prévu le ramonage ?', assetRef: null },
      // Échéance signalée : préparer reste proposé.
      { question: 'Que dois-je préparer pour le contrôle technique ?', assetRef: null },
      // Une référence d'échéance n'existe pas en v1 : invérifiable.
      { question: 'Quand est prévu le ramonage ?', assetRef: null, deadlineRef: 'D2', purpose: 'CONSULT' },
    ], v1)).toEqual(['Quand est prévu le ramonage ?', 'Que dois-je préparer pour le contrôle technique ?']);
  });

  it('AC09 — R12 renforcée dans le prompt livré (branche FORMULATE seule, signature EVALUATE inchangée)', async () => {
    expect(MASTER).toMatch(/cite le `label` de cette échéance/);
    expect(MASTER).toMatch(/`assetRef` vaut celui de l’échéance ou null/);
    expect(R.t6EvaluateSectionDigest(MASTER)).toBe(R.t6EvaluateSectionDigest(MASTER.replace(/R12 — [\s\S]*?SORTIE FORMULATE/, 'SORTIE FORMULATE')));
  });
});
