/**
 * Passage 114AA (Trello #753, CDC T2 §6.1, §8.1, §9.10, §14.3 W21 – W28, §19.10) — de bout en bout sur
 * PostgreSQL réel : façade du service d'export partagée avec la route, façade métier du graphe de la carte
 * #744 pour les événements de référence. Aucune IA, aucune tâche de fond.
 *
 *   E01  W28 : un dossier mis en préparation devient « Prêt » DANS LA CONVERSATION — état relu au retour dans
 *        le fil (historique) et à l'envoi d'un message ; le lien de téléchargement est celui de la route ;
 *   E02  W28 : le coût est borné (aucune lecture de génération sans carte « En préparation ») ; une génération
 *        d'un autre compte ne change jamais une carte ; un échec et une expiration sont dits ;
 *   E03  « cet événement de référence » d'un tour à l'autre : mémorisé après une action aboutie, relu dans le
 *        compte, proposé avec confirmation ; une suppression l'oublie ;
 *   E04  cloisonnement : l'événement du fil ne vaut que pour CE fil et CE membre ; aucun identifiant venu du
 *        modèle ; interrupteur `VEREBONA_ASSISTANT_WRITE_COMMANDS` coupé : aucune action, rien d'écrit ;
 *   E05  chiffre clé : une réponse validée qui en porte un est présentée en blocs, à l'identique au rejeu,
 *        sans rien stocker de plus.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander } from '../chain';

// Stockage objet : configuration factice (aucun appel réseau — le dépôt du ZIP est simulé ci-dessous).
process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
process.env.OVH_S3_ENDPOINT ??= 'https://s3.e2e.invalid';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/export-upload.service', async (o) => ({
  ...(await o<object>()), uploadExportFile: async (_b: Buffer, key: string) => key,
}));
vi.mock('@/services/exports/export-support-notifier', () => ({ notifySupportOfExportFailure: async () => true }));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;

scenario('L114AA-EXPORT-PRET-ET-EVENEMENT-DU-FIL', 'Passage 114AA — dossier d’export prêt annoncé dans la conversation, « cette opération » d’un tour à l’autre, chiffre clé', ({ sql, make }) => {
  const compte = async (plan: 'standard' | 'premium' = 'premium'): Promise<Compte> => {
    const a = await make.account({ plan });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string) => {
    const b = await make.asset(c as never, { name, category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${b.id}`;
    return b.id as number;
  };
  const fil = async (c: Compte) => {
    const { resolveConversation } = await import('@/services/verebona-assistant/core/conversation.service');
    return resolveConversation(c.id, c.ownerUserId, 'fr-FR', undefined);
  };
  /** Historique du fil tel que la route le rend : cartes revérifiées PUIS état des exports relu. */
  const historique = async (c: Compte, conversationId: number) => {
    const { listActiveMessages } = await import('@/services/verebona-assistant/core/conversation.service');
    const { reverifierCartesDesMessages } = await import('@/services/verebona-assistant/core/source-availability.service');
    const { rafraichirCartesExport } = await import('@/services/verebona-assistant/core/export-card-state');
    const page = await listActiveMessages(c.id, c.ownerUserId, conversationId);
    return rafraichirCartesExport(
      await reverifierCartesDesMessages(page.messages as never, c.id),
      c.id,
    ) as Promise<Array<Json>>;
  };
  const cartesDe = (messages: Json[]) =>
    messages.flatMap((m) => (Array.isArray(m.result_groups_json) ? (m.result_groups_json as Json[]) : [])).flatMap((g) => g.items ?? []);
  const generations = (c: Compte) => sql<Json[]>`
    SELECT id::int AS id, public_id, status, export_type FROM export_generation WHERE account_id = ${c.id} ORDER BY id`;
  const preparer = async (c: Compte, message: string, extra: Json = {}) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', message, clientRequestId: `l114aa-${Math.random()}`, locale: 'fr-FR', ...extra } as never);
  };
  const confirmer = async (c: Compte, planId: string) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
  };
  const planDe = (r: Awaited<ReturnType<typeof preparer>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };
  const evenementDuFil = async (conversationId: number) =>
    (await sql<Json[]>`SELECT context_json->'lastReferenceEventId' AS id FROM verebona_conversations WHERE id = ${conversationId}`)[0]?.id ?? null;
  const evenements = (c: Compte) => sql<Json[]>`
    SELECT id::int AS id, type_code, technical_label, provider, invalidated_at IS NOT NULL AS invalide
      FROM business_operations WHERE account_id = ${c.id} ORDER BY id`;
  const fournisseur = async (c: Compte, name: string) => {
    const { createSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    return (await createSupplierForAccount({ accountId: c.id, userId: c.ownerUserId, input: { name } })).id;
  };

  it('E01 — un dossier mis en préparation devient « Prêt » dans la conversation, au retour dans le fil et à l’envoi d’un message', async () => {
    const c = await compte('premium');
    await bien(c, 'Clio');
    const conversationId = await fil(c);

    const r = await demander(c, 'Génère le dossier complet de la Clio', { conversationId });
    expect(r.answer).toContain('est en cours de préparation');
    const [g] = await generations(c);
    expect(g.status).toBe('queued');
    // La carte répondue porte la GÉNÉRATION et son statut d'alors.
    expect(r.resultGroups?.[0].items[0]).toMatchObject({ id: `export_${g.id}`, status: 'En préparation' });

    // Au retour dans le fil, tant que la génération est en file : la carte ne change pas.
    expect(cartesDe(await historique(c, conversationId))).toContainEqual(expect.objectContaining({ id: `export_${g.id}`, status: 'En préparation' }));

    // Le worker (AUTRE processus) termine la génération : rien, dans l'Assistant, ne l'observe.
    await sql`
      UPDATE export_generation
         SET status = 'ready', output_payload = ${JSON.stringify({ pdfS3Key: 'k/dossier.pdf', pdfSize: 1234 })},
             expires_at = now() + interval '30 days', completed_at = now()
       WHERE id = ${g.id}`;

    // 1. L'utilisateur revient dans la conversation : la carte passe à « Prêt », avec le lien de la route.
    const cartes = cartesDe(await historique(c, conversationId));
    expect(cartes).toContainEqual(expect.objectContaining({
      id: `export_${g.id}`, status: 'Prêt', href: `/api/export-generations/${g.public_id}/download?file=pdf`,
    }));
    // Le titre et le bien restent ceux de la réponse : rien n'est réécrit.
    const carte = cartes.find((x) => x.id === `export_${g.id}`)!;
    expect(carte).toMatchObject({ title: 'Dossier complet du bien', subtitle: 'Clio', typeLabel: 'Export' });

    // 2. L'utilisateur envoie un message : la mise à jour part avec la réponse (carte du message ANTÉRIEUR).
    const { misesAJourDuFil } = await import('@/services/verebona-assistant/core/export-card-state');
    const maj = await misesAJourDuFil({ accountId: c.id, userId: c.ownerUserId, conversationId });
    expect(maj).toHaveLength(1);
    expect(maj[0].resultGroups[0].items[0]).toMatchObject({ status: 'Prêt', href: `/api/export-generations/${g.public_id}/download?file=pdf` });

    // RIEN n'est réécrit en base : la réponse enregistrée garde la carte telle qu'elle a été répondue.
    const [enregistre] = await sql<Json[]>`
      SELECT result_groups_json AS g FROM verebona_messages
       WHERE conversation_id = ${conversationId} AND result_groups_json IS NOT NULL ORDER BY id DESC LIMIT 1`;
    expect((enregistre.g as Json[])[0].items[0].status).toBe('En préparation');
    // Aucune tâche de fond, aucune notification : rien n'a été ajouté au fil.
    const [n] = await sql<Json[]>`SELECT count(*)::int AS n FROM verebona_messages WHERE conversation_id = ${conversationId}`;
    expect(n.n).toBe(2);
  });

  it('E02 — coût borné, cloisonnement, échec et expiration', async () => {
    const a = await compte('premium');
    const b = await compte('premium');
    await bien(a, 'Clio');
    const filA = await fil(a);

    // Un fil SANS carte « En préparation » : aucune lecture de génération n'est faite.
    await demander(a, 'Quel est le kilométrage de la Clio ?', { conversationId: filA });
    const { misesAJourDuFil, rafraichirCartesExport } = await import('@/services/verebona-assistant/core/export-card-state');
    const lecteur = vi.fn(async () => []);
    expect(await misesAJourDuFil({ accountId: a.id, userId: a.ownerUserId, conversationId: filA }, lecteur)).toEqual([]);
    expect(lecteur).not.toHaveBeenCalled();

    await demander(a, 'Génère le dossier complet de la Clio', { conversationId: filA });
    const [g] = await generations(a);
    await sql`UPDATE export_generation SET status = 'ready', output_payload = ${JSON.stringify({ zipS3Key: 'k/d.zip' })}, expires_at = now() + interval '30 days' WHERE id = ${g.id}`;

    // Le fil de A voit sa carte prête ; le COMPTE B ne la voit pas et ne peut pas la faire changer.
    expect(cartesDe(await historique(a, filA))).toContainEqual(expect.objectContaining({ status: 'Prêt', href: `/api/export-generations/${g.public_id}/download?file=zip` }));
    const vuDepuisB = await rafraichirCartesExport(
      [{ id: 1, result_groups_json: [{ type: 'document', label: 'Documents', total: 1, hasMore: false, moreHref: null, items: [{ id: `export_${g.id}`, typeLabel: 'Export', title: 'X', subtitle: null, date: null, status: 'En préparation', excerpt: null, href: null }] }] }],
      b.id,
    );
    expect((vuDepuisB[0].result_groups_json as Json[])[0].items[0].status).toBe('En préparation');

    // Échec de la génération : c'est dit, sans lien.
    await sql`UPDATE export_generation SET status = 'failed', output_payload = NULL, expires_at = NULL, error_code = 'GENERATION_FAILED' WHERE id = ${g.id}`;
    expect(cartesDe(await historique(a, filA))).toContainEqual(expect.objectContaining({ id: `export_${g.id}`, status: 'Échec', href: null }));

    // Rétention dépassée : « Expiré », sans lien.
    await sql`UPDATE export_generation SET status = 'ready', output_payload = ${JSON.stringify({ zipS3Key: 'k/d.zip' })}, expires_at = now() - interval '1 day' WHERE id = ${g.id}`;
    expect(cartesDe(await historique(a, filA))).toContainEqual(expect.objectContaining({ id: `export_${g.id}`, status: 'Expiré', href: null }));

    // Génération supprimée : la garde de disponibilité reprend la main (lien retiré, « N'est plus disponible »).
    await sql`UPDATE export_generation SET status = 'deleted' WHERE id = ${g.id}`;
    expect(cartesDe(await historique(a, filA))).toContainEqual(expect.objectContaining({ id: `export_${g.id}`, status: 'N’est plus disponible', href: null }));
  });

  it('E03 — « cette opération » d’un tour à l’autre : mémorisé, relu, confirmé ; une suppression l’oublie', async () => {
    const c = await compte('premium');
    await bien(c, 'Clio');
    const conversationId = await fil(c);
    await fournisseur(c, 'Garage Martin');

    // Tour 1 : déclaration confirmée.
    const p1 = planDe(await preparer(c, 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio', { conversationId }));
    expect(await evenementDuFil(conversationId)).toBeNull();
    expect(await confirmer(c, p1.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [ev] = await evenements(c);
    expect(await evenementDuFil(conversationId)).toBe(ev.id);

    // Tour 2 : la phrase ne nomme plus l'événement — c'est celui du fil, relu dans le compte.
    const { loadThreadContext } = await import('@/services/verebona-assistant/core/conversation.service');
    const ctx = await loadThreadContext(c.id, c.ownerUserId, conversationId);
    expect(ctx!.lastReferenceEventId).toBe(ev.id);
    const p2 = planDe(await preparer(c, 'Relie le fournisseur Garage Martin à cette opération', { conversationId, threadReferenceEventId: ctx!.lastReferenceEventId }));
    // L'aperçu NOMME l'événement : l'utilisateur sait sur quoi il s'engage. Et rien n'est écrit avant.
    expect(p2.preview.summary).toContain('Relier le fournisseur « Garage Martin » à l’opération « Intervention — Vidange »');
    expect(p2.preview.summary).toContain('Confirmez-vous ?');
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(JSON.stringify(p2.preview)).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    expect(await sql`SELECT 1 FROM business_operation_suppliers WHERE account_id = ${c.id}`).toHaveLength(0);
    expect(await confirmer(c, p2.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await sql`SELECT 1 FROM business_operation_suppliers WHERE account_id = ${c.id}`).toHaveLength(1);

    // Tour 3 : le pronom seul, pour la seule forme qui ne peut rien désigner d'autre.
    const ctx3 = await loadThreadContext(c.id, c.ownerUserId, conversationId);
    expect(ctx3!.lastReferenceEventId).toBe(ev.id);
    const p3 = planDe(await preparer(c, 'Corrige le prestataire de cette opération en Garage Martin', { conversationId, threadReferenceEventId: ctx3!.lastReferenceEventId }));
    expect(p3.plan.actions[0].command).toBe('UPDATE_REFERENCE_EVENT');
    expect(await confirmer(c, p3.plan.planId)).toMatchObject({ ok: true });
    expect((await evenements(c))[0].provider).toBe('Garage Martin');

    // Tour 4 : suppression confirmée — le fil OUBLIE l'événement (il n'existe plus).
    const p4 = planDe(await preparer(c, 'Supprime cette opération', { conversationId, threadReferenceEventId: ev.id }));
    expect(p4.preview.summary).toContain('Intervention — Vidange');
    expect(await confirmer(c, p4.plan.planId)).toMatchObject({ ok: true });
    expect((await evenements(c))[0].invalide).toBe(true);
    expect(await evenementDuFil(conversationId)).toBeNull();
    // La phrase suivante ne trouve plus rien : la question est posée, rien n'est préparé.
    expect(await preparer(c, 'Supprime cette opération', { conversationId })).toMatchObject({ kind: 'need_info' });
  });

  it('E04 — cloisonnement du fil et du compte ; interrupteur des actions coupé', async () => {
    const a = await compte('premium');
    const b = await compte('premium');
    await bien(a, 'Clio');
    const filA = await fil(a);
    const p = planDe(await preparer(a, 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio', { conversationId: filA }));
    await confirmer(a, p.plan.planId);
    const [ev] = await evenements(a);
    expect(await evenementDuFil(filA)).toBe(ev.id);

    // Un AUTRE fil du même utilisateur n'a pas d'événement : la question est posée.
    const { getOrCreateActiveConversation, loadThreadContext, clearUserHistory } = await import('@/services/verebona-assistant/core/conversation.service');
    await clearUserHistory(a.id, a.ownerUserId, filA);
    const autreFil = await getOrCreateActiveConversation(a.id, a.ownerUserId, 'fr-FR');
    expect(autreFil).not.toBe(filA);
    expect((await loadThreadContext(a.id, a.ownerUserId, autreFil))!.lastReferenceEventId).toBeNull();
    expect(await preparer(a, 'Supprime cette opération', { conversationId: autreFil })).toMatchObject({ kind: 'need_info' });

    // Le COMPTE B ne retrouve jamais l'événement du compte A, même avec son identifiant.
    expect(await preparer(b, 'Supprime cette opération', { threadReferenceEventId: ev.id })).toMatchObject({ kind: 'need_info' });
    expect(await evenements(b)).toHaveLength(0);
    // Le contexte d'un fil du compte A n'est pas lisible depuis le compte B.
    expect(await loadThreadContext(b.id, b.ownerUserId, autreFil)).toBeNull();

    // Interrupteur coupé : l'Assistant ne prépare plus AUCUNE action — ni sur un événement nommé, ni sur
    // l'événement du fil ; la phrase suit le parcours de réponse normal et rien n'est écrit.
    const { areWriteCommandsEnabled } = await import('@/services/verebona-assistant/config/assistant-config');
    const { buildOrchestratorPorts } = await import('@/services/verebona-assistant/core/ports');
    const avant = process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS;
    process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = 'false';
    try {
      expect(areWriteCommandsEnabled()).toBe(false);
      const ports = buildOrchestratorPorts();
      const entree = { accountId: a.id, userId: a.ownerUserId, planType: 'PREMIUM', locale: 'fr-FR', clientRequestId: 'off', conversationId: filA } as never;
      for (const message of [
        'Déclare une intervention « Freins » réalisée le 2 juin 2024 pour la Clio',
        'Supprime cette opération',
        'Relie le fournisseur Garage Martin à celui-ci',
        'Génère le dossier complet de la Clio',
      ]) {
        expect(await ports.prepareCommand!({ ...(entree as object), message, threadReferenceEventId: ev.id } as never)).toBeNull();
      }
      expect((await evenements(a)).filter((e) => e.technical_label === 'Freins')).toHaveLength(0);
      expect(await generations(a)).toHaveLength(0);
    } finally {
      if (avant === undefined) delete process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS;
      else process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = avant;
    }
  });

  it('E05 — chiffre clé : réponse validée présentée en blocs, à l’identique au rejeu, rien de plus stocké', async () => {
    const c = await compte('premium');
    await bien(c, 'Clio');
    const clientRequestId = `l114aa-cle-${Math.random()}`;
    const r = await demander(c, 'Quel est le kilométrage de la Clio ?', { clientRequestId });

    // Le texte VALIDÉ et enregistré est la seule source de la présentation (le modèle n'écrit cette forme que
    // si le prompt le lui demande — bloc PO n° 40, second passage).
    const TEXTE = 'Voici le bilan de la Clio.\nChiffre clé : 2 974,53 € — coût documenté depuis l’achat\nLe détail figure sur sa fiche.';
    await sql`UPDATE verebona_messages SET content = ${TEXTE} WHERE request_id = ${r.requestId} AND role = 'assistant'`;

    const { answerBlocksForApi } = await import('@/services/verebona-assistant/core/api-payload');
    const { findReplayedAnswer } = await import('@/services/verebona-assistant/core/conversation.service');
    const rejeu = await findReplayedAnswer(c.id, c.ownerUserId, clientRequestId);
    expect(rejeu!.content).toBe(TEXTE);
    const blocs = answerBlocksForApi(rejeu!.content)!;
    expect(blocs.map((b) => b.kind)).toEqual(['paragraph', 'metric', 'paragraph']);
    expect(blocs[1]).toEqual({
      kind: 'metric',
      value: [{ text: '2 974,53 €' }],
      caption: [{ text: 'coût documenté depuis l’achat' }],
    });
    // Rien n'est enregistré en plus du texte.
    const [col] = await sql<Json[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'verebona_messages' AND column_name LIKE '%metric%'`;
    expect(col.n).toBe(0);
  });
});
