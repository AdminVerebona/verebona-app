/**
 * Lot 102D — parrainage : RÈGLE CENTRALE UNIQUE et alignement des sources
 * (API, écrans, e-mail, BO, traitement planifié).
 *
 *   L102D-R01  fenêtre d'attribution : usage du lien → inscription ≤ 90 jours
 *   L102D-R02  auto-parrainage : même compte, même personne (e-mail normalisé,
 *              membre du compte parrain), même carte, même adresse
 *   L102D-R03  délai de rétractation : calendrier légal (prorogation) + marge
 *   L102D-R04  parrain : titulaire d'un abonnement payant, toutes offres
 *   L102D-R05  jeton d'usage du lien (`rt`) : signé, lié au code
 *   L102D-R06  lien public « Parrainage » : base d'URL configurable
 *   L102D-R07  sources alignées : aucune règle concurrente écrite ailleurs
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  REFERRAL_RULES, REFERRAL_TEXT, addressKey, attributionDeadline, isWithinAttributionWindow, normalizeEmailIdentity,
  paymentSelfReferralReason, referralTermsUrl, referrerEligibility, rewardEarliestAt, signupSelfReferralReason,
} from '../referral-rules';
import { createReferralTouch, verifyReferralTouch } from '../referral-touch';
import { withdrawalWindowClosesAt } from '@/services/withdrawal/withdrawal-window';

const DAY = 24 * 60 * 60 * 1000;
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('L102D-R01 — fenêtre d’attribution (90 jours, usage → inscription)', () => {
  const used = new Date('2026-07-01T10:00:00Z');
  it('paramètre central : 90 jours', () => {
    expect(REFERRAL_RULES.attributionWindowDays).toBe(90);
    expect(attributionDeadline(used).getTime() - used.getTime()).toBe(90 * DAY);
  });
  it('inscription le 90ᵉ jour : attribuée ; le 91ᵉ : refusée', () => {
    expect(isWithinAttributionWindow(used, new Date(used.getTime() + 90 * DAY))).toBe(true);
    expect(isWithinAttributionWindow(used, new Date(used.getTime() + 90 * DAY + 1000))).toBe(false);
  });
  it('code saisi à l’inscription (aucun usage antérieur connu) : attribué', () => {
    expect(isWithinAttributionWindow(null, used)).toBe(true);
  });
});

describe('L102D-R02 — auto-parrainage interdit', () => {
  it('adresse e-mail normalisée (casse, +alias, points Gmail, googlemail)', () => {
    expect(normalizeEmailIdentity(' Jean.Dupont+parrain@GoogleMail.com ')).toBe('jeandupont@gmail.com');
    expect(normalizeEmailIdentity('jean.dupont@exemple.fr')).toBe('jean.dupont@exemple.fr');
    expect(normalizeEmailIdentity('pas-une-adresse')).toBeNull();
  });
  it('inscription : même compte, membre du compte parrain, même personne', () => {
    const base = { referrerAccountId: 1, referredAccountId: 2, referredUserId: 20, referredEmail: 'ami@exemple.fr', referrerMembers: [{ userId: 10, email: 'jean.dupont@gmail.com' }] };
    expect(signupSelfReferralReason(base)).toBeNull();
    expect(signupSelfReferralReason({ ...base, referredAccountId: 1 })).toBe('SELF_REFERRAL_SAME_ACCOUNT');
    expect(signupSelfReferralReason({ ...base, referredUserId: 10 })).toBe('SELF_REFERRAL_SAME_PERSON');
    expect(signupSelfReferralReason({ ...base, referredEmail: 'JeanDupont+2@gmail.com' })).toBe('SELF_REFERRAL_SAME_PERSON');
  });
  it('paiement : même carte ou même adresse de facturation que le parrain', () => {
    const k = addressKey({ line1: '12 rue de l’Église', postal_code: '75 001', country: 'fr' });
    expect(k).toBe(addressKey({ line1: '12 RUE DE L EGLISE', postal_code: '75001', country: 'FR' }));
    const none = { referredCardFingerprints: ['fpA'], referredAddressKeys: [null], referrerCardFingerprints: ['fpB'], referrerAddressKeys: [] };
    expect(paymentSelfReferralReason(none)).toBeNull();
    expect(paymentSelfReferralReason({ ...none, referrerCardFingerprints: ['fpA'] })).toBe('SELF_REFERRAL_SAME_PAYMENT_METHOD');
    expect(paymentSelfReferralReason({ ...none, referredAddressKeys: [k], referrerAddressKeys: [k] })).toBe('SELF_REFERRAL_SAME_ADDRESS');
  });
});

describe('L102D-R03 — délai de rétractation du filleul (calendrier légal + marge)', () => {
  it('= clôture légale (prorogation comprise) + marge centrale', () => {
    // 14ᵉ jour un dimanche (15/11/2026) : délai prorogé au lundi.
    const paid = new Date('2026-11-01T09:00:00Z');
    const closes = withdrawalWindowClosesAt(paid)!;
    expect(closes.getTime()).toBeGreaterThan(paid.getTime() + 15 * DAY);
    expect(rewardEarliestAt({ firstBilledAt: paid })!.getTime()).toBe(closes.getTime() + REFERRAL_RULES.rewardGraceDaysAfterWithdrawalClose * DAY);
  });
  it('aucun paiement : aucune date', () => {
    expect(rewardEarliestAt({ firstBilledAt: null })).toBeNull();
  });
});

describe('L102D-R04 — parrain', () => {
  const sub = (o: Partial<{ planCode: string; status: string; firstBilledAt: Date | null }> = {}) => ({ planCode: 'standard', status: 'active', firstBilledAt: new Date(), ...o });
  it('titulaire d’un abonnement payant : Standard, Premium, Premium Duo, mensuel ou annuel', () => {
    for (const planCode of ['standard', 'premium', 'premium_duo']) expect(referrerEligibility({ role: 'owner', subscription: sub({ planCode }) }).eligible).toBe(true);
  });
  it('membre invité, essai sans paiement, abonnement résilié : non', () => {
    expect(referrerEligibility({ role: 'member', subscription: sub() })).toEqual({ eligible: false, reason: 'NOT_ACCOUNT_OWNER' });
    expect(referrerEligibility({ role: 'owner', subscription: sub({ firstBilledAt: null, status: 'trialing' }) })).toEqual({ eligible: false, reason: 'NO_PAID_SUBSCRIPTION' });
    expect(referrerEligibility({ role: 'owner', subscription: sub({ status: 'canceled' }) }).eligible).toBe(false);
    expect(referrerEligibility({ role: 'owner', subscription: null }).eligible).toBe(false);
  });
});

describe('L102D-R05 — jeton d’usage du lien', () => {
  const env = { REFERRAL_TOUCH_SECRET: 'secret-de-test' };
  it('valide pour son code, refusé pour un autre code ou altéré', () => {
    const at = new Date('2026-08-01T12:00:00Z');
    const t = createReferralTouch('ABCD2345', at, env)!;
    expect(verifyReferralTouch('ABCD2345', t, env)?.toISOString()).toBe(at.toISOString());
    expect(verifyReferralTouch('AUTRE234', t, env)).toBeNull();
    expect(verifyReferralTouch('ABCD2345', t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), env)).toBeNull();
    expect(verifyReferralTouch('ABCD2345', 'nimporte', env)).toBeNull();
  });
  it('production sans secret réel : aucun jeton (le code vaut alors « saisi à l’inscription »)', () => {
    expect(createReferralTouch('ABCD2345', new Date(), { NODE_ENV: 'production' })).toBeNull();
  });
});

describe('L102D-R06 — lien public « Parrainage »', () => {
  it('base du site public + chemin par défaut, surchargeable', () => {
    expect(referralTermsUrl({ NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://preprod.verebona.fr/' })).toBe('https://preprod.verebona.fr/legal/parrainage');
    expect(referralTermsUrl({ NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://www.verebona.fr', NEXT_PUBLIC_LEGAL_REFERRAL_PATH: 'legal#parrainage' })).toBe('https://www.verebona.fr/legal#parrainage');
    expect(referralTermsUrl({ NEXT_PUBLIC_LEGAL_REFERRAL_URL: 'https://x.test/p', NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://www.verebona.fr' })).toBe('https://x.test/p');
  });
});

describe('L102D-R07 — sources alignées sur la règle centrale', () => {
  it('libellés : récompense et conditions dérivées des paramètres', () => {
    expect(REFERRAL_TEXT.reward).toContain(`${REFERRAL_RULES.rewardMonths} mois offert`);
    expect(REFERRAL_TEXT.conditions.join(' ')).toContain(`${REFERRAL_RULES.attributionWindowDays} jours`);
    expect(REFERRAL_TEXT.conditions.join(' ')).toMatch(/annuel/);
    expect(REFERRAL_TEXT.conditions.join(' ')).toMatch(/rétractation/);
    expect(REFERRAL_TEXT.notEligible).not.toMatch(/Premium/);
  });

  it('écrans : Mon compte, carte, inscription, Offres, BO lisent REFERRAL_TEXT (plus de règle écrite en dur)', () => {
    for (const f of [
      'src/components/account/ReferralBlock.tsx', 'src/components/account/ReferralCard.tsx', 'src/app/(auth)/signup/SignupForm.tsx',
      'src/app/(dashboard)/mon-compte/offres/page.tsx', 'src/app/admin/referrals/page.tsx',
    ]) {
      const src = code(read(f));
      expect(src, f).toContain('REFERRAL_TEXT');
      expect(src, f).not.toMatch(/Premium ou Premium Duo annuelles|1 mois d&apos;abonnement|un mois offert lorsque/);
    }
  });

  it('API : éligibilité parrain par la règle centrale ; récompense lue dans les paramètres', () => {
    const api = code(read('src/app/api/referral/me/route.ts'));
    expect(api).toContain('referrerEligibility(');
    expect(api).toContain('REFERRAL_RULES.rewardMonths');
    expect(api).not.toMatch(/\['PREMIUM', 'PREMIUM_DUO'\]/);
  });

  it('paiement : un code transmis au checkout n’attribue plus rien', () => {
    const checkout = code(read('src/app/api/billing/create-checkout-session/route.ts'));
    expect(checkout).not.toMatch(/body\.referralCode/);
    expect(checkout).toMatch(/const referralCode = await getStoredReferralCode\(user\.id\)/);
  });

  it('premier paiement : seul l’annuel qualifie ; aucune notification avant l’attribution', () => {
    const cm = code(read('src/services/commercial-model.service.ts'));
    const fn = cm.slice(cm.indexOf('export async function grantReferralRewardForFirstBilling'));
    expect(fn).toContain('REFERRAL_RULES.requiredBillingPeriod');
    expect(fn).not.toMatch(/emit\(/);
    const job = code(read('src/services/referral/referral-rewards.job.ts'));
    expect(job.indexOf('await notifyReferrer(event)')).toBeGreaterThan(job.indexOf('if (!referrer.granted)'));
    expect(job).toContain('cancelReferralsAfterWithdrawal(now)');
    expect(job).toContain('rewardPrefilterCutoff(now)');
  });

  it('plus aucune constante de 14 jours ni de récompense hors de la règle centrale', () => {
    expect(code(read('src/services/referral-reward.service.ts'))).not.toMatch(/WITHDRAWAL_PERIOD_DAYS\s*=\s*14/);
    expect(code(read('src/services/referral-attribution.service.ts'))).not.toMatch(/REFERRAL_ATTRIBUTION_DAYS\s*=/);
  });

  it('e-mail d’invitation : conditions issues des paramètres et lien public', () => {
    const mig = read('src/db/migrations/0920_l102d_parrainage_regle_centrale.sql');
    for (const v of ['{{referralTermsUrl}}', '{{referralWindowDays}}', '{{referralReward}}']) expect(mig).toContain(v);
    expect(code(read('src/services/referral/referral-invitation.service.ts'))).toContain('referralInvitationRuleVariables()');
  });
});
