/**
 * Carte #790 RECENTRÉE (22/11/2026), complément du 24/11 — voie IA à PLUSIEURS AFFIRMATIONS et ancien historique,
 * de bout en bout sur PostgreSQL réel, par les VRAIES routes (`POST /api/verebona/messages`,
 * `GET /api/verebona/conversation`, `GET /api/verebona/messages/[id]/sources`).
 *
 *   Q01  §2.B / §2.D — réponse IA à plusieurs affirmations : une affirmation par paragraphe ; le texte enregistré
 *        porte les frontières ; chaque affirmation est enregistrée avec SA source ; l'historique redonne les mêmes
 *        blocs ; le rejeu du même `clientRequestId` rend la même présentation SANS appel d'IA ni seconde écriture ;
 *   Q02  réponse IA simple (une affirmation) : une phrase, aucun bloc transmis ; lignes qui forment une même
 *        phrase : un paragraphe ;
 *   Q03  §4.3 — ANCIEN historique : un message enregistré avant les correctifs (réponse monobloc) est relu tel
 *        quel, jamais réécrit ; il s'affiche en un paragraphe ; la même question reposée rend la réponse en blocs ;
 *   Q04  §4.4 — sources sur demande : mêmes sources avant et après le rejeu ; ni l'autre membre d'un compte Duo,
 *        ni un autre compte ne lisent le fil, la réponse ou les sources ; le même identifiant de demande envoyé
 *        par un autre compte ne rend jamais la réponse du premier.
 *
 * Fournisseur d'IA SIMULÉ et COMPTÉ : aucun appel réel.
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
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
vi.mock('@/lib/verebona/rate-limit', async (o) => ({
  ...(await o<object>()),
  checkAssistantRateLimit: async () => ({ allowed: true, retryAfterMs: 0 }),
  checkAssistantReadRateLimit: async () => ({ allowed: true, retryAfterMs: 0 }),
}));
vi.mock('@/services/verebona-assistant', async (o) => ({ ...(await o<object>()), ensureAssistantStartupChecked: () => ({ ok: true }) }));

type Compte = { id: number; ownerUserId: number };
type Bloc = { kind: string } & Record<string, unknown>;
type Corps = Record<string, unknown> & {
  answer?: string; requestId?: string; messageId?: string; conversationId?: number; intent?: string; mode?: string;
  sourceCount?: number; answerBlocks?: Bloc[]; actions?: Array<{ type: string }>;
};


const SYNTHESE = 'Fais-moi une synthèse de la Polo';
const QUESTION_TCO = 'Quel est le coût de possession de Polo ?';
const A1 = 'Polo est enregistrée dans votre compte.';
const A2 = 'Elle fait partie de vos véhicules.';
const A3 = 'Elle est rattachée à votre espace.';

scenario('C790C-IA', 'Carte #790 recentrée — réponse IA à plusieurs affirmations et ancien historique : mêmes blocs de la production au rejeu', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  const appels: string[] = [];
  /** Lignes que le modèle simulé rend à la prochaine demande ANSWER. */
  let lignesModele: Array<{ text: string; sourceIds: string[]; factual?: boolean }> | null = null;

  beforeAll(async () => {
    (await import('@/services/ai/gateway/providers')).setAiProvider({
      name: 'simule', isConfigured: () => true,
      async call(input: { task?: string; operationCode?: string; prompt?: string }) {
        if (String(input.operationCode ?? '').startsWith('t2_')) appels.push(String(input.task ?? input.operationCode));
        if (input.task === 'UNDERSTAND') {
          return { rawText: JSON.stringify({ mode: 'UNDERSTAND', confidence: 'low', intent: 'UNKNOWN', requestedTopics: [], filters: {}, entityHints: [], requestedFacts: [], reason: 'simulé' }), inputTokens: 1, outputTokens: 1 };
        }
        if (input.task === 'ANSWER') {
          const ids = [...String(input.prompt ?? '').matchAll(/"sourceId": "([^"]+)"/g)].map((m) => m[1]);
          const claims = (lignesModele ?? []).map((l) => ({ ...l, sourceIds: l.sourceIds.length ? ids.slice(0, 1) : [] }));
          return { rawText: JSON.stringify({ mode: 'ANSWER', format: 'claims', status: 'answered', claims }), inputTokens: 1, outputTokens: 1 };
        }
        return { rawText: '{}', inputTokens: 0, outputTokens: 0 };
      },
    } as never);
  });
  beforeEach(async () => {
    (await import('@/services/verebona-assistant/core/retrieval-cache')).clearRetrievalCache?.();
    appels.length = 0;
    lignesModele = null;
  });

  /** Dépenses consolidées réalisées d'un bien : (type d'opération, centimes). */
  const depenses = async (c: Compte, assetId: number, lignes: ReadonlyArray<readonly [string, number, string]>) => {
    for (const [type, cents, libelle] of lignes) {
      const [op] = await sql<{ id: number }[]>`
        INSERT INTO business_operations (account_id, type_code, status, realized_date, technical_label)
        VALUES (${c.id}, ${type}, 'REALIZED', DATE '2025-03-10', ${libelle}) RETURNING id::int AS id`;
      await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority)
                VALUES (${c.id}, ${op.id}, 'MIGRATION', ${`e2e:${op.id}`}, 'STRUCTURED')`;
      await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority)
                VALUES (${c.id}, ${op.id}, ${assetId}, 'PRIMARY', 'STRUCTURED')`;
      await sql`INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency)
                VALUES (${c.id}, ${op.id}, 'REALIZED_COST', ${cents}, 'EUR')`;
    }
  };
  /** Les montants de la carte : 559,51 + 1 115,53 + 801,37 = 2 476,41. */
  const POLO_CARTE = [
    ['INTERVENTION', 30_000, 'Révision annuelle'], ['INTERVENTION', 25_951, 'Remplacement des plaquettes'],
    ['CONTRACT', 70_000, 'Assurance auto 2025'], ['CONTRACT', 41_553, 'Contrat d’entretien'],
    ['OTHER', 50_000, 'Stationnement résident'], ['OTHER', 30_137, 'Frais divers'],
  ] as const;
  const preparer = async (plan: 'standard' | 'premium' | 'premium_duo', lignes: ReadonlyArray<readonly [string, number, string]> = POLO_CARTE) => {
    const a = await make.account({ plan });
    const c: Compte = { id: a.id, ownerUserId: a.ownerUserId };
    const polo = await make.asset(a as never, { name: 'Polo', category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${polo.id}`;
    await depenses(c, polo.id as number, lignes);
    return { c, poloId: polo.id as number };
  };
  /** VRAIE route d'envoi, avec la session du membre demandé. */
  const poser = async (c: Compte, message: string, clientRequestId: string, userId = c.ownerUserId) => {
    session.userId = userId; session.currentAccountId = c.id;
    const { POST } = await import('@/app/api/verebona/messages/route');
    const res = await POST(new NextRequest('http://localhost/api/verebona/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, clientRequestId, pageContext: { route: '/accueil', platform: 'web' } }),
    }));
    return { status: res.status, body: await res.json() as Corps };
  };
  /** VRAIE route de l'historique. */
  const historique = async (c: Compte, conversationId: number, userId = c.ownerUserId) => {
    session.userId = userId; session.currentAccountId = c.id;
    const { GET } = await import('@/app/api/verebona/conversation/route');
    const res = await GET(new NextRequest(`http://localhost/api/verebona/conversation?conversationId=${conversationId}`));
    return { status: res.status, body: await res.json() as { messages: Array<Record<string, unknown>> } };
  };
  const lignesMessages = (conversationId: number) => sql<{ id: number; role: string; content: string }[]>`
    SELECT id::int AS id, role, content FROM verebona_messages WHERE conversation_id = ${conversationId} ORDER BY id`;
  const formes = (b: Corps) => (b.answerBlocks ?? []).map((x) => x.kind);

  /** VRAIE route des sources d'un message. */
  const sourcesDe = async (c: Compte, messageId: unknown, userId = c.ownerUserId) => {
    session.userId = userId; session.currentAccountId = c.id;
    const { GET } = await import('@/app/api/verebona/messages/[messageId]/sources/route');
    const res = await GET(new NextRequest(`http://localhost/api/verebona/messages/${messageId}/sources`), { params: Promise.resolve({ messageId: String(messageId) }) });
    return { status: res.status, body: await res.json() as { sources?: Array<{ id?: string; title?: string }>; total?: number } };
  };
  const source = (text: string) => ({ text, sourceIds: ['première source'] });

  it('Q01 — plusieurs affirmations : un paragraphe chacune ; texte enregistré, affirmations sourcées, historique et rejeu identiques, sans appel d’IA', async () => {
    const { c } = await preparer('premium');
    lignesModele = [source(A1), source(A2), source(A3)];
    const premier = await poser(c, SYNTHESE, 'ia-q01');
    expect(premier.status).toBe(200);
    expect(premier.body.mode).toBe('ai');
    expect(appels.filter((a) => a === 'ANSWER')).toHaveLength(1);
    // Recette §4 point 2 : les affirmations distinctes ne sont pas concaténées en un seul bloc.
    expect(premier.body.answer).toBe([A1, A2, A3].join('\n\n'));
    expect(formes(premier.body)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect((premier.body.answerBlocks ?? []).map((b) => (b.spans as Array<{ text: string }>).map((s) => s.text).join(''))).toEqual([A1, A2, A3]);

    // Persistance : le texte enregistré porte les frontières ; chaque affirmation est enregistrée, avec sa source.
    const lignes = await lignesMessages(premier.body.conversationId!);
    expect(lignes[lignes.length - 1].content).toBe(premier.body.answer);
    const affirmations = await sql<{ claim_key: string; claim_text: string; sources: number }[]>`
      SELECT c.claim_key, c.claim_text, (SELECT count(*)::int FROM verebona_claim_sources cs WHERE cs.claim_id = c.id) AS sources
      FROM verebona_message_claims c WHERE c.message_id = ${Number(premier.body.messageId)} ORDER BY c.id`;
    expect(affirmations.map((x) => [x.claim_key, x.claim_text])).toEqual([['c1', A1], ['c2', A2], ['c3', A3]]);
    expect(affirmations.every((x) => x.sources >= 1)).toBe(true);

    // Historique : même texte, donc mêmes blocs à l'écran (aucun bloc n'est stocké).
    const h = await historique(c, premier.body.conversationId!);
    const relu = h.body.messages.filter((m) => m.role === 'assistant').pop()!;
    expect(relu.content).toBe(premier.body.answer);
    const { answerBlocksFor } = await import('@/lib/verebona/answer-blocks');
    expect(answerBlocksFor(String(relu.content), undefined)).toEqual(premier.body.answerBlocks);

    // Rejeu du même clientRequestId : même présentation, aucun appel d'IA, aucune écriture.
    const sourcesAvant = await sourcesDe(c, premier.body.messageId);
    const nbAffirmations = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_message_claims c JOIN verebona_messages m ON m.id = c.message_id WHERE m.conversation_id = ${premier.body.conversationId!}`)[0].n;
    const avant = await nbAffirmations();
    appels.length = 0;
    // Même si le modèle répondait autre chose, le rejeu ne l'interroge pas.
    lignesModele = [source('Tout autre texte.')];
    for (let i = 0; i < 2; i += 1) {
      const rejeu = await poser(c, SYNTHESE, 'ia-q01');
      expect(rejeu.status).toBe(200);
      expect(rejeu.body.answer).toBe(premier.body.answer);
      expect(rejeu.body.answerBlocks).toEqual(premier.body.answerBlocks);
      expect(rejeu.body.messageId).toBe(premier.body.messageId);
      expect((rejeu.body.actions ?? []).map((a) => a.type)).toEqual((premier.body.actions ?? []).map((a) => a.type));
      expect(rejeu.body.sourceCount ?? 0).toBe(premier.body.sourceCount ?? 0);
    }
    expect(appels).toEqual([]);
    expect(await lignesMessages(premier.body.conversationId!)).toEqual(lignes);
    expect(await nbAffirmations()).toBe(avant);
    // Sources sur demande : identiques avant et après le rejeu.
    expect(sourcesAvant.status).toBe(200);
    expect((sourcesAvant.body.sources ?? []).length).toBeGreaterThan(0);
    expect((await sourcesDe(c, premier.body.messageId)).body).toEqual(sourcesAvant.body);

    // Requêtes en LECTURE SEULE données au PO dans la fiche (pas à pas 8.1 et 8.2) : exécutées telles quelles ici.
    const dernieres = await sql.unsafe(`
      SELECT id, mode, intent, support_level, created_at, left(content, 200) AS debut
      FROM verebona_messages
      WHERE account_id = ${c.id} AND role = 'assistant'
      ORDER BY id DESC
      LIMIT 10`);
    expect(dernieres.map((x) => x.mode)).toEqual(['ai']);
    const detail = await sql.unsafe(`
      SELECT c.claim_key, c.claim_text,
             (SELECT count(*) FROM verebona_claim_sources cs WHERE cs.claim_id = c.id) AS sources
      FROM verebona_message_claims c
      WHERE c.message_id = ${Number(premier.body.messageId)}
      ORDER BY c.id`);
    expect(detail).toHaveLength(3);
    const prompt = await sql.unsafe(`
      SELECT environment, treatment, master_prompt_code, version_number, status, content_sha256, activated_at
      FROM ai_master_prompt_versions
      WHERE status = 'ACTIVE' AND treatment = 'T2'
      ORDER BY environment`);
    expect(Array.isArray(prompt)).toBe(true);
  });

  it('Q02 — réponse IA simple : une phrase, aucun bloc transmis ; lignes d’une même phrase : un paragraphe', async () => {
    const { c } = await preparer('premium');
    lignesModele = [source(A1)];
    const simple = await poser(c, SYNTHESE, 'ia-q02');
    expect(simple.body.mode).toBe('ai');
    expect(simple.body.answer).toBe(A1);
    expect(simple.body.answerBlocks).toBeUndefined();

    (await import('@/services/verebona-assistant/core/retrieval-cache')).clearRetrievalCache?.();
    lignesModele = [source('Polo est enregistrée dans votre compte'), source('et elle fait partie de vos véhicules.')];
    const phrase = await poser(c, SYNTHESE, 'ia-q02-phrase');
    expect(phrase.body.mode).toBe('ai');
    expect(phrase.body.answer).toBe('Polo est enregistrée dans votre compte et elle fait partie de vos véhicules.');
    expect(phrase.body.answerBlocks).toBeUndefined();
  });

  it('Q03 — ancien historique : un message monobloc d’avant les correctifs est relu tel quel, en un paragraphe ; la question reposée rend les blocs', async () => {
    const { c } = await preparer('premium');
    // Un premier échange crée le fil ; on y enregistre ensuite, tels qu'ils l'étaient avant les correctifs,
    // une réponse « coût de possession » sur une ligne et une réponse IA dont les affirmations sont recollées.
    const neuf = await poser(c, QUESTION_TCO, 'ia-q03');
    const conversationId = neuf.body.conversationId!;
    const ANCIEN_TCO = 'Coût de possession de Polo : coût cumulé documenté 2 476,41 € (entretien, réparations et travaux 559,51 €, contrats et assurances 1 115,53 €, autres coûts 801,37 €). Ce total peut être incomplet.';
    const ANCIEN_IA = `${A1} ${A2} ${A3}`;
    const anciens: number[] = [];
    for (const [i, content] of [ANCIEN_TCO, ANCIEN_IA].entries()) {
      // Mêmes colonnes que l'enregistrement d'une réponse (`conversation.service`), daté d'avant les correctifs.
      const [cree] = await sql<{ id: number }[]>`
        INSERT INTO verebona_messages (conversation_id, account_id, author_user_id, role, status, content, intent, mode, support_level, request_id, response_locale, expires_at, created_at)
        SELECT conversation_id, account_id, NULL, 'assistant', 'ready', ${content}, intent, ${i === 0 ? 'deterministic' : 'ai'}, support_level, ${`ancien-${i}`}, response_locale, expires_at,
               TIMESTAMPTZ '2026-11-10 10:00:00+00' + ${i} * INTERVAL '1 minute'
        FROM verebona_messages WHERE id = ${Number(neuf.body.messageId)}
        RETURNING id::int AS id`;
      anciens.push(cree.id);
    }
    const h = await historique(c, conversationId);
    expect(h.status).toBe(200);
    const { answerBlocksFor, answerBlocksText } = await import('@/lib/verebona/answer-blocks');
    for (const [i, content] of [ANCIEN_TCO, ANCIEN_IA].entries()) {
      const relu = h.body.messages.find((m) => Number(m.id) === anciens[i])!;
      // Relu tel qu'enregistré : aucune réécriture, aucune réinterprétation.
      expect(relu.content).toBe(content);
      const blocs = answerBlocksFor(String(relu.content), (relu as { answerBlocks?: unknown }).answerBlocks);
      expect(blocs.map((b) => b.kind)).toEqual(['paragraph']);
      expect(answerBlocksText(blocs)).toBe(content);
    }
    // La lecture de l'historique n'écrit rien : les anciens messages restent tels quels en base.
    const enBase = await sql<{ id: number; content: string }[]>`SELECT id::int AS id, content FROM verebona_messages WHERE id IN ${sql(anciens)} ORDER BY id`;
    expect(enBase.map((x) => x.content)).toEqual([ANCIEN_TCO, ANCIEN_IA]);
    // La même question, reposée aujourd'hui, rend la réponse en blocs ; l'ancien message n'est pas modifié.
    const repose = await poser(c, QUESTION_TCO, 'ia-q03-bis');
    expect(formes(repose.body)).toEqual(['metric', 'paragraph', 'list', 'paragraph', 'list']);
    expect((await sql<{ content: string }[]>`SELECT content FROM verebona_messages WHERE id = ${anciens[0]}`)[0].content).toBe(ANCIEN_TCO);
  });

  it('Q04 — aucune fuite : ni l’autre membre d’un compte Duo, ni un autre compte ne lisent le fil, la réponse ou ses sources', async () => {
    const duo = await preparer('premium_duo');
    const second = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.c.id}, ${second.id}, 'member', 'active')`;
    lignesModele = [source(A1), source(A2)];
    const a = await poser(duo.c, SYNTHESE, 'ia-q04');
    expect(a.body.mode).toBe('ai');
    expect(formes(a.body)).toEqual(['paragraph', 'paragraph']);
    expect(((await sourcesDe(duo.c, a.body.messageId)).body.sources ?? []).length).toBeGreaterThan(0);

    // Second membre du même compte, même identifiant de demande : SA demande, SON fil — jamais la réponse de l'autre.
    (await import('@/services/verebona-assistant/core/retrieval-cache')).clearRetrievalCache?.();
    lignesModele = [source(A3)];
    const b = await poser(duo.c, SYNTHESE, 'ia-q04', second.id as number);
    expect(b.body.conversationId).not.toBe(a.body.conversationId);
    expect(b.body.messageId).not.toBe(a.body.messageId);
    expect(b.body.answer).toBe(A3);
    expect((await historique(duo.c, a.body.conversationId!, second.id as number)).status).toBe(404);
    const sourcesParAutreMembre = await sourcesDe(duo.c, a.body.messageId, second.id as number);
    expect((sourcesParAutreMembre.body.sources ?? []).length).toBe(0);

    // Autre compte : ni le fil, ni les sources ; le même identifiant de demande ne rend pas la réponse du premier.
    const autre = await preparer('premium', [['INTERVENTION', 12_345, 'Vidange']]);
    expect((await historique(autre.c, a.body.conversationId!)).status).toBe(404);
    expect(((await sourcesDe(autre.c, a.body.messageId)).body.sources ?? []).length).toBe(0);
    (await import('@/services/verebona-assistant/core/retrieval-cache')).clearRetrievalCache?.();
    lignesModele = [source('Polo figure parmi vos biens.')];
    const etranger = await poser(autre.c, SYNTHESE, 'ia-q04');
    expect(etranger.body.messageId).not.toBe(a.body.messageId);
    expect(etranger.body.answer).toBe('Polo figure parmi vos biens.');
    // Le premier membre retrouve toujours SA réponse, intacte.
    appels.length = 0;
    const rejeu = await poser(duo.c, SYNTHESE, 'ia-q04');
    expect(rejeu.body.answer).toBe(a.body.answer);
    expect(rejeu.body.answerBlocks).toEqual(a.body.answerBlocks);
    expect(appels).toEqual([]);
  });
});
