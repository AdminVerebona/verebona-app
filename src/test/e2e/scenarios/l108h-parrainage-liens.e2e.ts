/**
 * Lot 108H — parrainage simplifié : liens par environnement, base PostgreSQL
 * réelle, vraies routes. Aucun réseau.
 *
 *   L108H-E2E-01  lien personnel de parrainage (Mon compte) = origine de
 *                 l'environnement (production simulée) ; aucun hôte de préprod
 *   L108H-E2E-02  « Voir les conditions du parrainage » : /api/legal/links rend
 *                 l'URL directe de l'onglet Légal › Parrainage du site public
 *                 de l'environnement, admise par la liste blanche, et ouverte
 *                 par AppLauncher (navigateur système) sur iOS / Android
 *   L108H-E2E-03  site public pas encore livré (mode repli) : page actuelle,
 *                 jamais de 404 (limite connue, voir recette 108H)
 */
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const APP = 'https://app.verebona.fr';
const SITE = 'https://www.verebona.fr';
const PREPROD = /(^|[.-])(preprod|pre-prod|staging|recette)([.-]|$)/i;

const etat = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.verebona.fr';
  process.env.NEXT_PUBLIC_PUBLIC_SITE_URL = 'https://www.verebona.fr';
  return { session: { userId: 0, currentAccountId: 0 as number | null } };
});
afterAll(() => { delete process.env.LEGAL_PUBLIC_V2; });

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

scenario('L108H', 'Parrainage simplifié : liens par environnement, conditions en navigateur système', ({ sql, make }) => {
  it('L108H-E2E-01 — lien personnel : origine de l’environnement, aucun domaine de préproduction', async () => {
    const acc = await make.account({ plan: 'premium' });
    await sql`UPDATE accounts SET plan_type = 'PREMIUM' WHERE id = ${acc.id}`;
    await sql`INSERT INTO referral_links (account_id, code, created_by_user_id, is_active, created_at, updated_at)
              VALUES (${acc.id}, 'L108HPRD', ${acc.ownerUserId}, true, now(), now())`;
    etat.session.userId = acc.ownerUserId;
    etat.session.currentAccountId = acc.id;
    const { GET } = await import('@/app/api/referral/me/route');
    const body = await (await GET(new NextRequest(`${APP}/api/referral/me`))).json();
    expect(body.link.code).toBe('L108HPRD');
    expect(body.link.url).toBe(`${APP}/r/L108HPRD`);
    expect(new URL(body.link.url).hostname).not.toMatch(PREPROD);
    // Le texte partagé ne contient que le code (l'URL est jointe à part).
    const { referralShareText } = await import('@/components/account/ReferralBlock');
    expect(referralShareText('L108HPRD')).not.toMatch(/https?:\/\//);
  });

  it('L108H-E2E-02 — conditions : URL directe /legal/parrainage, admise, ouverte par AppLauncher', async () => {
    process.env.LEGAL_PUBLIC_V2 = 'on';
    const { GET } = await import('@/app/api/legal/links/route');
    const r = await (await GET()).json() as { mode: string; links: Record<string, string>; allowedOrigins: string[] };
    expect(r.mode).toBe('v2');
    expect(r.links.parrainage).toBe(`${SITE}/legal/parrainage`);
    expect(r.allowedOrigins).toContain(SITE);
    // Les autres textes ouverts depuis l'app suivent la même règle.
    expect(r.links.cguv).toBe(`${SITE}/legal/cguv`);
    expect(r.links.confidentialite).toBe(`${SITE}/legal/confidentialite`);
    expect(r.links.mentionsLegales).toBe(`${SITE}/legal/mentions-legales`);

    const { buildLegalLinkPolicy, openLegalLink } = await import('@/lib/legal/open-legal-link');
    const policy = buildLegalLinkPolicy({ publicSiteUrl: SITE, extraOrigins: r.allowedOrigins, appOrigin: APP, production: true });
    for (const platform of ['ios', 'android'] as const) {
      const openUrl = vi.fn(async () => ({ completed: true }));
      const windowOpen = vi.fn(() => true);
      const o = await openLegalLink(r.links.parrainage, { policy, platform, appLauncher: { openUrl }, windowOpen });
      expect(o).toEqual({ ok: true, strategy: 'native-external', url: `${SITE}/legal/parrainage` });
      expect(openUrl).toHaveBeenCalledWith({ url: `${SITE}/legal/parrainage` });
      expect(windowOpen).not.toHaveBeenCalled();
    }
  });

  it('L108H-E2E-03 — site public pas encore livré : page actuelle (aucun 404), domaine de l’environnement', async () => {
    process.env.LEGAL_PUBLIC_V2 = 'off';
    const { GET } = await import('@/app/api/legal/links/route');
    const r = await (await GET()).json() as { mode: string; links: Record<string, string> };
    expect(r.mode).toBe('legacy');
    expect(r.links.parrainage).toBe(`${SITE}/cgu`);
    for (const href of Object.values(r.links)) expect(new URL(href).hostname).not.toMatch(PREPROD);
  });
});
