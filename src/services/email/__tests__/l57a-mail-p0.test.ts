/**
 * Lot 57A — ticket P0 e-mails : fonctions pures et règles statiques.
 *
 * MAIL-P0-01 signature Svix : valide acceptée ; fausse, absente, périmée,
 *            secret absent → refus (codes distincts, aucun traitement).
 * MAIL-P0-02 reprise bornée : 1, 5, 15, 60, 180 min ; 6 tentatives.
 * MAIL-P0-03 aucun jeton dans le journal des e-mails (`metadata`).
 * MAIL-P0-04 recherche BO : filtres normalisés, jokers LIKE échappés,
 *            limite bornée.
 * MAIL-P0-07 textes publics : demande ENREGISTRÉE, jamais « envoyé » ;
 *            neutres (53A).
 * MAIL-P0-08 WELCOME hors du chemin critique ; envoi de vérification sans
 *            promesse détachée seule (demande enregistrée avant la réponse).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signSvixPayload, verifySvixSignature } from '../email-provider-events.service';
import { EMAIL_JOB_MAX_ATTEMPTS, emailJobBackoffMs } from '../transactional-email-jobs.service';
import { redactActionLinks } from '@/lib/email/email-service';
import { normalizeEmailSearch } from '@/services/admin/transactional-email-logs.service';
import { RESEND_VERIFICATION_NEUTRAL_MESSAGE, SIGNUP_NEUTRAL_MESSAGE } from '@/lib/auth/auth-messages';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SECRET = `whsec_${Buffer.from('secret-de-test-57a').toString('base64')}`;

describe('L57A — e-mails indispensables', () => {
  it('MAIL-P0-01 — signature Svix des webhooks Resend', () => {
    const body = '{"type":"email.delivered","data":{"email_id":"em_1"}}';
    const now = 1_760_000_000_000;
    const ts = Math.floor(now / 1000);
    const sig = signSvixPayload(SECRET, 'msg_1', ts, body);
    const h = { id: 'msg_1', timestamp: String(ts), signature: `v1,faux ${sig}` };
    expect(verifySvixSignature(body, h, SECRET, now)).toEqual({ ok: true });
    expect(verifySvixSignature(body.replace('em_1', 'em_2'), h, SECRET, now)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifySvixSignature(body, { ...h, signature: 'v1,AAAA' }, SECRET, now)).toEqual({ ok: false, code: 'BAD_SIGNATURE' });
    expect(verifySvixSignature(body, { ...h, signature: null }, SECRET, now)).toEqual({ ok: false, code: 'MISSING_HEADERS' });
    expect(verifySvixSignature(body, h, SECRET, now + 6 * 60_000)).toEqual({ ok: false, code: 'STALE_TIMESTAMP' });
    expect(verifySvixSignature(body, h, undefined, now)).toEqual({ ok: false, code: 'NOT_CONFIGURED' });
  });

  it('MAIL-P0-02 — reprise bornée et espacée', () => {
    expect(EMAIL_JOB_MAX_ATTEMPTS).toBe(6);
    expect([1, 2, 3, 4, 5, 6].map((n) => emailJobBackoffMs(n) / 60_000)).toEqual([1, 5, 15, 60, 180, 180]);
  });

  it('MAIL-P0-03 — aucun jeton dans `email_logs.metadata`', () => {
    const v = redactActionLinks({
      firstName: 'Alice',
      verificationUrl: 'https://app.verebona.fr/api/auth/verify-email?token=SECRETTOKEN123&plan=premium',
      inviteUrl: 'https://app.verebona.fr/duo/join/0123456789abcdef0123456789abcdef',
      actionUrl: 'https://app.verebona.fr/duo/join/0123456789abcdef0123456789abcdef',
      resetUrl: 'https://app.verebona.fr/reset-password?token=abc.def',
      loginUrl: 'https://app.verebona.fr/login',
      forgotPasswordUrl: 'https://app.verebona.fr/forgot-password',
    });
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/SECRETTOKEN|0123456789abcdef|abc\.def/);
    expect(v.verificationUrl).toBe('https://app.verebona.fr/api/auth/verify-email?token=[masqué]&plan=premium');
    expect(v.inviteUrl).toBe('https://app.verebona.fr/duo/join/[masqué]');
    expect(v.loginUrl).toBe('https://app.verebona.fr/login');
    expect(v.forgotPasswordUrl).toBe('https://app.verebona.fr/forgot-password');
    expect(v.firstName).toBe('Alice');
  });

  it('MAIL-P0-04 — filtres de la recherche BO', () => {
    expect(normalizeEmailSearch({ type: ' duo_invitation ', recipient: 'A_b%@Proton.me', limit: 9999 }))
      .toEqual({ type: 'DUO_INVITATION', like: '%a\\_b\\%@proton.me%', problemsOnly: false, limit: 200 });
    expect(normalizeEmailSearch({})).toEqual({ type: null, like: null, problemsOnly: false, limit: 50 });
    const svc = read('src/services/admin/transactional-email-logs.service.ts');
    expect(svc).not.toMatch(/\bl\.metadata\b|\bcontext\b,/);
  });

  it('MAIL-P0-07 — textes publics : demande enregistrée, jamais d’expédition annoncée ; neutres', () => {
    for (const m of [SIGNUP_NEUTRAL_MESSAGE, RESEND_VERIFICATION_NEUTRAL_MESSAGE]) {
      expect(m).toMatch(/Demande enregistrée/);
      expect(m).not.toMatch(/(vient d’être|avons) envoyé/);
      expect(m).not.toMatch(/déjà|existe/i);
    }
    const page = read('src/app/(auth)/verify-email/page.tsx');
    expect(page).not.toMatch(/Nous avons envoyé un e-mail/);
    expect(page).toMatch(/publicSiteUrl\('\/contact'\)/);
  });

  it('MAIL-P0-08 — vérification : demande durable avant la réponse ; WELCOME non attendu', () => {
    const signup = read('src/app/api/users/route.ts');
    expect(signup).toMatch(/await enqueueVerificationEmail\(/);
    expect(signup).not.toMatch(/emailService\.send\(/);
    const resend = read('src/app/api/auth/resend-verification/route.ts');
    expect(resend.indexOf('await recordVerificationResendRequest(')).toBeGreaterThan(-1);
    expect(resend.indexOf('await recordVerificationResendRequest(')).toBeLessThan(resend.indexOf('return neutral();\n  } catch'));
    const verify = read('src/app/api/auth/verify-email/route.ts');
    expect(verify).toMatch(/runDetached\('e-mail de bienvenue'/);
    expect(verify).not.toMatch(/await emailService\.send\(\{\s*templateCode: 'WELCOME'/);
    // Duo : plus de « fire and forget » ni de date posée avant l'acceptation.
    const duo = read('src/app/api/duo/invitation/route.ts');
    expect(duo).not.toMatch(/\.catch\(\(err\) => console\.error\('\[DuoInvitation\]/);
    expect(duo).not.toMatch(/pendingInviteSentAt: new Date\(\)/);
    expect(duo).not.toMatch(/duoFirstInviteSentAt:/);
  });
});
