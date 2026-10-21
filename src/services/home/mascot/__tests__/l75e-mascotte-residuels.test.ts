/**
 * Lot 75E — BUG P1 « Mascotte : corriger les écarts résiduels du lot 71F et
 * garantir une suppression sans perte d'information ». Classificateur
 * déterministe UNIQUE (`counting-intro.ts`) partagé par la composition, la
 * validation T6 et le cache ; aucun bloc vide ; révision du contrat de
 * présentation côté client. Rendu réel dans Chromium :
 * `src/components/home/__tests__/l75e-mascotte-navigateur.test.ts`.
 *
 *  L75E-M-STRIP   §2 : préambule seul retiré (deux-points, virgule, tirets,
 *                 point), information métier intégralement conservée
 *  L75E-M-FP      §2 : phrases métier mentionnant plusieurs éléments jamais tronquées
 *  L75E-M-VAR     §4 : variantes (« Voici deux sujets importants », « Vous avez… »,
 *                 « Il y a… ») détectées ; accents, apostrophes, insécables
 *  L75E-M-UNIQUE  §4 : même classification composition / contrat T6 / cache
 *  L75E-M-BLOC    §3 : aucun bloc vide — repli fallbackText, puis données structurées
 *  L75E-M-CLIENT  §5 : formulation interdite jamais conservée malgré un contextHash identique
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
const T = await import('../types');
type Raw = import('../signals').MascotRawData;
type P = import('../types').MascotPresentation;

beforeEach(() => { unsafe.mockReset(); unsafe.mockImplementation(async () => []); });

const NFD = (s: string) => s.normalize('NFD');

describe('L75E-M-STRIP — préambule seul retiré, information conservée', () => {
  const CAS: Array<[string, string, string]> = [
    ['deux-points (nominal)', 'Un sujet mérite votre attention aujourd’hui : Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.',
      'Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.'],
    ['virgule (anomalie A)', 'Un sujet mérite votre attention aujourd’hui, ajoutez votre premier document pour garage.',
      'Ajoutez votre premier document pour garage.'],
    ['tiret cadratin', 'Deux sujets importants — le ramonage le 4 novembre 2026 et la vidange de la Cupra.',
      'Le ramonage le 4 novembre 2026 et la vidange de la Cupra.'],
    ['tiret demi-cadratin', 'Deux points à traiter – la garantie du lave-linge expire le 3 mars 2027.',
      'La garantie du lave-linge expire le 3 mars 2027.'],
    ['tiret simple', 'Un point à voir - le contrôle technique de la Cupra le 18 avril 2028.',
      'Le contrôle technique de la Cupra le 18 avril 2028.'],
    ['point', 'Deux sujets nécessitent votre attention. Le ramonage est prévu le 4 novembre 2026 pour 85 €.',
      'Le ramonage est prévu le 4 novembre 2026 pour 85 €.'],
    ['phrase finale', 'Le ramonage est prévu le 4 novembre 2026. Un sujet mérite votre attention.',
      'Le ramonage est prévu le 4 novembre 2026.'],
    ['« Voici deux sujets importants »', 'Voici deux sujets importants : le ramonage et la vidange.', 'Le ramonage et la vidange.'],
    ['« Vous avez »', 'Vous avez deux points à regarder aujourd’hui : la facture Engie de 142,50 € et le bail.', 'La facture Engie de 142,50 € et le bail.'],
    ['« Il y a »', 'Il y a trois éléments à signaler : le contrat MAAF expire le 1er janvier 2027.', 'Le contrat MAAF expire le 1er janvier 2027.'],
    ['ouverture « Aujourd’hui, »', 'Aujourd’hui, deux sujets méritent toute votre attention : le ramonage.', 'Le ramonage.'],
    ['point-virgule', 'Plusieurs points demandent votre attention ; la chaudière doit être révisée avant le 15 décembre 2026.', 'La chaudière doit être révisée avant le 15 décembre 2026.'],
  ];
  it.each(CAS)('L75E-M-STRIP — %s', (_n, entree, attendu) => {
    expect(CI.stripCountingIntro(entree)).toBe(attendu);
    expect(CI.countingIntroOf(entree)).toMatchObject({ kind: 'INTRO', text: attendu });
    // Insécables, apostrophes droites, accents décomposés : même résultat.
    const variante = NFD(entree.replace(/ /g, ' ').replace(/’/g, '\''));
    expect(CI.stripCountingIntro(variante).normalize('NFC').replace(/ /g, ' ').replace(/'/g, '’'), variante).toBe(attendu.replace(/'/g, '’'));
  });

  it('L75E-M-STRIP-INTEGRITE — dates, montants, biens, documents et équipements intacts', () => {
    const faits = ['4 novembre 2026', '142,50 €', 'Cupra', 'garage', 'Facture Engie', 'lave-linge', '1er janvier 2027'];
    for (const [, entree] of CAS) {
      const sortie = CI.stripCountingIntro(entree);
      for (const f of faits) if (entree.includes(f)) expect(sortie, entree).toContain(f);
      expect(sortie).not.toMatch(/^\s|\s$|\s{2}/);
      expect(CI.hasCountingIntro(sortie), sortie).toBe(false);
    }
  });

  it('L75E-M-STRIP-SEUL — texte composé uniquement d’une introduction : vide (repli de l’appelant), jamais une phrase inventée', () => {
    for (const t of ['Deux sujets nécessitent votre attention aujourd’hui.', 'Voici deux sujets :', 'Plusieurs éléments requièrent votre attention.']) {
      expect(CI.countingIntroOf(t)).toEqual({ kind: 'INTRO_ONLY', text: '' });
      expect(CI.stripCountingIntro(t)).toBe('');
    }
  });

  it('L75E-M-STRIP-INCERTAIN — séparation non fiable : rien n’est retiré à l’aveugle (UNSAFE, repli de secours)', () => {
    for (const t of [
      // Introduction au milieu d’une phrase : retirer la seule proposition laisserait une phrase mutilée.
      'Bonjour Fabien, deux sujets méritent votre attention : le ramonage.',
      // Mot inconnu dans le préambule (« d’assurance ») : information potentielle.
      'Deux sujets d’assurance : l’habitation et l’auto.',
    ]) {
      expect(CI.countingIntroOf(t).kind, t).toBe('UNSAFE');
      expect(CI.hasCountingIntro(t), t).toBe(true);
      expect(CI.stripCountingIntro(t), t).toBe('');
    }
  });
});

describe('L75E-M-FP — faux positifs : aucune suppression abusive', () => {
  const METIER = [
    'Votre contrat contient deux éléments qui demandent votre attention : les freins et les pneus.',
    'Le devis comporte trois points à vérifier : la TVA, la main-d’œuvre et le délai.',
    'Vous avez deux points de contrôle à prévoir sur la Cupra : freins et pneus.',
    'La garantie couvre deux éléments : le moteur et la boîte de vitesses.',
    'Il y a deux échéances à surveiller pour la maison : le ramonage et la chaudière.',
    'Un rappel : le ramonage de la maison est prévu le 4 novembre 2026.',
    'Le contrat prévoit un préavis de deux mois, à envoyer avant le 1er mars 2027.',
    'Aucun sujet à traiter en priorité pour le moment.',
  ];
  it.each(METIER)('L75E-M-FP — « %s » conservée intégralement', (t) => {
    expect(CI.countingIntroOf(t)).toEqual({ kind: 'NONE', text: t });
    expect(CI.hasCountingIntro(t)).toBe(false);
    expect(CI.stripCountingIntro(t)).toBe(t);
    expect(C.mechanicalWording(t)).toBe(false);
  });

  it('L75E-M-FP-B — anomalie B du ticket : le contexte « Votre contrat… » n’est plus perdu', () => {
    expect(CI.stripCountingIntro('Votre contrat contient deux éléments qui demandent votre attention : les freins et les pneus.'))
      .toBe('Votre contrat contient deux éléments qui demandent votre attention : les freins et les pneus.');
  });
});

describe('L75E-M-VAR / L75E-M-UNIQUE — détection partagée composition / T6 / cache', () => {
  const VARIANTES = [
    'Voici deux sujets importants : le ramonage et la vidange.',
    'Voici 2 nouveaux points prioritaires : le ramonage.',
    'Vous avez un sujet à traiter : le ramonage.',
    'Il y a deux sujets pour vous aujourd’hui : le ramonage.',
    'J’ai trois points à vous signaler : la vidange.',
    'VOICI DEUX SUJETS IMPORTANTS : LE RAMONAGE.',
    NFD('Deux éléments méritent votre attention : le ramonage.'),
    'Deux sujets nécessitent votre attention : le ramonage.',
    'Un sujet mérite votre attention aujourdʼhui, ajoutez votre premier document.',
  ];
  it.each(VARIANTES)('L75E-M-VAR — « %s » : introduction détectée partout', (t) => {
    expect(CI.hasCountingIntro(t)).toBe(true);
    expect(C.mechanicalWording(t)).toBe(true);
  });

  it('L75E-M-UNIQUE-01 — sortie IA « Voici deux sujets importants » rejetée (repli de secours)', () => {
    const input = C.buildT6Input([{
      subjectId: 'S1', sourceCode: 'DATE-NEXT', intent: 'deadline',
      facts: { title: 'Ramonage', dateLabel: '4 novembre 2026', dateNature: 'confirmée' },
      fallbackText: 'Le ramonage est à prévoir pour le 4 novembre 2026.', allowedHighlight: null,
    } as never]);
    const v = C.validateT6MasterOutput(input, { schemaVersion: 't6-output-v2', messages: [{ subjectId: 'S1', text: 'Voici deux sujets importants : le ramonage, le 4 novembre 2026.' }] });
    expect(v.ok).toBe(false);
    // Phrase métier légitime : acceptée.
    const ok = C.validateT6MasterOutput(input, { schemaVersion: 't6-output-v2', messages: [{ subjectId: 'S1', text: 'Le ramonage est à prévoir pour le 4 novembre 2026.' }] });
    expect(ok.ok).toBe(true);
  });

  it('L75E-M-UNIQUE-02 — cache T6 porteur d’une variante : supprimé, jamais servi', async () => {
    const input = C.buildT6Input([{
      subjectId: 'S1', sourceCode: 'DATE-NEXT', intent: 'deadline',
      facts: { title: 'Ramonage', dateLabel: '4 novembre 2026', dateNature: 'confirmée' },
      fallbackText: 'Le ramonage est à prévoir pour le 4 novembre 2026.', allowedHighlight: null,
    } as never]);
    unsafe.mockResolvedValueOnce([{ messages: [{ subjectId: 'S1', text: 'Voici deux sujets importants : le ramonage, le 4 novembre 2026.', highlight: null }] }]);
    expect(await R.readT6CacheEntry(7, 'k75', input)).toBeNull();
    expect(unsafe.mock.calls.some(([s]) => /DELETE FROM home_mascot_cache/.test(s))).toBe(true);
  });

  it('L75E-M-UNIQUE-03 — un seul classificateur : t6-contract et bubble n’embarquent plus leur propre motif de comptage', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const contrat = readFileSync(join(__dirname, '../t6-contract.ts'), 'utf8');
    const bulle = readFileSync(join(__dirname, '../bubble.ts'), 'utf8');
    const pres = readFileSync(join(__dirname, '../presentation.ts'), 'utf8');
    expect(contrat).not.toMatch(/sujets\?\\s\+\(merite/);
    for (const src of [contrat, bulle, pres]) expect(src).toMatch(/from '\.\/counting-intro'/);
  });
});

// ── Composition : aucun bloc vide ───────────────────────────────────────────

const raw = (over: Partial<Raw> = {}): Raw => ({
  accountId: 7, today: '2026-10-19', processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Maison' }], activeAssetCount: 1, documentCount: 3 },
  toProcess: [], agenda: [], acknowledgments: [], overdueAgenda: [], ...over,
} as Raw);
const GARAGE = raw({ onboarding: { activeAssets: [{ id: 3, name: 'garage' }], activeAssetCount: 1, documentCount: 0 } });
const RAMONAGE = { id: 2, title: 'Ramonage cheminée', date: '2026-11-04', forecast: false, requiresQualification: false, assetId: 1, assetName: 'Maison', assetCategory: 'IMMOBILIER', assetSubtype: 'Maison', dateRole: 'DEADLINE', seriesKey: null } as const;
const action = (id: number) => ({ agendaItemId: id, interpellation: { mode: 'ACT_NOW', priority: 'MEDIUM', code: 'AI_ACT_NOW', reasonCode: 'ACTION_REQUIRED_SOON', category: 'ACTION_NOW' }, action: 'Prendre rendez-vous pour le ramonage', reminder: { agendaItemId: id, suggestedDate: '2026-10-28', hasSeries: false } }) as never;
const present = (r: Raw, o: Partial<Parameters<typeof buildPresentation>[0]> = {}, shown: never[] = []) => {
  const c = buildCandidates(r, { interpellation: { shown } });
  const s = selectSubjects(c.candidates);
  return buildPresentation({ subjects: s, secondaries: buildSecondaries(c, s, []), degraded: c.degraded, messages: null, today: '2026-10-19', todo: { total: 0, items: [] }, ...o });
};

describe('L75E-M-BLOC — aucun bloc vide, aucune action orpheline', () => {
  it('L75E-M-BLOC-01 — ancienne présentation : texte = introduction seule → fallbackText du sujet', () => {
    const p0 = present(GARAGE);
    const p: P = { ...p0, paragraphs: p0.paragraphs.map((x) => ({ ...x, text: 'Un sujet mérite votre attention aujourd’hui.', fallbackText: 'Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.' })) };
    const [b] = B.subjectBlocks(p);
    expect(b.text).toBe('Ajoutez votre premier document pour garage : une facture, un contrat ou une garantie.');
    expect(b.actions.map((a) => a.label)).toEqual(['Déposer un document']);
  });

  it('L75E-M-BLOC-02 — présentation historique SANS fallbackText : données structurées (intitulé, bien, date), rien d’inventé', () => {
    const p0 = present(raw({ agenda: [RAMONAGE as never] }), {}, [action(2)]);
    expect(p0.paragraphs[0].tile).toBeTruthy();
    const p: P = { ...p0, paragraphs: p0.paragraphs.map((x) => { const { fallbackText: _f, ...y } = x as typeof x & { fallbackText?: string }; return { ...y, text: 'Deux sujets nécessitent votre attention aujourd’hui.' }; }) };
    const [b] = B.subjectBlocks(p);
    expect(b.text).toBe('Ramonage cheminée · Maison · 4 novembre 2026');
    expect(b.actions.length).toBeGreaterThan(0);
    expect(b.reminder).not.toBeNull();
    // Message complet : même texte, une seule fois.
    expect(B.composeSpeech({ presentation: p, empty: false }).text).toBe('Ramonage cheminée · Maison · 4 novembre 2026');
  });

  it('L75E-M-BLOC-03 — sans tuile ni secours : libellé de l’action ; sans rien : bloc non rendu (jamais un paragraphe vide)', () => {
    const p0 = present(GARAGE);
    const sansTuile: P = { ...p0, paragraphs: p0.paragraphs.map(({ tile: _t, ...x }) => ({ ...x, text: 'Voici deux sujets :' })) };
    expect(B.subjectBlocks(sansTuile).map((b) => b.text)).toEqual(['Déposer un document']);
    const rien: P = { ...p0, paragraphs: p0.paragraphs.map(({ tile: _t, ...x }) => ({ ...x, text: 'Voici deux sujets :', actions: [] })) };
    expect(B.subjectBlocks(rien)).toEqual([]);
  });

  it('L75E-M-BLOC-04 — sortie T6 « UNSAFE » : le serveur sert le texte de secours et le transmet au client', () => {
    const c = buildCandidates(raw({ agenda: [RAMONAGE as never] }), { interpellation: { shown: [action(2)] } });
    const s = selectSubjects(c.candidates);
    const p = buildPresentation({
      subjects: s, secondaries: [], degraded: false, today: '2026-10-19',
      messages: s.map((x) => ({ subjectId: x.subjectId, text: 'Bonjour Fabien, deux sujets méritent votre attention : le ramonage.', highlight: null })),
    });
    expect(p.paragraphs[0].text).toBe(s[0].fallbackText);
    // Texte T6 valide : servi, son secours accompagne le paragraphe (repli client).
    const ok = buildPresentation({ subjects: s, secondaries: [], degraded: false, today: '2026-10-19', messages: s.map((x) => ({ subjectId: x.subjectId, text: 'Pensez au ramonage de la maison avant le 4 novembre 2026.', highlight: null })) });
    expect(ok.paragraphs[0]).toMatchObject({ text: 'Pensez au ramonage de la maison avant le 4 novembre 2026.', fallbackText: s[0].fallbackText });
  });

  it('L75E-M-BLOC-05 — espaces : texte rendu sans espace résiduel ni ponctuation orpheline', () => {
    const p0 = present(GARAGE);
    const p: P = { ...p0, paragraphs: p0.paragraphs.map((x) => ({ ...x, text: '  Un sujet mérite votre attention aujourd’hui ,   ajoutez votre premier document pour garage.  ' })) };
    expect(B.subjectBlocks(p)[0].text).toBe('Ajoutez votre premier document pour garage.');
  });
});

describe('L75E-M-CLIENT — révision du contrat de présentation', () => {
  it('L75E-M-CLIENT-01 — le serveur publie la révision courante', () => {
    expect(present(GARAGE).presentationRevision).toBe(T.MASCOT_PRESENTATION_REVISION);
  });

  it('L75E-M-CLIENT-02 — même contextHash : présentation conservée SEULEMENT si même révision et aucune formulation interdite', () => {
    const p = present(GARAGE);
    const interdite: P = { ...p, paragraphs: p.paragraphs.map((x) => ({ ...x, text: `Un sujet mérite votre attention aujourd’hui : ${x.text}` })) };
    const ancienne: P = { ...p, presentationRevision: undefined };
    expect(B.keepDisplayedPresentation(p, { ...p, computedAt: 'x' })).toBe(true);
    expect(B.keepDisplayedPresentation(interdite, p)).toBe(false);
    expect(B.keepDisplayedPresentation(ancienne, p)).toBe(false);
    expect(B.keepDisplayedPresentation(p, { ...p, contextHash: 'autre' })).toBe(false);
    expect(B.keepDisplayedPresentation(null, p)).toBe(false);
    expect(B.presentationDisplayable(interdite)).toBe(false);
    expect(B.presentationDisplayable(p)).toBe(true);
  });
});
