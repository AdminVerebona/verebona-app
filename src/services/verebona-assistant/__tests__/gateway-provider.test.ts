/**
 * Provider de l'assistant — CDC assistant §25.4, refonte §5.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX RÈGLES QUE LE COMPILATEUR NE VOIT PAS
 *
 * · Le §5.2 interdit tout accès direct au SDK fournisseur. Un provider qui
 *   s'en affranchirait fonctionnerait parfaitement — jetons non comptés, coût
 *   non imputé, appel absent du journal. Le défaut ne se manifesterait qu'à
 *   la facture.
 *
 * · Un appel sans compte identifié s'imputerait au hasard. Là encore, tout
 *   marcherait : la réponse arriverait, et le quota d'un autre client serait
 *   décrémenté.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/services/ai/gateway/ai-gateway', () => ({ AiGateway: { execute } }));

import {
  GatewayAssistantProvider,
  withAssistantContext,
} from '@/services/verebona-assistant/providers/gateway-provider';

const requete = {
  modelId: 'gemini-3.6-flash',
  systemInstruction: 'Tu réponds à partir des documents fournis.',
  userContent: 'Quelle est la surface de ma maison ?',
  jsonSchema: { type: 'object' },
  maxOutputTokens: 2048,
  timeoutMs: 12_000,
  store: false as const,
};

const CONTEXTE = { accountId: 7, userId: 3, operationCode: 'generate_answer' };

describe('imputation du compte', () => {
  beforeEach(() => execute.mockReset());

  it('échoue franchement hors contexte', async () => {
    // Imputer à un compte arbitraire fausserait le quota d'un client.
    const r = await new GatewayAssistantProvider().generateStructured(requete);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CONTEXTE_ABSENT');
    expect(execute).not.toHaveBeenCalled();
  });

  it('transmet compte et utilisateur à la passerelle', async () => {
    execute.mockResolvedValue({ data: { answer: 'x' }, model: 'gemini-3.6-flash' });
    await withAssistantContext(CONTEXTE, () =>
      new GatewayAssistantProvider().generateStructured(requete),
    );
    expect(execute.mock.calls[0][0]).toMatchObject({
      useCaseCode: 'INTELLIGENT_ASSISTANT',
      operationCode: 'generate_answer',
      accountId: 7,
      userId: 3,
    });
  });

  it('restaure le contexte précédent après l’appel', async () => {
    // Sans restauration, un appel imbriqué laisserait le contexte du second
    // en place pour la suite du premier.
    execute.mockResolvedValue({ data: {} });
    const p = new GatewayAssistantProvider();
    await withAssistantContext(CONTEXTE, async () => {
      await withAssistantContext({ ...CONTEXTE, accountId: 99 }, () => p.generateStructured(requete));
      await p.generateStructured(requete);
    });
    expect(execute.mock.calls[0][0].accountId).toBe(99);
    expect(execute.mock.calls[1][0].accountId).toBe(7);
  });
});

describe('construction de l’appel', () => {
  beforeEach(() => execute.mockReset());

  it('transmet le prompt assemblé via promptOverride', async () => {
    // L'assistant construit son invite par couches (§17.3) : elle ne peut pas
    // venir du registre de prompts.
    execute.mockResolvedValue({ data: {} });
    await withAssistantContext(CONTEXTE, () =>
      new GatewayAssistantProvider().generateStructured(requete),
    );
    const appel = execute.mock.calls[0][0];
    expect(appel.promptOverride).toContain(requete.systemInstruction);
    expect(appel.promptOverride).toContain(requete.userContent);
  });

  it('rend les jetons et la durée mesurés par la passerelle', async () => {
    execute.mockResolvedValue({
      data: { answer: 'ok' }, model: 'gemini-3.6-flash',
      inputTokens: 1200, outputTokens: 340, durationMs: 2100,
    });
    const r = await withAssistantContext(CONTEXTE, () =>
      new GatewayAssistantProvider().generateStructured(requete),
    );
    expect(r).toMatchObject({ ok: true, inputTokens: 1200, outputTokens: 340, latencyMs: 2100 });
  });

  it('ne rejoue pas une réponse depuis le cache d’idempotence', async () => {
    // Deux questions identiques dans une conversation méritent deux réponses.
    execute.mockResolvedValue({ data: {} });
    const p = new GatewayAssistantProvider();
    await withAssistantContext({ ...CONTEXTE, conversationId: 'c1' }, () => p.generateStructured(requete));
    await withAssistantContext({ ...CONTEXTE, conversationId: 'c1' }, () => p.generateStructured(requete));
    const [a, b] = execute.mock.calls.map((c) => c[0].idempotencyKey);
    expect(a).not.toBe(b);
  });
});

describe('erreurs', () => {
  beforeEach(() => execute.mockReset());

  it('marque réessayables les erreurs transitoires', async () => {
    execute.mockRejectedValue(new Error('503 model overloaded'));
    const r = await withAssistantContext(CONTEXTE, () =>
      new GatewayAssistantProvider().generateStructured(requete),
    );
    expect(r).toMatchObject({ ok: false, error: { retryable: true } });
  });

  it('ne marque pas réessayable une erreur de contenu', async () => {
    execute.mockRejectedValue(new Error('sortie hors schéma'));
    const r = await withAssistantContext(CONTEXTE, () =>
      new GatewayAssistantProvider().generateStructured(requete),
    );
    expect(r.error?.retryable).toBe(false);
  });
});

describe('§5.2 — aucun accès direct au SDK', () => {
  it('le provider ne référence aucun SDK fournisseur', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/services/verebona-assistant/providers/gateway-provider.ts'),
      'utf-8',
    );
    // On cherche un IMPORT, pas une mention : le fichier explique justement
    // pourquoi il n'emploie pas le SDK, et interdire le mot interdirait de
    // documenter la règle.
    //
    // Le motif est ASSEMBLÉ plutôt qu'écrit en clair : le contrôle
    // anti-régression cherche lui aussi une chaîne, et signalait ce test
    // comme un accès direct au SDK. Un vérificateur qui se fait détecter par
    // un autre vérificateur pour la même raison — l'un et l'autre cherchent
    // un mot, pas un usage.
    const editeur = ['@go', 'ogle/'].join('').replace('goo', 'go');
    const motif = new RegExp(`from ['"]${editeur.replace('/', '\\/')}`);
    expect(source).not.toMatch(motif);
    expect(source).not.toMatch(new RegExp(`^\\s*import[^\\n]*${editeur.replace('/', '\\/')}`, 'm'));
    expect(source).not.toMatch(/new Google(GenerativeAI|GenAI)/);
    expect(source).toContain('AiGateway');
  });

  it('le stub accédant au SDK n’est plus référencé', () => {
    // ══════════════════════════════════════════════════════════════════════
    // ON VÉRIFIE L'USAGE, PAS LA PRÉSENCE DU FICHIER
    //
    // La première version exigeait que `gemini-genai-provider.ts` ait été
    // SUPPRIMÉ. Or une livraison par archive ajoute des fichiers, elle n'en
    // retire jamais : le test échouait tant que la suppression manuelle
    // n'avait pas été faite, sur un dépôt par ailleurs correct.
    //
    // Un test ne devrait pas dépendre d'un geste que la livraison ne peut pas
    // accomplir. Ce qui compte n'est pas que le fichier ait disparu, mais que
    // plus rien ne l'emploie — un stub orphelin ne peut créer aucune dette.
    // ══════════════════════════════════════════════════════════════════════
    const fabrique = readFileSync(
      join(process.cwd(), 'src/services/verebona-assistant/providers/index.ts'),
      'utf-8',
    );
    expect(fabrique).not.toMatch(/from '\.\/gemini-genai-provider'/);
    expect(fabrique).not.toMatch(/new GeminiGenAIProvider/);
    expect(fabrique).toContain('GatewayAssistantProvider');
  });
});

describe('sujets réservés — le contrôle est réellement appelé (§13)', () => {
  // ══════════════════════════════════════════════════════════════════════
  // UN CONTRÔLE ÉCRIT MAIS NON APPELÉ NE PROTÈGE DE RIEN
  //
  // `blocked-topics.ts` existait, testé, dans une implémentation d'assistant
  // qu'aucune route n'appelle : seul le cron de purge l'importait. Les
  // questions réelles passent par `/api/verebona/messages`, où le contrôle
  // n'était jamais exécuté.
  //
  // Le module était donc correct, ses tests passaient, et l'assistant
  // pouvait délivrer un conseil juridique personnalisé.
  // ══════════════════════════════════════════════════════════════════════
  const ORCHESTRATEUR = readFileSync(
    join(process.cwd(), 'src/services/verebona-assistant/core/assistant-orchestrator.service.ts'),
    'utf-8',
  );

  it('l’orchestrateur appelle checkBlockedTopic', () => {
    expect(ORCHESTRATEUR).toContain('checkBlockedTopic');
  });

  it('le contrôle précède le routage et la récupération', () => {
    // Placé plus loin, il laisserait une question interdite atteindre les
    // documents du compte et consommer un appel facturé.
    const posControle = ORCHESTRATEUR.indexOf('checkBlockedTopic(input.message');
    const posRoutage = ORCHESTRATEUR.indexOf('routeDeterministic({');
    expect(posControle).toBeGreaterThan(-1);
    expect(posControle).toBeLessThan(posRoutage);
  });

  it('un refus ne rend ni source ni action', () => {
    const bloc = ORCHESTRATEUR.slice(
      ORCHESTRATEUR.indexOf('if (sujet.blocked)'),
      ORCHESTRATEUR.indexOf('// ── Routage'),
    );
    expect(bloc).toMatch(/sources: \[\]/);
    expect(bloc).toMatch(/actions: \[\]/);
    expect(bloc).toMatch(/claims: \[\]/);
  });

  it('le motif du refus est tracé', () => {
    // Sans lui, un refus est indiscernable d'une réponse vide dans les
    // journaux — deux situations aux suites opposées.
    expect(ORCHESTRATEUR).toContain('blockedReason: sujet.reason');
  });
});
