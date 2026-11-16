/**
 * Lot 114Y (Trello #753, CDC T2 §9.2, §14.3 W11, M27) — DÉPÔT D'UN FICHIER DEMANDÉ DEPUIS L'ASSISTANT, de bout en
 * bout sur PostgreSQL réel : `runAssistant` + ports réels (résolution du bien, résolveur d'actions, persistance).
 *
 *   E01  « Dépose une facture pour la Clio » : aucun document créé, aucun plan ; le bouton existant « Ajouter un
 *        document » est proposé avec le bien présélectionné (commande de création contrôlée par le serveur) ;
 *   E02  bien d'un autre compte (nommé, ou glissé dans le contexte de page) : jamais présélectionné ;
 *   E03  compte en lecture seule : c'est dit, aucun bouton ;
 *   E04  une question d'aide n'est pas une demande de dépôt.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

scenario('L114Y-DEPOT', 'Lot 114Y — dépôt d’un fichier demandé depuis l’Assistant (parcours existant, aucun faux dépôt)', ({ sql, make }) => {
  const compte = async (): Promise<Compte> => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string) => {
    const b = await make.asset(c as never, { name, category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL WHERE id = ${b.id}`;
    return b.id as number;
  };
  const documents = async (c: Compte) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${c.id}`)[0].n);
  const plans = async (c: Compte) => Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM verebona_command_plans WHERE account_id = ${c.id}`)[0].n);
  const depot = (r: Awaited<ReturnType<typeof demander>>) => r.actions.map((a) => ({ type: a.type, label: a.label, href: a.href, command: a.command ?? null }));

  it('E01 — bouton existant « Ajouter un document », bien présélectionné ; aucun document ni plan créé', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const r = await demander(c, 'Dépose une facture pour la Clio');
    expect(r.cascade?.intent).toBe('UPLOAD_COMMAND');
    expect(r.cascade?.aiCalls ?? 0).toBe(0);
    expect(r.answer).toBe('Pour déposer un document pour Clio, choisissez le fichier avec le bouton « Ajouter un document » ci-dessous.');
    expect(depot(r)).toEqual([{ type: 'START_ADD_DOCUMENT', label: 'Ajouter un document', href: null, command: { kind: 'CREATE', flow: 'document', assetId: clio } }]);
    expect(r.commandPlan ?? null).toBeNull();
    expect(await documents(c)).toBe(0);
    expect(await plans(c)).toBe(0);

    // Sans bien nommé, sur la fiche d'un bien : ce bien.
    const page = await demander(c, 'Ajoute un document', { pageContext: { assetId: String(clio), route: `/assets/${clio}` } });
    expect(depot(page)[0]?.command).toEqual({ kind: 'CREATE', flow: 'document', assetId: clio });
    // Sans bien du tout : la fenêtre de dépôt s'ouvre sans bien présélectionné.
    const sans = await demander(c, 'Ajoute un document');
    expect(sans.answer).toBe('Pour déposer un document, choisissez le fichier avec le bouton « Ajouter un document » ci-dessous. Vous indiquerez le bien concerné dans la fenêtre de dépôt.');
    expect(depot(sans)[0]?.command).toEqual({ kind: 'CREATE', flow: 'document', assetId: null });
  });

  it('E02 — bien d’un autre compte : jamais présélectionné', async () => {
    const a = await compte();
    const b = await compte();
    await bien(a, 'Clio');
    const twingo = await bien(b, 'Twingo');
    const parNom = await demander(a, 'Dépose une facture pour la Twingo');
    expect(depot(parNom)[0]?.command).toEqual({ kind: 'CREATE', flow: 'document', assetId: null });
    const parPage = await demander(a, 'Ajoute un document pour ce bien', { pageContext: { assetId: String(twingo) } });
    expect(depot(parPage)[0]?.command).toEqual({ kind: 'CREATE', flow: 'document', assetId: null });
    expect(await documents(b)).toBe(0);
  });

  it('E03 — compte en lecture seule : c’est dit, aucun bouton', async () => {
    const c = await compte();
    await bien(c, 'Clio');
    const r = await demander(c, 'Dépose une facture pour la Clio', { planLimit: 'TRIAL_EXPIRED' });
    expect(r.answer).toContain('Votre compte est en lecture seule');
    expect(r.actions.filter((a) => a.type === 'START_ADD_DOCUMENT')).toEqual([]);
    expect(await documents(c)).toBe(0);
  });

  it('E04 — une question d’aide n’est pas une demande de dépôt', async () => {
    const c = await compte();
    await bien(c, 'Clio');
    const r = await demander(c, 'Comment ajouter un document ?');
    expect(r.cascade?.intent).not.toBe('UPLOAD_COMMAND');
  });
});
