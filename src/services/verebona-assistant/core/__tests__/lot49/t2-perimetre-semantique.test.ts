/**
 * Lot 49 — ticket 3 : « T2 : réduire le routage déterministe et laisser
 * l'IA gérer les ambiguïtés métier ».
 *
 * Orchestrateur RÉEL (`runAssistant`), résolution des cibles RÉELLE
 * (`resolveAssistantTargets`), sélection RÉELLE des interprétations
 * (`selectInterpretations`) sur des sources métier construites par le
 * fournisseur RÉEL (`operationBusinessSource`) à partir d'opérations en
 * mémoire ; UNDERSTAND simulé (compteur d'appels modèle).
 *
 * AUCUNE règle lexicale « internet → Orange », « contrat → LLD » : les
 * réponses ne dépendent que des DONNÉES exposées et des sujets compris.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const H = await import('../lot29/harness');
const { operationBusinessSource } = await import('../../../canonical/business-sources');
const { routeDeterministic } = await import('../../intent-router.service');
const { semanticResidue, selectInterpretations, detectValueNeed, semanticQuestion } = await import('../../semantic-scope');
const { tryCanonicalStructured } = await import('../../../canonical/structured-answers');
const { answerFromData } = await import('../../data-answer.service');
const { DEFAULT_THRESHOLDS } = await import('../../sufficiency');
const { inputDeReprise } = await import('../../clarification.service');
const { toIntentRoute } = await import('../../classification.adapter');

type Op = import('../../../canonical/operations').AssistantOperationRead;
type Source = import('../../semantic-scope').BusinessSource;
type Port = import('../../data-answer.service').AccountDataPort;
type Route = import('../../../types/contracts').IntentRoute;

/** Espaces insécables (format monétaire fr-FR) ramenés à des espaces simples. */
const n = (t: string | undefined) => (t ?? '').replace(/[\u202f\u00a0]/g, ' ');

// ── Fixtures ────────────────────────────────────────────────────────────────

let nextId = 100;
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
const doc = (fileId: number, title: string) => ({ fileId, role: 'INVOICE' as const, title, date: '2026-09-02', amountCents: null, documentTypeCode: 'SUBSCRIPTION_INVOICE' });

const CUPRA = { id: 7, name: 'Cupra', category: 'VEHICULE', subtype: 'Voiture' };
const MAISON = { id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' };
const lld = () => op({ assetIds: [7], technicalLabel: 'LLD Cupra Formentor', provider: 'Leasys', effectiveFrom: '2024-07-01', effectiveTo: '2027-06-30' });
const assurance = () => op({ assetIds: [7], technicalLabel: 'Assurance auto', provider: 'MAAF', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' });
const entretien = () => op({ assetIds: [7], typeCode: 'INTERVENTION', status: 'REALIZED', technicalLabel: 'Révision 30 000 km', provider: 'Garage', realizedDate: '2026-03-01', components: [cout(32000, '2026-03-01')] });
const orangeFibre = () => op({ assetIds: [3], technicalLabel: 'Abonnement Orange Fibre', provider: 'Orange', documents: [doc(501, 'Facture Orange septembre')], components: [cout(3999, '2026-08-02'), cout(3999, '2026-09-02')] });
const freeFibre = () => op({ assetIds: [3], technicalLabel: 'Free Fibre', provider: 'Free', components: [cout(2999, '2026-09-05')] });
const netflix = () => op({ assetIds: [3], technicalLabel: 'Abonnement Netflix', provider: 'Netflix', components: [cout(1349, '2026-09-10')] });
const electricite = () => op({ assetIds: [3], technicalLabel: 'Électricité', provider: 'EDF', components: [cout(8500, '2026-09-15')] });

interface DocFx { fileId: number; title: string; amountCents: number | null; date: string; assetId: number }

/** Harnais : orchestrateur réel + fournisseur de sources métier en mémoire. */
function harness(assets: Array<typeof CUPRA>, ops: Op[], o: { understand?: Route | null; docs?: DocFx[]; plan?: string } = {}) {
  const h = H.harness(H.account({ assets }), { understand: o.understand ?? null });
  const sourcesOf = (assetIds: number[]): Source[] => [
    ...ops.filter((x) => !assetIds.length || x.assetIds.some((a) => assetIds.includes(a)))
      .map((x) => operationBusinessSource(x, x.assetIds[0] ?? null, assets.find((a) => a.id === x.assetIds[0])?.name ?? null)),
    ...(o.docs ?? []).filter((d) => !assetIds.length || assetIds.includes(d.assetId)).map((d): Source => ({
      ref: `document:${d.fileId}`, domain: 'document', label: d.title, detail: null, text: d.title, assetId: d.assetId,
      amountCents: d.amountCents, date: d.date, source: { id: `doc_${d.fileId}`, type: 'document', title: d.title, content: d.title, relevanceScore: 1 },
    })),
  ];
  const list = vi.fn(async (_acc: number, req: { assetIds: number[] }) => ({ sources: sourcesOf(req.assetIds), domains: ['operation', 'field', 'agenda', 'document'] }));
  const read = vi.fn(async (_acc: number, ref: string, ctx: { assetIds: number[] }) => sourcesOf(ctx.assetIds).find((s) => s.ref === ref) ?? null);
  h.ports.listBusinessSources = list;
  h.ports.readBusinessSource = read;
  const ask = (message: string, extra = {}) => h.ask(message, { planType: o.plan ?? 'PREMIUM', ...extra });
  return { ...h, ask, list, read };
}

/** Sortie UNDERSTAND simulée : intention, cible, sujets compris par T2. */
function compris(intent: string, hints: Array<{ type: string; value: string }>, topics: string[], facts: string[] = [], confidence: 'exact' | 'probable' | 'ambiguous' = 'probable'): Route {
  return { ...toIntentRoute({ intent, confidence, entityHints: hints as never, reason: 'test' }, 'PREMIUM'), understanding: { requestedFacts: facts, requestedTopics: topics, filters: {} } };
}

// ── Cas A — contrat ─────────────────────────────────────────────────────────

describe('Lot 49 — T2 : contrat ambigu (Cas A)', () => {
  it('T2SEM-AC01 — Cupra LLD + assurance : UNDERSTAND, clarification « De quel contrat parlez-vous ? », choix issus des données, aucun fallback', async () => {
    const h = harness([CUPRA], [lld(), assurance(), entretien()], { understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], ['contrat', 'fin de contrat']) });
    const r = await h.ask('Quand finit le contrat de la Cupra ?');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(r.clarification?.question).toBe('De quel contrat parlez-vous ?');
    expect(r.clarification?.candidateType).toBe('business_source');
    // Choix = données réelles (libellés des opérations), validés côté serveur.
    expect(r.clarification?.candidates.map((c) => c.label)).toEqual(['Contrat « LLD Cupra Formentor »', 'Contrat « Assurance auto »']);
    expect(r.clarification?.candidates.every((c) => /^operation:\d+$/.test(c.sourceRef ?? ''))).toBe(true);
    // Ni agenda, ni « aucun résultat ».
    expect(r.answer).not.toMatch(/rien trouvé|aucun résultat|agenda/i);
    expect(h.retrieve).not.toHaveBeenCalled();
    const sem = r.cascade?.semantic;
    expect(sem).toMatchObject({
      deterministicConfidence: 'WEAK', understandCalled: true, classificationEscalated: true, semanticAmbiguity: true,
      clarificationCreated: true, clarificationReason: 'SEMANTIC_MULTIPLE_INTERPRETATIONS', trigger: 'weak_route', resolvedTargets: [7],
    });
    expect(sem?.semanticResidue).toEqual(['contrat']);
    expect(sem?.operationCandidates).toHaveLength(2);
    expect(sem?.sourceDomainsAvailable).toContain('operation');
  });

  it('T2SEM-AC02 — une seule interprétation (LLD seule) : réponse directe, sans clarification', async () => {
    const h = harness([CUPRA], [lld(), entretien()], { understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], ['contrat']) });
    const r = await h.ask('Quand finit le contrat de la Cupra ?');
    expect(r.clarification).toBeNull();
    expect(r.answer).toBe('Contrat « LLD Cupra Formentor » (Cupra) se termine le 30 juin 2027.');
    expect(r.cascade?.semantic?.selectedOperationId).toBeGreaterThan(0);
    expect(r.cascade?.semantic?.semanticScopeResolved).toBe(true);
    expect(r.cascade?.strategy).toBe('semantic.operation');
  });

  it.each([
    'Quand finit le contrat de la Cupra ?',
    'C’est quand la fin du contrat de la Cupra ?',
    'Jusqu’à quand court le contrat de la Cupra ?',
    'Le contrat de la Cupra se termine quand ?',
    'Quand se termine le contrat de ma Cupra ?',
  ])('T2SEM-AC03 — variantes linguistiques sans regex par phrase : « %s » → même clarification', async (q) => {
    const h = harness([CUPRA], [lld(), assurance()], { understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], ['contrat']) });
    const r = await h.ask(q);
    expect(r.clarification?.question).toBe('De quel contrat parlez-vous ?');
    expect(r.clarification?.candidates).toHaveLength(2);
  });

  it('T2SEM-AC04 — agenda explicite « Quelles sont les prochaines échéances de la Cupra ? » : routage déterministe FORT, ni UNDERSTAND ni sources métier', async () => {
    const o = routeDeterministic({ message: 'Quelles sont les prochaines échéances de la Cupra ?', planType: 'PREMIUM', hasPendingClarification: false });
    expect(o.kind === 'route' && o.route.intent).toBe('ACCOUNT_SEARCH_AGENDA');
    expect(o.kind === 'route' && o.route.deterministicConfidence).toBe('STRONG');
    const h = harness([CUPRA], [lld(), assurance()]);
    const r = await h.ask('Quelles sont les prochaines échéances de la Cupra ?');
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(r.cascade?.semantic).toMatchObject({ deterministicConfidence: 'STRONG', trigger: 'none', understandCalled: false });
  });

  it('T2SEM-AC05 — reprise après clarification : contexte STRUCTURÉ (source choisie), aucune reformulation ni reclassement', async () => {
    const h = harness([CUPRA], [lld(), assurance()], { understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], ['contrat']) });
    const r = await h.ask('Quand finit le contrat de la Cupra ?');
    const etat = r.clarification!;
    const choix = etat.candidates.find((c) => c.label.includes('LLD'))!;
    const reprise = inputDeReprise({ accountId: 1, userId: 7, planType: 'PREMIUM', locale: 'fr-FR' }, { ...etat, conversationId: 99 }, choix);
    // Même demande initiale (pas le libellé recollé), source choisie en paramètre structuré.
    expect(reprise.message).toBe('Quand finit le contrat de la Cupra ?');
    expect(reprise.resume?.semanticSource).toEqual({ ref: choix.sourceRef, need: 'end_date', assetId: 7 });
    h.classify.mockClear();
    const suite = await h.ask(reprise.message, reprise);
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledWith(1, choix.sourceRef, expect.objectContaining({ assetIds: [7] }));
    expect(suite.answer).toBe('Contrat « LLD Cupra Formentor » (Cupra) se termine le 30 juin 2027.');
    expect(suite.cascade?.semantic?.trigger).toBe('resume_choice');
  });

  it('T2SEM-AC06 — choix devenu invalide (source disparue) : refusé par le serveur, jamais servi', async () => {
    const h = harness([CUPRA], [lld()]);
    const r = await h.ask('Quand finit le contrat de la Cupra ?', {
      resume: { clarificationId: 'c', intent: 'ACCOUNT_FACT_ASSET', assetId: 7, chainDepth: 1, choiceLabel: 'X', semanticSource: { ref: 'operation:999999', need: 'end_date', assetId: 7 } },
      pageContext: { assetId: '7' },
    });
    expect(r.answer).toBe('Cet élément n’est plus disponible.');
    expect(r.supportLevel).toBe('insufficient');
  });
});

// ── Cas B — internet ────────────────────────────────────────────────────────

describe('Lot 49 — T2 : périmètre de dépense précis (Cas B)', () => {
  const UNDERSTAND_INTERNET = compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'maison' }], ['internet', 'fibre', 'box internet']);

  it('T2SEM-AC07 — Maison avec plusieurs abonnements + Orange Fibre : montant CIBLÉ de l’opération, jamais la somme des abonnements', async () => {
    const h = harness([MAISON], [orangeFibre(), netflix(), electricite()], { understand: UNDERSTAND_INTERNET });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(r.clarification).toBeNull();
    expect(n(r.answer)).toBe('Contrat « Abonnement Orange Fibre » (Maison) : dernier montant documenté 39,99 € (2 septembre 2026) ; total documenté 79,98 € sur 2 montants.');
    expect(r.answer).not.toMatch(/13,49|85,00|Netflix|EDF/);
    expect(r.sources.map((s) => s.id)).toEqual(['doc_501']);
    expect(r.cascade?.semantic).toMatchObject({ understandCalled: true, semanticScopeResolved: true, requestedTopics: ['internet', 'fibre', 'box internet'] });
    expect(r.cascade?.semantic?.semanticResidue).toEqual(['internet']);
  });

  it('T2SEM-AC08 — deux services Internet plausibles (Orange Fibre, Free Fibre) : clarification', async () => {
    const h = harness([MAISON], [orangeFibre(), freeFibre(), netflix()], { understand: UNDERSTAND_INTERNET });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(r.clarification?.question).toBe('De quel contrat parlez-vous ?');
    expect(r.clarification?.candidates.map((c) => c.label).sort()).toEqual(['Contrat « Abonnement Orange Fibre »', 'Contrat « Free Fibre »']);
  });

  it('T2SEM-AC09 — aucun service identifiable : information insuffisante, jamais une somme globale', async () => {
    const h = harness([MAISON], [netflix(), electricite()], { understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'maison' }], ['internet']) });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(r.clarification).toBeNull();
    expect(r.supportLevel).toBe('insufficient');
    expect(r.answer).toMatch(/aucune donnée sur « internet » pour Maison/);
    expect(r.answer).not.toMatch(/€/);
    expect(r.cascade?.semantic?.fallbackReason).toBe('NO_MATCHING_SOURCE');
  });

  it('T2SEM-AC10 — compatibilité Opérations : même question, sans opération (document) puis avec opération — meilleure réponse, aucune règle nouvelle', async () => {
    const docs = [{ fileId: 501, title: 'Facture Orange Fibre septembre', amountCents: 3999, date: '2026-09-02', assetId: 3 }];
    const sans = await harness([MAISON], [netflix()], { understand: UNDERSTAND_INTERNET, docs }).ask('Je paye combien pour internet à la maison ?');
    expect(n(sans.answer)).toBe('« Facture Orange Fibre septembre » (Maison) : 39,99 € (2 septembre 2026).');
    expect(sans.cascade?.strategy).toBe('semantic.document');
    const avec = await harness([MAISON], [netflix(), orangeFibre()], { understand: UNDERSTAND_INTERNET, docs }).ask('Je paye combien pour internet à la maison ?');
    // L'opération représente le document : elle est préférée (source native), le document n'est pas une 2e interprétation.
    expect(avec.cascade?.strategy).toBe('semantic.operation');
    expect(n(avec.answer)).toMatch(/^Contrat « Abonnement Orange Fibre » \(Maison\) : dernier montant documenté 39,99 €/);
  });

  it('T2SEM-AC11 — agrégation EXPLICITE « Combien ai-je dépensé en abonnements pour la Maison ? » : calcul structuré, aucun appel IA', async () => {
    const h = harness([MAISON], [orangeFibre(), netflix()]);
    const port = fakePort();
    h.ports.answerFromData = (route, input, thresholds) => answerFromData({ port, accountId: 1, message: input.message, thresholds, intent: route.intent });
    const r = await h.ask('Combien ai-je dépensé en abonnements pour la Maison ?');
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(r.cascade?.strategy).toBe('structured.sum_qualified');
    expect(n(r.answer)).toMatch(/Dépenses de abonnements documentées pour Maison : 53,48/);
    expect(r.cascade?.semantic).toMatchObject({ structuredStrategyExecuted: true, structuredScopeFallbackPrevented: false });
  });

  it('T2SEM-AC12 — sans IA (offre Standard) : aucune compréhension inventée, sélection sur le seul résidu — jamais d’élargissement', async () => {
    const h = harness([MAISON], [orangeFibre(), netflix()], { plan: 'STANDARD' });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(h.classify).not.toHaveBeenCalled();
    expect(r.answer).not.toMatch(/13,49|Netflix/);
    expect(r.supportLevel).toBe('insufficient');
  });
});

// ── tryCanonicalStructured : la stratégie n'est plus exécutée hors périmètre ─

function fakePort(over: Partial<Port> = {}): Port & { calls: string[] } {
  const calls: string[] = [];
  const maison = { id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison', purchaseDate: null, isRented: false };
  const p: Port = {
    today: () => '2026-10-12',
    findAssets: async (_a, words) => (words.some((w) => /maison/.test(w)) ? [{ ...maison, matched: 1 }] : []),
    listAssets: async () => [maison],
    countDocuments: async () => 0, countAgenda: async () => 0, upcomingAgenda: async () => [],
    sumDocumentAmounts: async () => { calls.push('sumDocumentAmounts'); return { sumCents: 999999, count: 9 }; },
    searchFacts: async () => [], searchDocuments: async () => [],
    readAcquisition: async () => { calls.push('readAcquisition'); return { operationId: 1, priceCents: 30000000, foreign: [], date: null, provider: null, source: null }; },
    readPayments: async () => { calls.push('readPayments'); return { proofs: [], sumCents: 0, withoutAmount: 0 }; },
    readOperationCosts: async () => { calls.push('readOperationCosts'); return []; },
    sumQualifiedExpenses: async (_a, o) => {
      calls.push(`sumQualifiedExpenses:${o.theme ?? 'all'}`);
      return {
        qualifiedSumCents: 5348, complete: true, byTheme: [{ theme: 'subscription', label: 'abonnements', sumCents: 5348, count: 3, operationIds: [] }],
        unqualified: { count: 0, sumCents: 0 }, excluded: { count: 0 }, duplicates: { count: 0 },
      } as never;
    },
    ...over,
  };
  return Object.assign(p, { calls });
}

describe('Lot 49 — tryCanonicalStructured() et périmètre sémantique', () => {
  const scope = (port: Port) => async (texte: string) => {
    const a = await port.findAssets(1, texte.toLowerCase().split(/\W+/));
    return { assets: a, ambiguous: false, unresolved: a.length === 0, label: a[0]?.name ?? null };
  };

  it('T2SEM-AC13 — « Je paye combien pour internet à la maison ? » : stratégie candidate NON exécutée (ni prix d’achat, ni paiements, ni somme)', async () => {
    const port = fakePort();
    const r = await tryCanonicalStructured({ port, accountId: 1, message: 'Je paye combien pour internet à la maison ?', resolveScope: scope(port) });
    expect(r).toEqual({ scopeUnresolved: { strategyCandidate: 'structured.acquisition_price', terms: ['internet'], assetIds: [3] } });
    expect(port.calls).toEqual([]);
  });

  it('T2SEM-AC14 — « Combien me coûte internet à la maison ? » : jamais l’agrégat d’une catégorie générique', async () => {
    const port = fakePort();
    const r = await tryCanonicalStructured({ port, accountId: 1, message: 'Combien me coûte internet à la maison ?', resolveScope: scope(port) });
    expect(r && 'scopeUnresolved' in r && r.scopeUnresolved.strategyCandidate).toBe('structured.sum_qualified');
    expect(port.calls.some((c) => c.startsWith('sumQualifiedExpenses'))).toBe(false);
    // answerFromData : aucun repli plus large (somme brute des documents, faits du bien).
    const d = await answerFromData({ port, accountId: 1, message: 'Combien me coûte internet à la maison ?', thresholds: DEFAULT_THRESHOLDS });
    expect(d.handled).toBe(false);
    expect(d.semanticScope).toMatchObject({ resolved: false, strategyCandidate: 'structured.sum_qualified', terms: ['internet'] });
    expect(d.decision.reason).toBe('SEMANTIC_SCOPE_UNRESOLVED');
    expect(port.calls).not.toContain('sumDocumentAmounts');
  });

  it('T2SEM-AC15 — catégorie EXPLICITE (« en abonnements ») : la stratégie structurée s’exécute (STRONG)', async () => {
    const port = fakePort();
    const r = await tryCanonicalStructured({ port, accountId: 1, message: 'Combien ai-je dépensé en abonnements pour la Maison ?', resolveScope: scope(port) });
    expect(r && 'strategy' in r && r.strategy).toBe('structured.sum_qualified');
    expect(port.calls).toContain('sumQualifiedExpenses:subscription');
  });

  it('T2SEM-AC16 — intervention précise non désignée par les données (« la réfection du toit ») : plus d’agrégat du bien', async () => {
    const port = fakePort();
    const r = await tryCanonicalStructured({ port, accountId: 1, message: 'Combien a coûté la réfection du toit de la Maison ?', resolveScope: scope(port) });
    expect(r && 'scopeUnresolved' in r && r.scopeUnresolved.terms).toEqual(['refection', 'toit']);
    expect(port.calls).toEqual(['readOperationCosts']);
  });

  it('T2SEM-AC17 — « J’ai payé combien pour la Maison ? » (sans sujet résiduel) : comportement C15.2 conservé (prix d’achat)', async () => {
    const port = fakePort();
    const r = await tryCanonicalStructured({ port, accountId: 1, message: 'J’ai payé combien pour la Maison ?', resolveScope: scope(port) });
    expect(r && 'strategy' in r && r.strategy).toBe('structured.acquisition_price');
  });

  it('T2SEM-AC18 — orchestrateur : stratégie candidate non exécutée → UNDERSTAND + sources (observabilité complète)', async () => {
    const h = harness([MAISON], [orangeFibre(), netflix()], { understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'maison' }], ['fibre']) });
    // Route FORTE ici (aucun signal faible) : seul le niveau structuré détecte le périmètre non résolu.
    h.ports.answerFromData = async () => ({
      handled: false, sources: [], claims: [], decision: { status: 'INSUFFICIENT', level: 1, score: 0, threshold: 0.9, reason: 'SEMANTIC_SCOPE_UNRESOLVED' },
      strategy: 'none', attempts: [], contextSources: [],
      semanticScope: { resolved: false, strategyCandidate: 'structured.payments', terms: ['internet'], assetIds: [3] },
    });
    const r = await h.ask('Mes dépenses internet de la maison ?');
    expect(r.cascade?.semantic).toMatchObject({
      trigger: 'structured_scope', structuredStrategyCandidate: 'structured.payments', structuredStrategyExecuted: false,
      structuredScopeFallbackPrevented: true, understandCalled: true, semanticScopeResolved: true,
    });
    expect(r.answer).toMatch(/Abonnement Orange Fibre/);
  });
});

// ── Règle STRONG / WEAK et absence de lexique codé en dur ──────────────────

describe('Lot 49 — STRONG / WEAK, généricité', () => {
  it('T2SEM-AC19 — signaux faibles seuls : route WEAK ; décisions fortes conservées', () => {
    const r = (m: string) => { const o = routeDeterministic({ message: m, planType: 'PREMIUM', hasPendingClarification: false }); return o.kind === 'route' ? o.route : null; };
    expect(r('Quand finit le contrat de la Cupra ?')).toMatchObject({ intent: 'ACCOUNT_SEARCH_AGENDA', deterministicConfidence: 'WEAK', weakSignals: ['quand'] });
    expect(r('Je paye combien pour internet à la maison ?')?.deterministicConfidence).toBe('WEAK');
    for (const [m, i] of [
      ['Quelles sont mes échéances ?', 'ACCOUNT_SEARCH_AGENDA'], ['Que dois-je traiter ?', 'ACCOUNT_TO_PROCESS'],
      ['Quels documents ne sont rattachés à aucun bien ?', 'ACCOUNT_SEARCH_DOCUMENT'], ['Quand ai-je acheté ma Peugeot ?', 'ACCOUNT_FACT_ASSET'],
    ] as const) {
      expect(r(m)).toMatchObject({ intent: i, deterministicConfidence: 'STRONG' });
    }
    // Non-régression : une pièce DÉSIGNÉE (type de document explicite) fixe le
    // périmètre de la donnée — la recherche documentaire consomme le reste.
    expect(r('Quel est le montant de ma dernière facture EDF ?')).toMatchObject({ intent: 'ACCOUNT_FACT_DOCUMENT', deterministicConfidence: 'STRONG' });
    // Verbes et locutions génériques (« vaut », « a lieu ») : jamais un sujet.
    expect(semanticResidue('Combien vaut ma maison ?', { assetNames: ['Maison'] })).toEqual([]);
    expect(semanticResidue('Quand a lieu le contrôle technique de la Polo ?', { assetNames: ['Polo'] })).toEqual([]);
  });

  it('T2SEM-AC20 — résidu sémantique générique : sujets non consommés seulement', () => {
    expect(semanticResidue('Je paye combien pour internet à la maison ?', { assetNames: ['Maison'] })).toEqual(['internet']);
    expect(semanticResidue('Quand finit le contrat de la Cupra ?', { assetNames: ['Cupra Formentor'] })).toEqual(['contrat']);
    expect(semanticResidue('Combien ai-je dépensé en entretien pour la Polo ?', { assetNames: ['Polo'], consumed: ['entretien'] })).toEqual([]);
    expect(semanticResidue('Quelle est la date d’achat de la Polo ?', { assetNames: ['Polo'] })).toEqual([]);
    expect(detectValueNeed('Quand finit le contrat ?')).toBe('end_date');
    expect(detectValueNeed('Je paye combien ?')).toBe('amount');
  });

  it('T2SEM-AC21 — interprétations : 1 → directe, 2 → clarification, 0 → insuffisant ; question issue des données', () => {
    const a = operationBusinessSource(lld(), 7, 'Cupra'); const b = operationBusinessSource(assurance(), 7, 'Cupra');
    const besoin = { terms: ['contrat'], facts: [], need: 'end_date' as const };
    expect(selectInterpretations([a, b], besoin).selected).toHaveLength(2);
    expect(selectInterpretations([a], besoin).selected).toEqual([a]);
    expect(selectInterpretations([a, b], { ...besoin, terms: ['piscine'] }).selected).toEqual([]);
    expect(semanticQuestion([a, b])).toBe('De quel contrat parlez-vous ?');
  });

  it('T2SEM-AC22 — aucun mapping lexical codé en dur (internet → Orange, fibre → abonnement, Cupra → LLD)', () => {
    const racine = join(process.cwd(), 'src/services/verebona-assistant');
    for (const f of ['core/semantic-scope.ts', 'core/semantic-stage.ts', 'canonical/business-sources.ts', 'core/intent-router.service.ts', 'canonical/structured-answers.ts']) {
      const src = readFileSync(join(racine, f), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).join('\n');
      expect(src).not.toMatch(/internet|fibre|orange|\bfree\b|cupra|\blld\b|leasing/i);
    }
  });
});
