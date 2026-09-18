/**
 * CDC §22.6, §22.7 et §22.9 — résolution et contrôle des actions.
 *
 * La règle du §22.7 : le serveur vérifie la cible AVANT de produire une action,
 * et il vérifie la bonne table. L'ancienne implémentation interrogeait les
 * quatre vérificateurs et acceptait dès que l'un répondait vrai — un
 * identifiant de document pouvait donc autoriser l'ouverture d'un bien.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveActions, exigeUneCible, type AccessChecker } from '../action-resolver.service';

function acces(over: Partial<AccessChecker> = {}): AccessChecker {
  return {
    assetInAccount: vi.fn(async () => true),
    documentInAccount: vi.fn(async () => true),
    agendaItemInAccount: vi.fn(async () => true),
    helpEntryPublished: vi.fn(async () => true),
    ...over,
  };
}

describe('contrôle d\'accès dirigé par le type d\'action', () => {
  it('interroge la table du type visé, et elle seule', async () => {
    const access = acces();
    await resolveActions({
      accountId: 1, intent: 'ACCOUNT_SEARCH_ASSET',
      actionIntents: [{ type: 'OPEN_ASSET', targetId: 'asset_42' }],
      access,
    });

    expect(access.assetInAccount).toHaveBeenCalledWith(1, 42);
    expect(access.documentInAccount).not.toHaveBeenCalled();
    expect(access.agendaItemInAccount).not.toHaveBeenCalled();
  });

  it("n'autorise pas l'ouverture d'un bien avec un identifiant de document", async () => {
    // Même si le document existe bien dans le compte : ce n'est pas la même
    // entité, et le lien mènerait à une fiche sans rapport.
    const actions = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_SEARCH_ASSET',
      actionIntents: [{ type: 'OPEN_ASSET', targetId: 'doc_42' }],
      access: acces(),
    });
    expect(actions).toHaveLength(0);
  });

  it('écarte une action à cible dont la cible est absente', async () => {
    const actions = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_SEARCH_ASSET',
      actionIntents: [{ type: 'OPEN_ASSET' }],
      access: acces(),
    });
    expect(actions).toHaveLength(0);
  });

  it("écarte une cible qui n'appartient pas au compte", async () => {
    const actions = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_SEARCH_DOCUMENT',
      actionIntents: [{ type: 'OPEN_DOCUMENT', targetId: 'doc_128' }],
      access: acces({ documentInAccount: vi.fn(async () => false) }),
    });
    expect(actions).toHaveLength(0);
  });

  it('écarte un type non autorisé pour l\'intention (§22.1)', async () => {
    const actions = await resolveActions({
      accountId: 1, intent: 'PRODUCT_PLAN_LIMIT',   // n'autorise que OPEN_PRICING
      actionIntents: [{ type: 'OPEN_DOCUMENT', targetId: 'doc_1' }],
      access: acces(),
    });
    expect(actions).toHaveLength(0);
  });
});

describe('construction du href (§22.7)', () => {
  it('produit une URL vers la page de détail réelle', async () => {
    const [action] = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_SEARCH_DOCUMENT',
      actionIntents: [{ type: 'OPEN_DOCUMENT', targetId: 'doc_128' }],
      access: acces(),
    });
    expect(action.href).toBe('/documents/128');
  });

  it('ouvre le bien sur l\'onglet demandé par le serveur', async () => {
    const [action] = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_SEARCH_ASSET',
      actionIntents: [{ type: 'OPEN_ASSET', targetId: 'asset_42', params: { tab: 'equipments' } }],
      access: acces(),
    });
    expect(action.href).toBe('/assets/42?tab=equipments');
  });

  it('envoie « À traiter » sur /accueil/a-traiter', async () => {
    const [action] = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_TO_PROCESS',
      actionIntents: [{ type: 'OPEN_TO_PROCESS' }],
      access: acces(),
    });
    expect(action.href).toBe('/accueil/a-traiter');
  });

  it('ouvre la zone d\'export dans la fiche du bien, pas sur une page /export', async () => {
    const [action] = await resolveActions({
      accountId: 1, intent: 'EXPORT_HELP',
      actionIntents: [{ type: 'OPEN_EXPORT_AREA', targetId: 'asset_42' }],
      access: acces(),
    });
    expect(action.href).toBe('/assets/42?tab=exports');
  });

  it('ne propose plus les fournisseurs, faute de route', async () => {
    // `/fournisseurs` n'existe pas : l'intention oriente vers les documents.
    const actions = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_SEARCH_SUPPLIER',
      actionIntents: [{ type: 'OPEN_SUPPLIERS' }, { type: 'OPEN_DOCUMENTS_PAGE' }],
      access: acces(),
    });
    expect(actions.map((a) => a.type)).toEqual(['OPEN_DOCUMENTS_PAGE']);
  });
});

describe('limite du §22.9 et doublons', () => {
  it('retient au plus trois actions métier : une principale, deux secondaires', async () => {
    const actions = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_SEARCH_ASSET',
      actionIntents: [
        { type: 'OPEN_ASSET', targetId: 'asset_1' },
        { type: 'OPEN_ASSET', targetId: 'asset_2' },
        { type: 'OPEN_ASSET', targetId: 'asset_3' },
        { type: 'OPEN_ASSET', targetId: 'asset_4' },
      ],
      access: acces(),
    });
    expect(actions).toHaveLength(3);
    expect(actions[0].href).toBe('/assets/1');   // l'ordre de pertinence est conservé
  });

  it('ne compte pas deux fois le même bien remonté par plusieurs sources', async () => {
    // Un bien, une de ses pièces et un de ses équipements produisent trois
    // fois la même cible : sans déduplication, le quota est consommé pour un
    // seul objet.
    const actions = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_SEARCH_ASSET',
      actionIntents: [
        { type: 'OPEN_ASSET', targetId: 'asset_42' },
        { type: 'OPEN_ASSET', targetId: 'asset_42' },
        { type: 'OPEN_ASSET', targetId: 'asset_7' },
      ],
      access: acces(),
    });
    expect(actions.map((a) => a.href)).toEqual(['/assets/42', '/assets/7']);
  });

  it('les actions non métier ne consomment pas le quota', async () => {
    const actions = await resolveActions({
      accountId: 1, intent: 'ACCOUNT_FACT_ASSET',
      actionIntents: [
        { type: 'OPEN_ASSET', targetId: 'asset_1' },
        { type: 'OPEN_DOCUMENT', targetId: 'doc_1' },
        { type: 'SHOW_SOURCES' },
      ],
      access: acces(),
    });
    expect(actions.map((a) => a.type)).toContain('SHOW_SOURCES');
  });
});

describe('exigeUneCible', () => {
  it('distingue les actions d\'ouverture d\'objet des actions de liste', () => {
    expect(exigeUneCible('OPEN_ASSET')).toBe(true);
    expect(exigeUneCible('OPEN_DOCUMENT')).toBe(true);
    expect(exigeUneCible('OPEN_EXPORT_AREA')).toBe(true);
    expect(exigeUneCible('OPEN_DOCUMENTS_PAGE')).toBe(false);
    expect(exigeUneCible('OPEN_HELP')).toBe(false);
  });
});
