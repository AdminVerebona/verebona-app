/**
 * Lot 53 (53F) — retours PO D21, D22, Q24 sur l'assistant T2 (lot 49).
 *
 *   D21  clarification : un service, plusieurs biens, des périodes ; la
 *        clarification entraîne un traitement ultérieur correct ; limites de
 *        la règle « un appel IA par question » ; jamais un total élargi.
 *   D22  analyse CONTEXTUELLE de l'ambiguïté (homographes verbe / nom) au
 *        lieu d'une liste fermée de mots exclus : faux positifs et faux
 *        négatifs de clarification.
 *   Q24  question de clarification contextuelle (« De quel contrat ou service
 *        parlez-vous ? ») plutôt que le message générique quand le contexte
 *        le permet.
 *
 * Orchestrateur RÉEL (`runAssistant`), résolution RÉELLE des cibles, sources
 * métier construites par le fournisseur RÉEL (`operationBusinessSource`) à
 * partir d'opérations en mémoire ; UNDERSTAND simulé et compté.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const H = await import('../lot29/harness');
const { operationBusinessSource, answerFromBusinessSource } = await import('../../../canonical/business-sources');
const { semanticResidue, roleGrammatical, tokensOf, contextualQuestion, selectInterpretations } = await import('../../semantic-scope');
const { toIntentRoute } = await import('../../classification.adapter');
const { inputDeReprise } = await import('../../clarification.service');
const { answerFromData } = await import('../../data-answer.service');
const { aujourdhuiParis } = await import('../../query-period');

type Op = import('../../../canonical/operations').AssistantOperationRead;
type Source = import('../../semantic-scope').BusinessSource;
type Route = import('../../../types/contracts').IntentRoute;
type Port = import('../../data-answer.service').AccountDataPort;
type RunResult = import('../../../types/contracts').AssistantRunResult;

const n = (t: string | undefined) => (t ?? '').replace(/[  ]/g, ' ');

// ── Fixtures ────────────────────────────────────────────────────────────────

let nextId = 1000;
function op(p: Partial<Op> & { assetIds: number[] }): Op {
  return {
    id: nextId++, accountId: 1, typeCode: 'CONTRACT', status: 'REALIZED', technicalLabel: null, parentOperationId: null, provider: null,
    plannedDate: null, startDate: null, realizedDate: null, endDate: null, closedAt: null, invalidatedAt: null, invalidationReason: null,
    mergedIntoOperationId: null, lastReconciledAt: null, version: 1, active: true, contractReference: null, effectiveFrom: null, effectiveTo: null,
    claimStatus: null, claimType: null, insurerClaimRef: null, declaredOn: null, components: [], documents: [], sourceKinds: ['DOCUMENT'],
    ...p,
  } as Op;
}
const cout = (cents: number, date: string) => ({ id: nextId++, kind: 'REALIZED_COST' as const, amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: date, targetAssetId: null, label: null });

const MAISON = { id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' };
const APPART = { id: 4, name: 'Appartement Lyon', category: 'IMMOBILIER', subtype: 'Appartement' };
const ANNEE = Number(aujourdhuiParis().slice(0, 4));

/** Fibre Orange : deux montants en 2025 (avril, novembre), un en septembre 2026, et un en mars des deux dernières années. */
const orange = (assetId: number, cents = 3999) => op({
  assetIds: [assetId], technicalLabel: 'Abonnement Orange Fibre', provider: 'Orange',
  components: [cout(3499, '2025-04-02'), cout(3499, '2025-11-02'), cout(cents, '2026-09-02'), cout(3799, `${ANNEE}-03-02`), cout(3599, `${ANNEE - 1}-03-15`)],
});
const netflix = (a = 3) => op({ assetIds: [a], technicalLabel: 'Abonnement Netflix', provider: 'Netflix', components: [cout(1349, '2026-09-10')] });
const edf = (a = 3) => op({ assetIds: [a], technicalLabel: 'Électricité', provider: 'EDF', components: [cout(8500, '2026-09-15')] });
const navigo = (a = 3) => op({ assetIds: [a], technicalLabel: 'Pass Navigo annuel', provider: 'RATP', components: [cout(8640, '2026-01-05')] });
const sfrBox = (a = 3) => op({ assetIds: [a], technicalLabel: 'Box SFR', provider: 'SFR', components: [cout(2999, '2026-09-03')] });

function harness(assets: Array<typeof MAISON>, ops: Op[], o: { understand?: Route | null; plan?: string } = {}) {
  const h = H.harness(H.account({ assets }), { understand: o.understand ?? null });
  const nom = (id: number | null) => assets.find((a) => a.id === id)?.name ?? null;
  const sourcesOf = (ids: number[]): Source[] => ops
    .filter((x) => !ids.length || x.assetIds.some((a) => ids.includes(a)))
    .map((x) => { const a = x.assetIds.find((y) => ids.includes(y)) ?? x.assetIds[0] ?? null; return operationBusinessSource(x, a, nom(a)); });
  const list = vi.fn(async (_acc: number, req: { assetIds: number[] }) => ({ sources: sourcesOf(req.assetIds), domains: ['operation'] }));
  const read = vi.fn(async (_acc: number, ref: string, ctx: { assetIds: number[] }) => sourcesOf(ctx.assetIds).find((s) => s.ref === ref) ?? null);
  h.ports.listBusinessSources = list;
  h.ports.readBusinessSource = read;
  const ask = (message: string, extra = {}) => h.ask(message, { planType: o.plan ?? 'PREMIUM', ...extra });
  return { ...h, ask, list, read };
}

function compris(hints: Array<{ type: string; value: string }>, topics: string[], intent = 'ACCOUNT_FACT_ASSET'): Route {
  return { ...toIntentRoute({ intent, confidence: 'probable', entityHints: hints as never, reason: 'test' }, 'PREMIUM'), understanding: { requestedFacts: [], requestedTopics: topics, filters: {} } };
}
const INTERNET_MAISON = compris([{ type: 'asset', value: 'maison' }], ['internet', 'fibre', 'box internet']);

/** Reprise après clarification (choix de l'utilisateur), comme l'API la construit. */
function reprendre(r: RunResult, choisir: (c: { label: string; secondaryLabel?: string }) => boolean) {
  const etat = r.clarification!;
  const choix = etat.candidates.find(choisir)!;
  expect(choix).toBeTruthy();
  return inputDeReprise({ accountId: 1, userId: 7, planType: 'PREMIUM', locale: 'fr-FR' }, { ...etat, conversationId: 99 }, choix);
}

// ══════════════════════════════════════════════════════════════════════════
// D21 — qualité de la clarification, traitement ultérieur, un appel IA
// ══════════════════════════════════════════════════════════════════════════

describe('PO D21 — service, plusieurs biens, périodes', () => {
  it('PO-D21-01 — un service (« internet ») sur un bien : montant CIBLÉ, un seul appel IA, aucune génération', async () => {
    const h = harness([MAISON], [orange(3), netflix(), edf()], { understand: INTERNET_MAISON });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.generate).not.toHaveBeenCalled();
    expect(r.clarification).toBeNull();
    expect(n(r.answer)).toMatch(/^Contrat « Abonnement Orange Fibre » \(Maison\) : dernier montant documenté/);
    expect(r.answer).not.toMatch(/13,49|85,00|Netflix|EDF/);
  });

  it('PO-D21-02 — plusieurs biens sans bien nommé : clarification dont les choix sont distingués par le BIEN (un seul appel IA)', async () => {
    const h = harness([MAISON, APPART], [orange(3), orange(4, 2999), netflix()], { understand: compris([], ['internet', 'fibre']) });
    const r = await h.ask('Je paye combien pour internet ?');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.generate).not.toHaveBeenCalled();
    expect(r.clarification?.question).toBe('De quel contrat parlez-vous ?');
    const choix = r.clarification!.candidates;
    expect(choix).toHaveLength(2);
    expect(choix.map((c) => c.secondaryLabel?.split(' · ')[0]).sort()).toEqual(['Appartement Lyon', 'Maison']);
    expect(r.cascade?.semantic).toMatchObject({ trigger: 'classified_scope', understandCalled: false, clarificationReason: 'SEMANTIC_MULTIPLE_INTERPRETATIONS' });
    expect(r.answer).not.toMatch(/rien trouvé/);
  });

  it('PO-D21-03 — reprise après le choix du bien : réponse sur CE bien, aucun appel IA', async () => {
    const h = harness([MAISON, APPART], [orange(3), orange(4, 2999)], { understand: compris([], ['internet', 'fibre']) });
    const r = await h.ask('Je paye combien pour internet ?');
    const reprise = reprendre(r, (c) => (c.secondaryLabel ?? '').startsWith('Appartement Lyon'));
    h.classify.mockClear();
    const suite = await h.ask(reprise.message, reprise);
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(n(suite.answer)).toMatch(/^Contrat « Abonnement Orange Fibre » \(Appartement Lyon\) : dernier montant documenté 29,99 €/);
    expect(suite.answer).not.toMatch(/Maison/);
  });

  it('PO-D21-04 — période « en 2025 » : total de la PÉRIODE seulement, jamais le total de toute la durée', async () => {
    const h = harness([MAISON], [orange(3)], { understand: INTERNET_MAISON });
    const r = await h.ask('Combien ai-je payé pour internet en 2025 à la maison ?');
    expect(h.classify).toHaveBeenCalledTimes(1);
    const attendu = 3499 + 3499 + (ANNEE - 1 === 2025 ? 3599 : 0) + (ANNEE === 2025 ? 3799 : 0);
    const nb = 2 + (ANNEE - 1 === 2025 ? 1 : 0) + (ANNEE === 2025 ? 1 : 0);
    expect(n(r.answer)).toContain(`total documenté ${(attendu / 100).toFixed(2).replace('.', ',')} € sur l’année 2025 (${nb} montants`);
    expect(r.answer).not.toMatch(/39,99/);
  });

  it('PO-D21-05 — période sans montant (« en 2019 ») : absence dite, aucun montant d’une autre période', async () => {
    const h = harness([MAISON], [orange(3)], { understand: INTERNET_MAISON });
    const r = await h.ask('Combien ai-je payé pour internet en 2019 à la maison ?');
    expect(r.answer).toBe('Contrat « Abonnement Orange Fibre » (Maison) : aucun montant documenté sur l’année 2019.');
    expect(r.answer).not.toMatch(/€/);
  });

  it('PO-D21-06 — mois sans année : clarification de période, puis la reprise reste dans le périmètre sémantique', async () => {
    const h = harness([MAISON], [orange(3), netflix()], { understand: INTERNET_MAISON });
    const r = await h.ask('Je paye combien pour internet en mars à la maison ?');
    expect(r.clarification?.ambiguity?.kind).toBe('period');
    const annee = ANNEE - 1;
    const reprise = reprendre(r, (c) => c.label === `Mars ${annee}`);
    expect(reprise.message).toContain(`mars ${annee}`);
    const suite = await h.ask(reprise.message, reprise);
    // Seul le montant de mars de l'année choisie (35,99 €), ni ceux des autres mois, ni Netflix.
    expect(n(suite.answer)).toMatch(new RegExp(`^Contrat « Abonnement Orange Fibre » \\(Maison\\) : 35,99 € documenté sur mars ${annee}`));
    expect(suite.answer).not.toMatch(/Netflix|13,49|39,99/);
    expect(suite.cascade?.semantic?.trigger).toBe('weak_route');
  });

  it('PO-D21-07 — limite « un appel IA » : UNDERSTAND déjà utilisé n’est jamais rappelé ; sans IA, aucun élargissement', async () => {
    // Classification + étape sémantique : 1 appel au total.
    const h = harness([MAISON, APPART], [orange(3), orange(4, 2999)], { understand: compris([], ['internet', 'fibre']) });
    await h.ask('Je paye combien pour internet ?');
    expect(h.llmCalls()).toBe(1);
    // Offre sans IA : aucun appel, jamais une somme de tout le bien.
    const s = harness([MAISON], [orange(3), netflix(), edf()], { plan: 'STANDARD' });
    const r = await s.ask('Je paye combien pour internet à la maison ?');
    expect(s.llmCalls()).toBe(0);
    expect(r.answer).not.toMatch(/13,49|85,00|Netflix|EDF/);
  });

  it('PO-D21-08 — limite : deux services dans la même question → clarification (une interprétation par réponse), jamais une somme', async () => {
    const h = harness([MAISON], [orange(3), edf(), netflix()], { understand: compris([{ type: 'asset', value: 'maison' }], ['internet', 'fibre', 'électricité']) });
    const r = await h.ask('Je paye combien pour internet et l’électricité à la maison ?');
    expect(h.llmCalls()).toBe(1);
    expect(r.clarification?.candidates.map((c) => c.label).sort()).toEqual(['Contrat « Abonnement Orange Fibre »', 'Contrat « Électricité »']);
    expect(r.answer).not.toMatch(/€/);
  });

  it('PO-D21-09 — sélection : une pièce datée hors de la période demandée n’est pas une interprétation', () => {
    const doc = (id: number, date: string): Source => ({ ref: `document:${id}`, domain: 'document', label: `Facture fibre ${date}`, detail: null, text: 'Facture fibre', assetId: 3, amountCents: 3999, date });
    const besoin = { terms: ['fibre'], facts: [], need: 'amount' as const };
    expect(selectInterpretations([doc(1, '2024-05-02'), doc(2, '2025-05-02')], besoin, { period: { from: '2025-01-01', to: '2025-12-31' } }).selected.map((s) => s.ref)).toEqual(['document:2']);
    expect(selectInterpretations([doc(1, '2024-05-02'), doc(2, '2025-05-02')], besoin).selected).toHaveLength(2);
    // Réponse d'une opération sans période : comportement lot 49 inchangé.
    const s = operationBusinessSource(orange(3), 3, 'Maison');
    expect(n(answerFromBusinessSource(s, 'amount', { assetName: 'Maison' }).text)).toMatch(/dernier montant documenté .* ; total documenté/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// D22 — analyse contextuelle au lieu d'une liste fermée de mots
// ══════════════════════════════════════════════════════════════════════════

describe('PO D22 — homographes : le contexte décide (faux positifs / faux négatifs)', () => {
  it('PO-D22-01 — faux négatifs corrigés : employé comme NOM, le mot est un sujet (→ compréhension / clarification)', () => {
    expect(semanticResidue('Je paye combien pour le passe de la maison ?', { assetNames: ['Maison'] })).toEqual(['passe']);
    expect(semanticResidue('Je paye combien pour le lieu de répétition ?')).toEqual(['lieu', 'repetition']);
    // « lieu de stockage » est une formulation du REGISTRE (champ storageLocation) : lue comme un champ, pas un résidu.
    expect(semanticResidue('Quel est le lieu de stockage du vélo ?')).not.toContain('lieu');
    expect(semanticResidue('Quand finit mon passe Navigo ?')).toEqual(['passe', 'navigo']);
  });

  it('PO-D22-02 — faux positifs évités : verbe ou locution, le mot n’est pas un sujet (réponse directe conservée)', () => {
    expect(semanticResidue('Combien vaut ma maison ?', { assetNames: ['Maison'] })).toEqual([]);
    expect(semanticResidue('Quand a lieu le contrôle technique de la Polo ?', { assetNames: ['Polo'] })).toEqual([]);
    expect(semanticResidue('Quand aura-t-il lieu pour la Polo ?', { assetNames: ['Polo'] })).toEqual([]);
    expect(semanticResidue('Combien je paye pour ce qui concerne la fibre de la maison ?', { assetNames: ['Maison'] })).toEqual(['fibre']);
    expect(semanticResidue('Combien ai-je payé pour internet l’an passé à la maison ?', { assetNames: ['Maison'] })).toEqual(['internet']);
    // « passée » (féminin) n'était pas dans l'ancienne liste : c'était un faux positif.
    expect(semanticResidue('Combien ai-je payé pour la fibre la semaine passée à la maison ?', { assetNames: ['Maison'] })).toEqual(['fibre']);
    expect(semanticResidue('Combien je paye au lieu de l’ancien tarif pour la fibre ?')).toEqual(['ancien', 'fibre']);
  });

  it('PO-D22-03 — rôle grammatical (pure) : déterminant → nom ; sinon verbe / locution', () => {
    const r = (q: string, w: string) => { const t = tokensOf(q); return roleGrammatical(t, t.indexOf(w)); };
    expect(r('le lieu du sinistre', 'lieu')).toBe('nom');
    expect(r('quel lieu', 'lieu')).toBe('nom');
    expect(r('ca a lieu quand', 'lieu')).toBe('grammatical');
    expect(r('au lieu de payer', 'lieu')).toBe('grammatical');
    expect(r('ce qui se passe', 'passe')).toBe('grammatical');
    expect(r('mon passe', 'passe')).toBe('nom');
    expect(r('combien vaut la maison', 'vaut')).toBe('grammatical');
  });

  it('PO-D22-04 — orchestrateur : « le passe de la maison » n’est plus servi par le PRIX D’ACHAT (faux négatif du lot 49)', async () => {
    const h = harness([MAISON], [navigo(), orange(3)], { understand: compris([{ type: 'asset', value: 'maison' }], ['passe', 'pass navigo']) });
    const calls: string[] = [];
    const port = fakePort(calls);
    h.ports.answerFromData = (route, input, thresholds) => answerFromData({ port, accountId: 1, message: input.message, thresholds, intent: route.intent });
    const r = await h.ask('Je paye combien pour le passe de la maison ?');
    expect(calls).not.toContain('readAcquisition');
    expect(r.answer).not.toMatch(/300 000|prix d.achat/i);
    expect(n(r.answer)).toMatch(/^Contrat « Pass Navigo annuel » \(Maison\) : dernier montant documenté 86,40 €/);
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

  it('PO-D22-05 — orchestrateur : question claire avec homographe verbal → aucune clarification, aucun appel IA', async () => {
    const h = harness([MAISON], [orange(3), netflix()]);
    const calls: string[] = [];
    const port = fakePort(calls);
    h.ports.answerFromData = (route, input, thresholds) => answerFromData({ port, accountId: 1, message: input.message, thresholds, intent: route.intent });
    const r = await h.ask('Combien je paye pour ce qui concerne la maison ?');
    expect(h.classify).not.toHaveBeenCalled();
    expect(r.clarification).toBeNull();
    // Comportement C15.2 / T2SEM-AC17 conservé (« pour la maison » = prix d'achat).
    expect(calls).toContain('readAcquisition');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Q24 — clarification contextuelle plutôt que le message générique
// ══════════════════════════════════════════════════════════════════════════

describe('PO Q24 — « De quel contrat ou service parlez-vous ? »', () => {
  it('PO-Q24-01 — aucun libellé ne correspond mais le bien porte plusieurs contrats : question contextuelle, choix issus des données', async () => {
    const h = harness([MAISON], [sfrBox(), netflix(), edf()], { understand: compris([{ type: 'asset', value: 'maison' }], ['internet']) });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(r.clarification?.question).toBe('Je n’ai trouvé aucun élément mentionnant « internet » pour Maison. De quel contrat ou service parlez-vous ?');
    expect(r.clarification?.candidates.map((c) => c.label)).toEqual(['Contrat « Box SFR »', 'Contrat « Abonnement Netflix »', 'Contrat « Électricité »']);
    expect(r.answer).not.toMatch(/€/);
    expect(r.cascade?.semantic).toMatchObject({ clarificationReason: 'SEMANTIC_NO_MATCH_CONTEXTUAL', fallbackReason: 'NO_MATCHING_SOURCE' });
  });

  it('PO-Q24-02 — la réponse de l’utilisateur entraîne le bon traitement (source choisie relue, aucun appel IA)', async () => {
    const h = harness([MAISON], [sfrBox(), netflix(), edf()], { understand: compris([{ type: 'asset', value: 'maison' }], ['internet']) });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    const reprise = reprendre(r, (c) => c.label.includes('SFR'));
    h.classify.mockClear();
    const suite = await h.ask(reprise.message, reprise);
    expect(h.classify).not.toHaveBeenCalled();
    expect(n(suite.answer)).toBe('Contrat « Box SFR » (Maison) : dernier montant documenté 29,99 € (3 septembre 2026).');
  });

  it('PO-Q24-03 — un seul contrat candidat : jamais servi à la place de la demande, message d’absence', async () => {
    const h = harness([MAISON], [netflix()], { understand: compris([{ type: 'asset', value: 'maison' }], ['internet']) });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(r.clarification).toBeNull();
    expect(r.supportLevel).toBe('insufficient');
    expect(r.answer).toBe('Je n’ai trouvé aucune donnée sur « internet » pour Maison qui réponde précisément à votre question. '
      + 'Je préfère ne pas vous donner un total plus large qui n’y répondrait pas : précisez le contrat, le service ou le document concerné.');
  });

  it('PO-Q24-04 — sans bien unique, pas de liste de tous les contrats du compte (question non contextualisable)', async () => {
    const h = harness([MAISON, APPART], [netflix(3), edf(4), sfrBox(4)], { understand: compris([], ['internet']) });
    const r = await h.ask('Je paye combien pour internet ?');
    expect(r.clarification).toBeNull();
    expect(r.answer).not.toMatch(/€/);
  });

  it('PO-Q24-05 — formulation (pure) : contrats → « De quel contrat ou service… » ; autres types → question du type', () => {
    const c = operationBusinessSource(sfrBox(), 3, 'Maison');
    const i = operationBusinessSource(op({ assetIds: [3], typeCode: 'INTERVENTION', technicalLabel: 'Ramonage', components: [cout(9000, '2026-02-01')] }), 3, 'Maison');
    const i2 = operationBusinessSource(op({ assetIds: [3], typeCode: 'INTERVENTION', technicalLabel: 'Élagage', components: [cout(15000, '2026-03-01')] }), 3, 'Maison');
    expect(contextualQuestion(['internet'], [c, c], 'Maison')).toBe('Je n’ai trouvé aucun élément mentionnant « internet » pour Maison. De quel contrat ou service parlez-vous ?');
    expect(contextualQuestion(['toit'], [i, i2], 'Maison')).toBe('Je n’ai trouvé aucun élément mentionnant « toit » pour Maison. De quelle intervention parlez-vous ?');
    expect(contextualQuestion(['x'], [c, i], null)).toBe('Je n’ai trouvé aucun élément mentionnant « x ». Plusieurs éléments correspondent à votre question. Lequel voulez-vous consulter ?');
  });
});

function fakePort(calls: string[]): Port {
  const maison = { id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison', purchaseDate: null, isRented: false };
  return {
    today: () => '2026-10-12',
    findAssets: async (_a, words) => (words.some((w) => /maison/.test(w)) ? [{ ...maison, matched: 1 }] : []),
    listAssets: async () => [maison],
    countDocuments: async () => 0, countAgenda: async () => 0, upcomingAgenda: async () => [],
    sumDocumentAmounts: async () => { calls.push('sumDocumentAmounts'); return { sumCents: 999999, count: 9 }; },
    searchFacts: async () => [], searchDocuments: async () => [],
    readAcquisition: async () => { calls.push('readAcquisition'); return { operationId: 1, priceCents: 30000000, foreign: [], date: null, provider: null, source: null }; },
    readPayments: async () => { calls.push('readPayments'); return { proofs: [], sumCents: 0, withoutAmount: 0 }; },
    readOperationCosts: async () => { calls.push('readOperationCosts'); return []; },
    sumQualifiedExpenses: async () => { calls.push('sumQualifiedExpenses'); return { qualifiedSumCents: 0, complete: true, byTheme: [], unqualified: { count: 0, sumCents: 0 }, excluded: { count: 0 }, duplicates: { count: 0 } } as never; },
  };
}
