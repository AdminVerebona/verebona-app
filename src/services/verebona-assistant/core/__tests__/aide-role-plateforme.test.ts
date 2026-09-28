/**
 * Contexte transmis au moteur d'aide : plateforme ET rôle — CDC Centre d'aide
 * T2-05 (« plateforme/connexion/offre/rôle/écran/type d'objet transmis et
 * vérifié à chaque interaction »), CDC Assistant §10.
 *
 * Les rôles (titulaire, membre Duo, payeur, utilisateur autorisé…) sont
 * résolus CÔTÉ SERVEUR — jamais lus dans la requête du client — et exprimés
 * dans le vocabulaire des articles (`roles:` du front-matter, référentiel
 * `ROLES` du site public).
 */
import { describe, it, expect, vi } from 'vitest';
import type { HelpRoleSituation } from '../retrieval.service';

const h = vi.hoisted(() => ({
  unsafe: vi.fn(async (): Promise<unknown[]> => [situation({ account_member: true })]),
  retrieveHelpSources: vi.fn(async () => []),
}));

vi.mock('@/db', () => ({ pgClient: { unsafe: h.unsafe }, db: {}, ensureUnaccent: vi.fn(async () => {}) }));
vi.mock('../help-corpus.service', async (orig) => ({
  ...(await orig<typeof import('../help-corpus.service')>()),
  retrieveHelpSources: h.retrieveHelpSources,
}));

function situation(over: Record<string, boolean> = {}) {
  return {
    account_owner: false, account_member: false, duo_holder: false, duo_member: false,
    pays_subscription: false, pending_transmission: false, ...over,
  };
}

function sit(over: Partial<HelpRoleSituation> = {}): HelpRoleSituation {
  return {
    accountOwner: false, accountMember: false, duoHolder: false, duoMember: false,
    paysSubscription: false, pendingTransmission: false, ...over,
  };
}

/** Miroir de `ROLES` (site public `src/help/referentials.ts`), hors `all`. */
const ARTICLE_ROLES = ['owner', 'duo_member', 'authorized_user', 'recipient', 'concerned_user', 'billing_owner', 'referrer'];

const { retrieve, helpRolesFor, helpRolesFromSituation } = await import('../retrieval.service');
const help = await import('../help-corpus.service');
const { routeForIntent } = await import('../intent-router.service');

describe('aide : plateforme et rôle transmis (T2-05)', () => {
  it('le rôle vient du compte (serveur), la plateforme du contexte de page validé', async () => {
    await retrieve(routeForIntent('PRODUCT_HELP_HOW_TO', 'STANDARD', 't'), {
      accountId: 7, userId: 3, planType: 'STANDARD', message: 'Comment ajouter un document ?',
      clientRequestId: 'c', locale: 'fr-FR', pageContext: { route: '/documents', platform: 'mobile' },
    });
    const [, plan, , ctx] = h.retrieveHelpSources.mock.calls[0] as unknown as [string, string, number, { platform: string; roles: string[] }];
    expect(plan).toBe('STANDARD');
    expect(ctx.platform).toBe('mobile');
    expect(ctx.roles).toEqual(expect.arrayContaining(['authorized_user']));
    expect(ctx.roles).not.toContain('member');
    const [sql, params] = h.unsafe.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/owner_user_id = \$2/);
    expect(params).toEqual([7, 3]);
  });

  it('titulaire d’un compte payant → owner + billing_owner + referrer', async () => {
    h.unsafe.mockResolvedValueOnce([situation({ account_owner: true, pays_subscription: true })]);
    const roles = await helpRolesFor(7, 3);
    expect(roles).toEqual(expect.arrayContaining(['owner', 'billing_owner', 'referrer', 'concerned_user']));
    expect(roles).not.toContain('duo_member');
  });

  it('compte introuvable → aucun rôle', async () => {
    h.unsafe.mockResolvedValueOnce([]);
    expect(await helpRolesFor(7, 3)).toEqual([]);
  });

  it('le layout transmet la route ; le hook ajoute la plateforme', async () => {
    const { readFileSync } = await import('node:fs');
    const hook = readFileSync('src/lib/verebona/useVerebona.ts', 'utf8');
    expect(hook).toMatch(/enrichPageContext\(rawPageContext, currentPlatform\(\)\)/);
  });
});

describe('situation réelle → rôles des articles (T2-05)', () => {
  it('titulaire d’un Premium Duo : owner + billing_owner, jamais duo_member', () => {
    const r = helpRolesFromSituation(sit({ accountOwner: true, duoHolder: true, paysSubscription: true }));
    expect(r).toEqual(expect.arrayContaining(['owner', 'billing_owner']));
    expect(r).not.toContain('duo_member');
  });

  it('second utilisateur Duo : duo_member, ni owner du Duo ni billing_owner', () => {
    const r = helpRolesFromSituation(sit({ duoMember: true }));
    expect(r).toContain('duo_member');
    expect(r).not.toContain('billing_owner');
    expect(r).not.toContain('owner');
  });

  it('membre Duo sur son propre compte gratuit : owner (de son compte) + duo_member, pas billing_owner', () => {
    const r = helpRolesFromSituation(sit({ accountOwner: true, duoMember: true }));
    expect(r).toEqual(expect.arrayContaining(['owner', 'duo_member']));
    expect(r).not.toContain('billing_owner');
  });

  it('titulaire sans abonnement payé : owner, pas billing_owner', () => {
    const r = helpRolesFromSituation(sit({ accountOwner: true }));
    expect(r).toContain('owner');
    expect(r).not.toContain('billing_owner');
  });

  it('membre du compte (non titulaire, hors Duo) : authorized_user', () => {
    const r = helpRolesFromSituation(sit({ accountMember: true }));
    expect(r).toContain('authorized_user');
    expect(r).not.toContain('owner');
  });

  it('transmission en attente : recipient', () => {
    expect(helpRolesFromSituation(sit({ pendingTransmission: true }))).toContain('recipient');
  });

  it('tous les rôles produits appartiennent au référentiel des articles', () => {
    const flags = ['accountOwner', 'accountMember', 'duoHolder', 'duoMember', 'paysSubscription', 'pendingTransmission'];
    for (let mask = 0; mask < 1 << flags.length; mask++) {
      const over = Object.fromEntries(flags.map((f, i) => [f, !!(mask & (1 << i))]));
      for (const role of helpRolesFromSituation(sit(over))) expect(ARTICLE_ROLES).toContain(role);
    }
  });

  it('pondération : un membre Duo n’est plus pénalisé sur un article duo_member', () => {
    const a = { roles: ['duo_member'] } as never;
    const ctx = help.helpContextFromPage(undefined, helpRolesFromSituation(sit({ duoMember: true })));
    expect(help.contextWeight(a, ctx)).toBe(1);
    const titulaire = help.helpContextFromPage(undefined, helpRolesFromSituation(sit({ accountOwner: true, duoHolder: true })));
    expect(help.contextWeight({ roles: ['billing_owner'] } as never, titulaire)).toBe(1);
    expect(help.contextWeight(a, titulaire)).toBeCloseTo(0.6);
  });

});
