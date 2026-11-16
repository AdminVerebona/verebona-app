/**
 * Lot 114Y (Trello #753, CDC T2 §7.6, §8.3, §12.4, §13.8 — D05, D24, D25, M12, M14) — SOURCES SUR DEMANDE ET
 * RÉPONSES EN BLOCS, de bout en bout sur PostgreSQL réel : `runAssistant` + ports réels, réponses enregistrées
 * (`verebona_messages`, `verebona_message_sources`, cartes), rejeu d'une demande.
 *
 *   E01  par défaut, aucune source du compte n'est présentée ; « D'où vient ce chiffre ? » présente l'élément du
 *        compte sur lequel s'appuie la réponse précédente (fiche du bien, champ concerné), sans appel modèle ;
 *        la réponse et sa carte sont enregistrées ;
 *   E02  aucune réponse précédente dans le fil : la phrase suit le parcours normal ;
 *   E03  cloisonnement : le fil d'un autre utilisateur ne livre rien ; un autre compte non plus ;
 *   E04  bien supprimé après la réponse : l'élément est annoncé sans lien ;
 *   E05  blocs : mêmes blocs à la réponse et au rejeu de la demande (dérivés du texte enregistré).
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;

scenario('L114Y-SOURCES', 'Lot 114Y — sources sur demande et réponses en blocs', ({ sql, make }) => {
  const compte = async (): Promise<Compte> => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const polo = async (c: Compte) => {
    const a = await make.asset(c as never, { category: 'VEHICULE', name: 'Polo', keyCharacteristics: { acquisitionDate: '2021-06-15', acquisitionPrice: 18500, mileage: 82000 } });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${a.id}`;
    return a.id as number;
  };
  const fil = async (c: Compte, userId = c.ownerUserId) => {
    const { resolveConversation } = await import('@/services/verebona-assistant/core/conversation.service');
    return resolveConversation(c.id, userId, 'fr-FR', undefined);
  };
  const cartes = (r: Awaited<ReturnType<typeof demander>>) => (r.resultGroups ?? []).flatMap((g) => g.items);
  const api = async (r: Awaited<ReturnType<typeof demander>>) => (await import('@/services/verebona-assistant/core/api-payload')).toApiPayload(r);

  it('E01 — par défaut aucune source présentée ; « D’où vient ce chiffre ? » présente l’élément de la réponse précédente', async () => {
    const c = await compte();
    const id = await polo(c);
    const conversationId = await fil(c);

    const r = await demander(c, 'Quel est le kilométrage de la Polo ?', { conversationId });
    expect(r.answer.replace(/[  ]/g, ' ')).toContain('82 000 km');
    expect(r.sources.map((s) => s.id)).toContain(`asset_field:${id}:mileage`);
    // Par défaut : la réponse ne présente aucune carte de source.
    expect(r.resultGroups ?? []).toEqual([]);

    const d = await demander(c, 'D’où vient ce chiffre ?', { conversationId });
    expect(d.cascade?.intent).toBe('SOURCE_DISCLOSURE');
    expect(d.cascade?.aiCalls ?? 0).toBe(0);
    expect(d.answer).toBe('Voici l’élément de votre compte sur lequel s’appuie la réponse précédente.');
    expect(cartes(d)).toHaveLength(1);
    expect(cartes(d)[0]).toMatchObject({ id: `asset_field:${id}:mileage`, typeLabel: 'Bien', href: `/assets/${id}?tab=details&highlight=mileage` });
    expect(d.commandPlan ?? null).toBeNull();
    expect(d.clarification ?? null).toBeNull();

    // Enregistrée avec sa carte (relue telle quelle dans l'historique).
    const [ligne] = await sql<Json[]>`
      SELECT content, result_groups_json FROM verebona_messages
       WHERE conversation_id = ${conversationId} AND role = 'assistant' ORDER BY id DESC LIMIT 1`;
    expect(ligne.content).toBe(d.answer);
    expect(ligne.result_groups_json).toEqual(JSON.parse(JSON.stringify(d.resultGroups)));
  });

  it('E02 — aucune réponse précédente dans le fil : parcours normal', async () => {
    const c = await compte();
    await polo(c);
    const d = await demander(c, 'D’où vient ce chiffre ?', { conversationId: await fil(c) });
    expect(d.cascade?.intent).not.toBe('SOURCE_DISCLOSURE');
    expect(d.resultGroups ?? []).toEqual([]);
    const sansFil = await demander(c, 'D’où vient ce chiffre ?');
    expect(sansFil.cascade?.intent).not.toBe('SOURCE_DISCLOSURE');
  });

  it('E03 — cloisonnement : fil d’un autre utilisateur du compte, autre compte', async () => {
    const c = await compte();
    const id = await polo(c);
    const conversationId = await fil(c);
    await demander(c, 'Quel est le kilométrage de la Polo ?', { conversationId });

    const { discloseSources, sqlSourceDisclosureDeps } = await import('@/services/verebona-assistant/core/source-disclosure');
    const deps = await sqlSourceDisclosureDeps();
    // Le titulaire, dans son fil : l'élément est lu.
    const titulaire = await discloseSources({ accountId: c.id, userId: c.ownerUserId, conversationId }, deps);
    expect(titulaire?.resultGroups.flatMap((g) => g.items).map((x) => x.id)).toEqual([`asset_field:${id}:mileage`]);
    // Un autre membre du même compte, avec l'identifiant du fil du titulaire : rien.
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${c.id}, ${membre.id}, 'member', 'active')`;
    expect(await discloseSources({ accountId: c.id, userId: membre.id, conversationId }, deps)).toBeNull();
    // Un autre compte, avec le même identifiant de fil : rien.
    const autre = await compte();
    expect(await discloseSources({ accountId: autre.id, userId: autre.ownerUserId, conversationId }, deps)).toBeNull();
    expect(await discloseSources({ accountId: autre.id, userId: c.ownerUserId, conversationId }, deps)).toBeNull();
  });

  it('E04 — bien supprimé après la réponse : élément annoncé sans lien', async () => {
    const c = await compte();
    const id = await polo(c);
    const conversationId = await fil(c);
    await demander(c, 'Quel est le kilométrage de la Polo ?', { conversationId });
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${id}`;
    const d = await demander(c, 'Quelle est la source ?', { conversationId });
    expect(d.cascade?.intent).toBe('SOURCE_DISCLOSURE');
    expect(cartes(d)).toHaveLength(1);
    expect(cartes(d)[0]).toMatchObject({ href: null, status: 'N’est plus disponible' });
  });

  it('E05 — blocs : mêmes blocs à la réponse et au rejeu de la demande', async () => {
    const c = await compte();
    await polo(c);
    const conversationId = await fil(c);
    const clientRequestId = `l114y-blocs-${Math.random()}`;
    const r = await demander(c, 'Quel est le prix d’achat de la Polo ?', { conversationId, clientRequestId });
    expect(r.answer.replace(/[  ]/g, ' ')).toContain('18 500 €');
    const envoye = await api(r);
    // Le montant est mis en évidence ; le texte de la réponse est inchangé.
    expect(envoye.answer).toBe(r.answer);
    const forts = (envoye.answerBlocks ?? []).flatMap((b) => (
      // Passage 114Z3 : les blocs comptent aussi des titres et des tableaux — tous les fragments sont parcourus.
      b.kind === 'paragraph' || b.kind === 'heading' ? b.spans
        : b.kind === 'list' ? b.items.flat()
          : b.kind === 'table' ? [...(b.header ?? []), ...b.rows.flat()].flat() : []
    )).filter((s) => s.strong).map((s) => s.text.replace(/[  ]/g, ' '));
    expect(forts).toEqual(['18 500 €']);

    const { findReplayedAnswer } = await import('@/services/verebona-assistant/core/conversation.service');
    const { answerBlocksForApi } = await import('@/services/verebona-assistant/core/api-payload');
    const rejeu = await findReplayedAnswer(c.id, c.ownerUserId, clientRequestId);
    expect(rejeu?.content).toBe(r.answer);
    expect(answerBlocksForApi(rejeu!.content)).toEqual(envoye.answerBlocks);
  });
});
