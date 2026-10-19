/**
 * Lot 71F — BUG P1 « supprimer définitivement les introductions « X sujets
 * méritent votre attention » » : détection, contrat T6, cache T6 et
 * composition de la bulle (IA et base simulées). Rendu complet de l'écran :
 * `src/components/home/__tests__/l71f-mascotte-sans-comptage.test.ts`.
 *
 *  L71F-DETECT  détection insensible aux accents, apostrophes, casse, espaces insécables, pluriel ;
 *               messages d'état et textes de sujets jamais pris pour une introduction
 *  L71F-STRIP   retrait de l'introduction seule, sans phrase de remplacement
 *  L71F-BULLE   composeSpeech / bubbleLead : plus aucun comptage (À traiter, Duo, sujets)
 *  L71F-CONTRAT sortie IA, sujet figé (bulle précédente) : repli sur le texte de secours du sujet
 *  L71F-CACHE   entrée de cache porteuse : jamais servie, et SUPPRIMÉE (renouvelée)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));
vi.mock('@/services/ai/config/config-resolver', () => ({
  resolveOperationConfig: async () => ({ promptArchitecture: 'master', masterPromptText: null, configVersionId: 3 }),
}));
vi.mock('@/services/ai/queue/job-queue.repository', () => ({ canStart: async () => true }));

const CI = await import('../counting-intro');
const C = await import('../t6-contract');
const R = await import('../t6-runner');
const B = await import('../bubble');
const { buildCandidates } = await import('../signals');
const { selectSubjects, buildSecondaries } = await import('../selector');
const { buildPresentation } = await import('../presentation');
type Raw = import('../signals').MascotRawData;

beforeEach(() => { unsafe.mockReset(); unsafe.mockImplementation(async () => []); });

const INTERDITES = [
  'Un sujet mérite votre attention aujourd’hui',
  'Un sujet mérite votre attention aujourd\'hui : Ajoutez maintenant votre premier document pour garage.',
  'Deux sujets méritent votre attention',
  'Un sujet nécessite votre attention aujourd’hui.',
  'Trois sujets nécessitent votre attention aujourd’hui.',
  '2 sujets nécessitent votre attention.',
  'UN SUJET MERITE VOTRE ATTENTION AUJOURD’HUI',
  'un sujet merite votre attention aujourdʼhui',
  // Accents décomposés (NFD) et espaces insécables.
  'Un sujet mérite votre attention.',
  'Deux nouveaux sujets méritent toute votre attention aujourd’hui.',
  'Deux points demandent votre attention : le ramonage et la vidange.',
  'Plusieurs éléments requièrent votre attention.',
  'Voici deux sujets :',
  'Deux points à traiter aujourd’hui : le ramonage.',
  'Le ramonage est prévu le 4 novembre 2026. Un sujet mérite votre attention.',
];
const AUTORISEES = [
  B.NOTHING_PRIORITY, B.NOTHING_TO_REPORT_SPEECH, B.EVALUATION_PENDING_SPEECH, B.EVALUATION_UNAVAILABLE_SPEECH,
  B.EMPTY_ACCOUNT_SPEECH, B.DEGRADED_SPEECH, B.PARTIAL_DATA_SPEECH,
  'Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.',
  'Pour commencer, ajoutez votre premier bien : un logement, un véhicule ou un objet.',
  'La visite expert bois de la maison est prévue le 22 octobre 2026.',
  'Le contrôle technique de la Cupra est à prévoir pour le 18 avril 2028.',
  'Le document « Facture garage » est en cours d’analyse.',
  'Un rappel : le ramonage de la maison est prévu le 4 novembre 2026.',
];

describe('L71F-DETECT / L71F-STRIP — introductions de comptage', () => {
  it('L71F-DETECT-01 — toutes les variantes détectées (accents, apostrophes, casse, insécables, singulier / pluriel)', () => {
    for (const t of INTERDITES) expect(CI.hasCountingIntro(t), t).toBe(true);
    for (const t of INTERDITES) expect(C.mechanicalWording(t), t).toBe(true);
  });

  it('L71F-DETECT-02 — messages d’état et textes de sujets jamais pris pour une introduction', () => {
    for (const t of AUTORISEES) expect(CI.hasCountingIntro(t), t).toBe(false);
    for (const t of AUTORISEES) expect(C.mechanicalWording(t), t).toBe(false);
    expect(CI.hasCountingIntro('')).toBe(false);
    expect(CI.hasCountingIntro(null)).toBe(false);
  });

  it('L71F-STRIP-01 — retrait de la seule introduction, majuscule rendue, rien à la place', () => {
    expect(CI.stripCountingIntro('Un sujet mérite votre attention aujourd’hui : Ajoutez maintenant votre premier document pour garage : une facture, un contrat ou une garantie.'))
      .toBe('Ajoutez maintenant votre premier document pour garage : une facture, un contrat ou une garantie.');
    expect(CI.stripCountingIntro('Deux sujets méritent votre attention : le ramonage, le 4 novembre 2026.')).toBe('Le ramonage, le 4 novembre 2026.');
    expect(CI.stripCountingIntro('Deux sujets nécessitent votre attention aujourd’hui.')).toBe('');
    for (const t of AUTORISEES) expect(CI.stripCountingIntro(t)).toBe(t);
  });
});

// ── Bulle ────────────────────────────────────────────────────────────────────

const raw = (over: Partial<Raw> = {}): Raw => ({
  accountId: 7, today: '2026-10-19', processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 3 },
  toProcess: [], agenda: [], acknowledgments: [], overdueAgenda: [], ...over,
} as Raw);
const present = (r: Raw, o: Partial<Parameters<typeof buildPresentation>[0]> = {}) => {
  const c = buildCandidates(r);
  const s = selectSubjects(c.candidates);
  return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages: null, todo: { total: 0, items: [] }, ...o });
};
const todo = (id: string) => ({ todoId: id, actionKind: 'COMPLETE', priority: 'DO_FIRST', title: 'Numéro à compléter', subtitle: 'Maison', cta: 'Ouvrir', entityType: 'ASSET', actionType: 'OPEN_TODO_CARD', todoType: 'DATA', card: { question: 'Numéro ?' } }) as never;
const DUO = { href: '/mon-compte?panneau=duo', title: 'Inviter quelqu’un', subtitle: 'Premium Duo', cta: 'Inviter' };
const GARAGE = raw({ onboarding: { activeAssets: [{ id: 3, name: 'garage' }], activeAssetCount: 1, documentCount: 0 } });

describe('L71F-BULLE — composition sans comptage', () => {
  it('L71F-BULLE-01 — plus de générateur de comptage exporté', () => {
    expect('todoSummary' in B).toBe(false);
  });

  it('L71F-BULLE-02 — ONB-DOC (capture) : texte direct, en-tête vide', () => {
    const p = present(GARAGE);
    expect(B.composeSpeech({ presentation: p, empty: false }).text).toBe('Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.');
    expect(B.bubbleLead({ presentation: p, empty: false }).text).toBe('');
    expect(B.subjectBlocks(p).map((b) => [b.text, b.actions.map((a) => a.label)])).toEqual([
      ['Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.', ['Déposer un document']],
    ]);
  });

  it('L71F-BULLE-03 — 1 / 2 « À traiter », Duo seul, Duo + « À traiter », Duo + ONB-DOC : jamais de comptage ni « rien à signaler »', () => {
    const cas = [
      present(raw(), { todo: { total: 1, items: [todo('a')] } }),
      present(raw(), { todo: { total: 4, items: [todo('a'), todo('b')] } }),
      present(raw(), { duoInvite: DUO }),
      present(raw(), { duoInvite: DUO, todo: { total: 1, items: [todo('a')] } }),
      present(GARAGE, { duoInvite: DUO, todo: { total: 1, items: [todo('a')] } }),
    ];
    for (const p of cas) {
      for (const f of [B.composeSpeech, B.bubbleLead]) {
        const t = f({ presentation: p, empty: false }).text;
        expect(CI.hasCountingIntro(t), t).toBe(false);
        expect(t).not.toMatch(/votre attention|Rien de particulier|Aucun sujet à traiter/);
      }
      expect(B.bubbleLead({ presentation: p, empty: false }).text).toBe('');
      expect(p.state?.kind).toBe('ACTIONS');
    }
    expect(B.composeSpeech({ presentation: cas[4], empty: false }).text).toBe('Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.');
  });

  it('L71F-BULLE-04 — paragraphe d’une présentation antérieure porteur d’une introduction : retiré (blocs et message complet)', () => {
    const p0 = present(GARAGE);
    const p = { ...p0, paragraphs: p0.paragraphs.map((x) => ({ ...x, text: `Un sujet mérite votre attention aujourd’hui : ${x.text}` })) };
    expect(B.subjectBlocks(p)[0].text).toBe('Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.');
    expect(B.composeSpeech({ presentation: p, empty: false }).text).toBe('Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.');
  });
});

// ── Contrat T6 et cache ─────────────────────────────────────────────────────

const ramonage = () => C.buildT6Input([{
  subjectId: 'S1', sourceCode: 'DATE-NEXT', intent: 'deadline',
  facts: { title: 'Ramonage', dateLabel: '4 novembre 2026', dateNature: 'confirmée' },
  fallbackText: 'Le ramonage est à prévoir pour le 4 novembre 2026.', allowedHighlight: null,
} as never]);

describe('L71F-CONTRAT / L71F-CACHE — T6', () => {
  it('L71F-CONTRAT-01 — sortie IA porteuse (variantes) : repli sur le texte de secours du sujet', () => {
    const input = ramonage();
    for (const t of [
      'Deux points demandent votre attention : le ramonage, le 4 novembre 2026.',
      'UN SUJET MERITE VOTRE ATTENTION : le ramonage, le 4 novembre 2026.',
      'Voici un point à traiter : le ramonage, le 4 novembre 2026.',
    ]) {
      const v = C.validateT6MasterOutput(input, { schemaVersion: 't6-output-v2', messages: [{ subjectId: 'S1', text: t }] });
      // Un seul sujet, fautif : bulle rejetée → texte de secours.
      expect(v.ok, t).toBe(false);
    }
  });

  it('L71F-CONTRAT-02 — texte figé d’une bulle précédente porteur : jamais réutilisé tel quel', () => {
    const input = ramonage();
    const ancien = { input, output: { schemaVersion: 't6-output-v2', messages: [{ subjectId: 'S1', text: 'Un sujet mérite votre attention : le ramonage, le 4 novembre 2026.' }] } };
    const w = R.previousWording(input, [ancien]);
    expect(w.reuse).toBeNull();
    expect(w.pinned.size).toBe(0);
  });

  it('L71F-CACHE-01 — entrée de cache porteuse : non servie et SUPPRIMÉE ; entrée saine : servie, rien supprimé', async () => {
    const input = ramonage();
    for (const texte of [
      'Un sujet mérite votre attention aujourd’hui : le ramonage, le 4 novembre 2026.',
      'Deux points nécessitent votre attention : le ramonage, le 4 novembre 2026.',
    ]) {
      unsafe.mockReset();
      unsafe.mockResolvedValueOnce([{ messages: [{ subjectId: 'S1', text: texte, highlight: null }] }]);
      unsafe.mockResolvedValue([]);
      expect(await R.readT6CacheEntry(7, 'k1', input)).toBeNull();
      const del = unsafe.mock.calls.find(([sql]) => /DELETE FROM home_mascot_cache/.test(sql));
      expect(del?.[0]).toMatch(/WHERE account_id = \$1 AND cache_key = \$2/);
      expect(del?.[1]).toEqual([7, 'k1']);
    }
    unsafe.mockReset();
    unsafe.mockResolvedValueOnce([{ messages: [{ subjectId: 'S1', text: 'Le ramonage est à prévoir pour le 4 novembre 2026.', highlight: null }] }]);
    expect(await R.readT6CacheEntry(7, 'k2', input)).toMatchObject({ messages: [{ text: 'Le ramonage est à prévoir pour le 4 novembre 2026.' }] });
    expect(unsafe.mock.calls.some(([sql]) => /DELETE/.test(sql))).toBe(false);
  });

  it('L71F-CACHE-02 — suppression en échec : jamais d’erreur, l’entrée n’est pas servie', async () => {
    const input = ramonage();
    unsafe.mockResolvedValueOnce([{ messages: [{ subjectId: 'S1', text: 'Un sujet mérite votre attention : le ramonage, le 4 novembre 2026.', highlight: null }] }]);
    unsafe.mockRejectedValueOnce(new Error('base indisponible'));
    expect(await R.readT6CacheEntry(7, 'k3', input)).toBeNull();
  });
});
