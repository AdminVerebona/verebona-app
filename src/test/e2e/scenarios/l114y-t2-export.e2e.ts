/**
 * Lot 114Y (Trello #753, CDC T2 §9.10, §12.5, §14.3 W28, D27) — EXPORT DEMANDÉ DEPUIS L'ASSISTANT, de bout en bout
 * sur PostgreSQL réel : `runAssistant` + ports réels, façade du service d'export partagée avec la route
 * (`export-request.facade`), historique des générations réel. Seul le dépôt du fichier (stockage objet) est simulé.
 *
 *   E01  données brutes (offre Standard) : générées tout de suite, SANS plan ni confirmation ; ligne d'historique
 *        prête ; carte de téléchargement ; réponse enregistrée et rejouée à l'identique (cartes comprises) ;
 *   E02  dossier prêt à l'emploi en Standard : refus du service d'export repris, rien n'est mis en file ;
 *   E03  dossier prêt à l'emploi en Premium : mis en file une fois ; la même demande répétée ne crée pas de doublon ;
 *   E04  deux comptes : le bien de l'autre compte est introuvable, rien n'est généré chez lui ; export non nommé
 *        ou bien non désigné : une question, rien n'est généré ;
 *   E05  aucune donnée métier modifiée (bien, documents, échéances) ; interrupteur des actions coupé : la phrase
 *        suit le parcours d'aide, rien n'est généré ;
 *   E06  parité : la route `POST /api/assets/[id]/exports` et l'Assistant produisent la même ligne d'historique ;
 *   E07  compte en lecture seule : données brutes générées comme depuis l'onglet Exports, dossier refusé par le service.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { demander } from '../chain';

// Stockage objet : configuration factice (aucun appel réseau — le dépôt du ZIP est simulé ci-dessous).
process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
process.env.OVH_S3_ENDPOINT ??= 'https://s3.e2e.invalid';

const h = vi.hoisted(() => ({ depots: [] as string[], session: { currentAccountId: 0, userId: 0 } }));

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
// Stockage objet simulé : le ZIP est réellement construit, seul son dépôt est remplacé.
vi.mock('@/services/export-upload.service', async (o) => ({
  ...(await o<object>()),
  uploadExportFile: async (_buffer: Buffer, key: string) => { h.depots.push(key); return key; },
}));
vi.mock('@/services/exports/export-support-notifier', () => ({ notifySupportOfExportFailure: async () => true }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: h.session.userId, currentAccountId: h.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;

scenario('L114Y-EXPORT', 'Lot 114Y — export demandé depuis l’Assistant (génération directe, sans confirmation)', ({ sql, make }) => {
  const compte = async (plan: 'standard' | 'premium'): Promise<Compte> => {
    const a = await make.account({ plan });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string, category = 'VEHICULE') => {
    const b = await make.asset(c as never, { name, category });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${b.id}`;
    return b.id as number;
  };
  const generations = (c: Compte) => sql<Json[]>`
    SELECT id, public_id, asset_id, account_id, user_id, export_type, status, output_format, requested_outputs
      FROM export_generation WHERE account_id = ${c.id} ORDER BY id`;
  const plans = async (c: Compte) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_command_plans WHERE account_id = ${c.id}`)[0].n);
  const etatBien = async (id: number) => (await sql<Json[]>`SELECT name, key_characteristics, updated_at::text AS updated_at FROM assets WHERE id = ${id}`)[0];
  const fil = async (c: Compte) => {
    const { resolveConversation } = await import('@/services/verebona-assistant/core/conversation.service');
    return resolveConversation(c.id, c.ownerUserId, 'fr-FR', undefined);
  };
  const carte = (r: Awaited<ReturnType<typeof demander>>) => r.resultGroups?.[0]?.items?.[0];

  it('E01 — données brutes en Standard : générées tout de suite, sans plan ; carte de téléchargement ; rejeu à l’identique', async () => {
    const c = await compte('standard');
    const clio = await bien(c, 'Clio');
    const avant = await etatBien(clio);
    const conversationId = await fil(c);
    const clientRequestId = `l114y-e01-${Math.random()}`;
    h.depots = [];

    const r = await demander(c, 'Exporte les données brutes de la Clio', { planType: 'STANDARD', conversationId, clientRequestId });

    expect(r.error ?? null).toBeNull();
    expect(r.commandPlan ?? null).toBeNull();
    expect(r.clarification ?? null).toBeNull();
    expect(r.answer).toBe('L’export « Export données brutes » de Clio est prêt. Il reste disponible 30 jours dans les exports de ce bien.');
    expect(r.cascade?.intent).toBe('EXPORT_COMMAND');
    expect(r.cascade?.aiCalls ?? 0).toBe(0);

    const lignes = await generations(c);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({ asset_id: clio, account_id: c.id, user_id: c.ownerUserId, export_type: 'EXPORT_BRUT', status: 'ready', output_format: 'ZIP' });
    expect(h.depots).toHaveLength(1);
    expect(carte(r)).toMatchObject({
      id: `asset_${clio}`, typeLabel: 'Export', title: 'Export données brutes', subtitle: 'Clio', status: 'Prêt',
      href: `/api/export-generations/${lignes[0].public_id}/download?file=zip`,
    });
    // Aucune confirmation : aucun plan n'a été préparé ; aucune donnée métier n'a bougé.
    expect(await plans(c)).toBe(0);
    expect(await etatBien(clio)).toEqual(avant);

    // Réponse enregistrée avec sa carte, et rejouée à l'identique sans rien régénérer.
    const { findReplayedAnswer } = await import('@/services/verebona-assistant/core/conversation.service');
    const rejeu = await findReplayedAnswer(c.id, c.ownerUserId, clientRequestId);
    expect(rejeu?.content).toBe(r.answer);
    expect(rejeu?.resultGroups).toEqual(JSON.parse(JSON.stringify(r.resultGroups)));
    expect(await generations(c)).toHaveLength(1);
  });

  it('E02 — dossier prêt à l’emploi en Standard : refus du service d’export, rien n’est mis en file', async () => {
    const c = await compte('standard');
    await bien(c, 'Clio');
    const r = await demander(c, 'Génère le dossier complet de la Clio', { planType: 'STANDARD' });
    expect(r.answer).toBe('« Dossier complet du bien » pour Clio n’a pas été lancé. Cette fonctionnalité est disponible avec Premium et Premium Duo.');
    expect(r.resultGroups ?? []).toEqual([]);
    expect(r.actions.map((a) => a.type)).toEqual([]);
    expect(r.commandPlan ?? null).toBeNull();
    expect(await generations(c)).toHaveLength(0);
  });

  it('E03 — dossier prêt à l’emploi en Premium : mis en file une fois ; demande répétée sans doublon', async () => {
    const c = await compte('premium');
    const clio = await bien(c, 'Clio');
    const r = await demander(c, 'Génère le dossier complet de la Clio');
    expect(r.answer).toBe('Le dossier « Dossier complet du bien » de Clio est en cours de préparation. Vous le retrouverez, dès qu’il sera prêt, dans les exports de ce bien.');
    expect(r.commandPlan ?? null).toBeNull();
    let lignes = await generations(c);
    expect(lignes).toHaveLength(1);
    // Passage 114AA : la carte porte l'identifiant de la GÉNÉRATION, pour que son état soit relu ensuite.
    expect(carte(r)).toMatchObject({ id: `export_${lignes[0].id}`, title: 'Dossier complet du bien', status: 'En préparation', href: `/assets/${clio}?tab=exports` });
    expect(lignes[0]).toMatchObject({ asset_id: clio, export_type: 'DOSSIER_COMPLET', status: 'queued', output_format: 'PDF' });

    const encore = await demander(c, 'Génère le dossier complet de la Clio');
    expect(encore.answer).toContain('est déjà en cours de préparation');
    lignes = await generations(c);
    expect(lignes).toHaveLength(1);
    expect(await plans(c)).toBe(0);
    // La file est laissée propre pour les autres scénarios du fichier.
    await sql`UPDATE export_generation SET status = 'failed' WHERE account_id = ${c.id} AND status = 'queued'`;
  });

  it('E04 — deux comptes cloisonnés ; export non nommé ou bien non désigné : une question, rien n’est généré', async () => {
    const a = await compte('standard');
    const b = await compte('standard');
    await bien(a, 'Clio');
    const twingo = await bien(b, 'Twingo');

    // Le bien de l'autre compte est introuvable depuis le compte A, par son nom comme par un contexte de page forgé.
    const parNom = await demander(a, 'Exporte les données brutes de la Twingo', { planType: 'STANDARD' });
    expect(parNom.answer).toBe('Je n’ai pas trouvé ce bien dans votre compte. Pour quel bien voulez-vous cet export ?');
    const parPage = await demander(a, 'Exporte les données brutes de ce bien', { planType: 'STANDARD', pageContext: { assetId: String(twingo) } });
    expect(parPage.answer).toBe('Pour quel bien voulez-vous cet export ?');

    const sansType = await demander(a, 'Exporte la Clio', { planType: 'STANDARD' });
    expect(sansType.answer).toBe('Quel export voulez-vous pour Clio ? « Export données brutes », « Dossier complet du bien », « Kit de mise en vente », « Assurance — souscription / mise à jour », « Assurance — sinistre / indemnisation ».');
    const sansBien = await demander(a, 'Exporte les données brutes', { planType: 'STANDARD' });
    expect(sansBien.answer).toBe('Pour quel bien voulez-vous cet export ?');

    expect(await generations(a)).toHaveLength(0);
    expect(await generations(b)).toHaveLength(0);
  });

  it('E05 — interrupteur des actions coupé : la phrase suit le parcours d’aide, rien n’est généré ; une question n’est jamais une demande', async () => {
    const c = await compte('standard');
    await bien(c, 'Clio');
    const question = await demander(c, 'Comment exporter les données brutes de la Clio ?', { planType: 'STANDARD' });
    expect(question.cascade?.intent).not.toBe('EXPORT_COMMAND');
    expect(await generations(c)).toHaveLength(0);

    const avant = process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS;
    process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = 'false';
    try {
      const r = await demander(c, 'Exporte les données brutes de la Clio', { planType: 'STANDARD' });
      expect(r.cascade?.intent).not.toBe('EXPORT_COMMAND');
      expect(await generations(c)).toHaveLength(0);
    } finally {
      if (avant === undefined) delete process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS; else process.env.VEREBONA_ASSISTANT_WRITE_COMMANDS = avant;
    }
  });

  it('E06 — parité : la route des exports et l’Assistant produisent la même ligne d’historique', async () => {
    const c = await compte('standard');
    const clio = await bien(c, 'Clio');
    h.session.currentAccountId = c.id; h.session.userId = c.ownerUserId;
    const { POST } = await import('@/app/api/assets/[id]/exports/route');
    const res = await POST(new NextRequest(`https://app.e2e.verebona.test/api/assets/${clio}/exports`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.e2e.verebona.test' },
      body: JSON.stringify({ exportType: 'EXPORT_BRUT', requestedOutputs: ['ZIP'] }),
    }), { params: Promise.resolve({ id: String(clio) }) });
    expect(res.status).toBe(200);
    const json = await res.json() as Json;
    expect(json).toMatchObject({ status: 'ready', generationStatus: 'ready' });
    expect(json.downloadZipUrl).toBe(`/api/export-generations/${json.publicId}/download?file=zip`);

    await demander(c, 'Exporte les données brutes de la Clio', { planType: 'STANDARD' });
    const lignes = await generations(c);
    expect(lignes).toHaveLength(2);
    const sansId = ({ id: _i, public_id: _p, ...reste }: Json) => reste;
    expect(sansId(lignes[1])).toEqual(sansId(lignes[0]));
  });

  it('E07 — compte en lecture seule : données brutes générées (comme depuis l’onglet Exports), dossier refusé par le service', async () => {
    const c = await compte('premium');
    const clio = await bien(c, 'Clio');
    // Fin d'essai : abonnement échu — les droits réels sont ceux que lit le service d'export.
    await sql`UPDATE account_subscriptions SET status = 'canceled' WHERE account_id = ${c.id}`;
    const brut = await demander(c, 'Exporte les données brutes de la Clio', { planType: 'STANDARD', planLimit: 'SUBSCRIPTION_REQUIRED', aiAccess: { canWrite: false } });
    expect(brut.cascade?.intent).toBe('EXPORT_COMMAND');
    expect(carte(brut)).toMatchObject({ id: `asset_${clio}`, status: 'Prêt' });
    const dossier = await demander(c, 'Génère le dossier complet de la Clio', { planType: 'STANDARD', planLimit: 'SUBSCRIPTION_REQUIRED', aiAccess: { canWrite: false } });
    expect(dossier.answer).toContain('n’a pas été lancé.');
    const lignes = await generations(c);
    expect(lignes.map((l) => [l.export_type, l.status])).toEqual([['EXPORT_BRUT', 'ready']]);
  });
});
