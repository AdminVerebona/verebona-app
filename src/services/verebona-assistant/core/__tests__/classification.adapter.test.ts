/**
 * CDC §9.1, §9.2 et §9.5 — classification de l'intention.
 *
 * La règle absolue du §9.1 : « une intention inconnue n'est JAMAIS créée
 * dynamiquement par le modèle ». Et son corollaire, moins écrit mais plus
 * important : le modèle ne décide pas des droits. Il propose une intention ;
 * l'éligibilité, la nécessité de recherche et les actions autorisées sont lues
 * dans le registre, côté serveur.
 *
 * Sans cela, un modèle pourrait étendre ses propres permissions en se déclarant
 * éligible sur une intention qui ne l'est pas.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const execute = vi.fn();
vi.mock('@/services/ai/gateway/ai-gateway', () => ({ AiGateway: { execute: (...a: unknown[]) => execute(...a) } }));

const { classifyAssistantIntent, toIntentRoute, buildClassificationPort } =
  await import('../classification.adapter');
const { getIntentDefinition } = await import('../../registries/intent-registry');

const input = { accountId: 1, userId: 2, planType: 'premium', message: 'x' } as never;

function plan(over: Record<string, unknown> = {}) {
  return { intent: 'ACCOUNT_FACT_ASSET', confidence: 'probable', entityHints: [], reason: 'r', ...over } as never;
}

beforeEach(() => {
  execute.mockReset();
  delete process.env.AI_INTELLIGENT_ASSISTANT;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('les droits viennent du registre, pas du modèle', () => {
  it('lit l\'éligibilité et la recherche dans le catalogue', () => {
    const route = toIntentRoute(plan(), 'premium');
    const def = getIntentDefinition('ACCOUNT_FACT_ASSET');

    expect(route.aiEligible).toBe(def.geminiEligible);
    expect(route.requiresRetrieval).toBe(def.requiresRetrieval);
  });

  it('impose la portée compte côté serveur', () => {
    // Jamais dérivée d'une réponse de modèle, quelle qu'elle soit.
    expect(toIntentRoute(plan({ accountScope: 'global' }), 'premium').accountScope)
      .toBe('server-enforced');
  });

  it('lit les actions autorisées dans le catalogue', () => {
    const route = toIntentRoute(plan({ allowedActionTypes: ['DELETE_ASSET'] }), 'premium');
    expect(route.allowedActionTypes).not.toContain('DELETE_ASSET');
  });

  it('conserve les indices d\'entités proposés', () => {
    const route = toIntentRoute(plan({ entityHints: [{ type: 'asset', value: 'Maison' }] }), 'premium');
    expect(route.entityHints).toEqual([{ type: 'asset', value: 'Maison' }]);
  });
});

describe('confiance et clarification', () => {
  it('demande confirmation sur une intention ambiguë plutôt que de deviner', () => {
    expect(toIntentRoute(plan({ confidence: 'ambiguous' }), 'premium').clarificationRequired).toBe(true);
  });

  it('ne demande rien sur une intention certaine', () => {
    expect(toIntentRoute(plan({ confidence: 'exact' }), 'premium').clarificationRequired).toBe(false);
  });

  it('journalise le motif du classement', () => {
    expect(toIntentRoute(plan({ reason: 'question sur une surface' }), 'premium').routeReason)
      .toContain('surface');
  });
});

describe('catalogue fermé (§9.1)', () => {
  it('REFUSE une intention hors catalogue', async () => {
    execute.mockRejectedValue(new Error('validation de sortie échouée'));
    // Le schéma `z.enum(VEREBONA_INTENTS)` fait échouer la gateway en amont :
    // l'intention inventée n'atteint jamais l'orchestrateur.
    await expect(classifyAssistantIntent('bonjour', input)).resolves.toBeNull();
  });

  it('déclare l\'usage et l\'opération du référentiel', async () => {
    execute.mockResolvedValue({ data: plan() });
    await classifyAssistantIntent('quelle surface ?', input);

    expect(execute.mock.calls[0][0]).toMatchObject({
      useCaseCode: 'INTELLIGENT_ASSISTANT',
      operationCode: 'understand_request',
    });
  });

  it('transmet le catalogue au modèle — il choisit dedans', async () => {
    execute.mockResolvedValue({ data: plan() });
    await classifyAssistantIntent('quelle surface ?', input);

    expect(String(execute.mock.calls[0][0].promptVariables.INTENTS)).toContain('ACCOUNT_FACT_ASSET');
  });
});

describe('robustesse', () => {
  it('n\'appelle pas le modèle sur un message vide', async () => {
    expect(await classifyAssistantIntent('   ', input)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rend null plutôt que de lever — le repli UNKNOWN reste prévu', async () => {
    execute.mockRejectedValue(new Error('délai dépassé'));
    await expect(classifyAssistantIntent('question', input)).resolves.toBeNull();
  });
});

describe('gouvernance par le drapeau', () => {
  it('laisse le port indéfini tant que l\'usage n\'est pas basculé', () => {
    expect(buildClassificationPort()).toBeUndefined();
  });

  it('fournit le port une fois l\'usage activé', () => {
    process.env.AI_INTELLIGENT_ASSISTANT = 'enabled';
    expect(typeof buildClassificationPort()).toBe('function');
  });
});
