/**
 * Lot 34I — parrainage : e-mail d'invitation (point 7) et lien /r/<code>
 * (point 8). Règles pures et câblage, sans base ; le parcours complet sur
 * PostgreSQL est dans `src/test/e2e/scenarios/l34i-parrainage.e2e.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REFERRAL_INVITATION_TEMPLATE,
  MAX_RECIPIENTS_PER_SEND,
  buildReferralUrl,
  classifySendError,
  invitationFailureMessage,
  maskEmail,
  normalizeRecipients,
  referralRedirectPath,
  referralSenderName,
  sendReferralInvitations,
} from '@/services/referral/referral-invitation.service';

const { resolveReferralCode } = vi.hoisted(() => ({ resolveReferralCode: vi.fn() }));
vi.mock('@/services/referral-attribution.service', async (orig) => ({
  ...(await orig<typeof import('@/services/referral-attribution.service')>()),
  resolveReferralCode: (...a: unknown[]) => resolveReferralCode(...a),
}));

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('AC-7.1 — une invitation n’est comptée envoyée que si le service e-mail le confirme', () => {
  it('succès et refus (réponse sans exception, comme le SDK Resend) sont distingués', async () => {
    const send = vi.fn(async (o: { to: string }) =>
      o.to === 'ko@exemple.fr' ? { success: false, error: 'The verebona.fr domain is not verified.' } : { success: true });
    const r = await sendReferralInvitations({
      recipients: ['ok@exemple.fr', 'ko@exemple.fr'],
      senderName: 'Camille Durand',
      referralUrl: 'https://app.verebona.fr/r/ABCD2345',
      send,
    });
    expect(r.sent).toEqual(['ok@exemple.fr']);
    expect(r.failed).toEqual([{ email: 'ko@exemple.fr', reason: 'PROVIDER_REJECTED' }]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toEqual({
      templateCode: REFERRAL_INVITATION_TEMPLATE,
      to: 'ok@exemple.fr',
      variables: {
        senderName: 'Camille Durand',
        referralUrl: 'https://app.verebona.fr/r/ABCD2345',
        actionUrl: 'https://app.verebona.fr/r/ABCD2345',
      },
    });
  });

  it('une exception d’un envoi est un échec de cet envoi, pas de la série', async () => {
    let n = 0;
    const send = vi.fn(async () => { n += 1; if (n === 1) throw new Error('réseau'); return { success: true }; });
    const r = await sendReferralInvitations({ recipients: ['a@x.fr', 'b@x.fr'], senderName: 'X', referralUrl: 'u', send });
    expect(r.sent).toEqual(['b@x.fr']);
    expect(r.failed).toEqual([{ email: 'a@x.fr', reason: 'PROVIDER_REJECTED' }]);
  });

  it('les erreurs du service e-mail sont classées', () => {
    expect(classifySendError('CHANNEL_DISABLED')).toBe('CHANNEL_DISABLED');
    expect(classifySendError('Emails disabled')).toBe('EMAILS_DISABLED');
    expect(classifySendError('Email provider not configured')).toBe('NOT_CONFIGURED');
    expect(classifySendError('Template REFERRAL_INVITATION not found')).toBe('TEMPLATE_MISSING');
    expect(classifySendError('rate limit')).toBe('PROVIDER_REJECTED');
    expect(classifySendError(undefined)).toBe('PROVIDER_REJECTED');
  });
});

describe('AC-7.2 — erreurs visibles et non techniques', () => {
  it('message générique sans détail technique', () => {
    for (const reasons of [['PROVIDER_REJECTED'], ['NOT_CONFIGURED'], ['TEMPLATE_MISSING'], []] as const) {
      const m = invitationFailureMessage([...reasons]);
      expect(m).toMatch(/n’a pas pu être envoyée/);
      expect(m).not.toMatch(/Resend|API|template|domain|Error/i);
    }
  });

  it('canal désactivé dans le BO : le dit et propose de copier le lien', () => {
    expect(invitationFailureMessage(['CHANNEL_DISABLED'])).toMatch(/désactivé.*Copiez votre lien/);
    expect(invitationFailureMessage(['EMAILS_DISABLED'])).toMatch(/désactivé/);
  });

  it('le bloc Parrainage n’affiche que le message du serveur, jamais « API Error 500 »', () => {
    const src = read('src/components/account/ReferralBlock.tsx');
    expect(src).toContain('e.serverMessage');
    expect(src).not.toMatch(/\(e as \{ message\?: string \}\)\.message/);
    expect(src).toMatch(/if \(result\.sent > 0\)/);
  });
});

describe('AC-7.3 — la route passe par le service e-mail commun (expéditeur BO, gabarit, journal)', () => {
  const route = read('src/app/api/referral/send-email/route.ts');

  it('plus d’appel direct au SDK ni d’expéditeur codé en dur, plus de « mode dev » qui simule un succès', () => {
    expect(route).not.toMatch(/from 'resend'|import\('resend'\)/);
    expect(route).not.toContain('RESEND_FROM_EMAIL');
    expect(route).not.toContain('no-reply@verebona.fr');
    expect(route).not.toContain('DEV MODE');
    expect(route).toContain('emailService.send');
  });

  it('aucun envoi accepté → 502 EMAIL_NOT_SENT avec message ; seuls les envois acceptés sont journalisés', () => {
    expect(route).toMatch(/code: 'EMAIL_NOT_SENT'[\s\S]*status: 502/);
    expect(route).toMatch(/result\.sent\.map\(\(email\) =>/);
  });

  it('migration 0301 : gabarit idempotent, sans écraser une retouche BO', () => {
    const sql = read('src/db/migrations/0301_referral_invitation_email_template.sql');
    expect(sql).toContain("'REFERRAL_INVITATION'");
    expect(sql).toContain('ON CONFLICT (type) DO NOTHING');
    for (const v of ['senderName', 'referralUrl']) expect(sql).toContain(`{{${v}}}`);
    expect(sql).not.toMatch(/CONCURRENTLY/);
  });

  it('le gabarit est pilotable dans le BO (Communications) et désactivable', async () => {
    const { TRANSACTIONAL_EMAILS } = await import('@/services/admin/communications.service');
    expect(TRANSACTIONAL_EMAILS.map((t) => t.templateCode)).toContain('REFERRAL_INVITATION');
    const { transactionalLockReason } = await import('@/lib/notifications/channel-activation');
    expect(transactionalLockReason('REFERRAL_INVITATION')).toBeNull();
  });
});

describe('AC-7.4 — destinataires et nom du parrain', () => {
  it('normalise, dédoublonne et plafonne', () => {
    expect(normalizeRecipients([' A@X.fr ', 'a@x.fr', 'pas-une-adresse', 3, 'b@x.fr'])).toEqual(['a@x.fr', 'b@x.fr']);
    const many = Array.from({ length: 15 }, (_, i) => `p${i}@x.fr`);
    expect(normalizeRecipients(many)).toHaveLength(MAX_RECIPIENTS_PER_SEND);
    expect(normalizeRecipients('a@x.fr')).toEqual([]);
  });

  it('retire le balisage du nom (e-mail adressé à un tiers) et a un repli', () => {
    expect(referralSenderName('Camille', 'Durand')).toBe('Camille Durand');
    expect(referralSenderName('<img src=x>', '"Bob"')).toBe('img src=x Bob');
    expect(referralSenderName(null, '  ')).toBe('Un proche');
  });

  it('les journaux applicatifs masquent l’adresse', () => {
    expect(maskEmail('jean@exemple.fr')).toBe('j***@exemple.fr');
  });
});

describe('AC-8.1 — lien généré et route qui le reçoit concordent', () => {
  it('format <app>/r/<CODE>', () => {
    expect(buildReferralUrl('EDTBB66Q', 'https://app.preprod.verebona.fr/')).toBe('https://app.preprod.verebona.fr/r/EDTBB66Q');
  });

  it('Mon compte › Parrainage et l’e-mail utilisent le même générateur', () => {
    const me = read('src/app/api/referral/me/route.ts');
    expect(me).not.toMatch(/\/r\/\$\{/);
    expect((me.match(/buildReferralUrl\(/g) ?? []).length).toBe(3);
    expect(read('src/app/api/referral/send-email/route.ts')).toContain('buildReferralUrl(link.code)');
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
    expect(res.headers.get('location')).toBe('https://app.preprod.verebona.fr/signup?ref=EDTBB66Q');
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
    expect(res.headers.get('location')).toBe('https://app.preprod.verebona.fr/signup?ref=ABCD2345');
  });
});
