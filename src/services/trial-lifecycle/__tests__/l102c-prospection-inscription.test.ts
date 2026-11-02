/**
 * Lot 102C — prospection post-essai : information et choix à l'inscription
 * alignés sur la base légale du BO (moteur 100G unique), preuve conservée.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings, type TrialLifecycleSettings } from '../milestones';
import { choiceFor, mechanismFor, privacyPolicyUrl, readSignupMarketingInput, signupNoticeFor } from '../signup-collection';

const read = (p: string) => readFileSync(resolve(__dirname, '../../../..', p), 'utf8');
const S = (patch: Partial<TrialLifecycleSettings>): TrialLifecycleSettings => ({ ...DEFAULT_SETTINGS, ...patch });

describe('L102C-PRO-01 — réglage BO, désactivé par défaut', () => {
  it('défaut : rien à l’inscription', () => {
    expect(DEFAULT_SETTINGS.signupCollection).toEqual({ enabled: false, softOptInMechanism: 'opt_out_checkbox' });
    expect(signupNoticeFor(DEFAULT_SETTINGS, 'https://www.verebona.fr/confidentialite')).toBeNull();
  });
  it('anciens réglages stockés sans ce champ : défaut prudent', () => {
    expect(mergeSettings({ commercialEnabled: false }).signupCollection.enabled).toBe(false);
    expect(mergeSettings({ signupCollection: { enabled: true, softOptInMechanism: 'mention' } }).signupCollection).toEqual({ enabled: true, softOptInMechanism: 'mention' });
  });
  it('base « client existant » : campagne impossible sans information à l’inscription', () => {
    const s = S({ legalBasis: 'soft_opt_in', softOptInDeclaration: { declaredAt: 'x', declaredBy: 'po' }, commercialEnabled: true });
    expect(validateSettings(s).map((i) => i.field)).toContain('signupCollection.enabled');
    expect(validateSettings({ ...s, signupCollection: { enabled: true, softOptInMechanism: 'mention' } })).toEqual([]);
  });
});

describe('L102C-PRO-02 — mécanisme selon la base légale', () => {
  const url = 'https://www.verebona.fr/confidentialite';
  it('consentement : case d’acceptation, non pré-cochée côté serveur (coché seulement si transmis)', () => {
    const n = signupNoticeFor(S({ signupCollection: { enabled: true, softOptInMechanism: 'mention' } }), url)!;
    expect(n.mechanism).toBe('consent_checkbox');
    expect(n.checkboxLabel).toMatch(/J’accepte/);
    expect(choiceFor('consent_checkbox', undefined)).toBe('not_consented');
    expect(choiceFor('consent_checkbox', 'true')).toBe('not_consented');
    expect(choiceFor('consent_checkbox', true)).toBe('consented');
  });
  it('client existant : case d’opposition ou mention seule', () => {
    const box = signupNoticeFor(S({ legalBasis: 'soft_opt_in', signupCollection: { enabled: true, softOptInMechanism: 'opt_out_checkbox' } }), url)!;
    expect(box.mechanism).toBe('opt_out_checkbox');
    expect(box.checkboxLabel).toMatch(/Je ne souhaite pas/);
    expect(choiceFor('opt_out_checkbox', true)).toBe('opposed');
    expect(choiceFor('opt_out_checkbox', false)).toBe('not_opposed');
    const mention = signupNoticeFor(S({ legalBasis: 'soft_opt_in', signupCollection: { enabled: true, softOptInMechanism: 'mention' } }), url)!;
    expect(mention.checkboxLabel).toBeNull();
    expect(choiceFor('mention', undefined)).toBe('informed');
    expect(mechanismFor('soft_opt_in', 'mention')).toBe('mention');
  });
  it('libellés factuels, opposition gratuite, renvoi au lien public Confidentialité ; empreinte stable', () => {
    const n = signupNoticeFor(S({ legalBasis: 'soft_opt_in', signupCollection: { enabled: true, softOptInMechanism: 'opt_out_checkbox' } }), url)!;
    expect(n.help).toMatch(/Gratuit/);
    expect(n.privacyUrl).toBe(url);
    expect(n.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(signupNoticeFor(S({ legalBasis: 'soft_opt_in', signupCollection: { enabled: true, softOptInMechanism: 'opt_out_checkbox' } }), url)!.sha256).toBe(n.sha256);
    expect(signupNoticeFor(S({ legalBasis: 'soft_opt_in', signupCollection: { enabled: true, softOptInMechanism: 'opt_out_checkbox' } }), `${url}?v=2`)!.sha256).not.toBe(n.sha256);
    for (const t of [n.information, n.checkboxLabel, n.help]) expect(t).not.toMatch(/Opération|CGSU|CGVU|article|RGPD/);
  });
  it('lien Confidentialité : base d’URL configurable', () => {
    expect(privacyPolicyUrl({ PUBLIC_PRIVACY_URL: 'https://legal.example.fr/conf' })).toBe('https://legal.example.fr/conf');
    expect(privacyPolicyUrl({})).toMatch(/\/confidentialite$/);
    expect(privacyPolicyUrl({ PUBLIC_PRIVACY_PATH: '/legal/confidentialite' })).toMatch(/\/legal\/confidentialite$/);
  });
  it('entrée du formulaire bornée', () => {
    expect(readSignupMarketingInput(null)).toBeNull();
    expect(readSignupMarketingInput({ checked: true, noticeSha256: 'a'.repeat(200) })).toEqual({ checked: true, noticeSha256: 'a'.repeat(64) });
  });
});

describe('L102C-PRO-03 — branchements (inscription locale, Google / Apple, BO, moteur unique)', () => {
  it('inscription locale et sociale : preuve enregistrée après la création', () => {
    expect(read('src/app/api/users/route.ts')).toMatch(/recordSignupMarketingChoice\(\{ userId: newUser\.id, context: 'signup'/);
    expect(read('src/lib/auth/oauth/social-signup.ts')).toMatch(/recordSignupMarketingChoice\(\{ userId: created\.userId, context: 'social_signup'/);
    expect(read('src/app/(auth)/signup/SignupForm.tsx')).toMatch(/<MarketingSignupNotice/);
    expect(read('src/app/(auth)/connexion-sociale/page.tsx')).toMatch(/<MarketingSignupNotice/);
  });
  it('bloc public sans session', () => {
    expect(read('src/middleware.ts')).toMatch(/'\/api\/public\/marketing\/signup-notice'/);
  });
  it('aucun second moteur : la décision d’envoi reste celle du 100G (preuve lue par la séquence)', () => {
    expect(read('src/services/trial-lifecycle/sequence.service.ts')).toMatch(/signupInformed: await signupInformedOf\(userId\)/);
    expect(read('src/services/trial-lifecycle/signup-collection.ts')).not.toMatch(/emailService|sendEmail/);
  });
});
