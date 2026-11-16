/**
 * Carte #790, passage 115E (E02) — PARITÉ DU REJEU D'UNE DEMANDE, de bout en bout
 * sur PostgreSQL réel et par la VRAIE route (`POST /api/verebona/messages`).
 *
 * Avant : un même `clientRequestId` rejoué (réseau instable, double envoi) rendait
 * le texte, les sources, les actions et les cartes, mais perdait la CHRONOLOGIE, la
 * CLARIFICATION encore à répondre et le PLAN à confirmer. Le contenu fonctionnel
 * était donc altéré après un incident réseau.
 *
 *   R01  plan à confirmer : même réponse, même plan, aucun second plan, aucune écriture ;
 *   R02  clarification encore valide : même question, mêmes choix, même identifiant ;
 *   R03  chronologie : mêmes événements, et aucun bloc (comme au premier retour) ;
 *   R04  plan confirmé puis rejeu : plus aucun bouton « Confirmer », une seule écriture ;
 *   R05  cloisonnement : un autre membre du compte et un autre compte ne retrouvent rien ;
 *   R06  aucun appel modèle, aucun message supplémentaire au rejeu.
 *
 * Modèle SIMULÉ et COMPTÉ : aucun appel réel à un fournisseur d'IA.
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, planType: 'PREMIUM' }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/lib/verebona/rate-limit', () => ({ checkAssistantRateLimit: async () => ({ allowed: true, retryAfterMs: 0 }) }));
vi.mock('@/services/verebona-assistant', async (o) => ({ ...(await o<object>()), ensureAssistantStartupChecked: () => ({ ok: true }) }));

type Compte = { id: number; ownerUserId: number };
type Corps = Record<string, unknown> & {
  answer?: string; requestId?: string; messageId?: string; conversationId?: number; replayed?: boolean;
  intent?: string; mode?: string; sourceCount?: number;
  actions?: Array<{ type: string; href: string | null }>;
  answerBlocks?: unknown[];
  events?: Array<{ date: string; text: string; href: string | null }>;
  clarification?: { clarificationId: string; question: string; expiresAt: string; choices: Array<{ choiceId: string; label: string }> } | null;
  commandPlan?: { planId: string; summary: string; actions: Array<{ actionId: string; preview: string }>; expiresAt: string } | null;
};

/** Modèle simulé : chaque appel T2 est compté ; sorties neutres. */
function modeleSimule() {
  const appels: string[] = [];
  const provider = {
    name: 'simule',
    isConfigured: () => true,
    async call(input: { task?: string; prompt: string; model: string; operationCode?: string }) {
      if (String(input.operationCode ?? '').startsWith('t2_')) appels.push(String(input.task ?? input.operationCode));
      if (input.task === 'UNDERSTAND') {
        return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }), inputTokens: 1, outputTokens: 1 };
      }
      if (input.task === 'ANSWER') {
        return { rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered', claims: [] }), inputTokens: 1, outputTokens: 1 };
      }
      if (input.task === 'REVALIDATE') {
        return { rawText: JSON.stringify({ mode: 'REVALIDATE', status: 'not_found', value: null, unit: null, confidence: 'low', evidence: null }), inputTokens: 1, outputTokens: 1 };
      }
      return { rawText: '{}', inputTokens: 0, outputTokens: 0 };
    },
  };
  return { appels, provider };
}

scenario('L115E-REJEU', 'Carte #790 (115E) — parité du rejeu d’une demande', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  let sim: ReturnType<typeof modeleSimule>;

  beforeAll(async () => {
    sim = modeleSimule();
    (await import('@/services/ai/gateway/providers')).setAiProvider(sim.provider as never);
  });
  beforeEach(async () => {
    process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = 'true';
    (await import('@/services/verebona-assistant/config/assistant-config')).resetAssistantConfigForTests();
    (await import('@/services/verebona-assistant/core/retrieval-cache')).clearRetrievalCache?.();
    sim.appels.length = 0;
  });
  afterEach(async () => {
    delete process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS;
    (await import('@/services/verebona-assistant/config/assistant-config')).resetAssistantConfigForTests();
  });

  // ── Données et route réelle ───────────────────────────────────────────────

  const compte = async (): Promise<Compte> => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string, extra: Record<string, unknown> = {}) => {
    const b = await make.asset(c as never, { category: 'VEHICULE', name, ...extra });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${b.id}`;
    return b.id as number;
  };
  const echeance = async (c: Compte, assetId: number, title: string, startDate: string, nature: string) => {
    const i = await make.agendaItem(c as never, { title, startDate, assetIds: [assetId] });
    await sql`UPDATE agenda_items SET event_nature = ${nature} WHERE id = ${i.id}`;
    return i.id as number;
  };

  /** VRAIE route, avec la session du compte demandé. */
  const poser = async (c: Compte, message: string, clientRequestId: string, extra: Record<string, unknown> = {}, userId = c.ownerUserId) => {
    session.userId = userId; session.currentAccountId = c.id;
    const { POST } = await import('@/app/api/verebona/messages/route');
    const res = await POST(new NextRequest('http://localhost/api/verebona/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, clientRequestId, pageContext: { route: '/accueil', platform: 'web' }, ...extra }),
    }));
    return { status: res.status, body: await res.json() as Corps };
  };
  const messages = async (conversationId: number) => {
    const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_messages WHERE conversation_id = ${conversationId}`;
    return r.n;
  };
  const plans = async (c: Compte) => {
    const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_command_plans WHERE account_id = ${c.id}`;
    return r.n;
  };
  /** Comparaison du contenu fonctionnel : tout ce que le client affiche. */
  const contenu = (b: Corps) => ({
    answer: b.answer, intent: b.intent, mode: b.mode, sourceCount: b.sourceCount ?? 0,
    actions: (b.actions ?? []).map((a) => ({ type: a.type, href: a.href })),
    answerBlocks: b.answerBlocks ?? null, events: b.events ?? null,
    clarification: b.clarification ?? null,
    commandPlan: b.commandPlan ? { summary: b.commandPlan.summary, actions: b.commandPlan.actions.map((a) => a.preview) } : null,
  });

  // ══════════════════════════════════════════════════════════════════════════

  it('R01 — plan à confirmer : rejeu identique, aucun second plan, aucune écriture', async () => {
    const c = await compte();
    const id = await bien(c, 'Clio');
    const crid = `l115e-plan-${Date.now()}`;

    const un = await poser(c, 'Renomme la Clio en Clio de Paul', crid);
    expect(un.status).toBe(200);
    expect(un.body.replayed ?? false).toBe(false);
    expect(un.body.commandPlan?.summary).toBeTypeOf('string');
    expect(un.body.commandPlan?.actions[0].preview).toBe('Renommer le bien « Clio » en « Clio de Paul ».');
    const conversationId = Number(un.body.conversationId);
    const avantMessages = await messages(conversationId);
    expect(await plans(c)).toBe(1);

    const deux = await poser(c, 'Renomme la Clio en Clio de Paul', crid);
    expect(deux.status).toBe(200);
    expect(deux.body.replayed).toBe(true);
    // Le plan revient à l'identique : même identifiant, même aperçu, même échéance.
    expect(deux.body.commandPlan?.planId).toBe(un.body.commandPlan?.planId);
    expect(deux.body.commandPlan?.expiresAt).toBe(un.body.commandPlan?.expiresAt);
    expect(contenu(deux.body)).toEqual(contenu(un.body));
    expect(deux.body.messageId).toBe(un.body.messageId);
    // Rien de plus en base : aucun second plan, aucun message supplémentaire, le bien intact.
    expect(await plans(c)).toBe(1);
    expect(await messages(conversationId)).toBe(avantMessages);
    const [a] = await sql<{ name: string }[]>`SELECT name FROM assets WHERE id = ${id}`;
    expect(a.name).toBe('Clio');
  });

  it('R02 — clarification encore valide : même question, mêmes choix au rejeu', async () => {
    const c = await compte();
    await bien(c, 'Clio');
    await bien(c, 'Polo');
    const crid = `l115e-clar-${Date.now()}`;

    const un = await poser(c, 'Fais-moi une synthèse de ce bien', crid);
    expect(un.status).toBe(200);
    // La question est ambiguë (deux biens) : une clarification EST posée, avec ses choix.
    expect(un.body.clarification?.choices.length ?? 0).toBeGreaterThanOrEqual(2);
    if (!un.body.clarification) return;
    const deux = await poser(c, 'Quel est le kilométrage de mon vélo ?', crid);
    expect(deux.body.replayed).toBe(true);
    expect(deux.body.clarification?.clarificationId).toBe(un.body.clarification.clarificationId);
    expect(deux.body.clarification?.question).toBe(un.body.clarification.question);
    expect(deux.body.clarification?.choices.map((x) => x.choiceId)).toEqual(un.body.clarification.choices.map((x) => x.choiceId));
    expect(deux.body.clarification?.choices.map((x) => x.label)).toEqual(un.body.clarification.choices.map((x) => x.label));
    expect(contenu(deux.body)).toEqual(contenu(un.body));
  });

  it('R03 — chronologie : mêmes événements au rejeu, et aucun bloc (comme au premier retour)', async () => {
    const c = await compte();
    const id = await bien(c, 'Clio');
    await echeance(c, id, 'Achat de la Clio', '2021-05-25', 'HISTORICAL');
    await echeance(c, id, 'Révision', '2023-06-01', 'HISTORICAL');
    await echeance(c, id, 'Contrôle technique', '2027-02-01', 'DEADLINE');
    const crid = `l115e-chrono-${Date.now()}`;

    const un = await poser(c, 'Historique de la Clio', crid);
    expect(un.status).toBe(200);
    expect((un.body.events ?? []).length).toBeGreaterThan(0);
    expect(un.body.answerBlocks ?? null).toBeNull();

    const deux = await poser(c, 'Historique de la Clio', crid);
    expect(deux.body.replayed).toBe(true);
    expect(deux.body.events).toEqual(un.body.events);
    expect(deux.body.answerBlocks ?? null).toBeNull();
    expect(contenu(deux.body)).toEqual(contenu(un.body));
  });

  it('R04 — plan confirmé puis rejeu : plus aucun bouton « Confirmer », une seule écriture', async () => {
    const c = await compte();
    const id = await bien(c, 'Clio');
    const crid = `l115e-confirme-${Date.now()}`;
    const un = await poser(c, 'Renomme la Clio en Clio 2', crid);
    const planId = String(un.body.commandPlan?.planId);
    expect(planId).not.toBe('undefined');

    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    const issue = await confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
    expect(issue.status === 'EXECUTED' || issue.status === 'PARTIAL').toBe(true);
    const [apres] = await sql<{ name: string }[]>`SELECT name FROM assets WHERE id = ${id}`;
    expect(apres.name).toBe('Clio 2');

    const rejeu = await poser(c, 'Renomme la Clio en Clio 2', crid);
    expect(rejeu.body.replayed).toBe(true);
    expect(rejeu.body.answer).toBe(un.body.answer);
    // Plan clos : aucun aperçu à confirmer n'est réaffiché, et rien n'est réécrit.
    expect(rejeu.body.commandPlan ?? null).toBeNull();
    expect(await plans(c)).toBe(1);
    const [encore] = await sql<{ name: string }[]>`SELECT name FROM assets WHERE id = ${id}`;
    expect(encore.name).toBe('Clio 2');
  });

  it('R05 — cloisonnement : autre membre du compte et autre compte ne retrouvent rien', async () => {
    const c = await compte();
    await bien(c, 'Clio');
    const crid = `l115e-cloison-${Date.now()}`;
    const un = await poser(c, 'Renomme la Clio en Clio de Paul', crid);
    expect(un.body.commandPlan?.planId).toBeTypeOf('string');

    // Autre membre du MÊME compte, même clientRequestId : jamais la réponse du titulaire.
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${membre.id}, 'member', 'active')`;
    const autreMembre = await poser(c, 'Renomme la Clio en Clio de Paul', crid, {}, membre.id as number);
    expect(autreMembre.body.replayed ?? false).toBe(false);
    expect(autreMembre.body.messageId).not.toBe(un.body.messageId);
    expect(autreMembre.body.commandPlan?.planId ?? null).not.toBe(un.body.commandPlan?.planId);

    // Autre compte, même clientRequestId : rien du premier compte.
    const autre = await compte();
    await bien(autre, 'Clio');
    const autreCompte = await poser(autre, 'Renomme la Clio en Clio de Paul', crid);
    expect(autreCompte.body.replayed ?? false).toBe(false);
    expect(autreCompte.body.messageId).not.toBe(un.body.messageId);
    expect(autreCompte.body.commandPlan?.planId ?? null).not.toBe(un.body.commandPlan?.planId);
    // Le plan du titulaire n'est jamais lisible depuis l'autre compte.
    const { findMessageCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    expect(await findMessageCommandPlan(autre.id, autre.ownerUserId, Number(un.body.messageId))).toBeNull();
    expect(await findMessageCommandPlan(c.id, membre.id as number, Number(un.body.messageId))).toBeNull();
    expect(await findMessageCommandPlan(c.id, c.ownerUserId, Number(un.body.messageId))).not.toBeNull();
  });

  it('R06 — le rejeu n’appelle aucun modèle et n’écrit aucun message', async () => {
    const c = await compte();
    const id = await bien(c, 'Clio', { keyCharacteristics: { mileage: 45000 } });
    expect(id).toBeGreaterThan(0);
    const crid = `l115e-cout-${Date.now()}`;
    await poser(c, 'Quel est le kilométrage de la Clio ?', crid);
    const conversationId = Number((await poser(c, 'Quel est le kilométrage de la Clio ?', `${crid}-bis`)).body.conversationId);
    const avant = await messages(conversationId);
    sim.appels.length = 0;

    const rejeu = await poser(c, 'Quel est le kilométrage de la Clio ?', crid);
    expect(rejeu.body.replayed).toBe(true);
    expect(sim.appels).toEqual([]);
    expect(await messages(conversationId)).toBe(avant);
  });
});
