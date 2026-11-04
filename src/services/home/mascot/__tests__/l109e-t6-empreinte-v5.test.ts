/**
 * Lot 109E — ticket « [P1] T6 EVALUATE — Corriger la perte de sens dans
 * l’empreinte des preuves » : tests UNITAIRES (base et IA simulées, appels IA
 * COMPTÉS). Exécution réelle sur PostgreSQL 16 :
 * `src/test/e2e/scenarios/l109e-t6-empreinte-v5.e2e.ts`.
 *
 *  AC01  « et » → « ou » dans une preuve transmise : empreinte changée, à données techniques égales
 *  AC02  ancienne évaluation jamais réutilisée ; nouvelle décision demandée puis utilisée
 *  AC03  corpus des mots effacés par v4 + paires de sens opposé / conditionnel : aucun faux équivalent
 *  AC04  casse, espaces, Unicode, réextraction identique : décision conservée, AUCUN appel IA
 *  AC05  décisions v4 (et antérieures) : jamais réutilisées, reprise bornée, sans boucle ni rafale
 *  AC06  mêmes garanties à l’affichage (utilisateur), en pré-génération et pour les reports
 *  —     empreinte calculée sur le candidat RÉELLEMENT sérialisé pour EVALUATE (aucune seconde sélection)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({ promptArchitecture: 'master', masterPromptText: null, configVersionId: 3, primaryModel: 'gemini-a' }),
}));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));
vi.mock('@/services/ai/execution-report/repository', () => ({ executionReportsReady: async () => true, writeExecutionReport: async () => 1 }));

const I = await import('../t6-interpellation');
const S = await import('../t6-interpellation.service');
const R = await import('../t6-runner');
const U = await import('../t6-fingerprint-upgrade');
type Raw = import('../signals').MascotRawData;
type Row = import('../signals').MascotAgendaRow;
type Evidence = import('../t6-interpellation.service').T6ItemEvidence;
type Fact = import('../t6-interpellation.service').T6DocumentFact;
type Stored = import('../t6-interpellation').T6StoredAssessment;
type Dec = import('../t6-contract').T6ValidatedDecision;

const TODAY = '2026-11-04';

const ligne = (id: number, o: Partial<Row> = {}): Row => ({
  id, title: `Contrat d’entretien ${id}`, date: '2026-12-01', forecast: false, requiresQualification: false,
  assetId: 1, assetName: 'Maison', assetCategory: 'LOGEMENT', dateRole: 'DEADLINE', seriesKey: null, ...o,
});
const raw = (agenda: Row[]): Raw => ({
  accountId: 7, today: TODAY, processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 1 },
  toProcess: [], toProcessTotal: 0, agenda, acknowledgments: [], toProcessAgendaIds: [], toProcessSettledAgendaIds: [], overdueAgenda: [],
});
const fait = (o: Partial<Fact> = {}): Fact => ({
  id: 1, fileId: 9, extractionId: 100, key: 'maintenanceCoverage', canonicalKey: null, label: 'Prestations d’entretien incluses',
  value: 'Inclus', confidence: 'certain', provenance: 'T1_EXTRACTION', excerpt: 'L’entretien et la réparation sont inclus.', ...o,
});
const preuves = (facts: Fact[], o: Partial<Evidence> = {}): Evidence => ({
  description: null, endDate: null, originFieldKey: null, documents: [{ fileId: 9, title: 'Contrat d’entretien chaudière', origin: true }], facts, ...o,
});
const ET = preuves([fait()]);
const OU = preuves([fait({ excerpt: 'L’entretien ou la réparation sont inclus.' })]);

// ── Harnais : cache des décisions (table simulée), IA simulée et COMPTÉE ────

const store = new Map<number, Stored>();
const execute = vi.fn(async (req: { promptVariables: Record<string, string | null> }) => {
  const ctx = JSON.parse(req.promptVariables.INTERPELLATION_CONTEXT!) as import('../t6-contract').T6EvaluationInput;
  const decisions: Dec[] = ctx.candidates.map((c) => ({
    subjectId: c.subjectId, decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON',
    reason: 'Une démarche est à engager avant la date limite.', expectedAction: 'Prendre rendez-vous', actionDeadline: null,
    suggestedReviewAt: null, priorityHint: 'MEDIUM', evidenceRefs: [`${c.subjectId}.dueDate`], uncertainties: [],
  }));
  return { data: { schemaVersion: 't6-evaluation-v1', decisions }, model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: `t${execute.mock.calls.length}` };
});
const ancienne = (fingerprint: string, o: Partial<Stored> = {}): Stored => ({
  fingerprint, assessedOn: TODAY, contractVersion: I.T6_ASSESSMENT_CONTRACT, contractRevision: 2,
  decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', evidenceRefs: ['C1.dueDate'], uncertainties: [],
  interpellation: 'ACT_NOW', actionNeeded: true, action: 'Prendre rendez-vous', reason: 'Décision antérieure.', consequence: null,
  actionDate: null, priority: 'MEDIUM', uncertainty: null, exceptionReason: null, reevaluateOn: null, id: 1, ...o,
});
const rebase = vi.fn(async (..._a: unknown[]) => 0);

async function passage(rows: Row[], ev: Map<number, Evidence>, o: {
  userId?: number | null; budget?: import('../t6-fingerprint-upgrade').T6UpgradeBudget | null;
  prefs?: import('../t6-interpellation').T6ReminderPreference[]; evaluate?: boolean;
} = {}) {
  const p = await S.prepareT6Interpellation({ accountId: 7, userId: o.userId ?? null, raw: raw(rows) }, {
    aiCapable: async () => true, thresholdDays: async () => 60,
    upgradeBudget: o.budget === undefined ? U.createT6UpgradeBudget({ perWindow: 1000 }) : o.budget,
    loaders: {
      assessments: async () => new Map(store), evidence: async () => ev, preferences: async () => o.prefs ?? [],
      dueReminders: async () => new Map(), examinations: async () => 0, cycles: async () => new Map(), rebaseFingerprints: rebase,
    },
  });
  if (p.bundle && o.evaluate !== false) {
    const refs = p.bundle.refs;
    // Persistance simulée = celle du service (même empreinte, même instantané), sans base.
    const bundle = {
      ...p.bundle,
      persist: async (list: Dec[]) => {
        for (const d of list) {
          const c = refs.get(d.subjectId)!;
          store.set(c.agendaItemId, {
            ...I.assessmentFromDecision(d, c.evidenceVersions), fingerprint: c.fingerprint, assessedOn: TODAY,
            contractVersion: I.T6_ASSESSMENT_CONTRACT, contractRevision: 2, reevaluationReason: c.reevaluationReason ?? null,
            evidenceSnapshot: I.evidenceSnapshotOf(d.evidenceRefs, c.evidenceVersions, c.fingerprint, c.fingerprintComponents),
          });
        }
        return { persisted: list.length, persistedSubjectIds: list.map((d) => d.subjectId) };
      },
    };
    const r = await R.evaluateWithT6({ accountId: 7, bundle, mode: o.userId != null ? 'display' : 'pregen' }, {
      available: async () => true, promptVersion: async () => 'pv', execute: execute as never,
    });
    expect(r.status).toBe('generated');
  }
  return p;
}
const appels = () => execute.mock.calls.length;

beforeEach(() => {
  unsafe.mockReset(); unsafe.mockImplementation(async () => []);
  execute.mockClear(); rebase.mockClear(); store.clear();
  R.resetT6EvaluationState(); S.resetContractRevisionProbe();
});

// ── AC01 / AC02 ─────────────────────────────────────────────────────────────

describe('L109E AC01/AC02 — « et » → « ou » dans une preuve transmise à EVALUATE', () => {
  const r = ligne(1);

  it('AC01 — défaut reproduit sur v4 (même représentation), corrigé en v5, à données techniques égales', () => {
    // Le défaut : l'ancienne normalisation efface « et » / « ou ».
    expect(I.probativeSequence('L’entretien et la réparation sont inclus.')).toBe('entretien reparation inclus');
    expect(I.probativeSequence('L’entretien ou la réparation sont inclus.')).toBe('entretien reparation inclus');
    expect(S.t6ContextFingerprintV4(r, ET)).toBe(S.t6ContextFingerprintV4(r, OU));
    // v5 : mêmes identifiants (fait, extraction, document), mêmes autres champs — seule la conjonction change.
    expect(OU.facts[0]).toEqual({ ...ET.facts[0], excerpt: 'L’entretien ou la réparation sont inclus.' });
    const a = S.t6ContextFingerprintDetailed(r, ET);
    const b = S.t6ContextFingerprintDetailed(r, OU);
    expect(a.fingerprint.startsWith('v5:')).toBe(true);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    // Seule la partie « faits » change (cause tracée).
    expect(I.T6_CONTEXT_COMPONENTS.filter((k) => a.components[k] !== b.components[k])).toEqual(['facts']);
  });

  it('AC02 — EVALUATE → invalidation (CONTEXT_CHANGED, cause tracée) → nouvelle décision → cache → accueil', async () => {
    // 1. Première évaluation : 1 appel, décision conservée en v5.
    await passage([r], new Map([[1, ET]]));
    expect(appels()).toBe(1);
    const fpEt = store.get(1)!.fingerprint;
    expect(fpEt.startsWith('v5:')).toBe(true);
    // 2. Relecture du cache : décision réutilisée, aucun appel.
    const p2 = await passage([r], new Map([[1, ET]]), { userId: 5 });
    expect(p2.shown.map((x) => x.agendaItemId)).toEqual([1]);
    expect(p2.decisions[0]).toMatchObject({ assessmentFresh: true, needsAssessment: false, contextChange: null });
    expect(appels()).toBe(1);
    // 3. « et » → « ou » : l'ancienne décision n'interpelle plus, nouvelle décision demandée.
    const p3 = await passage([r], new Map([[1, OU]]), { userId: 5, evaluate: false });
    expect(p3.shown).toEqual([]);
    expect(p3.decisions[0]).toMatchObject({
      decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', needsAssessment: true, assessmentFresh: false, aiDecision: null,
      reevaluationReason: 'CONTEXT_CHANGED', contextChange: { cause: 'CONTENT_CHANGED', storedFormat: 'v5', components: ['facts'] },
    });
    expect(p3.bundle!.context.candidates[0].facts![0].excerpt).toBe('L’entretien ou la réparation sont inclus.');
    // Pré-génération (sans utilisateur) : même invalidation, l'évaluation est faite (1 appel).
    const p4 = await passage([r], new Map([[1, OU]]));
    expect(p4.shown).toEqual([]);
    expect(appels()).toBe(2);
    expect(store.get(1)!).toMatchObject({ reevaluationReason: 'CONTEXT_CHANGED' });
    expect(store.get(1)!.fingerprint).not.toBe(fpEt);
    // 4. Nouvelle décision utilisée (affichage et pré-génération), sans nouvel appel.
    for (const userId of [5, null]) {
      const p = await passage([r], new Map([[1, OU]]), { userId });
      expect(p.shown.map((x) => x.agendaItemId)).toEqual([1]);
      expect(p.bundle).toBeNull();
    }
    expect(appels()).toBe(2);
  });

  it('AC02 — rapport T6 : invalidation par cause, empreintes abrégées (aucun texte)', async () => {
    const writes: unknown[][] = [];
    const repo = await import('@/services/ai/execution-report/repository');
    vi.spyOn(repo, 'writeExecutionReport').mockImplementation(async (...a: unknown[]) => { writes.push(a); return 1; });
    await passage([r], new Map([[1, ET]]));
    const p = await passage([r], new Map([[1, OU]]), { evaluate: false });
    await S.writeT6InterpellationReport({ accountId: 7, userId: null, mode: 'pregen', prep: p });
    const [rapport, entrees] = writes[0] as [{ counters: Record<string, number> }, Array<{ value: Record<string, unknown> }>];
    expect(rapport.counters).toMatchObject({ invalidatedContext: 1, invalidatedContent: 1, invalidatedLegacyFingerprint: 0, rebased: 0 });
    const change = entrees[0].value.contextChange as Record<string, unknown>;
    expect(change).toMatchObject({ cause: 'CONTENT_CHANGED', storedFormat: 'v5', components: ['facts'] });
    expect(String(change.from)).toMatch(/^v5:/);
    expect(change.from).not.toBe(change.to);
    expect(JSON.stringify(entrees)).not.toMatch(/réparation/);
  });
});

// ── Empreinte = candidat réellement transmis ────────────────────────────────

describe('L109E — empreinte calculée sur le candidat RÉELLEMENT sérialisé pour EVALUATE', () => {
  it('même construction : empreinte du candidat transmis = empreinte de la décision = empreinte du contexte', async () => {
    const r = ligne(1, { seriesKey: 's1' });
    const p = await passage([r], new Map([[1, ET]]), { evaluate: false });
    const cand = p.bundle!.context.candidates[0];
    const ref = p.bundle!.refs.get('C1')!;
    expect(S.t6CandidateFingerprint(cand).fingerprint).toBe(ref.fingerprint);
    expect(ref.fingerprint).toBe(p.decisions[0].fingerprint);
    expect(ref.fingerprint).toBe(S.t6ContextFingerprint(r, ET));
    // Ce qui est réellement envoyé (JSON) donne la même empreinte.
    expect(S.t6CandidateFingerprint(JSON.parse(JSON.stringify(cand))).fingerprint).toBe(ref.fingerprint);
    // Données volatiles ou opaques (identifiant, jours restants, affichages, références) : sans effet.
    const autre = { ...cand, subjectId: 'C7', daysUntilDue: 3, overdue: true, recentlyShownDays: 4, dateLabel: 'x', evidence: [],
      facts: cand.facts!.map((f) => ({ ...f, ref: f.ref.replace('C1', 'C7'), document: f.document?.replace('C1', 'C7') ?? null })) };
    expect(S.t6CandidateFingerprint(autre).fingerprint).toBe(ref.fingerprint);
    // Un fait NON transmis (au-delà des 8) n'entre pas dans l'empreinte (aucune seconde sélection).
    const neuf = Array.from({ length: 9 }, (_, k) => fait({ id: k + 1, key: `delai${k}`, value: `${k} jours`, excerpt: `Délai ${k}.`, confidence: k < 8 ? 'certain' : 'conflictual' }));
    expect(S.t6ContextFingerprint(r, preuves(neuf))).toBe(S.t6ContextFingerprint(r, preuves([...neuf.slice(0, 8), { ...neuf[8], excerpt: 'Autre clause.' }])));
    expect(S.t6ContextFingerprint(r, preuves(neuf))).not.toBe(S.t6ContextFingerprint(r, preuves([{ ...neuf[0], excerpt: 'Autre clause.' }, ...neuf.slice(1)])));
  });

  it('le prompt EVALUATE et le contrat d’entrée sont inchangés (aucun texte de prompt modifié)', () => {
    const master = readFileSync(join(process.cwd(), 'src/services/ai/prompts/mascot/t6_master_v1.txt'), 'utf8');
    expect(master).toMatch(/EVALUATE/);
    const contrat = readFileSync(join(process.cwd(), 'src/services/home/mascot/t6-contract.ts'), 'utf8');
    expect(contrat).toMatch(/T6_EVALUATION_INPUT_SCHEMA_VERSION = 't6-evaluation-input-v1'/);
  });
});

// ── AC03 ─────────────────────────────────────────────────────────────────────

describe('L109E AC03 — audit des suppressions lexicales : aucun faux équivalent sémantique connu', () => {
  const r = ligne(1);
  const avecExtrait = (x: string) => S.t6ContextFingerprint(r, preuves([fait({ excerpt: x })]));

  it('corpus COMPLET des mots effacés par v4 : chacun, ajouté ou retiré, change l’empreinte v5', () => {
    expect(I.T6_LEGACY_ELIDED_WORDS.length).toBeGreaterThanOrEqual(50);
    for (const w of I.T6_LEGACY_ELIDED_WORDS) {
      const a = `Entretien ${w} réparation inclus`;
      const b = 'Entretien réparation inclus';
      // v4 : assimilés (défaut) ; v5 : distincts.
      expect(I.probativeSequence(a)).toBe(I.probativeSequence(b));
      expect(I.cosmeticText(a)).not.toBe(I.cosmeticText(b));
      expect(avecExtrait(a)).not.toBe(avecExtrait(b));
    }
  });

  // Paires de SENS opposé, conditionnel, de portée ou d'obligation différentes — génériques (aucun document, aucun fournisseur).
  const paires: Array<[string, string]> = [
    ['L’entretien et la réparation sont inclus.', 'L’entretien ou la réparation sont inclus.'],
    ['À la charge du client et non du prestataire.', 'À la charge du prestataire et non du client.'],
    ['Résiliation par le client.', 'Résiliation pour le client.'],
    ['Frais à votre charge.', 'Frais à notre charge.'],
    ['N’est couvert que l’entretien.', 'Est couvert l’entretien.'],
    ['Le contrat n’est pas reconduit.', 'Le contrat est reconduit.'],
    ['Si le contrat est résilié, le préavis est d’un mois.', 'Le contrat est résilié, le préavis est d’un mois.'],
    ['Le locataire doit faire l’entretien.', 'Le locataire peut faire l’entretien.'],
    ['Tous les équipements sont couverts.', 'Les équipements sont couverts.'],
    ['Un mois de préavis.', 'Mois de préavis.'],
    ['Préavis de 1,5 mois.', 'Préavis de 15 mois.'],
    ['Pénalité de 10 %.', 'Pénalité de 10 €.'],
    ['Délai de -10 jours.', 'Délai de 10 jours.'],
    ['Montant dû.', 'Montant du.'],
    ['Où envoyer la résiliation.', 'Ou envoyer la résiliation.'],
    ['Il a résilié.', 'Il à résilié.'],
    ['Sans franchise.', 'Avec franchise.'],
    ['Avant l’échéance.', 'Après l’échéance.'],
    ['Entretien annuel inclus dans le forfait.', 'Entretien annuel inclus hors forfait.'],
  ];

  it('paires de sens opposé ou conditionnel : distinctes dans l’extrait, la valeur, l’intitulé, la description et le titre', () => {
    for (const [a, b] of paires) {
      expect(I.cosmeticText(a)).not.toBe(I.cosmeticText(b));
      expect(avecExtrait(a)).not.toBe(avecExtrait(b));
      expect(S.t6ContextFingerprint(r, preuves([fait({ value: a })]))).not.toBe(S.t6ContextFingerprint(r, preuves([fait({ value: b })])));
      expect(S.t6ContextFingerprint(r, preuves([fait({ label: a })]))).not.toBe(S.t6ContextFingerprint(r, preuves([fait({ label: b })])));
      expect(S.t6ContextFingerprint(r, preuves([], { description: a }))).not.toBe(S.t6ContextFingerprint(r, preuves([], { description: b })));
      expect(S.t6ContextFingerprint(ligne(1, { title: a }), undefined)).not.toBe(S.t6ContextFingerprint(ligne(1, { title: b }), undefined));
    }
  });

  it('la normalisation v5 ne contient aucune liste de mots (aucune règle propre à un exemple)', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/home/mascot/t6-interpellation.ts'), 'utf8');
    const corps = src.slice(src.indexOf('export function cosmeticText'), src.indexOf('export function t6EvaluationSubjectComponents'));
    expect(corps).not.toMatch(/MOTS_VIDES|probativeSequence|normalizeForFingerprint|new Set\(/);
  });
});

// ── AC04 ─────────────────────────────────────────────────────────────────────

describe('L109E AC04 — variations cosmétiques et réextraction identique : décision conservée, aucun appel IA', () => {
  const r = ligne(1);
  const base = preuves([fait(), fait({ id: 2, key: 'noticePeriod', label: 'Préavis', value: '1 mois', excerpt: 'Préavis d’un mois.' })]);
  const variantes: Array<[string, Evidence, Row?]> = [
    ['relecture', base],
    ['réextraction identique (nouveaux identifiants)', preuves([fait({ id: 31, extractionId: 300 }), fait({ id: 32, extractionId: 300, key: 'noticePeriod', label: 'Préavis', value: '1 mois', excerpt: 'Préavis d’un mois.' })])],
    ['casse', preuves([fait({ excerpt: 'L’ENTRETIEN ET LA RÉPARATION SONT INCLUS.' }), fait({ id: 2, key: 'noticePeriod', label: 'PRÉAVIS', value: '1 MOIS', excerpt: 'préavis d’un mois.' })])],
    ['espaces (répétés, insécables, en bord, avant ponctuation)', preuves([fait({ excerpt: '  L’entretien   et la réparation sont inclus .' }), fait({ id: 2, key: 'noticePeriod', label: ' Préavis ', value: '1 mois', excerpt: 'Préavis d’un  mois.' })])],
    ['Unicode (apostrophe droite, décomposé, invisible, point final)', preuves([fait({ excerpt: 'L\'entretien et la réparation sont​ inclus' }), fait({ id: 2, key: 'noticePeriod', label: 'Préavis', value: '1 mois', excerpt: 'Préavis d\'un mois' })])],
    ['ordre de lecture', preuves([fait({ id: 2, key: 'noticePeriod', label: 'Préavis', value: '1 mois', excerpt: 'Préavis d’un mois.' }), fait()])],
    ['titre : casse et espaces', base, ligne(1, { title: '  CONTRAT D’ENTRETIEN   1 ' })],
  ];

  it('empreinte v5 identique pour chaque variante', () => {
    const ref = S.t6ContextFingerprint(r, base);
    for (const [nom, e, row] of variantes) expect([nom, S.t6ContextFingerprint(row ?? r, e)]).toEqual([nom, ref]);
  });

  it('comptage des appels IA : une seule évaluation pour toutes les variantes, affichage et pré-génération', async () => {
    await passage([r], new Map([[1, base]]));
    expect(appels()).toBe(1);
    for (const [nom, e, row] of variantes) {
      for (const userId of [5, null]) {
        const p = await passage([row ?? r], new Map([[1, e]]), { userId });
        expect([nom, p.decisions[0].assessmentFresh, p.bundle]).toEqual([nom, true, null]);
        expect(p.shown.map((x) => x.agendaItemId)).toEqual([1]);
      }
    }
    expect(appels()).toBe(1);
  });
});

// ── AC05 ─────────────────────────────────────────────────────────────────────

describe('L109E AC05 — transition v4 → v5 sur évaluation persistée', () => {
  const r = ligne(1);

  it('décision v4 (contexte inchangé selon v4) : jamais réutilisée ni rebasée ; réévaluée une fois, puis stable', async () => {
    store.set(1, ancienne(S.t6ContextFingerprintV4(r, OU)));
    // Même avec un contexte « et » (assimilé par v4) : la décision ambiguë n'est pas utilisée.
    for (const e of [ET, OU]) {
      const p = await passage([r], new Map([[1, e]]), { userId: 5, evaluate: false });
      expect(p.shown).toEqual([]);
      expect(p.decisions[0]).toMatchObject({
        decision: 'DEFER', code: 'AI_ASSESSMENT_PENDING', assessmentFresh: false, reevaluationReason: 'FINGERPRINT_UPGRADE',
        contextChange: { cause: 'LEGACY_FORMAT', storedFormat: 'v4' },
      });
      expect(p.evaluation).toBe('PENDING');
    }
    expect(rebase).not.toHaveBeenCalled();
    await passage([r], new Map([[1, ET]]));
    expect(appels()).toBe(1);
    expect(store.get(1)!).toMatchObject({ reevaluationReason: 'FINGERPRINT_UPGRADE' });
    expect(store.get(1)!.fingerprint.startsWith('v5:')).toBe(true);
    // Aucune réévaluation répétitive : décision v5 réutilisée.
    for (let k = 0; k < 3; k++) {
      const p = await passage([r], new Map([[1, ET]]));
      expect(p.bundle).toBeNull();
      expect(p.shown.map((x) => x.agendaItemId)).toEqual([1]);
    }
    expect(appels()).toBe(1);
  });

  it('décision v4 dont l’empreinte v4 ne correspond plus : contexte changé (cause tracée)', async () => {
    store.set(1, ancienne(S.t6ContextFingerprintV4(r, preuves([fait({ excerpt: 'Aucun entretien inclus.' })]))));
    const p = await passage([r], new Map([[1, ET]]), { evaluate: false });
    expect(p.decisions[0]).toMatchObject({ reevaluationReason: 'CONTEXT_CHANGED', contextChange: { cause: 'CONTENT_CHANGED', storedFormat: 'v4' } });
  });

  it('reprise BORNÉE : budget glissant, les autres réévaluations jamais retenues, aucune boucle', async () => {
    let t = 0;
    const budget = U.createT6UpgradeBudget({ perWindow: 3, windowMs: 60_000, now: () => t });
    const lignes = Array.from({ length: 10 }, (_, k) => ligne(k + 1, { title: `Échéance ${k + 1}` }));
    const ev = new Map(lignes.map((x) => [x.id, ET]));
    for (const x of lignes) store.set(x.id, ancienne(S.t6ContextFingerprintV4(x, ET), { id: x.id }));
    // Échéance NOUVELLE (jamais évaluée) : hors budget de reprise.
    const nouvelle = ligne(11, { title: 'Nouvelle échéance', date: '2026-11-10' });
    ev.set(11, OU);
    const p1 = await passage([...lignes, nouvelle], ev, { budget });
    expect(appels()).toBe(1);
    expect([...p1.bundle!.refs.values()].map((x) => x.agendaItemId)).toEqual([11, 1, 2, 3]);
    expect(p1).toMatchObject({ upgradeDeferred: 7, pendingAssessments: 0 });
    expect(p1.upgradeRetryInMs).toBeGreaterThan(0);
    // Budget épuisé : nouveaux passages immédiats sans aucun appel (aucune rafale, aucune boucle).
    for (let k = 0; k < 3; k++) {
      const p = await passage([...lignes, nouvelle], ev, { budget });
      expect(p.bundle).toBeNull();
      expect(p.upgradeDeferred).toBe(7);
      expect(p.shown.map((x) => x.agendaItemId).sort((a, b) => a - b)).toEqual([1, 2, 3, 11]);
    }
    expect(appels()).toBe(1);
    // Fenêtre écoulée : 3 de plus ; au total, appels bornés par le budget.
    t += 60_000;
    const p2 = await passage([...lignes, nouvelle], ev, { budget });
    expect([...p2.bundle!.refs.values()].map((x) => x.agendaItemId)).toEqual([4, 5, 6]);
    t += 60_000; await passage([...lignes, nouvelle], ev, { budget });
    t += 60_000; await passage([...lignes, nouvelle], ev, { budget });
    const fin = await passage([...lignes, nouvelle], ev, { budget });
    expect(fin).toMatchObject({ upgradeDeferred: 0, bundle: null });
    expect(fin.shown).toHaveLength(11);
    expect(appels()).toBe(4); // appels : (11, 1-3), (4-6), (7-9), (10)
    // Plus aucune décision à empreinte antérieure.
    expect([...store.values()].every((a) => a.fingerprint.startsWith('v5:'))).toBe(true);
  });

  it('reprise : la pré-génération différée est demandée à la libération du budget (jamais immédiate en boucle)', () => {
    const svc = readFileSync(join(process.cwd(), 'src/services/home/mascot/mascot.service.ts'), 'utf8');
    expect(svc).toMatch(/upgradeDeferred \?\? 0\) > 0 && t6Permis && !reprise/);
    expect(svc).toMatch(/requestMascotPregenerationAt\(accountId, 't6-upgrade', delai\)/);
  });

  it('preuves illisibles : décision v4 jamais réutilisée, jamais réévaluée sur un contexte incomplet', async () => {
    store.set(1, ancienne(S.t6ContextFingerprintV4(r, ET)));
    const p = await S.prepareT6Interpellation({ accountId: 7, userId: null, raw: raw([r]) }, {
      aiCapable: async () => true, thresholdDays: async () => 60,
      loaders: {
        assessments: async () => new Map(store), evidence: async () => { throw new Error('panne'); }, preferences: async () => [],
        dueReminders: async () => new Map(), examinations: async () => 0, cycles: async () => new Map(), rebaseFingerprints: rebase,
      },
    });
    expect(p.shown).toEqual([]);
    expect(p.bundle).toBeNull();
    expect(p.decisions[0]).toMatchObject({ reevaluationReason: 'FINGERPRINT_UPGRADE' });
  });

  it('budget glissant (pur)', () => {
    let t = 0;
    const b = U.createT6UpgradeBudget({ perWindow: 2, windowMs: 1000, now: () => t });
    expect([b.take(1), b.take(1), b.take(1)]).toEqual([1, 1, 0]);
    expect(b.retryInMs()).toBe(5000); // plancher
    t = 1000;
    expect(b.retryInMs()).toBe(0);
    expect(b.take(5)).toBe(2);
    expect(U.t6UpgradePerMinute({})).toBe(60);
    expect(U.t6UpgradePerMinute({ MASCOT_T6_UPGRADE_PER_MINUTE: '5' })).toBe(5);
    expect(U.t6UpgradePerMinute({ MASCOT_T6_UPGRADE_PER_MINUTE: '0' })).toBe(60);
    expect(U.t6UpgradePerMinute({ MASCOT_T6_UPGRADE_PER_MINUTE: '99999' })).toBe(1000);
  });
});

// ── AC06 ─────────────────────────────────────────────────────────────────────

describe('L109E AC06 — chaîne T6 : affichage, pré-génération, reports', () => {
  const r = ligne(1);

  it('report : empreinte v5 au moment du report ; « et » → « ou » est un changement significatif', async () => {
    await passage([r], new Map([[1, ET]]));
    const fpEt = S.t6ContextFingerprint(r, ET);
    const report = (contextFingerprint: string) => [{ scope: 'OCCURRENCE' as const, decision: 'SNOOZED' as const, remindAt: '2026-12-20', contextFingerprint, agendaItemId: 1, seriesKey: null }];
    const inchange = await passage([r], new Map([[1, ET]]), { userId: 5, prefs: report(fpEt), evaluate: false });
    expect(inchange.decisions[0]).toMatchObject({ code: 'USER_SNOOZED', needsAssessment: false });
    const change = await passage([r], new Map([[1, OU]]), { userId: 5, prefs: report(fpEt), evaluate: false });
    expect(change.decisions[0]).toMatchObject({ code: 'USER_SNOOZED', needsAssessment: true, reevaluationReason: 'CONTEXT_CHANGED' });
    // Report antérieur (v4) : relu à son format, jamais pris pour un changement de masse.
    const v4 = await passage([r], new Map([[1, ET]]), { userId: 5, prefs: report(S.t6ContextFingerprintV4(r, ET)), evaluate: false });
    expect(v4.decisions[0]).toMatchObject({ code: 'USER_SNOOZED' });
    expect(v4.shown).toEqual([]);
  });

  it('fondements des questions (t6-suggestion-grounds) : même fraîcheur v5 — une décision v4 n’est jamais « fraîche »', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/home/mascot/t6-suggestion-grounds.ts'), 'utf8');
    expect(src).toMatch(/a\.fingerprint === service\.t6ContextFingerprint\(r, e\)/);
    expect(S.t6ContextFingerprint(r, ET)).not.toBe(S.t6ContextFingerprintV4(r, ET));
  });
});
