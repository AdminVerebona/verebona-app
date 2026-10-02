/**
 * Machine à états par REPAIRING (§9.6), codes informatifs du §27.11, cache
 * de retrieval (§43, §28.7) et éligibilité par le registre des capacités
 * (§25.6).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => { throw new Error('aucune base en test'); }) },
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));

const { runAssistant, noticesFor, RETRIEVAL_CACHE_HIT_EVENT } = await import('../assistant-orchestrator.service');
const { ConversationMachine } = await import('../conversation-machine');
const { toApiPayload } = await import('../api-payload');
const { cachedRetrieve, retrievalCacheKey, invalidateRetrievalCacheForAccount, clearRetrievalCache, setCacheVersionStoreForTests } = await import('../retrieval-cache');
const { capabilityAllows, isAiEligibleFor, capabilitiesForPlan } = await import('../../registries/capability-registry');
const { routeForIntent } = await import('../intent-router.service');
type Ports = import('../assistant-orchestrator.service').OrchestratorPorts;
type Input = import('../../types/contracts').AssistantRequestInput;
type Result = import('../../types/contracts').AssistantRunResult;
type Source = import('../../types/sources').RetrievedSource;

const SOURCES: Source[] = [{ id: 'doc_1', type: 'document', title: 'Garantie', content: 'Garantie 2 ans.', relevanceScore: 0.9 }];
const INPUT: Input = { accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Résume les garanties de mon vélo', clientRequestId: 'c', locale: 'fr-FR' };

const ports = (over: Partial<Ports> = {}): Ports => ({
  retrieve: async () => SOURCES,
  resolveSources: async (s) => s.map((x) => ({ id: x.id, type: x.type, typeLabel: 'Document', title: x.title, excerpt: x.content, isAvailable: true })),
  resolveActions: async () => [],
  persist: async () => null,
  hasPendingClarification: async () => false,
  ...over,
});

beforeEach(() => {
  clearRetrievalCache();
  delete process.env.VEREBONA_ASSISTANT_ACCOUNT_AI;
  delete process.env.VEREBONA_ASSISTANT_PRODUCT_HELP;
});

describe('§9.6 — la réparation passe par l’état REPAIRING', () => {
  it('sortie réparée : GENERATING → REPAIRING → VALIDATING → READY', async () => {
    const etats: string[] = [];
    // Enregistrement simple des transitions, sans changer le comportement.
    const vraie = ConversationMachine.prototype.transition;
    const espion = vi.spyOn(ConversationMachine.prototype, 'transition').mockImplementation(function (this: InstanceType<typeof ConversationMachine>, to, guards) {
      etats.push(to);
      return vraie.call(this, to, guards);
    });
    const r = await runAssistant(INPUT, ports({
      generateWithAI: async (_route, _s, input) => {
        input.aiReport?.events.push('REPAIR:INVALID_OUTPUT');
        return { answer: 'La garantie court 2 ans.', claims: [{ claimKey: 'c1', text: 'La garantie court 2 ans.', sourceIds: ['doc_1'], derivation: 'direct' }], actions: [], supportLevel: 'supported', path: 'repair' };
      },
    }));
    espion.mockRestore();
    expect(r.mode).toBe('ai');
    expect(r.finalState).toBe('READY');
    const i = etats.indexOf('GENERATING');
    expect(etats.slice(i, i + 4)).toEqual(['GENERATING', 'REPAIRING', 'VALIDATING', 'READY']);
  });

  it('réparation en échec : REPAIRING puis repli (ERROR_RECOVERABLE), code VALIDATION_FAILED', async () => {
    const etats: string[] = [];
    const vraie = ConversationMachine.prototype.transition;
    const espion = vi.spyOn(ConversationMachine.prototype, 'transition').mockImplementation(function (this: InstanceType<typeof ConversationMachine>, to, guards) {
      etats.push(to);
      return vraie.call(this, to, guards);
    });
    const r = await runAssistant(INPUT, ports({
      generateWithAI: async (_route, _s, input) => {
        input.aiReport?.events.push('REPAIR:INVALID_OUTPUT', 'REPAIR_FAILED', 'GENERATION_REJECTED:VALIDATION_FAILED');
        return null;
      },
    }));
    espion.mockRestore();
    expect(etats).toContain('REPAIRING');
    expect(r.mode).not.toBe('ai');
    expect(r.notices?.map((n) => n.code)).toContain('VALIDATION_FAILED');
  });

  it('la table de transitions autorise GENERATING → REPAIRING → VALIDATING', () => {
    const m = new ConversationMachine('GENERATING');
    expect(m.transition('REPAIRING')).toBe(true);
    expect(m.transition('VALIDATING')).toBe(true);
  });
});

describe('§27.11 — codes informatifs émis', () => {
  const base = (over: Partial<Result> = {}): Result => ({
    requestId: 'r', messageId: 'm', finalState: 'READY', mode: 'fallback', route: routeForIntent('ACCOUNT_SUMMARY', 'PREMIUM', 't'),
    answer: 'x', supportLevel: null, claims: [], sources: [], actions: [], clarification: null,
    cascade: {
      intent: 'ACCOUNT_SUMMARY', strategy: 'fallback.sources', answeredBy: 'fallback', sufficiency: 'INSUFFICIENT', escalationReasons: [],
      attempts: [], sourceCount: 0, aiCalls: 0, model: null, thresholds: { database: 1, text: 1, source: 'x' }, latencyMs: 1,
    },
    ...over,
  });
  const codes = (r: Result) => noticesFor(r).map((n) => n.code);

  it('NO_RELEVANT_SOURCE : repli sans aucune source', () => {
    expect(codes(base())).toEqual(['NO_RELEVANT_SOURCE']);
  });
  it('PLAN_NOT_ELIGIBLE : limite d’offre', () => {
    const r = base({ sources: [{ id: 'doc_1', type: 'document', typeLabel: 'D', title: 't', excerpt: '', isAvailable: true }] });
    r.cascade!.escalationReasons.push('PLAN_LIMIT:TRIAL_EXPIRED');
    expect(codes(r)).toEqual(['PLAN_NOT_ELIGIBLE']);
  });
  it('INVALID_ACTION et SOURCE_UNAVAILABLE', () => {
    const r = base({ mode: 'ai', sources: [{ id: 'doc_1', type: 'document', typeLabel: 'D', title: 't', excerpt: '', isAvailable: false }] });
    r.cascade!.answeredBy = 'llm';
    r.cascade!.securityEvents = [{ code: 'MODEL_ACTION_REJECTED' }];
    expect(codes(r).sort()).toEqual(['INVALID_ACTION', 'SOURCE_UNAVAILABLE']);
  });
  it('UNSAFE_REQUEST : sujet réservé ou malveillance', () => {
    expect(codes(base({ blockedReason: 'legal', cascade: undefined }))).toEqual(['UNSAFE_REQUEST']);
    expect(codes(base({ route: routeForIntent('UNSAFE_OR_MALICIOUS', 'PREMIUM', 't'), cascade: undefined }))).toEqual(['UNSAFE_REQUEST']);
  });
  it('une erreur bloquante n’est pas doublée par un code informatif', () => {
    const r = base({ error: { code: 'NO_RELEVANT_SOURCE', message: 'x', recoverable: true } });
    expect(codes(r)).toEqual([]);
  });

  it('l’API expose `notices` et jamais la cible interne des actions', () => {
    const payload = toApiPayload({
      ...base(),
      notices: [{ code: 'NO_RELEVANT_SOURCE', message: 'm' }],
      actions: [{ actionId: 'a', type: 'OPEN_ASSET', label: 'l', href: '/assets/1', token: null, requiresConfirmation: false, expiresAt: null, analyticsCode: 'x', targetRef: 'asset:1', payload: { tab: 'x' } }],
    });
    expect(payload.notices).toEqual([{ code: 'NO_RELEVANT_SOURCE', message: 'm' }]);
    expect(payload.status).toBe('ready');
    expect(payload.actions[0]).not.toHaveProperty('targetRef');
    expect(payload.actions[0]).not.toHaveProperty('payload');
  });

  it('bout en bout : question refusée (conseil réglementé) → UNSAFE_REQUEST dans la réponse', async () => {
    const r = await runAssistant({ ...INPUT, message: 'Dois-je résilier mon assurance habitation ?' }, ports());
    expect(r.notices?.map((n) => n.code)).toContain('UNSAFE_REQUEST');
  });
});

describe('§43 — cache de retrieval (RETRIEVAL_CACHE_TTL_SECONDS) et cache_hit (§28.7)', () => {
  const route = routeForIntent('ACCOUNT_SUMMARY', 'PREMIUM', 't');
  // Versions d'invalidation (§31.7) : stockage en mémoire, la base étant absente ici.
  beforeEach(() => setCacheVersionStoreForTests({ read: async () => ({}), bump: async () => {} }));

  it('servi par le cache pendant la durée configurée, plafonnée à 60 s, puis rechargé', async () => {
    let t = 1_000;
    const fetcher = vi.fn(async () => SOURCES);
    expect((await cachedRetrieve(route, INPUT, fetcher, 300, () => t)).hit).toBe(false);
    expect((await cachedRetrieve(route, INPUT, fetcher, 300, () => t)).hit).toBe(true);
    t += 59_000;
    expect((await cachedRetrieve(route, INPUT, fetcher, 300, () => t)).hit).toBe(true);
    t += 2_000; // 61 s : au-delà du plafond, même si la configuration dit 300 s
    expect((await cachedRetrieve(route, INPUT, fetcher, 300, () => t)).hit).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('clé propre à l’UTILISATEUR : l’aide dépend de ses rôles (Duo)', async () => {
    const aide = routeForIntent('PRODUCT_HELP_HOW_TO', 'PREMIUM', 't');
    expect(retrievalCacheKey(aide, INPUT)).not.toBe(retrievalCacheKey(aide, { ...INPUT, userId: 4 }));
    const fetcher = vi.fn(async () => SOURCES);
    await cachedRetrieve(aide, INPUT, fetcher, 60);
    expect((await cachedRetrieve(aide, { ...INPUT, userId: 4 }, fetcher, 60)).hit).toBe(false);
    expect((await cachedRetrieve(aide, INPUT, fetcher, 60)).hit).toBe(true);
  });

  it('jamais pour les listes et états (recherches, « À traiter », échéances)', async () => {
    for (const intent of ['ACCOUNT_SEARCH_DOCUMENT', 'ACCOUNT_TO_PROCESS', 'ACCOUNT_FACT_AGENDA'] as const) {
      const r = routeForIntent(intent, 'PREMIUM', 't');
      expect(retrievalCacheKey(r, INPUT)).toBeNull();
      const fetcher = vi.fn(async () => SOURCES);
      await cachedRetrieve(r, INPUT, fetcher, 60);
      expect((await cachedRetrieve(r, INPUT, fetcher, 60)).hit).toBe(false);
    }
  });

  it('jamais partagé entre comptes ; durée 0 = pas de cache ; invalidation par compte', async () => {
    expect(retrievalCacheKey(route, INPUT)).not.toBe(retrievalCacheKey(route, { ...INPUT, accountId: 8 }));
    const fetcher = vi.fn(async () => SOURCES);
    await cachedRetrieve(route, INPUT, fetcher, 0);
    expect((await cachedRetrieve(route, INPUT, fetcher, 0)).hit).toBe(false);
    await cachedRetrieve(route, INPUT, fetcher, 300);
    expect(invalidateRetrievalCacheForAccount(7)).toBe(1);
    expect((await cachedRetrieve(route, INPUT, fetcher, 300)).hit).toBe(false);
  });

  it('les sources servies sont des copies (aucune mutation partagée)', async () => {
    const fetcher = vi.fn(async () => [{ ...SOURCES[0], meta: { assetId: 1 } }] as Source[]);
    await cachedRetrieve(route, INPUT, fetcher, 300);
    const a = await cachedRetrieve(route, INPUT, fetcher, 300);
    (a.sources[0].meta as Record<string, unknown>).assetId = 99;
    const b = await cachedRetrieve(route, INPUT, fetcher, 300);
    expect(b.sources[0].meta).toEqual({ assetId: 1 });
  });

  it('un succès du cache est reporté dans la trace (cacheHit)', async () => {
    const r = await runAssistant(INPUT, ports({
      retrieve: async (_route, input) => { input.aiReport?.events.push(RETRIEVAL_CACHE_HIT_EVENT); return SOURCES; },
    }));
    expect(r.cascade?.cacheHit).toBe(true);
  });
});

describe('§25.6 — éligibilité lue dans le registre des capacités', () => {
  it('capabilityForIntent gouverne l’éligibilité : offre, flag du §39', () => {
    expect(isAiEligibleFor('ACCOUNT_SUMMARY', 'PREMIUM', true)).toBe(true);
    expect(isAiEligibleFor('ACCOUNT_SUMMARY', 'STANDARD', true)).toBe(false);
    process.env.VEREBONA_ASSISTANT_ACCOUNT_AI = 'off';
    expect(capabilityAllows('ACCOUNT_SUMMARY', 'PREMIUM')).toBe(false);
    expect(routeForIntent('ACCOUNT_SUMMARY', 'PREMIUM', 't').aiEligible).toBe(false);
    delete process.env.VEREBONA_ASSISTANT_ACCOUNT_AI;
    expect(routeForIntent('ACCOUNT_SUMMARY', 'PREMIUM', 't').aiEligible).toBe(true);
  });

  it('intention sans capacité : pas de restriction propre ; capacité désactivée : refus', () => {
    expect(capabilityAllows('GREETING', 'STANDARD')).toBe(true);
    expect(capabilitiesForPlan('PREMIUM').closed.map((c) => c.code)).toContain('voice_io');
  });
});
