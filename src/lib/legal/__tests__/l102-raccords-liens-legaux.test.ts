/**
 * Lot 102 — raccords d'intégration : une seule configuration des liens légaux
 * (102B) pour la confidentialité (102C inscription, 102D Mon compte) et le
 * parrainage (102D), et une seule règle d'export dans les états restreints.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { legalPublicUrl } from '@/lib/legal/public-legal';
import { privacyPolicyUrl as privacyFromSignup } from '@/services/trial-lifecycle/signup-collection';
import { privacyPolicyUrl as privacyFromOptOut } from '@/services/privacy/improvement-opt-out-rules';
import { referralTermsUrl } from '@/services/referral/referral-rules';

describe('L102-RAC-01 — liens légaux : configuration unique 102B', () => {
  it('confidentialité et parrainage sans argument = configuration 102B', () => {
    expect(privacyFromSignup()).toBe(legalPublicUrl('confidentialite'));
    expect(privacyFromOptOut()).toBe(legalPublicUrl('confidentialite'));
    expect(referralTermsUrl()).toBe(legalPublicUrl('parrainage'));
  });

  it('les écrans lisent les liens par useLegalLinks (bascule sans nouveau build)', () => {
    for (const f of [
      'src/components/account/PrivacyCard.tsx',
      'src/components/account/ReferralBlock.tsx',
      'src/app/(auth)/signup/SignupForm.tsx',
      'src/app/(dashboard)/mon-compte/offres/page.tsx',
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toContain('useLegalLinks');
      expect(src, f).not.toMatch(/referralTermsUrl\(\)|privacyPolicyUrl\(\)/);
    }
  });

  it('bloc d’information à l’inscription : même lien côté affichage et côté preuve', () => {
    expect(readFileSync('src/app/api/public/marketing/signup-notice/route.ts', 'utf8')).toContain('currentPrivacyPolicyUrl()');
    expect(readFileSync('src/services/trial-lifecycle/signup-collection.ts', 'utf8')).toContain('signupNoticeFor(settings, await currentPrivacyPolicyUrl())');
  });
});
