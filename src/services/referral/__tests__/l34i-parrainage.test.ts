/**
 * Lot 34I — parrainage : lien /r/<code> (point 8). Règles pures et câblage,
 * sans base ; le parcours complet sur PostgreSQL est dans
 * `src/test/e2e/scenarios/l34i-parrainage.e2e.ts`.
 *
 * Lot 112B (décision PO) : le point 7 (invitation PAR E-MAIL : route
 * `/api/referral/send-email`, gabarit `REFERRAL_INVITATION`, table
 * `referral_email_sends`) est supprimé ; ses tests (AC-7.x) avec lui. La
 * suppression est vérifiée par `l112b-parrainage-sans-email.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildReferralUrl,
  referralRedirectPath,
} from '@/services/referral/referral-invitation.service';

const { resolveReferralCode } = vi.hoisted(() => ({ resolveReferralCode: vi.fn() }));
vi.mock('@/services/referral-attribution.service', async (orig) => ({
  ...(await orig<typeof import('@/services/referral-attribution.service')>()),
  resolveReferralCode: (...a: unknown[]) => resolveReferralCode(...a),
}));

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('AC-7 — supprimé (lot 112B) : plus d’invitation envoyée par e-mail', () => {
  // Lot 111H : le bloc Parrainage n'appelait déjà plus la route ; lot 112B :
  // la route elle-même est supprimée.
  it('le bloc Parrainage n’appelle pas d’envoi par e-mail et la route n’existe plus', () => {
    const src = read('src/components/account/ReferralBlock.tsx');
    expect(src).not.toContain("'/api/referral/send-email'");
    expect(src).not.toMatch(/\(e as \{ message\?: string \}\)\.message/);
    expect(existsSync(join(process.cwd(), 'src/app/api/referral/send-email/route.ts'))).toBe(false);
  });
});

describe('AC-8.1 — lien généré et route qui le reçoit concordent', () => {
  it('format <app>/r/<CODE>', () => {
    expect(buildReferralUrl('EDTBB66Q', 'https://app.preprod.verebona.fr/')).toBe('https://app.preprod.verebona.fr/r/EDTBB66Q');
  });

  it('Mon compte › Parrainage utilise le générateur unique', () => {
    const me = read('src/app/api/referral/me/route.ts');
    expect(me).not.toMatch(/\/r\/\$\{/);
    expect((me.match(/buildReferralUrl\(/g) ?? []).length).toBe(3);
  });

  it('la route /r/[code] existe et n’est pas protégée par le middleware', () => {
    expect(existsSync(join(process.cwd(), 'src/app/r/[code]/route.ts'))).toBe(true);
    const mw = read('src/middleware.ts');
    expect(mw).not.toMatch(/'\/r'/);
  });
});

describe('AC-8.2 — redirection de /r/<code>', () => {
  beforeEach(() => {
    resolveReferralCode.mockReset();
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.preprod.verebona.fr';
  });

  async function get(code: string) {
    const { GET } = await import('@/app/r/[code]/route');
    const { NextRequest } = await import('next/server');
    return GET(new NextRequest(`http://localhost:3000/r/${code}`), { params: Promise.resolve({ code }) });
  }

  it('chemin de redirection', () => {
    expect(referralRedirectPath('ABC')).toBe('/signup?ref=ABC');
    expect(referralRedirectPath(null)).toBe('/signup');
  });

  it('code valide → inscription avec ?ref=, sur l’origine publique, sans cookie', async () => {
    resolveReferralCode.mockResolvedValue({ linkId: 1, referrerAccountId: 2 });
    const res = await get('edtbb66q');
    expect(resolveReferralCode).toHaveBeenCalledWith('EDTBB66Q', null);
    expect(res.status).toBe(307);
    // Lot 102D : `rt` = instant signé d'usage du lien (fenêtre de 90 jours).
    expect(res.headers.get('location')).toMatch(/^https:\/\/app\.preprod\.verebona\.fr\/signup\?ref=EDTBB66Q&rt=\d{9,11}\.[A-Za-z0-9_-]{22}$/);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('code inconnu → inscription sans code (pas de 404)', async () => {
    resolveReferralCode.mockResolvedValue(null);
    const res = await get('INCONNU1');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://app.preprod.verebona.fr/signup');
  });

  it('code mal formé → inscription sans consulter la base', async () => {
    const res = await get('---');
    expect(resolveReferralCode).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('https://app.preprod.verebona.fr/signup');
  });

  it('base injoignable → le code est propagé (le serveur le jugera à l’inscription)', async () => {
    resolveReferralCode.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await get('ABCD2345');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/^https:\/\/app\.preprod\.verebona\.fr\/signup\?ref=ABCD2345&rt=/);
  });
});
