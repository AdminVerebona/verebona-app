/**
 * Carte Trello #766 (lot 114R) — périodes métier : fiabiliser faits, corrections, exports (suite de #724 / #725).
 * Tests SANS base (règles pures, lectures sur un client SQL simulé). Les écritures réelles (correction,
 * propagation, reprise) sont prouvées sur PostgreSQL par `l114r-periodes-metier.e2e.ts`.
 *
 *   L114R-U-E01  couverture et facturation de mêmes bornes : deux faits, une principale, reprise du stock
 *   L114R-U-E10  fin inconnue ≠ durée indéterminée : fusion, empreinte, même fait, signature
 *   L114R-U-E05  verrou du FAIT corrigé (plus de la nature entière), rangs de segment stables
 *   L114R-U-E06  succession seulement sur preuve ; ordre non prouvé sans question
 *   L114R-U-E07  incident technique du réexamen T3 ≠ ambiguïté métier
 *   L114R-U-E08  continuité d'un fait corrigé (autre justificatif encore à l'ancienne valeur)
 *   L114R-U-E02  dossiers et Assistant : « aucun conflit » ≠ « résolution indisponible ou partielle »
 *   L114R-U-E03  durée indéterminée propagée par la lecture groupée (même libellé que la fiche)
 *   L114R-U-E09  période facturée de LA dépense, incertitude plutôt qu'association fausse
 *   L114R-U-E12  création d'une nature : pertinence contrôlée côté service
 *   L114R-U-E04  durée indéterminée et date de fin incompatibles (refus avant toute écriture)
 *   L114R-U-E11  détail des périodes rattaché à « Notes / Description », jamais écrit dans les notes
 *   L114R-U-R04  facture traversant deux mois, bornes partielles, périodes discontinues
 *   L114R-U-TEXTES  textes nouveaux sans « Opération »
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const base = vi.hoisted(() => ({ repondre: null as null | ((q: string, p: unknown[]) => unknown[] | Promise<unknown[]>), appels: [] as string[] }));
vi.mock('@/db', () => ({
  db: {},
  pgClient: {
    unsafe: async (q: string, p: unknown[]) => {
      base.appels.push(q);
      if (!base.repondre) throw new Error('aucune base dans ce test');
      return base.repondre(q, p);
    },
  },
}));

const lib = await import('@/lib/documents/business-periods');
const m = await import('../model');
const res = await import('../resolution');
const review = await import('../relation-review');
const svc = await import('../service');
const surf = await import('@/services/documents/business-period-surfaces');

type Entrees = Parameters<typeof m.deriveDocumentPeriods>[0];
const SANS_FACTURATION = { billedPeriod: null, statedMonth: null, hasBillingBlock: false };
const fait = (factId: number, rawKey: string, normalizedValue: string, over: Partial<Entrees['facts'][number]> = {}): Entrees['facts'][number] => ({
  factId, rawKey, normalizedValue, periodStart: null, periodEnd: null, attribute: null, confidence: 'certain', excerpt: `extrait ${factId}`, page: 1, ...over,
});
const derive = (p: Partial<Entrees>) => m.deriveDocumentPeriods({ candidates: [], facts: [], billing: SANS_FACTURATION, ...p });
type Stocke = Parameters<typeof m.planRefresh>[0][number];
const stocke = (id: number, over: Partial<Stocke> = {}): Stocke => ({
  id, kind: 'COVERAGE', segment: 0, start: '2025-01-01', end: '2025-03-31', principalHint: false, origin: 'T1', basis: 'T1_PERIOD_FACT',
  evidence: { quote: 'extrait 1', page: 1, factIds: [1] }, userLocked: false, ...over,
});
type Entree = import('../resolution').ResolutionEntry;
const e = (id: number, fileId: number, start: string | null, end: string | null, o: Partial<Entree> = {}): Entree =>
  ({ id, fileId, kind: 'COVERAGE', start, end, userCorrected: false, qualified: true, relation: null, ...o });

beforeEach(() => { base.repondre = null; base.appels.length = 0; });

describe('L114R-U-E01 — couverture et facturation de mêmes bornes : deux faits distincts', () => {
  const faits = [fait(1, 'period.coverage', '2025-01-01/2025-12-31'), fait(2, 'period.billing', '2025-01-01/2025-12-31')];
  it('les deux natures sont conservées, preuves séparées ; UNE principale (couverture), facturation secondaire', () => {
    const d = derive({ facts: faits });
    expect(d.map((x) => [x.kind, x.start, x.end, x.evidence.factIds])).toEqual([
      ['COVERAGE', '2025-01-01', '2025-12-31', [1]], ['BILLING', '2025-01-01', '2025-12-31', [2]],
    ]);
    expect(m.principalKind(d)).toBe('COVERAGE');
    expect(lib.principalLine('COVERAGE', d.filter((x) => x.kind === 'COVERAGE'))).toBe('Période couverte : du 01/01/2025 au 31/12/2025');
  });
  it('reprise du stock : un document enregistré « couverture seule » reçoit sa période facturée, sans toucher la couverture ; rejouée : rien', () => {
    const d = derive({ facts: faits });
    const avant = [stocke(10, { end: '2025-12-31' })];
    const plan = m.planRefresh(avant, d);
    expect(plan).toMatchObject({ keep: [10], supersede: [] });
    expect(plan.insert.map((x) => x.kind)).toEqual(['BILLING']);
    const apres = [...avant, { ...stocke(11), ...plan.insert[0], id: 11, origin: 'T1' as const, userLocked: false }];
    expect(m.planRefresh(apres, d)).toEqual({ keep: [10, 11], supersede: [], insert: [] });
  });
  it('la désignation de T1 reste prioritaire : facturation principale si T1 la désigne', () => {
    const d = derive({ facts: [faits[0], fait(2, 'period.billing', '2025-01-01/2025-12-31', { attribute: 'principal' })] });
    expect(m.principalKind(d)).toBe('BILLING');
  });
});

describe('L114R-U-E10 — fin inconnue ≠ durée indéterminée établie', () => {
  it('même nature, mêmes bornes stockées, modalités différentes : deux interprétations conservées (jamais fusionnées)', () => {
    const d = derive({ facts: [fait(1, 'period.coverage', '2026-01-01/'), fait(2, 'period.coverage', '2026-01-01/INDEFINITE')] });
    expect(d.map((x) => [x.segment, x.start, x.end, x.openEnded === true, x.evidence.factIds])).toEqual([
      [0, '2026-01-01', null, false, [1]], [1, '2026-01-01', null, true, [2]],
    ]);
    expect(d.map((x) => lib.periodLine(x.kind, x))).toEqual(['Début de couverture : 01/01/2026', 'Début de couverture : 01/01/2026 (durée indéterminée)']);
    expect(m.periodSignature(d[0])).not.toBe(m.periodSignature({ ...d[1], segment: 0 }));
    // Ordre indépendant de l'ordre des faits (déterministe).
    const inverse = derive({ facts: [fait(1, 'period.coverage', '2026-01-01/INDEFINITE'), fait(2, 'period.coverage', '2026-01-01/')] });
    expect(inverse.map((x) => x.openEnded === true)).toEqual([false, true]);
  });
  it('faits réellement équivalents : une seule ligne, preuves réunies', () => {
    const d = derive({ facts: [fait(1, 'period.coverage', '2026-01-01/INDEFINITE'), fait(2, 'period.coverage', '2026-01-01/INDEFINITE')] });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ openEnded: true, evidence: { factIds: [1, 2] } });
  });
  it('entre justificatifs : jamais « même fait » ; empreinte distincte ; empreintes déjà enregistrées inchangées', () => {
    const inconnue = e(1, 10, '2026-01-01', null);
    const indeterminee = e(2, 11, '2026-01-01', null, { openEnded: true });
    expect(lib.samePeriodBounds(inconnue, indeterminee)).toBe(false);
    expect(res.classifyPair(inconnue, indeterminee, new Map()).relation).toBe('UNDETERMINED');
    expect(res.classifyPair(indeterminee, e(3, 12, '2026-01-01', null, { openEnded: true }), new Map()).relation).toBe('SAME_FACT');
    expect(res.conflictFingerprint('COVERAGE', inconnue, indeterminee)).toBe('COVERAGE|10:2026-01-01/|11:2026-01-01/INDEFINITE');
    expect(res.conflictFingerprint('COVERAGE', e(1, 11, '2024-04-01', '2025-03-31'), e(2, 10, '2024-06-01', '2025-05-31')))
      .toBe('COVERAGE|10:2024-06-01/2025-05-31|11:2024-04-01/2025-03-31');
  });
});

describe('L114R-U-E05 — le fait corrigé est protégé, plus la nature entière', () => {
  const q1 = { kind: 'COVERAGE' as const, segment: 0, start: '2025-01-01', end: '2025-03-31', principalHint: false, basis: 'T1_PERIOD_FACT' as const, evidence: { quote: 'extrait 1', page: 1, factIds: [1] } };
  const q3 = { ...q1, segment: 1, start: '2025-07-01', end: '2025-09-30', evidence: { quote: 'extrait 2', page: 1, factIds: [2] } };
  const corrige = stocke(10, { origin: 'USER', basis: 'USER', userLocked: true, start: '2025-01-15', lockedBefore: { start: '2025-01-01', end: '2025-03-31' } });
  it('T1 relit le fait corrigé (valeur d’avant, ou valeur recouvrante) : jamais réécrit, jamais doublé', () => {
    expect(m.planRefresh([corrige], [q1])).toEqual({ keep: [], supersede: [], insert: [] });
    expect(m.planRefresh([corrige], [{ ...q1, start: '2025-02-01', end: '2025-04-30' }])).toEqual({ keep: [], supersede: [], insert: [] });
    expect(m.planRefresh([corrige], [])).toEqual({ keep: [], supersede: [], insert: [] });
  });
  it('un autre segment PROUVÉ disjoint est ajouté sur un rang libre ; deux reprises : stable', () => {
    const plan = m.planRefresh([corrige], [q1, q3]);
    expect(plan).toMatchObject({ keep: [], supersede: [] });
    expect(plan.insert).toEqual([q3]);
    const stock = [corrige, stocke(11, { segment: 1, start: '2025-07-01', end: '2025-09-30', evidence: q3.evidence })];
    expect(m.planRefresh(stock, [q1, q3])).toEqual({ keep: [11], supersede: [], insert: [] });
    expect(m.planRefresh(stock, [q1, q3])).toEqual({ keep: [11], supersede: [], insert: [] });
  });
  it('l’autre segment est mis à jour ou retiré par T1 sans toucher le fait corrigé', () => {
    const stock = [corrige, stocke(11, { segment: 1, start: '2025-07-01', end: '2025-09-30', evidence: q3.evidence })];
    const maj = m.planRefresh(stock, [q1, { ...q3, end: '2025-10-31' }]);
    expect(maj).toMatchObject({ keep: [], supersede: [11] });
    expect(maj.insert).toEqual([{ ...q3, end: '2025-10-31' }]);
    expect(m.planRefresh(stock, [q1])).toEqual({ keep: [], supersede: [11], insert: [] });
  });
  it('rang de segment : jamais celui du fait corrigé (index unique document / nature / segment)', () => {
    // T1 ne rend plus que le segment disjoint (rang 0 chez lui) : il prend le premier rang libre.
    const seul = m.planRefresh([corrige], [{ ...q3, segment: 0 }]);
    expect(seul.insert).toEqual([{ ...q3, segment: 1 }]);
    // Fait corrigé au rang 1 : les segments automatiques l'enjambent (0 puis 2).
    const verrou1 = stocke(10, { origin: 'USER', basis: 'USER', userLocked: true, segment: 1, start: '2025-04-01', end: '2025-06-30', lockedBefore: { start: '2025-04-01', end: '2025-06-15' } });
    const p = m.planRefresh([verrou1], [q1, { ...q3, segment: 1, start: '2025-04-01', end: '2025-06-15' }, { ...q3, segment: 2 }]);
    expect(p.insert.map((x) => [x.segment, x.start])).toEqual([[0, '2025-01-01'], [2, '2025-07-01']]);
  });
  it('étendue inconnue : prudence — rien n’est ajouté (aucune perte, aucune fusion de périodes discontinues)', () => {
    // Fait voulu dont la borne manquante empêche de prouver la distinction : écarté.
    expect(m.planRefresh([corrige], [{ ...q3, start: null }]).insert).toEqual([]);
    expect(m.planRefresh([corrige], [{ ...q3, start: null, end: null }]).insert).toEqual([]);
    // Début connu postérieur à la fin du fait corrigé : distinct prouvé, même sans date de fin.
    expect(m.planRefresh([corrige], [{ ...q3, end: null }]).insert).toEqual([{ ...q3, end: null }]);
    // Le fait corrigé remplaçait une ligne « non renseignée » : il vaut pour la nature (comme avant la carte).
    const rempli = stocke(10, { origin: 'USER', basis: 'USER', userLocked: true, lockedBefore: { start: null, end: null } });
    expect(m.planRefresh([rempli], [q3]).insert).toEqual([]);
    // Fait saisi sans fait antérieur : seul un segment prouvé disjoint s'ajoute.
    const saisi = stocke(10, { origin: 'USER', basis: 'USER', userLocked: true, lockedBefore: null });
    expect(m.planRefresh([saisi], [q1, q3]).insert).toEqual([q3]);
  });
  it('les autres natures ne sont pas concernées par le verrou', () => {
    const factu = { ...q1, kind: 'BILLING' as const, start: '2025-02', end: '2025-02', basis: 'T1_STATED_MONTH' as const, evidence: {} };
    expect(m.planRefresh([corrige], [q1, factu]).insert).toEqual([factu]);
  });
});

describe('L114R-U-E06 — succession seulement sur preuve', () => {
  it('ce que prouvent les bornes', () => {
    const p = (a: [string | null, string | null], b: [string | null, string | null], tol = 1) =>
      lib.boundsProof({ start: a[0], end: a[1] }, { start: b[0], end: b[1] }, tol).proof;
    expect(p(['2024-04-01', '2025-03-31'], ['2025-04-01', '2026-03-31'])).toBe('DISJOINT');
    expect(p(['2023-04-01', '2024-04-01'], ['2024-04-01', '2025-03-31'])).toBe('DISJOINT'); // jour de bascule toléré
    expect(p(['2024-04-01', '2025-03-31'], ['2024-06-01', '2025-05-31'])).toBe('OVERLAP');
    // Fin connue de l'une avant le début connu de l'autre : ordre prouvé malgré les bornes manquantes.
    expect(p([null, '2024-03-31'], ['2024-04-01', null])).toBe('DISJOINT');
    expect(p(['2024-04-01', null], [null, '2024-03-31'])).toBe('DISJOINT');
    // Borne manquante qui empêche de conclure : jamais une preuve.
    expect(p(['2024-04-01', '2025-03-31'], ['2024-06-01', null])).toBe('UNKNOWN');
    expect(p(['2024-04-01', null], ['2025-04-01', null])).toBe('UNKNOWN');
    expect(p([null, null], ['2024-04-01', '2025-03-31'])).toBe('UNKNOWN');
    expect(p([null, '2025-03-31'], [null, '2026-03-31'])).toBe('UNKNOWN');
    // Mois seul : étendue maximale réelle (février : 28 jours).
    expect(p(['2025-02', '2025-02'], ['2025-03-01', '2025-03-31'])).toBe('DISJOINT');
    expect(lib.lastDayOf('2025-02')).toBe('2025-02-28');
  });
  it('succession prouvée → SUCCESSION ; ordre non prouvé → ni succession, ni divergence, ni question', () => {
    expect(res.classifyPair(e(1, 10, '2024-04-01', '2025-03-31'), e(2, 11, '2025-04-01', null), new Map()).relation).toBe('SUCCESSION');
    const r = res.resolvePeriods([e(1, 10, '2024-04-01', '2025-03-31'), e(2, 11, '2024-06-01', null), e(3, 12, null, null)]);
    expect(r.pairs.map((x) => x.relation)).toEqual(['UNDETERMINED', 'UNDETERMINED', 'UNDETERMINED']);
    expect(r.conflicts).toEqual([]);
    expect([...r.entries.values()].every((x) => x.status === 'ESTABLISHED')).toBe(true);
    expect(r.uncertain.map((x) => [x.periodIds, x.needsUser, x.review])).toEqual([[[1, 2], false, 'NONE'], [[1, 3], false, 'NONE'], [[2, 3], false, 'NONE']]);
  });
  it('avenant / rectificatif déclaré à bornes partielles : aucune cible devinée, aucun remplacement, aucune question', () => {
    for (const relation of ['AMENDMENT', 'RECTIFICATION'] as const) {
      const r = res.resolvePeriods([e(1, 10, '2024-04-01', '2025-03-31'), e(2, 11, '2024-06-01', null, { relation })]);
      expect([...r.entries.values()].map((x) => x.status)).toEqual(['ESTABLISHED', 'ESTABLISHED']);
      expect(r.conflicts).toEqual([]);
      expect(r.uncertain).toHaveLength(1);
    }
  });
  it('réexamen T3 d’un ordre non prouvé : succession / même fait → rien ; avenant → remplacement ; contradiction CERTAINE → divergence réelle', () => {
    const a = e(1, 10, '2024-04-01', '2025-03-31');
    const b = e(2, 11, '2024-06-01', null);
    const fp = res.conflictFingerprint('COVERAGE', a, b);
    for (const relation of ['SUCCESSION', 'SAME_FACT', 'DIFFERENT_NATURES'] as const) {
      const r = res.resolvePeriods([a, b], [], [{ fingerprint: fp, state: 'DECIDED', relation, replacingFileId: null }]);
      expect([r.conflicts, r.uncertain]).toEqual([[], []]);
    }
    const avenant = res.resolvePeriods([a, b], [], [{ fingerprint: fp, state: 'DECIDED', relation: 'AMENDMENT', replacingFileId: 11 }]);
    expect(avenant.entries.get(1)).toMatchObject({ status: 'REPLACED', byFileId: 11, basis: 'AI_AMENDMENT' });
    // T3 a travaillé sans conclure (abstention) : l'ordre reste non prouvé — toujours aucune question.
    const abstention = res.resolvePeriods([a, b], [], [{ fingerprint: fp, state: 'EXAMINED' }]);
    expect(abstention.conflicts).toEqual([]);
    expect(abstention.uncertain).toEqual([expect.objectContaining({ review: 'EXAMINED', needsUser: false })]);
    // Contradiction certaine : seule voie vers la question (documents qualifiés).
    const contra = res.resolvePeriods([a, b], [], [{ fingerprint: fp, state: 'EXAMINED', contradiction: true }]);
    expect(contra.conflicts).toEqual([expect.objectContaining({ fingerprint: fp, needsUser: true, review: 'EXAMINED' })]);
    expect(contra.uncertain).toEqual([]);
    const nonQualifie = res.resolvePeriods([a, { ...b, qualified: false }], [], [{ fingerprint: fp, state: 'EXAMINED', contradiction: true }]);
    expect(nonQualifie.conflicts).toEqual([expect.objectContaining({ needsUser: false })]);
  });
  it('durée indéterminée et attestation annuelle : aucune contradiction fabriquée', () => {
    const r = res.resolvePeriods([e(1, 10, '2020-01-01', null, { openEnded: true }), e(2, 11, '2024-04-01', '2025-03-31')]);
    expect(r.conflicts).toEqual([]);
    expect(r.pairs[0].relation).toBe('UNDETERMINED');
    // Antérieure au début : succession prouvée.
    expect(res.classifyPair(e(1, 10, '2020-01-01', null, { openEnded: true }), e(2, 11, '2018-01-01', '2019-12-31'), new Map()).relation).toBe('SUCCESSION');
  });
});

describe('L114R-U-E07 — incident technique du réexamen T3 ≠ ambiguïté métier', () => {
  const a = e(1, 10, '2024-04-01', '2025-03-31');
  const b = e(2, 11, '2024-06-01', '2025-05-31');
  const fp = res.conflictFingerprint('COVERAGE', a, b);
  it('en attente (même en retard) ou en échec technique : la divergence reste visible, AUCUNE question', () => {
    for (const etat of [
      { fingerprint: fp, state: 'AWAITING' as const }, { fingerprint: fp, state: 'AWAITING' as const, late: true },
      { fingerprint: fp, state: 'FAILED' as const }, { fingerprint: fp, state: 'FAILED' as const, rearmable: true },
    ]) {
      const r = res.resolvePeriods([a, b], [], [etat]);
      expect(r.conflicts).toEqual([expect.objectContaining({ needsUser: false, review: etat.state })]);
      expect([...r.entries.values()].map((x) => x.status)).toEqual(['CONFLICT', 'CONFLICT']);
    }
    expect(res.resolvePeriods([a, b], [], [{ fingerprint: fp, state: 'AWAITING', late: true }]).conflicts[0]).toMatchObject({ late: true });
    expect(res.resolvePeriods([a, b], [], [{ fingerprint: fp, state: 'FAILED', rearmable: true }]).conflicts[0]).toMatchObject({ rearmable: true });
  });
  it('question seulement quand T3 a réellement travaillé sans expliquer (ou sans réexamen possible : 113AA)', () => {
    expect(res.resolvePeriods([a, b], [], [{ fingerprint: fp, state: 'EXAMINED' }]).conflicts[0].needsUser).toBe(true);
    expect(res.resolvePeriods([a, b], [], []).conflicts[0]).toMatchObject({ needsUser: true, review: 'NONE' });
  });
  it('mémoire : essais épuisés → FAILED (réarmable ou non) ; nouvel essai planifié → AWAITING ; 24 h dépassées → AWAITING « en retard », jamais EXAMINED', async () => {
    const lignes = [
      { fingerprint: 'epuise', status: 'AI_FAILED', relation: null, confidence: null, replacing_file_id: null, evidence: [], fresh: true, exhausted: true, rearmable: true },
      { fingerprint: 'bloque', status: 'AI_FAILED', relation: null, confidence: null, replacing_file_id: null, evidence: [], fresh: false, exhausted: true, rearmable: false },
      { fingerprint: 'essai', status: 'AI_FAILED', relation: null, confidence: null, replacing_file_id: null, evidence: [], fresh: true, exhausted: false, rearmable: true },
      { fingerprint: 'vieux', status: 'PENDING', relation: null, confidence: null, replacing_file_id: null, evidence: [], fresh: false, exhausted: false, rearmable: true },
      { fingerprint: 'abstenu', status: 'ABSTAINED', relation: 'ABSTAIN', confidence: 'certain', replacing_file_id: null, evidence: [], fresh: false, exhausted: false, rearmable: true },
    ];
    const appels: string[] = [];
    const sql = { unsafe: async (q: string) => { appels.push(q); return lignes; } } as never;
    expect(await review.loadRelationStates(sql, 7, [10, 11])).toEqual([
      { fingerprint: 'epuise', state: 'FAILED', rearmable: true }, { fingerprint: 'bloque', state: 'FAILED' },
      { fingerprint: 'essai', state: 'AWAITING' }, { fingerprint: 'vieux', state: 'AWAITING', late: true },
      { fingerprint: 'abstenu', state: 'EXAMINED' },
    ]);
    expect(appels[0]).toContain(`attempts >= ${review.PERIOD_RELATION_MAX_ATTEMPTS}`);
    expect(appels[0]).toContain(`ai_calls < ${review.PERIOD_RELATION_MAX_TOTAL_CALLS}`);
  });
  it('réarmement borné : compte, événement, essais épuisés, total d’appels plafonné, un cycle par délai ; rien à réarmer : aucune requête', async () => {
    const appels: Array<{ q: string; p: unknown[] }> = [];
    const sql = { unsafe: async (q: string, p: unknown[]) => { appels.push({ q, p }); return [{ fingerprint: 'x' }]; } } as never;
    expect(await review.rearmFailedRelationReviews(sql, 7, 3, [])).toEqual([]);
    expect(appels).toEqual([]);
    expect(await review.rearmFailedRelationReviews(sql, 7, 3, ['x', 'x'])).toEqual(['x']);
    expect(appels[0].p).toEqual([7, 3, ['x']]);
    expect(appels[0].q).toMatch(/account_id = \$1 AND operation_id = \$2/);
    expect(appels[0].q).toMatch(/status = 'AI_FAILED'/);
    expect(appels[0].q).toContain(`ai_calls < ${review.PERIOD_RELATION_MAX_TOTAL_CALLS}`);
    expect(appels[0].q).toContain(`hours => ${review.REARM_AFTER_HOURS}`);
    expect(review.PERIOD_RELATION_MAX_TOTAL_CALLS).toBeGreaterThanOrEqual(review.PERIOD_RELATION_MAX_ATTEMPTS);
  });
});

describe('L114R-U-E08 — continuité d’un fait corrigé entre justificatifs', () => {
  const corrigee = e(1, 10, '2024-04-15', '2025-04-14', { userCorrected: true, correctedFrom: { start: '2024-04-01', end: '2025-03-31' } });
  it('l’autre justificatif porte encore la valeur d’avant correction : même fait, remplacé par la correction, sans question', () => {
    for (const paire of [[corrigee, e(2, 11, '2024-04-01', '2025-03-31')], [e(2, 9, '2024-04-01', '2025-03-31'), corrigee]]) {
      const r = res.resolvePeriods(paire);
      expect(r.entries.get(2)).toMatchObject({ status: 'REPLACED', byFileId: 10, basis: 'CORRECTED_SAME_FACT' });
      expect(r.entries.get(1)).toMatchObject({ status: 'ESTABLISHED' });
      expect([r.conflicts, r.uncertain]).toEqual([[], []]);
    }
  });
  it('jamais étendu à une période distincte, à une autre nature, ni depuis une ligne « non renseignée »', () => {
    // Autres bornes (facture mensuelle, autre année) : règles ordinaires.
    expect(res.classifyPair(corrigee, e(2, 11, '2025-04-15', '2026-04-14'), new Map()).relation).toBe('SUCCESSION');
    expect(res.classifyPair(corrigee, e(2, 11, '2024-05-01', '2025-04-30'), new Map()).relation).toBe('CONTRADICTION');
    expect(res.classifyPair(corrigee, { ...e(2, 11, '2024-04-01', '2025-03-31'), kind: 'BILLING' }, new Map()).relation).toBe('DIFFERENT_NATURE');
    // Valeur d'avant « non renseignée » : n'identifie aucun fait.
    const remplie = e(1, 10, '2024-04-01', '2025-03-31', { userCorrected: true, correctedFrom: { start: null, end: null } });
    expect(res.classifyPair(remplie, e(2, 11, null, null), new Map()).relation).toBe('UNDETERMINED');
    // Deux périodes corrigées de mêmes bornes (propagation) : un seul fait.
    expect(res.classifyPair(corrigee, { ...corrigee, id: 2, fileId: 11 }, new Map()).relation).toBe('SAME_FACT');
  });
  it('texte de la fiche (à valider par le PO)', () => {
    expect(svc.RESOLUTION_NOTES.USER_CORRECTION('Attestation 2024')).toBe('Remplacée par votre correction sur « Attestation 2024 »');
  });
});

describe('L114R-U-E02 — « aucun conflit » ≠ « résolution indisponible ou partielle »', () => {
  const periode = (file: number, kind: string, start: string | null, end: string | null, over: Record<string, unknown> = {}) =>
    ({ id: file * 10, file_id: file, period_kind: kind, segment_index: 0, start_on: start, end_on: end, end_open: false, principal_hint: false, user_locked: false, ...over });
  const resumes = [periode(1, 'COVERAGE', '2024-04-01', '2025-03-31'), periode(2, 'BILLING', '2025-02', '2025-02')];
  const estResumes = (q: string) => /FROM document_business_periods p\s+JOIN asset_files f/.test(q) && !/business_operation_documents/.test(q);
  const erreur = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

  it('décision de publication (pure) : couverture non validée omise avec sa cause ; autres natures publiées', () => {
    const summary = (fileId: number, kind: 'COVERAGE' | 'BILLING', line: string) => ({
      fileId, principal: { kind, line, segments: [{ id: fileId, kind, segment: 0, start: '2024-04-01', end: '2025-03-31', line, userCorrected: false }] }, secondary: [], billing: [],
    });
    const m2 = new Map([[1, summary(1, 'COVERAGE', 'Période couverte : du 01/04/2024 au 31/03/2025')], [2, summary(2, 'BILLING', 'Période facturée : du 01/04/2024 au 31/03/2025')]]);
    const ok = surf.dossierPeriodDecision(m2, { state: 'RESOLVED', settlements: new Map(), unvalidated: new Set(), cause: null });
    expect([...ok.lines.keys()]).toEqual([1, 2]);
    expect(ok.omitted).toEqual([]);
    const ko = surf.dossierPeriodDecision(m2, { state: 'UNAVAILABLE', settlements: new Map(), unvalidated: new Set([1, 2]), cause: 'READ_FAILED' });
    expect([...ko.lines.keys()]).toEqual([2]);
    expect(ko.omitted).toEqual([{ fileId: 1, cause: 'RESOLUTION_UNAVAILABLE' }]);
    expect(ko.resolution).toEqual({ state: 'UNAVAILABLE', cause: 'READ_FAILED' });
    const partiel = surf.dossierPeriodDecision(m2, { state: 'PARTIAL', settlements: new Map(), unvalidated: new Set([1]), cause: 'EVENT_LIMIT' });
    expect(partiel.omitted).toEqual([{ fileId: 1, cause: 'RESOLUTION_PARTIAL' }]);
    const conflit = surf.dossierPeriodDecision(m2, {
      state: 'RESOLVED', settlements: new Map([['1|2024-04-01|2025-03-31', { status: 'CONFLICT' as const, note: 'x' }]]), unvalidated: new Set(), cause: null,
    });
    expect(conflit.omitted).toEqual([{ fileId: 1, cause: 'CONFLICT' }]);
  });

  it.each([
    ['table absente (42P01)', erreur('relation "business_operation_documents" does not exist', '42P01'), 'TABLE_MISSING'],
    ['erreur SQL', erreur('syntax error at or near "x"', '42601'), 'READ_FAILED'],
    ['délai dépassé', erreur('canceling statement due to statement timeout', '57014'), 'READ_FAILED'],
  ] as const)('%s : UNAVAILABLE après un nouvel essai ; le dossier garde la pièce, sans période de couverture', async (_nom, e2, cause) => {
    let lectures = 0;
    base.repondre = (q) => { if (estResumes(q)) return resumes; lectures++; throw e2; };
    const journal = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await surf.coverageSettlements(7, [1, 2]);
    expect(r).toMatchObject({ state: 'UNAVAILABLE', cause });
    expect([...r.unvalidated]).toEqual([1, 2]);
    expect(lectures).toBe(2); // un nouvel essai, pas davantage
    const rapport = await surf.dossierPeriodReport(7, [1, 2]);
    expect([...rapport.lines.entries()]).toEqual([[2, 'Période facturée : février 2025']]);
    expect(rapport.omitted).toEqual([{ fileId: 1, cause: 'RESOLUTION_UNAVAILABLE' }]);
    expect([...(await surf.dossierPeriodLines(7, [1, 2])).keys()]).toEqual([2]);
    // Omission journalisée avec sa cause (aucun texte de période dans le journal).
    const traces = journal.mock.calls.map((c) => String(c[0]));
    expect(traces.some((t) => t.includes('"event":"dossier.period_omitted"') && t.includes(`"cause":"${cause}"`) && t.includes('"fileIds":[1]'))).toBe(true);
    expect(traces.join(' ')).not.toMatch(/Période couverte/);
    journal.mockRestore();
  });

  it('Assistant (T2) : la couverture non validée n’est pas dite ; la période facturée reste fournie', async () => {
    base.repondre = (q) => { if (estResumes(q)) return resumes; throw erreur('connexion perdue'); };
    const journal = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const textes = await surf.documentPeriodTexts(7, [1, 2]);
    expect([...textes.entries()]).toEqual([[2, 'Période facturée : février 2025']]);
    expect(journal.mock.calls.some((c) => String(c[0]).includes('"event":"assistant.period_omitted"'))).toBe(true);
    journal.mockRestore();
  });

  it('résolution lue : sans appartenance, aucun conflit possible → publiée ; lecture bornée → PARTIAL, documents non validés', async () => {
    base.repondre = (q) => (estResumes(q) ? resumes : []);
    const r = await surf.dossierPeriodReport(7, [1, 2]);
    expect([...r.lines.keys()]).toEqual([1, 2]);
    expect(r.resolution).toEqual({ state: 'RESOLVED', cause: null });
    // Plus de documents que la borne de lecture : ceux d'après ne sont pas validés.
    const beaucoup = Array.from({ length: surf.SURFACE_MAX_DOCUMENTS + 2 }, (_x, i) => i + 1);
    const journal = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q2 = await surf.coverageSettlements(7, beaucoup);
    expect(q2).toMatchObject({ state: 'PARTIAL', cause: 'DOCUMENT_LIMIT' });
    expect([...q2.unvalidated]).toEqual([surf.SURFACE_MAX_DOCUMENTS + 1, surf.SURFACE_MAX_DOCUMENTS + 2]);
    expect(journal.mock.calls.some((c) => String(c[0]).includes('"event":"business_period.resolution_partial"'))).toBe(true);
    journal.mockRestore();
  });
});

describe('L114R-U-E03 — durée indéterminée propagée par la lecture groupée', () => {
  it('même libellé que la fiche : « durée indéterminée » ≠ fin inconnue, sans borne inventée', async () => {
    const ligne = (file: number, over: Record<string, unknown>) => ({
      id: file, file_id: file, period_kind: 'COVERAGE', segment_index: 0, start_on: '2026-01-01', end_on: null, end_open: false, principal_hint: false, user_locked: false, ...over,
    });
    const appels: string[] = [];
    const runner = { unsafe: async (q: string) => { appels.push(q); return [ligne(1, { end_open: true }), ligne(2, {}), ligne(3, { start_on: null, end_open: true }), ligne(4, { period_kind: 'BILLING', end_open: true })]; } } as never;
    const r = await surf.readDocumentPeriodSummaries(7, [1, 2, 3, 4], runner);
    expect(appels[0]).toContain('p.end_open');
    expect(r.get(1)!.principal).toMatchObject({ line: 'Début de couverture : 01/01/2026 (durée indéterminée)', segments: [expect.objectContaining({ openEnded: true, end: null })] });
    expect(r.get(2)!.principal!.line).toBe('Début de couverture : 01/01/2026');
    expect(r.get(2)!.principal!.segments[0]).not.toHaveProperty('openEnded');
    expect(r.get(3)!.principal!.line).toBe('Période couverte : durée indéterminée');
    // Dépense : la période facturée porte la même information.
    expect(r.get(4)!.billing[0]).toMatchObject({ line: 'Début de la période facturée : 01/01/2026 (durée indéterminée)', openEnded: true });
    // Parité avec la fiche (même formateur).
    expect(r.get(1)!.principal!.line).toBe(lib.periodLine('COVERAGE', { start: '2026-01-01', end: null, openEnded: true }));
  });
});

describe('L114R-U-E09 — période facturée de LA dépense', () => {
  const jan = { id: 1, start: '2026-01-01', end: '2026-01-31' };
  const fev = { id: 2, start: '2026-02', end: '2026-02' };
  const mars = { id: 3, start: '2026-03-01', end: '2026-03-31' };
  it('une seule période sur le justificatif : c’est la sienne (inchangé) ; aucune : rien', () => {
    expect(lib.expenseBillingPeriods([jan], null)).toEqual({ periods: [jan], undetermined: false });
    expect(lib.expenseBillingPeriods([], { start: '2026-01-01', end: '2026-01-31' })).toEqual({ periods: [], undetermined: false });
  });
  it('facture récapitulative : seulement la période qui contient celle de la ligne ; jamais toutes', () => {
    expect(lib.expenseBillingPeriods([jan, fev, mars], { start: '2026-02-01', end: '2026-02-28' })).toEqual({ periods: [fev], undetermined: false });
    expect(lib.expenseBillingPeriods([jan, fev, mars], { start: '2026-03-10', end: null })).toEqual({ periods: [mars], undetermined: false });
  });
  it('lien non établi : incertitude, aucune association (ligne sans période, hors période, à cheval, ambiguë)', () => {
    const incertain = { periods: [], undetermined: true };
    expect(lib.expenseBillingPeriods([jan, fev], null)).toEqual(incertain);
    expect(lib.expenseBillingPeriods([jan, fev], { start: null, end: null })).toEqual(incertain);
    expect(lib.expenseBillingPeriods([jan, fev], { start: '2026-04-01', end: '2026-04-30' })).toEqual(incertain);
    expect(lib.expenseBillingPeriods([jan, fev], { start: '2026-01-15', end: '2026-02-15' })).toEqual(incertain);
    expect(lib.expenseBillingPeriods([jan, { id: 9, start: '2026-01', end: '2026-03' }], { start: '2026-01-10', end: '2026-01-20' })).toEqual(incertain);
    // Période du justificatif à borne manquante : ne « contient » rien de prouvé.
    expect(lib.expenseBillingPeriods([{ id: 1, start: '2026-01-01', end: null }, fev], { start: '2026-01-10', end: '2026-01-20' })).toEqual(incertain);
  });
  it('période propre lue là où T1 / T3 l’ont établie, bornée au compte ; formes inconnues ignorées', async () => {
    expect(['c:12', 'doc:5:44:0', 'doc:5:44:net', 'doc:5', 'asset:3:acquisitionPrice', 'c:1;DROP'].map(lib.expenseLineHasReadablePeriod)).toEqual([true, true, false, false, false, false]);
    const appels: Array<{ q: string; p: unknown[] }> = [];
    const runner = {
      unsafe: async (q: string, p: unknown[]) => {
        appels.push({ q, p });
        if (/business_operation_financial_components/.test(q)) return [{ id: 12, period_start: '2026-02-01', period_end: '2026-02-28' }, { id: 13, period_start: null, period_end: null }];
        return [
          { id: 44, file_id: 5, payload: { financialHints: [{ periodStart: '2026-01-01', periodEnd: '2026-01-31' }, { amountMinor: 100 }] } },
          { id: 45, file_id: 6, payload: JSON.stringify({ financialHints: [{ periodStart: '2026-03-01T00:00:00Z', periodEnd: null }] }) },
        ];
      },
    } as never;
    const r = await surf.readExpenseLinePeriods(7, ['c:12', 'c:13', 'doc:5:44:0', 'doc:5:44:1', 'doc:5:45:0', 'doc:6:45:0', 'doc:5:44:net', 'asset:3:x'], runner);
    expect([...r.entries()]).toEqual([
      ['c:12', { start: '2026-02-01', end: '2026-02-28' }], ['doc:5:44:0', { start: '2026-01-01', end: '2026-01-31' }], ['doc:6:45:0', { start: '2026-03-01', end: null }],
    ]);
    expect(appels).toHaveLength(2);
    for (const a of appels) { expect(a.q).toMatch(/account_id = \$1/); expect(a.p[0]).toBe(7); }
    // Aucune ligne lisible : aucune requête.
    appels.length = 0;
    expect((await surf.readExpenseLinePeriods(7, ['doc:5', 'asset:3:x'], runner)).size).toBe(0);
    expect(appels).toEqual([]);
  });
});

describe('L114R-U-E12 — création d’une nature : pertinence contrôlée côté service', () => {
  const pertinence = (v: string) => fait(90, 'period.relevance', v);
  const facture = (typeHint: string) => ({ candidateKey: 'op1', established: true, confidence: 'certain', typeHint, payload: { sourceRoleHint: 'INVOICE', temporalHints: {}, financialHints: [] } });
  it('contrat v2 : connue / inconnue / indéterminée → permise ; non pertinente → refusée', () => {
    const inputs = { candidates: [], facts: [pertinence('coverage=known;warranty=unknown;billing=not_relevant;validity=undetermined')], billing: SANS_FACTURATION };
    expect(svc.creationAllowed('COVERAGE', inputs)).toBe(true);
    expect(svc.creationAllowed('WARRANTY', inputs)).toBe(true);
    expect(svc.creationAllowed('VALIDITY', inputs)).toBe(true);
    expect(svc.creationAllowed('SERVICE', inputs)).toBe(true); // absente du fait : indéterminée
    expect(svc.creationAllowed('BILLING', inputs)).toBe(false);
  });
  it('document non qualifié : seulement ce que les règles déterministes tiennent pour pertinent (achat ponctuel : aucun champ)', () => {
    const achat = { candidates: [facture('ACQUISITION')], facts: [], billing: SANS_FACTURATION };
    for (const k of lib.BUSINESS_PERIOD_KINDS) expect(svc.creationAllowed(k, achat)).toBe(false);
    const echeance = { candidates: [facture('CONTRACT')], facts: [], billing: SANS_FACTURATION };
    expect(svc.creationAllowed('BILLING', echeance)).toBe(true);
    expect(svc.creationAllowed('WARRANTY', echeance)).toBe(false);
  });
});

describe('L114R-U-E04 — durée indéterminée et date de fin', () => {
  it('les deux à la fois : refus avant toute lecture ou écriture', async () => {
    expect(await svc.correctDocumentPeriod(7, 1, 5, { periodId: 3, start: '2026-01-01', end: '2026-12-31', openEnded: true })).toEqual({ ok: false, error: 'INVALID_DATES' });
    expect(base.appels).toEqual([]);
  });
});

describe('L114R-U-E11 — détail des périodes rattaché à « Notes / Description », jamais écrit dans les notes', () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
  it('tiroir du document : le détail suit la zone « Notes / Description » ; le bloc principal ne porte plus le détail', () => {
    const tiroir = lire('src/components/assets/DocumentDrawer.tsx');
    const notes = tiroir.indexOf('data-testid="document-notes-description"');
    const detail = tiroir.indexOf('<DocumentPeriodsDetail');
    const principal = tiroir.indexOf('<DocumentBusinessPeriodField');
    expect(principal).toBeGreaterThan(0);
    expect(notes).toBeGreaterThan(principal);
    expect(detail).toBeGreaterThan(notes);
    // Une seule lecture des périodes pour les deux blocs.
    expect(tiroir.match(/useDocumentPeriods\(/g)).toHaveLength(1);
    const composant = lire('src/components/documents/BusinessPeriods.tsx');
    const bloc = composant.slice(composant.indexOf('export function DocumentBusinessPeriodField'), composant.indexOf('export function DocumentPeriodsDetail'));
    expect(bloc).not.toContain('view.secondary.map');
    expect(bloc).not.toContain('p.segments.map');
    const sousSection = composant.slice(composant.indexOf('export function DocumentPeriodsDetail'), composant.indexOf("// ── Tiroir d'un élément d'agenda"));
    expect(sousSection).toContain('PERIOD_DETAIL_TITLE');
    expect(sousSection).toContain('view.secondary.map');
    expect(sousSection).toContain('data-testid="document-periods-detail"');
  });
  it('lecture seule des notes : le composant des périodes n’écrit ni ne lit les notes ; l’enregistrement des notes ignore les périodes', () => {
    const composant = lire('src/components/documents/BusinessPeriods.tsx');
    expect(composant).not.toMatch(/notesDescription|notes:|description:/);
    // La seule écriture du composant est la correction du fait de période.
    expect([...composant.matchAll(/apiClient\.(put|post|patch|delete)\(`([^`]+)`/g)].map((x) => x[2])).toEqual(['/api/documents/${fileId}/periodes']);
    const tiroir = lire('src/components/assets/DocumentDrawer.tsx');
    const ecriture = tiroir.slice(tiroir.indexOf('const ecritureNotes = notesWriteFromEdit'), tiroir.indexOf('const ecritureNotes = notesWriteFromEdit') + 1500);
    expect(ecriture).not.toMatch(/periodesDocument|PERIOD_DETAIL_TITLE|periodLine/);
  });
  it('un seul parcours d’édition : la durée indéterminée est dans l’éditeur existant', () => {
    const composant = lire('src/components/documents/BusinessPeriods.tsx');
    expect(composant.match(/function PeriodEditor\(/g)).toHaveLength(1);
    expect(composant).toContain('PERIOD_OPEN_ENDED_LABEL');
    expect(composant).toContain('openEnded: end === null ? indeterminee : false');
  });
});

describe('L114R-U-R04 — facture traversant deux mois, bornes partielles, périodes discontinues (R04, R10, R11)', () => {
  const facture = { candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'CONTRACT', payload: { sourceRoleHint: 'INVOICE', temporalHints: {}, financialHints: [] } };
  it('R04 — du 15/01 au 14/02 : dates exactes conservées (aucun arrondi au mois), par le fait T1 comme par la règle de nommage', () => {
    const parFait = derive({ facts: [fait(1, 'period.billing', '2026-01-15/2026-02-14')] });
    expect(parFait.map((x) => lib.periodLine(x.kind, x))).toEqual(['Période facturée : du 15/01/2026 au 14/02/2026']);
    const parNommage = derive({ candidates: [facture], billing: { billedPeriod: { start: '2026-01-15', end: '2026-02-14', source: 'T1_COST_PERIOD' }, statedMonth: null, hasBillingBlock: false } });
    expect(parNommage).toEqual([expect.objectContaining({ kind: 'BILLING', start: '2026-01-15', end: '2026-02-14', basis: 'T1_COST_PERIOD' })]);
    // Le modèle ne reçoit jamais le titre du document : la période n'en dépend pas (aucune entrée « titre »).
    expect(Object.keys({ candidates: [], facts: [], billing: SANS_FACTURATION })).toEqual(['candidates', 'facts', 'billing']);
  });
  it('R10 — début seul, fin seule, mois seul ; R11 — périodes discontinues : jamais de période globale fabriquée', () => {
    const d = derive({ facts: [fait(1, 'period.billing', '2026-01-15/'), fait(2, 'period.validity', '/2026-06-30'), fait(3, 'period.warranty', '2026-03')] });
    expect(d.map((x) => lib.periodLine(x.kind, x))).toEqual(['Fin de validité : 30/06/2026', 'Période de garantie : mars 2026', 'Début de la période facturée : 15/01/2026']);
    const q = derive({ facts: [fait(1, 'period.billing', '2026-01-01/2026-01-31'), fait(2, 'period.billing', '2026-03-01/2026-03-31')] });
    expect(q.map((x) => [x.segment, x.start, x.end])).toEqual([[0, '2026-01-01', '2026-01-31'], [1, '2026-03-01', '2026-03-31']]);
    expect(lib.principalLine('BILLING', q)).toBe('Plusieurs périodes concernées');
  });
});

describe('L114R-U-TEXTES — textes nouveaux', () => {
  it('jamais « Opération » ; durée indéterminée distincte de « non renseignée »', () => {
    const textes = [lib.PERIOD_OPEN_ENDED_LABEL, lib.PERIOD_NOT_RELEVANT_MESSAGE, lib.PERIOD_DETAIL_TITLE, lib.EXPENSE_PERIOD_UNDETERMINED, svc.RESOLUTION_NOTES.USER_CORRECTION('x')];
    expect(textes.join(' ')).not.toMatch(/Opération/i);
    expect(lib.PERIOD_OPEN_ENDED_LABEL).not.toContain(lib.NOT_PROVIDED_LABEL);
  });
});
