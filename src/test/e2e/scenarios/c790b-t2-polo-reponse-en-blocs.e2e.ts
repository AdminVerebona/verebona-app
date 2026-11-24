/**
 * Carte #790, relance du 21/11/2026 (E03) — « Quel est le coût de possession de Polo ? » de bout en bout sur
 * PostgreSQL réel, par les VRAIES routes (`POST /api/verebona/messages`, `GET /api/verebona/conversation`).
 *
 * Jeu : une voiture « Polo » sans date ni prix d'achat, sans valeur estimée, et six dépenses consolidées qui
 * reproduisent EXACTEMENT les montants de la carte : 559,51 € (entretien, réparations, travaux),
 * 1 115,53 € (contrats, assurances), 801,37 € (autres) — total 2 476,41 €. Les montants sont calculés par le
 * VRAI moteur du coût de possession (aucun calcul dans ce scénario, aucune valeur injectée dans la réponse).
 *
 *   P01  production : le total seul en chiffre principal, la ventilation, les réserves — blocs distincts ;
 *        montants identiques à ceux du moteur (fiche) ; une seule affirmation, sur la source du coût ;
 *   P02  persistance : le texte enregistré est celui de la réponse ; rien d'autre n'est stocké pour les blocs ;
 *   P03  historique : le message relu porte le même texte, donc les mêmes blocs à l'écran ;
 *   P04  rejeu du même `clientRequestId` : réponse et blocs identiques, aucun second message, aucune écriture,
 *        aucun appel modèle ;
 *   P05  droits : Standard — aucun montant, aucun chiffre clé, coût de possession non lu ; Premium Duo — les
 *        deux membres obtiennent la même réponse chiffrée, chacun dans son fil ;
 *   P06  isolation : un autre compte qui possède aussi une « Polo » n'obtient que SES montants ;
 *   P07  voie IA simulée : des lignes structurées du modèle arrivent en blocs, à l'identique au rejeu.
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

const QUESTION = 'Quel est le coût de possession de Polo ?';
const nb = (s: string) => s.replace(/[  ]/g, ' ');
const montants = (s: string) => (nb(s).match(/\d+(?: \d{3})*,\d{2} €/g) ?? []).sort();
const ATTENDU = [
  'Chiffre clé : 2 476,41 € — coût cumulé documenté de Polo',
  '',
  'Ventilation :',
  '• Entretien, réparations et travaux : 559,51 €',
  '• Contrats et assurances : 1 115,53 €',
  '• Autres coûts : 801,37 €',
].join('\n');

scenario('C790B-POLO', 'Carte #790 (relance) — coût de possession de Polo : réponse en blocs, de la production au rejeu', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T2'] });
  const appels: string[] = [];
  /** Lignes que le modèle simulé rend à la prochaine demande ANSWER (P07). */
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

  it('P01 — production : chiffre principal seul, ventilation, réserves — et les montants du moteur, inchangés', async () => {
    const { c, poloId } = await preparer('premium');
    const tco = await (await import('@/services/business-operations/tco/service')).readAssetTco(c.id, poloId);
    // Le jeu reproduit exactement la carte, par le moteur réel.
    expect(tco.summary.cumulativeCostCents).toBe(247_641);
    expect(tco.breakdown.map((b) => [b.category, b.costsCents])).toEqual([['MAINTENANCE', 55_951], ['CONTRACTS', 111_553], ['OTHER', 80_137]]);
    expect(tco.summary.currentValue).toBeNull();
    expect(tco.period.start).toBeNull();

    const { status, body } = await poser(c, QUESTION, 'polo-p01');
    expect(status).toBe(200);
    expect(body.mode).toBe('deterministic');
    const answer = nb(String(body.answer));
    expect(answer.startsWith(`${ATTENDU}\n\nLimites :\n`)).toBe(true);
    // Les trois réserves de la carte, chacune sur sa ligne, à part des montants.
    const limites = answer.split('\n\nLimites :\n')[1].split('\n');
    expect(limites.some((l) => /^• Coût annuel moyen de possession non calculé : date d’achat du bien inconnue/.test(l))).toBe(true);
    expect(limites).toContain('• Coût net estimé non calculé : aucune estimation de valeur admissible postérieure à l’achat (le prix d’achat n’est jamais une valeur actuelle).');
    expect(limites).toContain('• Ce total peut être incomplet.');
    expect(limites.join(' ')).not.toMatch(/\d,\d{2} €/);
    // Chaque montant de la carte une seule fois ; aucun autre (non-double-comptage).
    expect(montants(answer)).toEqual(['1 115,53 €', '2 476,41 €', '559,51 €', '801,37 €']);
    // Blocs transmis par l'API : cinq blocs distincts, dans l'ordre de lecture.
    expect(formes(body)).toEqual(['metric', 'paragraph', 'list', 'paragraph', 'list']);
    const [principal, , ventilation, , reserves] = body.answerBlocks as Array<{ kind: string; value?: Array<{ text: string }>; caption?: Array<{ text: string }>; items?: Array<Array<{ text: string }>> }>;
    expect(nb(principal.value!.map((s) => s.text).join(''))).toBe('2 476,41 €');
    expect(principal.caption!.map((s) => s.text).join('')).toBe('coût cumulé documenté de Polo');
    expect(ventilation.items!.map((it) => nb(it.map((s) => s.text).join('')))).toEqual([
      'Entretien, réparations et travaux : 559,51 €', 'Contrats et assurances : 1 115,53 €', 'Autres coûts : 801,37 €',
    ]);
    expect(reserves.items).toHaveLength(limites.length);
    expect(appels).toEqual([]);

    // Affirmation ENREGISTRÉE avec le message : une seule, calculée, dont le texte est la réponse (chaque bloc en vient).
    const affirmations = await sql<{ claim_key: string; claim_text: string; derivation: string }[]>`
      SELECT claim_key, claim_text, derivation FROM verebona_message_claims WHERE message_id = ${Number(body.messageId)}`;
    expect(affirmations.map((x) => [x.claim_key, x.derivation, x.claim_text === body.answer])).toEqual([['ownership_cost', 'calculated', true]]);
    const { runAssistant } = await import('@/services/verebona-assistant/core/assistant-orchestrator.service');
    const { buildOrchestratorPorts } = await import('@/services/verebona-assistant/core/ports');
    const { getEntitlements } = await import('@/services/entitlements.service');
    const { assistantPlanFromEntitlements } = await import('@/services/verebona-assistant/core/plan-eligibility');
    const { assistantAiAccessFromEntitlements } = await import('@/services/verebona-assistant/core/ai-access');
    const ent = await getEntitlements(c.id);
    const direct = await runAssistant({
      accountId: c.id, userId: c.ownerUserId, planType: assistantPlanFromEntitlements(ent), aiAccess: assistantAiAccessFromEntitlements(ent),
      message: QUESTION, clientRequestId: 'polo-p01-direct', locale: 'fr-FR', pageContext: { route: '/accueil', platform: 'web' },
    } as never, buildOrchestratorPorts());
    expect(direct.cascade?.strategy).toBe('structured.ownership_cost');
    expect(direct.answer).toBe(body.answer);
    expect(direct.claims.map((x) => [x.claimKey, x.sourceIds, x.derivation, x.text === direct.answer])).toEqual([['ownership_cost', [`tco:${poloId}`], 'calculated', true]]);
    expect(direct.sources.map((x) => x.id)).toEqual([`tco:${poloId}`]);
  });

  it('P02 / P03 — persistance et historique : le texte enregistré porte la structure ; l’historique redonne les mêmes blocs', async () => {
    const { c } = await preparer('premium');
    const { body } = await poser(c, QUESTION, 'polo-p02');
    const lignes = await lignesMessages(body.conversationId!);
    expect(lignes.map((l) => l.role)).toEqual(['user', 'assistant']);
    // Une seule source : le texte enregistré EST la réponse rendue (aucune colonne de blocs).
    expect(lignes[1].content).toBe(body.answer);
    const colonnes = await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'verebona_messages'`;
    expect(colonnes.map((x) => x.column_name).filter((n) => /block/i.test(n))).toEqual([]);

    const h = await historique(c, body.conversationId!);
    expect(h.status).toBe(200);
    const relu = h.body.messages.find((m) => m.role === 'assistant')!;
    expect(relu.content).toBe(body.answer);
    // Ce que l'écran fait d'un message d'historique (aucun bloc reçu) : mêmes blocs qu'au premier retour.
    const { answerBlocksFor } = await import('@/lib/verebona/answer-blocks');
    expect(answerBlocksFor(String(relu.content), undefined)).toEqual(body.answerBlocks);
    expect(answerBlocksFor(String(relu.content), body.answerBlocks)).toEqual(body.answerBlocks);
  });

  it('P04 — rejeu du même clientRequestId : réponse et blocs identiques, aucun second message, aucun appel modèle', async () => {
    const { c } = await preparer('premium');
    const premier = await poser(c, QUESTION, 'polo-p04');
    const avant = await lignesMessages(premier.body.conversationId!);
    const rejeu = await poser(c, QUESTION, 'polo-p04');
    expect(rejeu.status).toBe(200);
    expect(rejeu.body.answer).toBe(premier.body.answer);
    expect(rejeu.body.answerBlocks).toEqual(premier.body.answerBlocks);
    expect(rejeu.body.messageId).toBe(premier.body.messageId);
    expect(rejeu.body.conversationId).toBe(premier.body.conversationId);
    expect(rejeu.body.sourceCount ?? 0).toBe(premier.body.sourceCount ?? 0);
    expect((rejeu.body.actions ?? []).map((a) => a.type)).toEqual((premier.body.actions ?? []).map((a) => a.type));
    // Aucune seconde écriture : mêmes lignes, mêmes identifiants, même contenu.
    expect(await lignesMessages(premier.body.conversationId!)).toEqual(avant);
    expect(appels).toEqual([]);
    // Troisième envoi : toujours la même réponse (le rejeu ne dépend pas d'un état transitoire).
    const encore = await poser(c, QUESTION, 'polo-p04');
    expect(encore.body.answerBlocks).toEqual(premier.body.answerBlocks);
    expect((await lignesMessages(premier.body.conversationId!)).length).toBe(2);
  });

  it('P05 — droits : Standard sans aucun montant ni chiffre clé ; Premium Duo : même réponse chiffrée pour les deux membres, chacun son fil', async () => {
    const std = await preparer('standard');
    const refuse = await poser(std.c, QUESTION, 'polo-p05-std');
    expect(refuse.status).toBe(200);
    expect(String(refuse.body.answer)).toMatch(/^Le coût de possession est disponible avec Premium et Premium Duo\.\n\nPour Polo, vous pouvez consulter vos dépenses documentées/);
    expect(montants(String(refuse.body.answer))).toEqual([]);
    expect(String(refuse.body.answer)).not.toMatch(/\d/);
    expect(formes(refuse.body)).not.toContain('metric');
    expect(JSON.stringify(refuse.body)).not.toMatch(/2476|247641|559,51/);

    const duo = await preparer('premium_duo');
    const second = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.c.id}, ${second.id}, 'member', 'active')`;
    const a = await poser(duo.c, QUESTION, 'polo-p05-duo');
    const b = await poser(duo.c, QUESTION, 'polo-p05-duo', second.id as number);
    expect(nb(String(a.body.answer)).startsWith(ATTENDU)).toBe(true);
    expect(b.body.answer).toBe(a.body.answer);
    expect(b.body.answerBlocks).toEqual(a.body.answerBlocks);
    // Même identifiant de demande, autre membre : jamais la réponse de l'autre (fil et message distincts).
    expect(b.body.conversationId).not.toBe(a.body.conversationId);
    expect(b.body.messageId).not.toBe(a.body.messageId);
    expect((await historique(duo.c, a.body.conversationId!, second.id as number)).status).toBe(404);
  });

  it('P06 — isolation : la « Polo » d’un autre compte ne donne que ses propres montants', async () => {
    const { c } = await preparer('premium');
    const autre = await preparer('premium', [['INTERVENTION', 12_345, 'Vidange']]);
    const r = await poser(autre.c, QUESTION, 'polo-p06');
    expect(montants(String(r.body.answer))).toEqual(['123,45 €', '123,45 €']);
    expect(nb(String(r.body.answer))).not.toMatch(/2 476,41|559,51|1 115,53|801,37/);
    const mien = await poser(c, QUESTION, 'polo-p06');
    expect(montants(String(mien.body.answer))).toEqual(['1 115,53 €', '2 476,41 €', '559,51 €', '801,37 €']);
  });

  it('P07 — voie IA simulée, par la vraie route : les lignes structurées du modèle arrivent en blocs, identiques à l’historique et au rejeu', async () => {
    const { c } = await preparer('premium');
    lignesModele = [
      { text: 'Voici ce que je retiens pour Polo :', sourceIds: [], factual: false },
      { text: '• Polo est enregistrée dans votre compte.', sourceIds: ['première source'] },
      { text: '• Elle fait partie de vos véhicules.', sourceIds: ['première source'] },
    ];
    const premier = await poser(c, 'Fais-moi une synthèse de la Polo', 'polo-p07');
    expect(premier.status).toBe(200);
    expect(appels).toContain('ANSWER');
    expect(premier.body.mode).toBe('ai');
    // Le filtre de sortie du modèle (existant) retire l'espace avant « : » ; la liste suit son annonce.
    expect(premier.body.answer).toBe('Voici ce que je retiens pour Polo:\n• Polo est enregistrée dans votre compte.\n• Elle fait partie de vos véhicules.');
    expect(formes(premier.body)).toEqual(['paragraph', 'list']);
    const lignes = await lignesMessages(premier.body.conversationId!);
    expect(lignes[lignes.length - 1].content).toBe(premier.body.answer);
    const h = await historique(c, premier.body.conversationId!);
    const { answerBlocksFor } = await import('@/lib/verebona/answer-blocks');
    expect(answerBlocksFor(String(h.body.messages.find((m) => m.role === 'assistant')!.content), undefined)).toEqual(premier.body.answerBlocks);
    appels.length = 0;
    const rejeu = await poser(c, 'Fais-moi une synthèse de la Polo', 'polo-p07');
    expect(rejeu.body.answer).toBe(premier.body.answer);
    expect(rejeu.body.answerBlocks).toEqual(premier.body.answerBlocks);
    expect(appels).toEqual([]);
    expect((await lignesMessages(premier.body.conversationId!)).length).toBe(lignes.length);

    // Règle remplacée (carte #790 recentrée le 22/11/2026, §2.B) : « sans structure dans la sortie du modèle : un
    // paragraphe, comme avant (aucun bloc à transmettre) ». Deux affirmations distinctes ne sont plus concaténées :
    // une par paragraphe (détail : `c790c-t2-reponse-ia-affirmations.e2e.ts`).
    lignesModele = [
      { text: 'Polo est enregistrée dans votre compte.', sourceIds: ['première source'] },
      { text: 'Elle fait partie de vos véhicules.', sourceIds: ['première source'] },
    ];
    (await import('@/services/verebona-assistant/core/retrieval-cache')).clearRetrievalCache?.();
    const simple = await poser(c, 'Fais-moi une synthèse de la Polo', 'polo-p07-simple');
    expect(simple.body.mode).toBe('ai');
    expect(simple.body.answer).toBe('Polo est enregistrée dans votre compte.\n\nElle fait partie de vos véhicules.');
    expect(formes(simple.body)).toEqual(['paragraph', 'paragraph']);
  });
});
