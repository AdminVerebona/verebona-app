/**
 * Lot 34I — parrainage sur PostgreSQL réel.
 *
 *   8. « Lien parrainage KO » : `/r/<code>` (généré par Mon compte ›
 *      Parrainage) redirige vers l'inscription, code propagé s'il est
 *      valide, sans erreur sinon ; l'inscription l'attribue.
 *
 * Lot 112B (décision PO) : le point 7 (invitation PAR E-MAIL — route
 * `/api/referral/send-email`, gabarit REFERRAL_INVITATION, table
 * `referral_email_sends`) est supprimé, avec ses cas AC-7.x. La suppression
 * (migration 1405, BO, historique `email_logs` conservé) est vérifiée par
 * `l112b-parrainage-sans-email.e2e.ts`.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.e2e.verebona.test';
  return {
    session: { userId: 0, currentAccountId: 0 as number | null },
  };
});

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

async function suivreLien(code: string): Promise<Response> {
  const { GET } = await import('@/app/r/[code]/route');
  return GET(new NextRequest(`${APP}/r/${code}`), { params: Promise.resolve({ code }) });
}

scenario('L34I', 'Parrainage : lien /r/<code> (invitation par e-mail supprimée au lot 112B)', ({ sql, make }) => {
  async function parrain(code: string, opts: { active?: boolean } = {}) {
    const acc = await make.account({ plan: 'premium' });
    await sql`UPDATE accounts SET plan_type = 'PREMIUM' WHERE id = ${acc.id}`;
    await sql`UPDATE users SET first_name = 'Camille', last_name = 'Durand' WHERE id = ${acc.ownerUserId}`;
    const [link] = await sql<{ id: number }[]>`
      INSERT INTO referral_links (account_id, code, created_by_user_id, is_active, created_at, updated_at)
      VALUES (${acc.id}, ${code}, ${acc.ownerUserId}, ${opts.active ?? true}, now(), now()) RETURNING id`;
    etat.session.userId = acc.ownerUserId;
    etat.session.currentAccountId = acc.id;
    return { acc, linkId: link.id };
  }

  it('AC-8.1 — le lien affiché dans Mon compte est <app>/r/<CODE> et il mène à l’inscription avec le code', async () => {
    await parrain('E2ELNK23');
    const { GET: me } = await import('@/app/api/referral/me/route');
    const res = await me(new NextRequest(`${APP}/api/referral/me`));
    const body = await res.json();
    expect(body.link.url).toBe(`${APP}/r/E2ELNK23`);

    const redir = await suivreLien('E2ELNK23');
    expect(redir.status).toBe(307);
    // Lot 102D : `rt` = instant signé d'usage du lien (fenêtre de 90 jours).
    expect(redir.headers.get('location')).toMatch(new RegExp(`^${APP.replace(/\./g, '\\.')}/signup\\?ref=E2ELNK23&rt=`));
    expect(redir.headers.get('set-cookie')).toBeNull(); // CDC §4.2 : aucun cookie
  });

  it('AC-8.2 — code inconnu, désactivé ou mal formé : inscription sans code, jamais de 404', async () => {
    await parrain('E2EINA23', { active: false });
    for (const code of ['INCONNU9', 'E2EINA23', '%3Cscript%3E', '-']) {
      const res = await suivreLien(code);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe(`${APP}/signup`);
    }
    // Casse indifférente : le code est normalisé.
    await parrain('E2EMIN23');
    expect((await suivreLien('e2emin23')).headers.get('location')).toMatch(/\/signup\?ref=E2EMIN23&rt=/);
  });

  it('AC-8.3 — de bout en bout : le code reçu par /r/ est attribué au filleul à l’inscription', async () => {
    const { acc } = await parrain('E2EATT23');
    const location = (await suivreLien('E2EATT23')).headers.get('location')!;
    const ref = new URL(location).searchParams.get('ref');
    const filleul = await make.account();
    const { recordSignupReferral } = await import('@/services/referral-attribution.service');
    const r = await recordSignupReferral({ userId: filleul.ownerUserId, accountId: filleul.id, rawCode: ref });
    expect(r?.referrerAccountId).toBe(acc.id);
    const [ctx] = await sql<{ validation_status: string; raw_code: string }[]>`
      SELECT validation_status, raw_code FROM signup_contexts WHERE user_id = ${filleul.ownerUserId}`;
    expect(ctx).toMatchObject({ validation_status: 'valid', raw_code: 'E2EATT23' });
  });
});
