/**
 * Lot 54E — ticket P1 « T2 : finaliser le routage sémantique IA et résorber
 * les écarts avec le #419 » (écarts 1 à 9, critères de clôture CC1 à CC8).
 *
 * Orchestrateur RÉEL (`runAssistant`), résolution des cibles RÉELLE,
 * sélection RÉELLE (`selectInterpretations`), sources construites par le
 * fournisseur RÉEL (`operationBusinessSource`), préparation de plan RÉELLE
 * (`prepareUpdateProposal`, base simulée) ; UNDERSTAND et l'arbitrage T2
 * SIMULÉS (compteurs d'appels).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const unsafe = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
vi.mock('@/db', () => ({ pgClient: { unsafe: (...a: unknown[]) => unsafe(...a) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const H = await import('../lot29/harness');
const { operationBusinessSource, registerBusinessSourceProvider, listBusinessSources, answerFromBusinessSource } = await import('../../../canonical/business-sources');
const { routeDeterministic } = await import('../../intent-router.service');
const S = await import('../../semantic-scope');
const { toIntentRoute } = await import('../../classification.adapter');
const { interactionHandling, updateFactsOf } = await import('../../interaction');
const P = await import('../../../commands/plan.service');
const { tryCanonicalStructured, structuredScopeBarrier, STRATEGY_SCOPE } = await import('../../../canonical/structured-answers');
const { answerFromData } = await import('../../data-answer.service');
const { T2UnderstandOutput } = await import('@/services/ai/assistant/master/t2-contract');
const { toT2Understanding, formatBusinessCandidates } = await import('@/services/ai/assistant/master/t2-understand');
const { OPTIONAL_MASTER_VARIABLES, renderMasterPrompt } = await import('@/services/ai/prompts/prompt-loader');
const { T2_MASTER_VARIABLES } = await import('@/services/ai/registry/operations');

type Op = import('../../../canonical/operations').AssistantOperationRead;
type Source = import('../../semantic-scope').BusinessSource;
type Route = import('../../../types/contracts').IntentRoute;
type Cand = import('../../semantic-stage').ArbitrationCandidate;
type Decision = import('../../semantic-scope').RawSemanticDecision;
type Fact = import('../../../types/contracts').SuppliedFact;

const n = (t: string | undefined) => (t ?? '').replace(/[  ]/g, ' ');

// ── Fixtures ────────────────────────────────────────────────────────────────

let nextId = 300;
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

const CUPRA = { id: 7, name: 'Cupra', category: 'VEHICULE', subtype: 'Voiture' };
const POLO = { id: 12, name: 'Polo', category: 'VEHICULE', subtype: 'Voiture' };
const MAISON = { id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' };
const orangeFibre = () => op({ assetIds: [3], technicalLabel: 'Abonnement Orange Fibre', provider: 'Orange', components: [cout(3999, '2026-09-02')] });
const freeFibre = () => op({ assetIds: [3], technicalLabel: 'Free Fibre', provider: 'Free', components: [cout(2999, '2026-09-05')] });
const netflix = () => op({ assetIds: [3], technicalLabel: 'Abonnement Netflix', provider: 'Netflix', components: [cout(1349, '2026-09-10')] });
const lld = (fin: string | null) => op({ assetIds: [7], technicalLabel: 'LLD Cupra Formentor', provider: 'Leasys', effectiveFrom: '2024-07-01', effectiveTo: fin });
const assurance = () => op({ assetIds: [7], technicalLabel: 'Assurance auto', provider: 'MAAF', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' });

interface Extra { ref: string; domain: string; label: string; text?: string; assetId: number; amountCents?: number | null; date?: string | null; endDate?: string | null; provider?: string | null; fieldKey?: string | null; kindNoun?: string | null }
const extra = (x: Extra): Source => ({
  ref: x.ref, domain: x.domain, label: x.label, detail: null, text: x.text ?? x.label, assetId: x.assetId, amountCents: x.amountCents ?? null,
  date: x.date ?? null, endDate: x.endDate ?? null, provider: x.provider ?? null, fieldKey: x.fieldKey ?? null, kindNoun: x.kindNoun ?? null,
  source: { id: x.ref.replace(':', '_'), type: x.domain === 'field' ? 'asset_field' : 'document', title: x.label, content: x.label, relevanceScore: 1 },
  ...(x.domain === 'field' ? { meta: { display: x.endDate ?? x.date ?? '' } } : {}),
});

/** Base des biens pour la préparation de plan (CommandLookup simulé). */
const ETATS: Record<number, import('../../../commands/plan.service').AssetState> = {
  7: { id: 7, name: 'Cupra', city: null, category: 'VEHICULE', status: 'EN_SERVICE', lockState: 'NONE', characteristics: { vehicleOwnershipStatus: 'LLD' } },
  12: { id: 12, name: 'Polo', city: null, category: 'VEHICULE', status: 'EN_SERVICE', lockState: 'NONE', characteristics: { mileage: 80000 } },
};
const lookup: import('../../../commands/plan.service').CommandLookup = {
  today: () => '2026-10-14',
  async findAssets() { return []; },
  async getAsset() { return null; },
  async findAgendaItems() { return []; },
  async getAgendaItem() { return null; },
  async listOpenAgendaItems() { return []; },
  async getAssetState(_a, id) { return ETATS[id] ?? null; },
};

function harness(assets: Array<typeof CUPRA>, ops: Op[], o: {
  understand?: Route | null; extras?: Source[]; plan?: string; arbitrate?: ((c: Cand[]) => Decision | null) | null; proposals?: boolean;
} = {}) {
  const h = H.harness(H.account({ assets }), { understand: o.understand ?? null });
  const sourcesOf = (assetIds: number[]): Source[] => [
    ...ops.filter((x) => !assetIds.length || x.assetIds.some((a) => assetIds.includes(a)))
      .map((x) => operationBusinessSource(x, x.assetIds[0] ?? null, assets.find((a) => a.id === x.assetIds[0])?.name ?? null)),
    ...(o.extras ?? []).filter((d) => !assetIds.length || assetIds.includes(d.assetId ?? -1)),
  ];
  h.ports.listBusinessSources = vi.fn(async (_acc: number, req: { assetIds: number[] }) => ({ sources: sourcesOf(req.assetIds), domains: ['operation', 'field', 'agenda', 'document'] }));
  h.ports.readBusinessSource = vi.fn(async (_acc: number, ref: string, ctx: { assetIds: number[] }) => sourcesOf(ctx.assetIds).find((s) => s.ref === ref) ?? null);
  const arbitrate = vi.fn(async (_m: string, _i: unknown, c: Cand[]) => (o.arbitrate ? o.arbitrate(c) : null));
  if (o.arbitrate !== undefined) h.ports.arbitrateWithAI = arbitrate;
  const propose = vi.fn(async (input: import('../../../types/contracts').AssistantRequestInput, req: { fact: Fact; assetId: number | null }) => {
    const r = await P.prepareUpdateProposal(input, req, lookup);
    return r.kind === 'plan' ? { kind: 'plan' as const, preview: r.preview, capability: r.capability, proposed: r.proposed, refused: r.refused } : r;
  });
  if (o.proposals !== false) h.ports.prepareUpdateProposal = propose;
  const ask = (message: string, extraIn = {}) => h.ask(message, { planType: o.plan ?? 'PREMIUM', ...extraIn });
  return { ...h, ask, arbitrate, propose };
}

function compris(intent: string, hints: Array<{ type: string; value: string }>, topics: string[], o: {
  facts?: string[]; confidence?: 'exact' | 'probable' | 'ambiguous'; mode?: import('../../../types/contracts').InteractionMode; supplied?: Partial<Fact>[];
} = {}): Route {
  return {
    ...toIntentRoute({ intent, confidence: o.confidence ?? 'probable', entityHints: hints as never, reason: 'test' }, 'PREMIUM'),
    understanding: {
      requestedFacts: o.facts ?? [], requestedTopics: topics, filters: {},
      ...(o.mode ? {
        interaction: {
          mode: o.mode,
          suppliedFacts: (o.supplied ?? []).map((f) => ({ targetHint: null, fieldKey: null, topic: null, value: null, normalizedValue: null, unit: null, role: 'unknown' as const, confidence: 'probable' as const, ...f })),
        },
      } : {}),
    },
  };
}
const choisir = (re: RegExp, confidence: Decision['confidence'] = 'probable') => (c: Cand[]): Decision => {
  const x = c.find((k) => re.test(k.label));
  return x ? { decision: 'SELECT', selectedCandidateRef: x.ref, confidence, reason: 'test' } : { decision: 'NONE', confidence: 'probable' };
};
const ecritures = () => unsafe.mock.calls.map((c) => String(c[0])).filter((q) => /\b(UPDATE|DELETE)\b|INSERT INTO (assets|asset_)/i.test(q));

beforeEach(() => unsafe.mockClear());

// ── Écart 1 — l'arbitrage final revient à T2 (test A) ─────────────────────

describe('#419 écart 1 / CC1 — sélection finale : T2 arbitre entre candidats prévalidés', () => {
  const INTERNET = compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'maison' }], ['internet']);

  it('T2-419-01 (A) — Internet : sources plausibles exposées, T2 choisit Orange Fibre, jamais Netflix ; trace complète', async () => {
    const docOrange = extra({ ref: 'document:900', domain: 'document', label: 'Facture Orange septembre', assetId: 3, amountCents: 3999, date: '2026-09-02', provider: 'Orange' });
    const h = harness([MAISON], [orangeFibre(), netflix()], { understand: INTERNET, extras: [docOrange], arbitrate: choisir(/Orange/) });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(h.arbitrate).toHaveBeenCalledTimes(1);
    const presentes = h.arbitrate.mock.calls[0][2] as Cand[];
    // Références OPAQUES — ni identifiant, ni table, ni source non autorisée.
    // Lot 59 (#419 R04) : candidats de TOUS les domaines qui portent la valeur (opérations ET document).
    expect(presentes.map((c) => c.ref)).toEqual(['C1', 'C2', 'C3']);
    expect(JSON.stringify(presentes)).not.toMatch(/operation:|document:|asset_files|\bid\b/);
    expect(presentes.map((c) => c.label).sort()).toEqual(['Contrat « Abonnement Netflix »', 'Contrat « Abonnement Orange Fibre »', 'Facture Orange septembre']);
    expect(n(r.answer)).toMatch(/^Contrat « Abonnement Orange Fibre » \(Maison\) : dernier montant documenté 39,99 €/);
    expect(r.answer).not.toMatch(/Netflix|13,49/);
    expect(r.cascade?.semantic).toMatchObject({
      candidateSelectionMode: 'ai', semanticDecision: 'SELECT', semanticDecisionConfidence: 'probable', candidateRefValidated: true,
      candidateValidationFailure: null, semanticScopeResolved: true,
    });
    expect(r.cascade?.semantic?.candidateRefsPresentedToAI).toHaveLength(3);
    expect(r.cascade?.semantic?.candidateRefSelectedByAI).toMatch(/^operation:\d+$/);
    expect(r.cascade?.semantic?.selectedSource).toBe(r.cascade?.semantic?.candidateRefSelectedByAI);
  });

  it('T2-419-01b — référence inventée ou identifiant technique renvoyé par T2 : refusé par le serveur, clarification, rien servi', async () => {
    for (const ref of ['C9', 'operation:1', '42']) {
      const h = harness([MAISON], [orangeFibre(), netflix()], { understand: INTERNET, arbitrate: () => ({ decision: 'SELECT', selectedCandidateRef: ref, confidence: 'exact' }) });
      const r = await h.ask('Je paye combien pour internet à la maison ?');
      expect(r.answer).not.toMatch(/€/);
      expect(r.clarification?.candidateType).toBe('business_source');
      expect(r.cascade?.semantic).toMatchObject({ candidateRefValidated: false, candidateValidationFailure: 'UNKNOWN_CANDIDATE_REF', candidateSelectionMode: null });
    }
  });

  it('T2-419-01c — sans arbitrage IA possible (port absent, offre sans IA) : jamais un choix lexical, clarification ou insuffisant', async () => {
    const sansPort = await harness([MAISON], [orangeFibre(), netflix()], { understand: INTERNET }).ask('Je paye combien pour internet à la maison ?');
    expect(sansPort.answer).not.toMatch(/€/);
    expect(sansPort.clarification?.candidates).toHaveLength(2);
    const standard = harness([MAISON], [orangeFibre(), netflix()], { arbitrate: choisir(/Orange/), plan: 'STANDARD' });
    const r = await standard.ask('Je paye combien pour internet à la maison ?');
    expect(standard.arbitrate).not.toHaveBeenCalled();
    expect(r.answer).not.toMatch(/€/);
  });

  it('T2-419-01d — pure : aucun « meilleur score » — deux sources plausibles de scores différents restent deux interprétations', () => {
    const a = extra({ ref: 'document:1', domain: 'document', label: 'Facture box fibre maison', assetId: 3, amountCents: 3000 });
    const b = extra({ ref: 'document:2', domain: 'document', label: 'Facture fibre', assetId: 3, amountCents: 2000 });
    const sel = S.selectInterpretations([a, b], { terms: ['box', 'fibre'], facts: [], need: 'amount' });
    expect(S.sourceScore(a, ['box', 'fibre'])).toBe(2);
    expect(S.sourceScore(b, ['box', 'fibre'])).toBe(1);
    expect(sel.selected.map((s) => s.ref).sort()).toEqual(['document:1', 'document:2']);
    expect(sel.reason).toBe('MULTIPLE_PLAUSIBLE');
  });

  it('T2-419-01e — pure : validation serveur de la décision (référence présentée, confiance, NONE / CLARIFY)', () => {
    const s = extra({ ref: 'operation:1', domain: 'operation', label: 'X', assetId: 3 });
    const m = new Map([['C1', s]]);
    expect(S.validateSemanticDecision({ decision: 'SELECT', selectedCandidateRef: 'C1', confidence: 'probable' }, m)).toMatchObject({ kind: 'select', source: s });
    expect(S.validateSemanticDecision({ decision: 'SELECT', selectedCandidateRef: 'C1', confidence: 'ambiguous' }, m)).toEqual({ kind: 'clarify', failure: 'INSUFFICIENT_CONFIDENCE' });
    expect(S.validateSemanticDecision({ decision: 'SELECT', selectedCandidateRef: 'C1', confidence: 'probable' }, m, { requireExact: true })).toEqual({ kind: 'clarify', failure: 'INSUFFICIENT_CONFIDENCE' });
    expect(S.validateSemanticDecision({ decision: 'SELECT', selectedCandidateRef: null, confidence: 'exact' }, m)).toEqual({ kind: 'clarify', failure: 'MISSING_CANDIDATE_REF' });
    expect(S.validateSemanticDecision({ decision: 'NONE', confidence: 'exact' }, m)).toEqual({ kind: 'none' });
    expect(S.validateSemanticDecision(null, m)).toEqual({ kind: 'clarify', failure: 'NO_DECISION' });
  });

  it('T2-419-01f — T2 répond NONE : information insuffisante (jamais un total plus large)', async () => {
    const h = harness([MAISON], [orangeFibre(), netflix()], { understand: INTERNET, arbitrate: () => ({ decision: 'NONE', confidence: 'exact' }) });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(r.answer).toMatch(/Je n’ai trouvé aucune donnée/);
    expect(r.answer).not.toMatch(/€/);
    expect(r.cascade?.semantic?.fallbackReason).toBe('AI_NO_MATCHING_CANDIDATE');
  });
});

// ── Écart 2 — capacité réelle à répondre (tests B, C) ─────────────────────

describe('#419 écart 2 / CC2 — plus de priorité absolue operation > field > agenda > document', () => {
  it('T2-419-02 (B) — opération Internet SANS montant + facture Internet 39,99 € : la facture répond (jamais « aucun montant »)', async () => {
    const opSans = op({ assetIds: [3], technicalLabel: 'Abonnement Internet', provider: 'Sosh' });
    const facture = extra({ ref: 'document:910', domain: 'document', label: 'Facture Internet août', assetId: 3, amountCents: 3999, date: '2026-08-31', provider: 'Bouygues' });
    const h = harness([MAISON], [opSans], { understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'maison' }], ['internet']), extras: [facture] });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(n(r.answer)).toBe('« Facture Internet août » (Maison) : 39,99 € (31 août 2026).');
    expect(r.answer).not.toMatch(/aucun montant/);
    expect(r.cascade?.strategy).toBe('semantic.document');
    expect(r.cascade?.semantic).toMatchObject({ candidateSelectionMode: 'deterministic', selectionReason: 'SINGLE_CAPABLE' });
  });

  it('T2-419-03 (C) — contrat SANS date de fin / champ « Fin de bail / location » renseigné : la date est servie', async () => {
    const champ = extra({ ref: 'field:7:leaseEndDate', domain: 'field', label: 'Fin de bail / location', text: 'Fin de bail / location leaseEndDate', assetId: 7, fieldKey: 'leaseEndDate', date: '2027-05-21', endDate: '2027-05-21' });
    const h = harness([CUPRA], [lld(null)], {
      understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], ['contrat'], { facts: ['leaseEndDate'] }), extras: [champ],
    });
    const r = await h.ask('Quand finit le contrat de la Cupra ?');
    expect(r.answer).toBe('Fin de bail / location (Cupra) : 2027-05-21.');
    expect(r.answer).not.toMatch(/aucune date de fin/);
    expect(r.cascade?.strategy).toBe('semantic.field');
  });

  it('T2-419-03b — opération ET pièce RATTACHÉE (même réalité démontrée) : l’opération, qui consolide le montant, la représente — sans arbitrage (lot 59 : un même prestataire ne suffit plus, voir R03)', async () => {
    const fibre = op({ assetIds: [3], technicalLabel: 'Abonnement Orange Fibre', provider: 'Orange', components: [cout(3999, '2026-09-02')],
      documents: [{ fileId: 920, role: null, title: 'Facture Orange Fibre octobre', date: '2026-10-02', amountCents: 3999, documentTypeCode: null }] as never });
    const piece = extra({ ref: 'document:920', domain: 'document', label: 'Facture Orange Fibre octobre', assetId: 3, amountCents: 3999, date: '2026-10-02', provider: 'Orange' });
    const h = harness([MAISON], [fibre, netflix()], { understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'maison' }], ['fibre']), extras: [piece], arbitrate: choisir(/Netflix/) });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(h.arbitrate).not.toHaveBeenCalled();
    expect(r.cascade?.strategy).toBe('semantic.operation');
    expect(r.cascade?.semantic?.candidatesExcluded).toEqual([{ ref: 'document:920', reason: 'REPRESENTED_BY_OPERATION' }]);
  });

  it('T2-419-03c — pure : une opération pertinente reste servie quand AUCUNE source ne porte la valeur (absence dite)', () => {
    const o = operationBusinessSource(lld(null), 7, 'Cupra');
    const sel = S.selectInterpretations([o], { terms: ['lld'], facts: [], need: 'end_date' });
    expect(sel.selected).toEqual([o]);
    expect(sel.reason).toBe('PLAUSIBLE_WITHOUT_VALUE');
    expect('DOMAIN_PRIORITY' in S).toBe(false);
  });
});

// ── Test D — plusieurs candidats équivalents ──────────────────────────────

describe('#419 test D — Orange Fibre / Free Fibre', () => {
  const FIBRE = compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'maison' }], ['fibre']);
  it('T2-419-04 — T2 répond CLARIFY (ou rien) : clarification, choix issus des données', async () => {
    for (const arb of [() => ({ decision: 'CLARIFY' as const, confidence: 'probable' as const }), null]) {
      const h = harness([MAISON], [orangeFibre(), freeFibre(), netflix()], { understand: FIBRE, arbitrate: arb });
      const r = await h.ask('Je paye combien pour internet à la maison ?');
      expect(r.clarification?.question).toBe('De quel contrat parlez-vous ?');
      expect(r.clarification?.candidates.map((c) => c.label).sort()).toEqual(['Contrat « Abonnement Orange Fibre »', 'Contrat « Free Fibre »']);
    }
  });
  it('T2-419-04b — T2 lève l’ambiguïté avec une confiance suffisante et une référence validable : réponse', async () => {
    const h = harness([MAISON], [orangeFibre(), freeFibre()], { understand: FIBRE, arbitrate: choisir(/Free/, 'exact') });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(n(r.answer)).toMatch(/^Contrat « Free Fibre » \(Maison\) : dernier montant documenté 29,99 €/);
    expect(r.cascade?.semantic?.candidateSelectionMode).toBe('ai');
  });
});

// ── Écarts 3 à 5 — information apportée (tests E, F) ──────────────────────

describe('#419 écarts 3–5 / CC3–CC5 — UPDATE_PROPOSAL, CONTEXT_ONLY, MIXED', () => {
  const LLD_PROPOSAL = compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], [], {
    mode: 'UPDATE_PROPOSAL',
    supplied: [{ targetHint: 'Cupra', fieldKey: 'leaseEndDate', topic: 'fin de LLD', value: '21/05/2027', normalizedValue: '2027-05-21', role: 'update', confidence: 'exact' }],
  });

  it('T2-419-05 (E) — « La date de fin de LLD de la Cupra est le 21/05/2027 » : UNDERSTAND → cible et capacité serveur → PENDING_CONFIRMATION, aucune écriture', async () => {
    const h = harness([CUPRA], [lld(null)], { understand: LLD_PROPOSAL });
    const r = await h.ask('La date de fin de LLD de la Cupra est le 21/05/2027');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.propose).toHaveBeenCalledTimes(1);
    // Cible résolue par le SERVEUR (catalogue du compte), jamais un identifiant du modèle.
    expect(h.propose.mock.calls[0][1].assetId).toBe(7);
    expect(r.commandPlan?.summary).toBe('Modifier « Fin de contrat prévue » de Cupra : non renseigné → 21 mai 2027. Confirmez-vous ?');
    expect(r.commandPlan?.actions[0]).toMatchObject({ label: expect.any(String) });
    // Plan enregistré PENDING_CONFIRMATION (CommandPlan existant) — aucune écriture métier.
    const sql = unsafe.mock.calls.map((c) => String(c[0]));
    expect(sql.some((q) => /INSERT INTO verebona_command_plans[\s\S]*'PENDING_CONFIRMATION'/.test(q))).toBe(true);
    expect(ecritures()).toEqual([]);
    expect(r.cascade?.semantic).toMatchObject({
      interactionMode: 'UPDATE_PROPOSAL', suppliedFactsCount: 1, updateCapabilityResolved: true, updateTargetType: 'asset_tenure_end', confirmationPlanCreated: true,
    });
  });

  it('T2-419-05b — information sur un champ modifiable (« Le kilométrage de la Polo est de 45 000 km ») : plan asset_field, sans regex ajoutée', async () => {
    const h = harness([POLO], [], {
      understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Polo' }], [], {
        mode: 'UPDATE_PROPOSAL', supplied: [{ targetHint: 'Polo', fieldKey: 'mileage', value: '45 000 km', normalizedValue: '45000', unit: 'km', role: 'update' }],
      }),
    });
    const r = await h.ask('Le kilométrage de la Polo est de 45 000 km');
    expect(n(r.commandPlan?.summary)).toBe('Modifier « Kilométrage » de Polo : 80 000 km → 45 000 km. Confirmez-vous ?');
    expect(r.cascade?.semantic?.updateTargetType).toBe('asset_field');
    expect(ecritures()).toEqual([]);
  });

  it('T2-419-05c — valeur absente du message, champ non modifiable, cible inconnue : aucune proposition, rien écrit, motif tracé', async () => {
    const invente = harness([CUPRA], [], { understand: compris('ACCOUNT_FACT_ASSET', [], [], { mode: 'UPDATE_PROPOSAL', supplied: [{ targetHint: 'Cupra', fieldKey: 'leaseEndDate', normalizedValue: '2027-06-30', role: 'update' }] }) });
    const a = await invente.ask('La date de fin de LLD de la Cupra est le 21/05/2027');
    expect(a.commandPlan ?? null).toBeNull();
    expect(a.answer).toMatch(/rien n’a été modifié/);
    expect(a.cascade?.semantic).toMatchObject({ confirmationPlanCreated: false, updateTargetType: 'asset_tenure_end' });
    const nonModifiable = harness([CUPRA], [], { understand: compris('ACCOUNT_FACT_ASSET', [], [], { mode: 'UPDATE_PROPOSAL', supplied: [{ targetHint: 'Cupra', fieldKey: 'vin', value: 'VSSZZZ5FZRR000001', role: 'update' }] }) });
    const b = await nonModifiable.ask('Le VIN de la Cupra est VSSZZZ5FZRR000001');
    expect(b.commandPlan ?? null).toBeNull();
    expect(b.cascade?.semantic).toMatchObject({ updateCapabilityResolved: false, confirmationPlanCreated: false });
    const inconnue = harness([CUPRA], [], { understand: compris('ACCOUNT_FACT_ASSET', [], [], { mode: 'UPDATE_PROPOSAL', supplied: [{ targetHint: 'Tesla', fieldKey: 'leaseEndDate', normalizedValue: '2027-05-21', role: 'update' }] }) });
    const c = await inconnue.ask('La date de fin de LLD de la Tesla est le 21/05/2027');
    expect(c.answer).toMatch(/Je n’ai pas trouvé « Tesla »/);
    expect(inconnue.propose).not.toHaveBeenCalled();
    expect(ecritures()).toEqual([]);
  });

  it('T2-419-05d — pure : capacité résolue par le serveur (jamais table / colonne / identifiant), valeur revalidée contre le message', () => {
    expect(P.updateCapabilityFor('mileage')?.type).toBe('asset_field');
    expect(P.updateCapabilityFor('leaseEndDate')?.def.sections).toEqual({ IMMOBILIER: 'occupancy_usage', VEHICULE: 'vehicle_usage' });
    for (const k of ['assets.characteristics', 'vin', 'operationId', null]) expect(P.updateCapabilityFor(k)).toBeNull();
    const def = P.updateCapabilityFor('leaseEndDate')!.def;
    expect(P.validateSuppliedValue(def, { value: null, normalizedValue: '2027-05-21' }, 'fin le 21/05/2027', '2026-10-14')).toBe('2027-05-21');
    expect(P.validateSuppliedValue(def, { value: null, normalizedValue: '2027-02-30' }, 'fin le 30/02/2027', '2026-10-14')).toBeNull();
    expect(P.validateSuppliedValue(def, { value: null, normalizedValue: '2028-01-01' }, 'fin le 21/05/2027', '2026-10-14')).toBeNull();
  });

  it('T2-419-05e — la proposition tient compte de la situation du bien (« Fin de contrat prévue » hors LLD / LOA : refusée)', async () => {
    const r = await P.prepareUpdateProposal(
      { accountId: 1, userId: 2, planType: 'PREMIUM', message: 'fin de LLD de la Polo le 21/05/2027', clientRequestId: 'x', locale: 'fr-FR' } as never,
      { fact: { targetHint: 'Polo', fieldKey: 'leaseEndDate', topic: null, value: null, normalizedValue: '2027-05-21', unit: null, role: 'update', confidence: 'exact' }, assetId: 12 },
      lookup,
    );
    expect(r).toMatchObject({ kind: 'need_info', reason: 'RESOLUTION' });
    expect(ecritures()).toEqual([]);
  });

  it('T2-419-06 (F) — « La LLD finit le 21/05/2027, combien de mensualités me reste-t-il ? » (MIXED, rôle contexte) : aucune proposition', async () => {
    const h = harness([CUPRA], [lld('2027-05-21')], {
      understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], ['mensualités'], {
        mode: 'MIXED', supplied: [{ targetHint: 'Cupra', fieldKey: 'leaseEndDate', normalizedValue: '2027-05-21', role: 'context' }],
      }),
    });
    const r = await h.ask('La LLD de la Cupra finit le 21/05/2027, combien de mensualités me reste-t-il ?');
    expect(h.propose).not.toHaveBeenCalled();
    expect(r.commandPlan ?? null).toBeNull();
    expect(r.cascade?.semantic?.interactionMode).toBe('MIXED');
    expect(r.cascade?.semantic?.confirmationPlanCreated).toBe(false);
    expect(ecritures()).toEqual([]);
  });

  it('T2-419-06b — CONTEXT_ONLY : accusé de lecture, rien d’enregistré, aucun plan', async () => {
    const h = harness([CUPRA], [], { understand: compris('ACCOUNT_FACT_ASSET', [], [], { mode: 'CONTEXT_ONLY', supplied: [{ targetHint: 'Cupra', normalizedValue: '2027-05-21', role: 'context' }] }) });
    const r = await h.ask('Pour info, la LLD de la Cupra se termine le 21/05/2027');
    expect(r.answer).toMatch(/Je n’ai rien modifié/);
    expect(h.propose).not.toHaveBeenCalled();
    expect(r.commandPlan ?? null).toBeNull();
  });

  it('T2-419-06c — pure : la nature vient de T2, jamais de la forme de la phrase (QUERY + information = aucune proposition)', () => {
    const f = { targetHint: 'Cupra', fieldKey: 'leaseEndDate', topic: null, value: '21/05/2027', normalizedValue: '2027-05-21', unit: null, confidence: 'exact' as const };
    expect(interactionHandling({ mode: 'QUERY', suppliedFacts: [{ ...f, role: 'update' }] })).toBeNull();
    expect(interactionHandling({ mode: 'MIXED', suppliedFacts: [{ ...f, role: 'context' }] })).toBeNull();
    expect(interactionHandling({ mode: 'UPDATE_PROPOSAL', suppliedFacts: [{ ...f, role: 'unknown' }] })).toBe('proposal');
    expect(interactionHandling({ mode: 'UPDATE_PROPOSAL', suppliedFacts: [{ ...f, role: 'context' }] })).toBeNull();
    expect(interactionHandling({ mode: 'AMBIGUOUS', suppliedFacts: [{ ...f, role: 'update' }] })).toBe('proposal');
    expect(interactionHandling({ mode: 'CONTEXT_ONLY', suppliedFacts: [] })).toBe('context_only');
    expect(updateFactsOf({ mode: 'ACTION_REQUEST', suppliedFacts: [{ ...f, role: 'update', value: null, normalizedValue: null }] })).toEqual([]);
  });

  it('T2-419-06d (CC5) — modifications désactivées ou compte en lecture seule : aucune proposition, aucune écriture', async () => {
    const coupe = harness([CUPRA], [], { understand: LLD_PROPOSAL, proposals: false });
    const a = await coupe.ask('La date de fin de LLD de la Cupra est le 21/05/2027');
    expect(a.answer).toMatch(/rien n’a été modifié/);
    expect(a.commandPlan ?? null).toBeNull();
    const lecture = harness([CUPRA], [], { understand: LLD_PROPOSAL });
    const b = await lecture.ask('La date de fin de LLD de la Cupra est le 21/05/2027', { planLimit: { reason: 'TRIAL_ENDED' } });
    expect(b.commandPlan ?? null).toBeNull();
    expect(lecture.propose).not.toHaveBeenCalled();
    expect(ecritures()).toEqual([]);
  });
});

// ── Test G / CC8 — fast-path explicite conservé ───────────────────────────

describe('#419 test G / CC8 — commande explicite', () => {
  it('T2-419-07 — « Mets le kilométrage de la Polo à 45 000 km. » : fast-path déterministe (aucun UNDERSTAND, aucune proposition IA)', async () => {
    const h = harness([POLO], [], { understand: compris('UNKNOWN', [], []) });
    const prepareCommand = vi.fn(async (input: import('../../../types/contracts').AssistantRequestInput) => {
      const r = await P.prepareCommand(input, { ...lookup, async findAssets(_a, w) { return w.some((x) => /polo/.test(x)) ? [{ id: 12, name: 'Polo' }] : []; } });
      return r && r.kind === 'plan' ? { kind: 'plan' as const, preview: r.preview } : r;
    });
    h.ports.prepareCommand = prepareCommand as never;
    const r = await h.ask('Mets le kilométrage de la Polo à 45 000 km.');
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.propose).not.toHaveBeenCalled();
    expect(n(r.commandPlan?.summary)).toBe('Modifier « Kilométrage » de Polo : 80 000 km → 45 000 km. Confirmez-vous ?');
    expect(ecritures()).toEqual([]);
  });
});

// ── Écart 6 — confidence = ambiguous (test H) ─────────────────────────────

describe('#419 écart 6 / CC6 — confidence=ambiguous respectée', () => {
  const AMBIGU = compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], ['formentor'], { confidence: 'ambiguous' });
  it('T2-419-08 (H) — un seul libellé correspond mais d’autres lectures existent : aucune réponse arbitraire, clarification', async () => {
    const h = harness([CUPRA], [lld('2027-06-30'), assurance()], { understand: AMBIGU });
    const r = await h.ask('Quand finit la Formentor de la Cupra ?');
    expect(r.answer).not.toMatch(/se termine le/);
    expect(r.clarification?.candidates.map((c) => c.label).sort()).toEqual(['Contrat « Assurance auto »', 'Contrat « LLD Cupra Formentor »']);
    expect(r.cascade?.semantic?.clarificationReason).toBe('SEMANTIC_UNDERSTANDING_AMBIGUOUS');
  });
  it('T2-419-08b — arbitrage T2 « probable » sur une demande ambiguë : insuffisant (exact exigé) ; « exact » : servi', async () => {
    const probable = await harness([CUPRA], [lld('2027-06-30'), assurance()], { understand: AMBIGU, arbitrate: choisir(/LLD/, 'probable') }).ask('Quand finit la Formentor de la Cupra ?');
    expect(probable.clarification).not.toBeNull();
    expect(probable.cascade?.semantic?.candidateValidationFailure).toBe('INSUFFICIENT_CONFIDENCE');
    const exact = await harness([CUPRA], [lld('2027-06-30'), assurance()], { understand: AMBIGU, arbitrate: choisir(/LLD/, 'exact') }).ask('Quand finit la Formentor de la Cupra ?');
    expect(exact.answer).toBe('Contrat « LLD Cupra Formentor » (Cupra) se termine le 30 juin 2027.');
  });
  it('T2-419-08c — preuve STRUCTURÉE forte (champ du registre demandé) : l’ambiguïté peut être levée par le serveur', async () => {
    const champ = extra({ ref: 'field:7:insuranceExpiry', domain: 'field', label: 'Échéance de l’assurance', assetId: 7, fieldKey: 'insuranceExpiry', date: '2026-12-31', endDate: '2026-12-31' });
    // Autre lecture possible (intervention datée, non désignée par la question) : le champ demandé fait preuve.
    const revision = op({ assetIds: [7], typeCode: 'INTERVENTION', technicalLabel: 'Révision', effectiveTo: '2026-11-30' });
    const h = harness([CUPRA], [revision], { understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], [], { facts: ['insuranceExpiry'], confidence: 'ambiguous' }), extras: [champ] });
    const r = await h.ask('Quand finit le contrat de la Cupra ?');
    expect(r.answer).toBe('Échéance de l’assurance (Cupra) : 2026-12-31.');
  });
});

// ── Test I / CC8 — STRONG inchangé ─────────────────────────────────────────

describe('#419 test I / CC8 — décisions déterministes fortes, sans appel IA', () => {
  it.each(['Quelles sont mes échéances ?', 'Que dois-je traiter ?', 'Quels documents ne sont rattachés à aucun bien ?'])('T2-419-09 — « %s » : route déterministe FORTE', (q) => {
    const o = routeDeterministic({ message: q, planType: 'PREMIUM', hasPendingClarification: false });
    expect(o.kind).toBe('route');
    if (o.kind === 'route') expect(o.route.deterministicConfidence ?? 'STRONG').toBe('STRONG');
  });
  it('T2-419-09b — « Combien ai-je dépensé en abonnements pour la Maison ? » : calcul structuré, ni UNDERSTAND ni arbitrage', async () => {
    const h = harness([MAISON], [orangeFibre(), netflix()], { arbitrate: choisir(/Orange/) });
    const port = {
      today: () => '2026-10-14',
      listAssets: async () => [{ id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' }],
      findAssets: async (_a: number, w: string[]) => (w.some((x) => /maison/i.test(x)) ? [{ id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' }] : []),
      sumQualifiedExpenses: async () => ({ qualifiedSumCents: 5348, byTheme: [{ theme: 'subscription', label: 'abonnements', sumCents: 5348, count: 2 }], unqualified: { count: 0 }, excluded: { count: 0 }, complete: true }),
    } as never;
    h.ports.answerFromData = (route, input, thresholds) => answerFromData({ port, accountId: 1, message: input.message, thresholds, intent: route.intent });
    const r = await h.ask('Combien ai-je dépensé en abonnements pour la Maison ?');
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.arbitrate).not.toHaveBeenCalled();
    expect(r.cascade?.strategy).toBe('structured.sum_qualified');
  });
});

// ── Test J — aucun lexique métier ajouté ──────────────────────────────────

describe('#419 test J — aucun mapping lexical codé en dur', () => {
  it('T2-419-10 — internet → Orange, fibre → abonnement, Cupra → LLD : absents du code de sélection, d’interaction et de proposition', () => {
    const racine = join(process.cwd(), 'src/services/verebona-assistant');
    for (const f of ['core/semantic-scope.ts', 'core/semantic-stage.ts', 'core/interaction.ts', 'canonical/business-sources.ts', 'canonical/structured-answers.ts',
      'core/intent-router.service.ts', 'commands/plan.service.ts', 'core/assistant-orchestrator.service.ts']) {
      const src = readFileSync(join(racine, f), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).join('\n');
      expect(src, f).not.toMatch(/internet|fibre|orange|\bfree\b|cupra|\blld\b|leasing/i);
    }
  });
});

// ── Écart 7 — barrière transversale ───────────────────────────────────────

describe('#419 écart 7 / CC7 — garde-fou d’élargissement transversal', () => {
  it('T2-419-11 — chaque stratégie structurée DÉCLARE sa portée ; une stratégie sans garde dédiée (coût de possession) est protégée', async () => {
    expect(Object.keys(STRATEGY_SCOPE).sort()).toEqual([
      'structured.acquisition_price', 'structured.asset_field', 'structured.claim_status', 'structured.contracts', 'structured.missing_information',
      'structured.operation_cost', 'structured.operation_history', 'structured.ownership_cost', 'structured.payments', 'structured.sum_qualified',
      'structured.upcoming_agenda',
    ]);
    expect(structuredScopeBarrier('structured.ownership_cost', 'Combien m’a coûté internet au total pour la Maison ?', ['Maison']))
      .toEqual({ semanticScopeResolved: false, unresolvedSemanticTerms: ['internet'] });
    expect(structuredScopeBarrier('structured.ownership_cost', 'Combien m’a coûté la Polo au total ?', ['Polo']).semanticScopeResolved).toBe(true);
    const port = {
      today: () => '2026-10-14',
      listAssets: async () => [{ id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' }],
      readOwnershipCost: vi.fn(async () => ({ status: 'COMPLETE', totalCents: 999999 })),
    } as never;
    const scope = async () => ({ assets: [{ id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' }], ambiguous: false, unresolved: false, label: 'Maison' });
    const r = await tryCanonicalStructured({ port, accountId: 1, message: 'Combien m’a coûté internet au total pour la Maison ?', resolveScope: scope as never });
    expect(r).toEqual({ scopeUnresolved: { strategyCandidate: 'structured.ownership_cost', terms: ['internet'], assetIds: [3] } });
    // Barrière AVANT exécution : le service TCO n'est même pas lu.
    expect((port as { readOwnershipCost: ReturnType<typeof vi.fn> }).readOwnershipCost).not.toHaveBeenCalled();
  });
});

// ── Écart 8 — sources extensibles ─────────────────────────────────────────

describe('#419 écart 8 — sources métier extensibles', () => {
  it('T2-419-12 — un domaine nouveau (« À traiter ») s’ajoute par un fournisseur : listé, sélectionné, servi, sans modifier l’orchestrateur', async () => {
    const retirer = registerBusinessSourceProvider({
      domain: 'to_process',
      descriptor: { domain: 'to_process', authority: 2, structured: true, noun: 'élément à traiter' },
      list: async () => [extra({ ref: 'to_process:5', domain: 'to_process', label: 'Relevé compteur eau', assetId: 3, date: '2026-11-02', endDate: '2026-11-02' })],
    });
    try {
      const lu = await listBusinessSources(1, { assetIds: [3], need: { terms: ['compteur'], facts: [], need: 'date' } });
      expect(lu.domains).toContain('to_process');
      const sel = S.selectInterpretations(lu.sources, { terms: ['compteur'], facts: [], need: 'date' });
      expect(sel.selected.map((s) => s.ref)).toEqual(['to_process:5']);
      expect(S.sourceDomain('to_process').authority).toBe(2);
      expect(S.semanticQuestion([sel.selected[0], { ...sel.selected[0], ref: 'to_process:6' }])).toBe('De quel élément à traiter parlez-vous ?');
    } finally {
      retirer();
    }
    expect((await listBusinessSources(1, { assetIds: [3], need: { terms: ['compteur'], facts: [], need: 'date' } })).domains).not.toContain('to_process');
  });
});

// ── Écarts 3 / 9 — contrat UNDERSTAND, prompt, observabilité ──────────────

describe('#419 écarts 3 et 9 — contrat UNDERSTAND, prompt T2, données transmises', () => {
  const BASE = { mode: 'UNDERSTAND', intent: 'ACCOUNT_FACT_ASSET', confidence: 'exact', entityHints: [], requestedFacts: [], requestedTopics: [], filters: {}, reason: '' };
  it('T2-419-13 — QUERY / UPDATE_PROPOSAL / CONTEXT_ONLY / ACTION_REQUEST / MIXED / AMBIGUOUS représentables ; sortie antérieure toujours valide', () => {
    for (const m of ['QUERY', 'UPDATE_PROPOSAL', 'CONTEXT_ONLY', 'ACTION_REQUEST', 'MIXED', 'AMBIGUOUS']) {
      expect(T2UnderstandOutput.parse({ ...BASE, interactionMode: m }).interactionMode).toBe(m);
    }
    const ancienne = T2UnderstandOutput.parse(BASE);
    expect(ancienne).toMatchObject({ interactionMode: 'QUERY', suppliedFacts: [] });
    expect(T2UnderstandOutput.safeParse({ ...BASE, interactionMode: 'WRITE' }).success).toBe(false);
    const u = toT2Understanding(T2UnderstandOutput.parse({
      ...BASE, interactionMode: 'UPDATE_PROPOSAL',
      suppliedFacts: [
        { targetHint: 'Cupra', fieldKey: 'leaseEndDate', value: '21/05/2027', normalizedValue: '2027-05-21', role: 'update' },
        { targetHint: 'Cupra', fieldKey: 'assets.characteristics', value: 'x', role: 'update' },
      ],
      semanticDecision: { decision: 'SELECT', selectedCandidateRef: 'C1', confidence: 'exact', reason: 'r' },
    }));
    expect(u.interaction.mode).toBe('UPDATE_PROPOSAL');
    expect(u.interaction.suppliedFacts[0]).toMatchObject({ fieldKey: 'leaseEndDate', normalizedValue: '2027-05-21', role: 'update' });
    // Clé hors FIELD_CATALOG : jamais une destination — rabattue en sujet.
    expect(u.interaction.suppliedFacts[1]).toMatchObject({ fieldKey: null, topic: 'assets.characteristics' });
    expect(u.semanticDecision).toMatchObject({ decision: 'SELECT', selectedCandidateRef: 'C1' });
  });

  it('T2-419-13b — prompt maître T2 : règles A7–A9 et emplacement FACULTATIF {{BUSINESS_CANDIDATES}} (version BO antérieure toujours valide)', () => {
    const texte = readFileSync(join(process.cwd(), 'src/services/ai/prompts/assistant/t2_master_v1.txt'), 'utf8');
    expect(texte).toMatch(/A7 — `interactionMode`/);
    expect(texte).toMatch(/A9 — Si des candidats métier sont fournis/);
    expect(texte).toContain('{{BUSINESS_CANDIDATES}}');
    expect(T2_MASTER_VARIABLES).toContain('BUSINESS_CANDIDATES');
    expect(OPTIONAL_MASTER_VARIABLES.t2_master_v1).toEqual(['BUSINESS_CANDIDATES']);
    const vars = Object.fromEntries(T2_MASTER_VARIABLES.map((v) => [v, null]));
    const ancien = texte.replace('Candidats métier exposés par le serveur (arbitrage) : {{BUSINESS_CANDIDATES}}\n\n', '');
    expect(() => renderMasterPrompt(ancien, { masterPromptCode: 't2_master_v1', task: 'UNDERSTAND', variables: vars, allowedTasks: ['UNDERSTAND', 'ANSWER', 'REVALIDATE'] })).not.toThrow();
  });

  it('T2-419-13c — observabilité : candidats présentés = références serveur ; données sensibles masquées dans {{BUSINESS_CANDIDATES}}', () => {
    const json = formatBusinessCandidates([{ ref: 'C1', kind: 'contrat', label: 'Prélèvement FR76 3000 6000 0112 3456 7890 189', detail: null, asset: 'Maison', carriesRequestedValue: true }], 'Je paye combien pour internet ?');
    expect(json).not.toMatch(/FR76 3000 6000 0112 3456 7890 189/);
    expect(JSON.parse(json)[0]).toMatchObject({ ref: 'C1', kind: 'contrat', carriesRequestedValue: true });
    const t = S.emptySemanticTrace({ trigger: 'none', deterministicMatch: null, deterministicConfidence: 'STRONG' });
    for (const k of ['candidateSelectionMode', 'semanticDecision', 'semanticDecisionConfidence', 'candidateRefsPresentedToAI', 'candidateRefSelectedByAI',
      'candidateRefValidated', 'candidateValidationFailure', 'interactionMode', 'suppliedFactsCount', 'updateCapabilityResolved', 'updateTargetType', 'confirmationPlanCreated']) {
      expect(t).toHaveProperty(k);
    }
  });
});

describe('#419 écart 1 — version de prompt maître antérieure (action BO non faite)', () => {
  it('T2-419-14 — prompt actif sans {{BUSINESS_CANDIDATES}} : aucun appel d’arbitrage dépensé, clarification prudente', async () => {
    const h = harness([MAISON], [orangeFibre(), netflix()], {
      understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'maison' }], ['internet']), arbitrate: choisir(/Orange/),
    });
    h.ports.canArbitrateWithAI = async () => false;
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(h.arbitrate).not.toHaveBeenCalled();
    expect(r.answer).not.toMatch(/€/);
    expect(r.clarification?.candidates).toHaveLength(2);
    expect(r.cascade?.escalationReasons).toContain('SEMANTIC:ARBITRATION_PROMPT_UNSUPPORTED');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// LOT 59 (59B) — « Finaliser le ticket #419 » : 8 corrections (R01…R08),
// configuration T2 effective et réponses IA non scriptées.
// ══════════════════════════════════════════════════════════════════════════

const { remainingPeriods, remainingCountUnit, memeRealite, lexicalMatchEstablished, diversifiedCandidates } = S;
const { contextCalculationAnswer, validateContextFacts, contextFactsOf } = await import('../../interaction');
const { t2PromptCapabilities } = await import('@/services/ai/assistant/master/t2-prompt-capabilities');
const { aujourdhuiParis } = await import('../../query-period');

const docOp = (fileId: number, title: string, amountCents: number | null = null, date: string | null = null) =>
  ({ fileId, role: null, title, date, amountCents, documentTypeCode: null });
const MAISON_Q = (topics: string[], o: Parameters<typeof compris>[3] = {}) => compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'maison' }], topics, o);

describe('#419 R01 — une Opération ne masque une pièce que si elle porte la valeur demandée', () => {
  it('T2-419-R01 — contrat Internet SANS montant + facture 39,99 € RATTACHÉE à cette Opération : montant restitué, sans doublon ni absence affirmée', async () => {
    const contrat = op({ assetIds: [3], technicalLabel: 'Contrat Internet', provider: 'Sosh', documents: [docOp(950, 'Contrat Sosh'), docOp(951, 'Facture Sosh octobre', 3999, '2026-10-02')] as never });
    const facture = extra({ ref: 'document:951', domain: 'document', label: 'Facture Sosh octobre', assetId: 3, amountCents: 3999, date: '2026-10-02', provider: 'Sosh' });
    const h = harness([MAISON], [contrat], { understand: MAISON_Q(['internet']), extras: [facture], arbitrate: () => ({ decision: 'NONE', confidence: 'exact' }) });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(n(r.answer)).toBe('« Facture Sosh octobre » (Maison) : 39,99 € (2 octobre 2026).');
    expect(r.answer).not.toMatch(/aucun montant|79,98/);
    expect(h.arbitrate).not.toHaveBeenCalled();
    expect(r.cascade?.semantic).toMatchObject({ candidateSelectionMode: 'deterministic', selectedSource: 'document:951' });
  });

  it('T2-419-R01b — pure : Opération qui CONSOLIDE déjà le montant → la pièce reste représentée (aucun double comptage, exclusion tracée)', () => {
    const o = operationBusinessSource(op({ assetIds: [3], technicalLabel: 'Contrat Internet', provider: 'Sosh', components: [cout(3999, '2026-10-02')], documents: [docOp(951, 'Facture Sosh octobre', 3999, '2026-10-02')] as never }), 3, 'Maison');
    const f = extra({ ref: 'document:951', domain: 'document', label: 'Facture Sosh octobre', assetId: 3, amountCents: 3999, date: '2026-10-02' });
    const sel = S.selectInterpretations([o, f], { terms: ['internet'], facts: [], need: 'amount' });
    expect(sel.selected).toEqual([o]);
    expect(sel.excluded).toEqual([{ ref: 'document:951', reason: 'REPRESENTED_BY_OPERATION' }]);
    expect(answerFromBusinessSource(sel.selected[0], 'amount', { assetName: 'Maison' }).text).not.toMatch(/79,98/);
  });

  it('T2-419-R01c — pure : tarif ANNONCÉ (prévisionnel) ≠ facture réelle rattachée ; preuve de paiement dite « réglé »', () => {
    const o = operationBusinessSource(op({ assetIds: [3], technicalLabel: 'Contrat Internet', components: [{ ...cout(2999, '2026-01-01'), kind: 'FORECAST_COST' as const }], documents: [docOp(951, 'Facture octobre', 3999, '2026-10-02')] as never }), 3, 'Maison');
    const f = extra({ ref: 'document:951', domain: 'document', label: 'Facture octobre', assetId: 3, amountCents: 3999, date: '2026-10-02' });
    const sel = S.selectInterpretations([o, f], { terms: ['internet'], facts: [], need: 'amount' });
    expect(sel.selected.map((s) => s.ref)).toEqual(['document:951']);
    expect(sel.reason).toBe('COMPLEMENTARY_SAME_REALITY');
    const preuve = { ...f, meta: { amountNature: 'payment' } };
    expect(n(answerFromBusinessSource(preuve, 'amount').text)).toBe('« Facture octobre » : montant réglé 39,99 € (2 octobre 2026).');
  });
});

describe('#419 R02 — signification métier des dates', () => {
  it('T2-419-R02 — contrat SANS date de fin + facture datée (non rattachée) : aucune date de fin inventée', async () => {
    const contrat = op({ assetIds: [3], technicalLabel: 'Contrat Internet', provider: 'Sosh', effectiveFrom: '2025-01-01' });
    const facture = extra({ ref: 'document:960', domain: 'document', label: 'Facture Internet septembre', assetId: 3, amountCents: 3999, date: '2026-09-02', provider: 'Sosh' });
    const h = harness([MAISON], [contrat], { understand: MAISON_Q(['contrat', 'internet']), extras: [facture] });
    const r = await h.ask('Quand se termine mon contrat internet à la maison ?');
    expect(r.answer).not.toMatch(/2 septembre 2026|2026-09-02/);
    expect(n(r.answer)).toBe('Contrat « Contrat Internet » (Maison) : aucune date de fin n’est renseignée.');
  });

  it('T2-419-R02b — pure : document_date / date d’effet ne portent jamais une date de fin ; échéance (endDate) oui', () => {
    const facture = extra({ ref: 'document:1', domain: 'document', label: 'Facture', assetId: 3, date: '2026-09-02' });
    expect(S.carriesRequestedValue(facture, 'end_date')).toBe(false);
    expect(S.carriesRequestedValue(facture, 'date')).toBe(true);
    expect(n(answerFromBusinessSource(facture, 'end_date').text)).toBe('« Facture » : aucune date de fin n’est renseignée.');
    expect(S.carriesRequestedValue(operationBusinessSource(lld(null), 7, 'Cupra'), 'end_date')).toBe(false);
    expect(S.carriesRequestedValue(extra({ ref: 'agenda:1', domain: 'agenda', label: 'Échéance', assetId: 3, endDate: '2027-01-01' }), 'end_date')).toBe(true);
  });
});

describe('#419 R03 — même réalité métier : preuve explicite exigée', () => {
  it('T2-419-R03 — deux contrats différents chez le même fournisseur, même bien : aucune fusion, T2 arbitre', async () => {
    const fibre = op({ assetIds: [3], technicalLabel: 'Orange Fibre', provider: 'Orange', components: [cout(3999, '2026-09-02')] });
    const mobile = extra({ ref: 'document:970', domain: 'document', label: 'Facture Orange Mobile', assetId: 3, amountCents: 1999, date: '2026-09-05', provider: 'Orange' });
    const h = harness([MAISON], [fibre], { understand: MAISON_Q(['orange']), extras: [mobile], arbitrate: choisir(/Mobile/) });
    const r = await h.ask('Je paye combien chez orange à la maison ?');
    expect(h.arbitrate).toHaveBeenCalledTimes(1);
    expect((h.arbitrate.mock.calls[0][2] as Cand[]).map((c) => c.label).sort()).toEqual(['Contrat « Orange Fibre »', 'Facture Orange Mobile']);
    expect(n(r.answer)).toBe('« Facture Orange Mobile » (Maison) : 19,99 € (5 septembre 2026).');
    expect(r.cascade?.semantic?.selectionReason).toBe('MULTIPLE_PLAUSIBLE');
  });

  it('T2-419-R03b — pure : prestataire + bien insuffisants ; rattachement, référence contractuelle : preuves', () => {
    const o = operationBusinessSource(op({ assetIds: [3], technicalLabel: 'Box', provider: 'Orange', contractReference: 'C-123', documents: [docOp(5, 'Facture')] as never }), 3, 'Maison');
    expect(memeRealite(o, extra({ ref: 'document:9', domain: 'document', label: 'Autre', assetId: 3, provider: 'Orange' }))).toBe(false);
    expect(memeRealite(o, extra({ ref: 'document:5', domain: 'document', label: 'Facture', assetId: 3 }))).toBe(true);
    expect(memeRealite(o, { ...extra({ ref: 'agenda:2', domain: 'agenda', label: 'Échéance', assetId: 3 }), meta: { contractReference: 'c-123' } })).toBe(true);
    const deux = [o, operationBusinessSource(op({ assetIds: [3], technicalLabel: 'Box 2', provider: 'Orange', components: [cout(100, '2026-01-01')] }), 3, 'Maison')];
    expect(S.selectInterpretations([{ ...deux[0], amountCents: 5 }, deux[1]], { terms: ['box'], facts: [], need: 'amount' }).selected).toHaveLength(2);
  });
});

describe('#419 R04 — T2 arbitre entre TOUS les domaines pertinents', () => {
  it('T2-419-R04 — formulation différente des libellés : candidats de plusieurs domaines exposés à T2 (opérations ET documents)', async () => {
    const sosh = op({ assetIds: [3], technicalLabel: 'Abonnement Sosh', provider: 'Sosh', components: [cout(2999, '2026-09-02')] });
    const releve = extra({ ref: 'document:980', domain: 'document', label: 'Relevé box', assetId: 3, amountCents: 3500, date: '2026-09-20' });
    const h = harness([MAISON], [sosh, netflix()], { understand: MAISON_Q(['connexion']), extras: [releve], arbitrate: choisir(/Relevé/) });
    const r = await h.ask('Combien me coûte ma connexion à la maison ?');
    const kinds = (h.arbitrate.mock.calls[0][2] as Cand[]).map((c) => c.kind);
    expect(kinds).toContain('document');
    expect(kinds).toContain('contrat');
    expect(n(r.answer)).toBe('« Relevé box » (Maison) : 35,00 € (20 septembre 2026).');
    expect(r.cascade?.semantic?.candidateSelectionMode).toBe('ai');
  });

  it('T2-419-R04b — correspondance lexicale TROMPEUSE (« box » ≠ box internet) : pas de sélection directe, T2 arbitre', async () => {
    const rangement = op({ assetIds: [3], typeCode: 'ACQUISITION', technicalLabel: 'Box de rangement', components: [cout(4500, '2026-03-01')] });
    const sosh = op({ assetIds: [3], technicalLabel: 'Abonnement Sosh', provider: 'Sosh', components: [cout(2999, '2026-09-02')] });
    const h = harness([MAISON], [rangement, sosh], { understand: MAISON_Q(['box internet']), arbitrate: choisir(/Sosh/) });
    const r = await h.ask('Combien je paye pour la box internet à la maison ?');
    expect(h.arbitrate).toHaveBeenCalledTimes(1);
    expect(r.answer).not.toMatch(/45,00/);
    expect(n(r.answer)).toMatch(/^Contrat « Abonnement Sosh » \(Maison\) : dernier montant documenté 29,99 €/);
    expect(r.cascade?.semantic?.lexicalMatchEstablished).toBe(false);
    // Sans arbitrage possible : clarification, jamais la box de rangement.
    const sans = await harness([MAISON], [rangement, sosh], { understand: MAISON_Q(['box internet']) }).ask('Combien je paye pour la box internet à la maison ?');
    expect(sans.answer).not.toMatch(/€/);
    expect(sans.clarification?.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('T2-419-R04c — pure : correspondance établie (tous les sujets) vs partielle ; candidats répartis par domaine et bornés', () => {
    const s = extra({ ref: 'operation:1', domain: 'operation', label: 'Box internet', assetId: 3 });
    expect(lexicalMatchEstablished(s, { terms: ['box', 'internet'], facts: [], need: 'amount' }, ['box internet'])).toBe(true);
    // Sujets ALTERNATIFS : un sujet entièrement retrouvé suffit (« fibre » parmi internet / fibre / box internet).
    expect(lexicalMatchEstablished(extra({ ref: 'operation:3', domain: 'operation', label: 'Orange Fibre', assetId: 3 }), { terms: ['internet', 'fibre'], facts: [], need: 'amount' }, ['internet', 'fibre', 'box internet'])).toBe(true);
    expect(lexicalMatchEstablished(extra({ ref: 'operation:2', domain: 'operation', label: 'Box de rangement', assetId: 3 }), { terms: ['box', 'internet'], facts: [], need: 'amount' }, ['box internet'])).toBe(false);
    const ops = Array.from({ length: 20 }, (_, i) => extra({ ref: `operation:${i}`, domain: 'operation', label: `Op ${i}`, assetId: 3 }));
    const docs = Array.from({ length: 5 }, (_, i) => extra({ ref: `document:${i}`, domain: 'document', label: `Doc ${i}`, assetId: 3 }));
    const d = diversifiedCandidates([...ops, ...docs], 12);
    expect(d).toHaveLength(12);
    expect(d.filter((x) => x.domain === 'document')).toHaveLength(5);
  });
});

describe('#419 R05 — ambiguïté reconnue par T2 strictement respectée', () => {
  const AMBIGU = compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], ['formentor'], { confidence: 'ambiguous' });
  it('T2-419-R05 — T2 « ambiguous », une seule source correspond lexicalement, aucun concurrent : pas de réponse arbitraire', async () => {
    const h = harness([CUPRA], [lld('2027-06-30')], { understand: AMBIGU });
    const r = await h.ask('Quand finit la Formentor de la Cupra ?');
    expect(r.answer).not.toMatch(/se termine le/);
    expect(r.clarification?.question).toMatch(/votre question porte-t-elle sur Contrat « LLD Cupra Formentor »/);
    expect(r.cascade?.semantic?.clarificationReason).toBe('SEMANTIC_UNDERSTANDING_AMBIGUOUS');
  });
  it('T2-419-R05b — arbitrage IA validé (« exact ») lève l’ambiguïté ; « probable » : clarification ; référence revalidée', async () => {
    const exact = await harness([CUPRA], [lld('2027-06-30')], { understand: AMBIGU, arbitrate: choisir(/LLD/, 'exact') }).ask('Quand finit la Formentor de la Cupra ?');
    expect(exact.answer).toBe('Contrat « LLD Cupra Formentor » (Cupra) se termine le 30 juin 2027.');
    const probable = await harness([CUPRA], [lld('2027-06-30')], { understand: AMBIGU, arbitrate: choisir(/LLD/, 'probable') }).ask('Quand finit la Formentor de la Cupra ?');
    expect(probable.answer).not.toMatch(/se termine le/);
    expect(probable.cascade?.semantic?.candidateValidationFailure).toBe('INSUFFICIENT_CONFIDENCE');
  });
});

describe('#419 R06 — protection généralisée contre l’élargissement du périmètre', () => {
  it('T2-419-R06 — « Combien m’a coûté Internet au total pour la maison ? » ne devient JAMAIS le TCO de la maison (parcours orchestrateur)', async () => {
    const h = harness([MAISON], [orangeFibre(), netflix()], { understand: MAISON_Q(['internet']), arbitrate: choisir(/Orange/) });
    const readOwnershipCost = vi.fn(async () => ({ status: 'COMPLETE', totalCents: 999999 }));
    const port = {
      today: () => '2026-10-14',
      listAssets: async () => [{ id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' }],
      findAssets: async (_a: number, w: string[]) => (w.some((x) => /maison/i.test(x)) ? [{ id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' }] : []),
      readOwnershipCost,
      sumQualifiedExpenses: vi.fn(async () => ({ qualifiedSumCents: 5348, byTheme: [], unqualified: { count: 0 }, excluded: { count: 0 }, complete: true })),
    } as never;
    h.ports.answerFromData = (route, input, thresholds) => answerFromData({ port, accountId: 1, message: input.message, thresholds, intent: route.intent });
    const r = await h.ask('Combien m’a coûté Internet au total pour la maison ?');
    expect(readOwnershipCost).not.toHaveBeenCalled();
    expect(r.answer).not.toMatch(/9 999,99|possession|53,48/);
    expect(r.cascade?.strategy).not.toBe('structured.ownership_cost');
    expect(n(r.answer)).toMatch(/Orange Fibre/);
  });

  it('T2-419-R06b — stratégies « désignées » (coût d’une intervention, échéances) : un sujet non porté par les données servies bloque la réponse', async () => {
    expect(STRATEGY_SCOPE['structured.operation_cost'].scope).toBe('designated');
    expect(structuredScopeBarrier('structured.operation_cost', 'Combien a coûté la réparation du toit de la véranda ?', ['Maison'], ['Coût de la réparation du toit : 1 200,00 €.'])
      .unresolvedSemanticTerms).toEqual(['veranda']);
    expect(structuredScopeBarrier('structured.operation_cost', 'Combien a coûté la réparation du toit ?', ['Maison'], ['Coût de la réparation du toit : 1 200,00 €.']).semanticScopeResolved).toBe(true);
    expect(structuredScopeBarrier('structured.upcoming_agenda', 'Quelles sont mes échéances ?', [], []).semanticScopeResolved).toBe(true);
    const port = {
      today: () => '2026-10-14',
      listAssets: async () => [{ id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' }],
      listUpcomingAgenda: async () => [{ id: 1, title: 'Ramonage', date: '2026-11-02', forecast: false, assetNames: ['Maison'] }],
    } as never;
    const scope = async () => ({ assets: [{ id: 3, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' }], ambiguous: false, unresolved: false, label: 'Maison' });
    const r = await tryCanonicalStructured({ port, accountId: 1, message: 'Quelles sont mes prochaines échéances internet pour la Maison ?', resolveScope: scope as never });
    expect(r).toMatchObject({ scopeUnresolved: { strategyCandidate: 'structured.upcoming_agenda', terms: ['internet'] } });
  });
});

describe('#419 R07 — informations de contexte (MIXED) exploitées sans enregistrement', () => {
  const MIXED = (fact: Partial<Fact>) => compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Cupra' }], ['mensualités'], {
    mode: 'MIXED', supplied: [{ targetHint: 'Cupra', fieldKey: 'leaseEndDate', normalizedValue: '2027-05-21', role: 'context', ...fact }],
  });
  const Q = 'La LLD de la Cupra finit le 21/05/2027, combien de mensualités me reste-t-il ?';

  it('T2-419-R07 — date de fin apportée en contexte : calcul serveur, aucune proposition, aucune écriture', async () => {
    const h = harness([CUPRA], [lld(null)], { understand: MIXED({}) });
    const r = await h.ask(Q);
    const attendu = remainingPeriods(aujourdhuiParis(), '2027-05-21', 'month');
    expect(n(r.answer)).toContain(`il reste ${attendu} mois`);
    expect(r.answer).toMatch(/n’a pas été enregistrée/);
    expect(h.propose).not.toHaveBeenCalled();
    expect(r.commandPlan ?? null).toBeNull();
    expect(ecritures()).toEqual([]);
    expect(r.cascade?.semantic).toMatchObject({ interactionMode: 'MIXED', contextFactsUsed: ['leaseEndDate'], calculation: 'remaining_periods', confirmationPlanCreated: false });
  });

  it('T2-419-R07b — contradiction avec la donnée enregistrée : signalée, jamais tranchée, aucun calcul', async () => {
    const champ = extra({ ref: 'field:7:leaseEndDate', domain: 'field', label: 'Fin de bail / location', assetId: 7, fieldKey: 'leaseEndDate', date: '2027-06-30', endDate: '2027-06-30' });
    const h = harness([CUPRA], [], { understand: MIXED({}), extras: [champ] });
    const r = await h.ask(Q);
    expect(r.answer).toMatch(/Je ne tranche pas/);
    expect(r.answer).not.toMatch(/il reste/);
    expect(r.cascade?.semantic).toMatchObject({ contextContradiction: true, calculation: 'remaining_periods:contradiction' });
    expect(ecritures()).toEqual([]);
  });

  it('T2-419-R07c — valeur absente du message (inventée) ou information manquante : ce qui manque est expliqué, aucun calcul', async () => {
    const h = harness([CUPRA], [], { understand: MIXED({ normalizedValue: '2027-09-30' }) });
    const r = await h.ask(Q);
    expect(r.answer).toMatch(/il me manque une date de fin fiable/);
    expect(r.cascade?.semantic).toMatchObject({ contextFactsIgnored: 1, calculation: 'remaining_periods:missing' });
  });

  it('T2-419-R07d — pure : décompte, unité, rôle des informations', () => {
    expect(remainingPeriods('2026-10-15', '2027-05-21', 'month')).toBe(7);
    expect(remainingPeriods('2026-10-15', '2026-10-01', 'month')).toBe(0);
    expect(remainingPeriods('2026-01-31', '2026-03-01', 'month')).toBe(1);
    expect(remainingCountUnit(Q)).toBe('month');
    expect(remainingCountUnit('Combien de mensualités ai-je payées ?')).toBeNull();
    const f = { targetHint: 'Cupra', fieldKey: 'leaseEndDate', topic: null, value: null, normalizedValue: '2027-05-21', unit: null, confidence: 'exact' as const };
    expect(contextFactsOf({ mode: 'MIXED', suppliedFacts: [{ ...f, role: 'context' }, { ...f, role: 'update' }] })).toHaveLength(1);
    expect(validateContextFacts([{ ...f, role: 'context' }], Q, '2026-10-15').valid[0]).toMatchObject({ fieldKey: 'leaseEndDate', endDate: '2027-05-21' });
    expect(contextCalculationAnswer({ message: Q, today: '2026-10-15', facts: [], stored: [], assetName: null }).calculation).toBe('remaining_periods:missing');
  });
});

describe('#419 R08 — toutes les informations d’une proposition multiple', () => {
  const DEUX = (second: Partial<Fact>) => compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Polo' }], [], {
    mode: 'UPDATE_PROPOSAL', supplied: [
      { targetHint: 'Polo', fieldKey: 'mileage', value: '45 000 km', normalizedValue: '45000', unit: 'km', role: 'update' },
      { targetHint: 'Polo', role: 'update', ...second },
    ],
  });

  it('T2-419-R08 — deux modifications sur un même bien : UN plan avec les DEUX modifications, confirmation unique, rien écrit', async () => {
    const h = harness([POLO], [], { understand: DEUX({ fieldKey: 'estimatedValue', value: '12 000 €', normalizedValue: '12000' }) });
    const r = await h.ask('Le kilométrage de la Polo est de 45 000 km et sa valeur est de 12 000 €');
    expect(h.propose).toHaveBeenCalledTimes(1);
    expect(r.commandPlan?.actions).toHaveLength(2);
    expect(n(r.commandPlan?.summary)).toMatch(/^Je vais effectuer 2 modifications : Modifier « Kilométrage » de Polo : 80 000 km → 45 000 km ; Modifier « [^»]+ » de Polo : non renseigné → 12 000/);
    expect(r.commandPlan?.summary).toMatch(/Confirmez-vous l’ensemble \?$/);
    expect(ecritures()).toEqual([]);
    expect(r.cascade?.semantic).toMatchObject({ updateFactsProposed: 2, updateFactsRefused: [], confirmationPlanCreated: true });
  });

  it('T2-419-R08b — une information non modifiable : refus EXPLICITE du traitement multiple, aucun plan partiel', async () => {
    const h = harness([POLO], [], { understand: DEUX({ fieldKey: 'vin', value: 'VSSZZZ5FZRR000001' }) });
    const r = await h.ask('Le kilométrage de la Polo est de 45 000 km et son VIN est VSSZZZ5FZRR000001');
    expect(r.commandPlan ?? null).toBeNull();
    expect(r.answer).toMatch(/contient 2 informations ; je ne peux pas toutes les proposer/);
    expect(r.answer).toMatch(/séparément/);
    expect(r.cascade?.semantic).toMatchObject({ updateFactsProposed: 0, confirmationPlanCreated: false });
    expect(r.cascade?.semantic?.updateFactsRefused).toEqual([{ fieldKey: 'vin', reason: 'FIELD_NOT_WRITABLE' }]);
    expect(ecritures()).toEqual([]);
  });

  it('T2-419-R08c — deux valeurs différentes pour la même information : refus, aucun choix arbitraire', async () => {
    const h = harness([POLO], [], { understand: DEUX({ fieldKey: 'mileage', value: '46 000 km', normalizedValue: '46000', unit: 'km' }) });
    const r = await h.ask('Le kilométrage de la Polo est de 45 000 km, non 46 000 km');
    expect(r.commandPlan ?? null).toBeNull();
    expect(r.cascade?.semantic?.updateFactsRefused).toEqual([{ fieldKey: 'mileage', reason: 'CONFLICTING_VALUES' }]);
  });
});

describe('#419 — prompt T2 EFFECTIF (BO) contrôlé', () => {
  it('T2-419-R09 — texte livré : A7–A9, interactionMode, suppliedFacts, {{BUSINESS_CANDIDATES}} présents ; version antérieure : arbitrage impossible signalé', () => {
    const texte = readFileSync(join(process.cwd(), 'src/services/ai/prompts/assistant/t2_master_v1.txt'), 'utf8');
    const c = t2PromptCapabilities(texte);
    expect(c).toMatchObject({ arbitration: true, interaction: true, message: null });
    expect(c.checks.every((x) => x.present)).toBe(true);
    const ancien = t2PromptCapabilities(texte.replace(/\{\{BUSINESS_CANDIDATES\}\}/g, '').replace(/\nA9 —[^\n]*/, ''));
    expect(ancien.arbitration).toBe(false);
    expect(ancien.interaction).toBe(true);
    expect(ancien.message).toMatch(/Arbitrage sémantique IMPOSSIBLE/);
    expect(t2PromptCapabilities(texte.replace(/\nA7 —[^\n]*/, '')).interaction).toBe(false);
  });

  it('T2-419-R09b — version active sans A9 : aucun appel d’arbitrage, motif et version tracés', async () => {
    const h = harness([MAISON], [orangeFibre(), netflix()], { understand: MAISON_Q(['internet']), arbitrate: choisir(/Orange/) });
    h.ports.t2PromptCapabilities = async () => ({ arbitration: false, interaction: true, version: 'v3' });
    const r = await h.ask('Je paye combien pour internet à la maison ?');
    expect(h.arbitrate).not.toHaveBeenCalled();
    expect(r.answer).not.toMatch(/€/);
    expect(r.cascade?.semantic).toMatchObject({ arbitrationUnavailableReason: 'PROMPT_UNSUPPORTED', t2PromptCapabilities: { arbitration: false, version: 'v3' } });
  });
});

describe('#419 — réponses IA NON scriptées : la validation serveur tient', () => {
  /** Générateur pseudo-aléatoire déterministe (reproductible). */
  const alea = (graine: number) => () => ((graine = (graine * 1103515245 + 12345) % 2147483648) / 2147483648);

  it('T2-419-R10 — 60 décisions T2 génériques (références au hasard, confiances variées, NONE/CLARIFY) : jamais de référence non présentée servie, jamais de confiance insuffisante servie', async () => {
    const r = alea(59);
    const decisions: Array<'SELECT' | 'CLARIFY' | 'NONE'> = ['SELECT', 'SELECT', 'CLARIFY', 'NONE'];
    const confiances: Array<'exact' | 'probable' | 'ambiguous'> = ['exact', 'probable', 'ambiguous'];
    for (let i = 0; i < 60; i += 1) {
      const ambigu = r() < 0.3;
      const generique = (c: Cand[]): Decision => {
        const d = decisions[Math.floor(r() * decisions.length)];
        const refs = [...c.map((x) => x.ref), 'C9', 'operation:1', ''];
        return { decision: d, selectedCandidateRef: d === 'SELECT' ? refs[Math.floor(r() * refs.length)] : null, confidence: confiances[Math.floor(r() * 3)], reason: 'générique' };
      };
      const h = harness([MAISON], [orangeFibre(), freeFibre(), netflix()], { understand: MAISON_Q(['fibre'], { confidence: ambigu ? 'ambiguous' : 'probable' }), arbitrate: generique });
      const res = await h.ask('Je paye combien pour internet à la maison ?');
      const sem = res.cascade!.semantic!;
      const brut = await h.arbitrate.mock.results[0]?.value as Decision | undefined;
      if (/€/.test(res.answer)) {
        // Servi : uniquement une référence PRÉSENTÉE, confiance suffisante, jamais un contrat non présenté.
        expect(sem.candidateSelectionMode).toBe('ai');
        expect(sem.candidateRefValidated).toBe(true);
        expect(['C1', 'C2']).toContain(brut?.selectedCandidateRef);
        expect(brut?.confidence).not.toBe('ambiguous');
        if (ambigu) expect(brut?.confidence).toBe('exact');
        expect(res.answer).not.toMatch(/Netflix/);
      } else {
        expect(res.clarification != null || /Je n’ai trouvé aucune donnée/.test(res.answer)).toBe(true);
      }
      expect(ecritures()).toEqual([]);
    }
  });

  it('T2-419-R10b — UNDERSTAND générique (modes et informations au hasard, valeurs parfois absentes du message) : aucune écriture, aucun plan sur valeur non relue', async () => {
    const r = alea(419);
    const modes = ['QUERY', 'UPDATE_PROPOSAL', 'CONTEXT_ONLY', 'ACTION_REQUEST', 'MIXED', 'AMBIGUOUS'] as const;
    const roles = ['update', 'context', 'unknown'] as const;
    for (let i = 0; i < 30; i += 1) {
      const valeur = r() < 0.5 ? '45000' : String(10000 + Math.floor(r() * 90000));
      const h = harness([POLO], [], {
        understand: compris('ACCOUNT_FACT_ASSET', [{ type: 'asset', value: 'Polo' }], [], {
          mode: modes[Math.floor(r() * modes.length)],
          supplied: [{ targetHint: 'Polo', fieldKey: 'mileage', value: `${valeur} km`, normalizedValue: valeur, unit: 'km', role: roles[Math.floor(r() * 3)] }],
        }),
      });
      const res = await h.ask('Le kilométrage de la Polo est de 45 000 km');
      if (res.commandPlan) expect(n(res.commandPlan.summary)).toMatch(/→ 45 000 km/);
      expect(ecritures()).toEqual([]);
    }
  });
});
