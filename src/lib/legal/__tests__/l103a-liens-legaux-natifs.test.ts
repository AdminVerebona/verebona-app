/**
 * Lot 103A — textes juridiques dans le NAVIGATEUR EXTERNE depuis l'app native
 * (MOB-LEGAL-01..10) ; « Retour à l'accueil » absent de l'app (connexion,
 * inscription).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  APP_LEGAL_PATH, buildLegalLinkPolicy, checkLegalUrl, chooseLegalOpenStrategy, legalOpenFailureMessage, openLegalLink,
} from '@/lib/legal/open-legal-link';
import { NATIVE_PLUGINS } from '@/lib/native/bridge';
import { AuthBackHomeLink, NativeShellProvider, showWebBackHomeLink } from '@/components/auth/AuthBackHomeLink';

(globalThis as { React?: typeof React }).React = React;
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const PREPROD = buildLegalLinkPolicy({
  publicSiteUrl: 'https://www.verebona.fr',
  overrides: ['', undefined, 'https://legal.verebona.fr/cguv', '/legal/x'],
  extraOrigins: ['https://archives.verebona.fr'],
  appOrigin: 'https://app.preprod.verebona.fr',
  production: true,
});

describe('MOB-LEGAL-08/10 — liste blanche HTTPS par environnement', () => {
  it('origines admises : site public (www et apex), surcharges absolues, origines du serveur', () => {
    expect(PREPROD.publicOrigins).toEqual(expect.arrayContaining([
      'https://www.verebona.fr', 'https://verebona.fr', 'https://legal.verebona.fr', 'https://archives.verebona.fr',
    ]));
    expect(PREPROD.appOrigin).toBe('https://app.preprod.verebona.fr');
  });

  it.each([
    'https://www.verebona.fr/legal/cguv',
    'https://www.verebona.fr/legal/cguv/versions/2026-07-30-v1',
    'https://verebona.fr/mentions-legales',
    'https://www.verebona.fr/cgu',
    'https://legal.verebona.fr/cguv',
    // Archive figée d'une version acceptée, servie par l'app (lot 102B).
    'https://app.preprod.verebona.fr/cguv/versions/2026-07-30-v1',
    'https://app.preprod.verebona.fr/cgvu/versions/2026-07-30-v1',
    '/cguv/versions/2026-07-30-v1',
  ])('autorisée : %s', (url) => {
    expect(checkLegalUrl(url, PREPROD).ok).toBe(true);
  });

  it.each([
    ['http://www.verebona.fr/legal/cguv', 'insecure'],
    ['https://evil.example/legal/cguv', 'domain'],
    ['https://www.verebona.fr.evil.example/cgu', 'domain'],
    ['https://app.preprod.verebona.fr/accueil', 'domain'],
    ['https://app.preprod.verebona.fr/api/auth/logout', 'domain'],
    ['https://app.preprod.verebona.fr/cguv/versions/../../accueil', 'domain'],
    ['https://user:pw@www.verebona.fr/cgu', 'credentials'],
    ['https://www.verebona.fr/cgu?token=abc', 'sensitive_data'],
    ['https://www.verebona.fr/cgu?sid=abc', 'sensitive_data'],
    ['https://www.verebona.fr/cgu?email=a%40b.fr', 'sensitive_data'],
    ['https://www.verebona.fr/cgu#access_token=abc', 'sensitive_data'],
    ['javascript:alert(1)', 'insecure'],
    ['#', 'invalid'],
    ['', 'invalid'],
    [null, 'invalid'],
  ])('refusée : %s → %s', (url, reason) => {
    expect(checkLegalUrl(url, PREPROD)).toEqual({ ok: false, reason });
  });

  it('HTTP local admis seulement hors production', () => {
    const dev = buildLegalLinkPolicy({ publicSiteUrl: 'http://localhost:3001', appOrigin: 'http://localhost:3000', production: false });
    expect(checkLegalUrl('http://localhost:3001/cgu', dev).ok).toBe(true);
    const prod = buildLegalLinkPolicy({ publicSiteUrl: 'http://localhost:3001', appOrigin: null, production: true });
    expect(checkLegalUrl('http://localhost:3001/cgu', prod)).toEqual({ ok: false, reason: 'insecure' });
  });

  it('chemins juridiques de l’application : redirection publique ou archive, rien d’autre', () => {
    expect(APP_LEGAL_PATH.test('/cguv')).toBe(true);
    expect(APP_LEGAL_PATH.test('/cguv/versions/2026-07-30-v1')).toBe(true);
    expect(APP_LEGAL_PATH.test('/cguv/versions/2026-07-30-v1/download')).toBe(false);
    expect(APP_LEGAL_PATH.test('/mon-compte')).toBe(false);
  });
});

describe('MOB-LEGAL-01/04/07 — sélection de la stratégie', () => {
  const base = { urlOrigin: 'https://www.verebona.fr', appOrigin: 'https://app.preprod.verebona.fr' };
  it.each([
    [null, false, base, 'web-new-tab'],
    [null, true, base, 'web-new-tab'],
    ['ios', true, base, 'native-external'],
    ['android', true, base, 'native-external'],
    ['ios', true, { ...base, urlOrigin: base.appOrigin }, 'native-external'],
    ['ios', false, base, 'native-system-handoff'],
    ['android', false, base, 'native-system-handoff'],
    ['ios', false, { ...base, urlOrigin: base.appOrigin }, 'native-unavailable'],
  ] as const)('plateforme %s, AppLauncher %s → %s', (platform, hasAppLauncher, ctx, attendu) => {
    expect(chooseLegalOpenStrategy({ platform, hasAppLauncher, ...ctx })).toBe(attendu);
  });

  it('iOS : AppLauncher.openUrl (navigateur système), jamais Browser.open ni la vue', async () => {
    const openUrl = vi.fn(async () => ({ completed: true }));
    const windowOpen = vi.fn(() => true);
    const r = await openLegalLink('https://app.preprod.verebona.fr/cguv/versions/2026-07-30-v1', {
      policy: PREPROD, platform: 'ios', appLauncher: { openUrl }, windowOpen,
    });
    expect(r).toEqual({ ok: true, strategy: 'native-external', url: 'https://app.preprod.verebona.fr/cguv/versions/2026-07-30-v1' });
    expect(openUrl).toHaveBeenCalledWith({ url: 'https://app.preprod.verebona.fr/cguv/versions/2026-07-30-v1' });
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('MOB-LEGAL-02/09 : la version acceptée est ouverte telle quelle (aucune substitution par la courante)', async () => {
    const openUrl = vi.fn(async () => ({ completed: true }));
    await openLegalLink('https://www.verebona.fr/legal/cguv/versions/2026-07-30-v1', { policy: PREPROD, platform: 'android', appLauncher: { openUrl }, fallbackUrl: 'https://www.verebona.fr/legal/cguv' });
    expect(openUrl).toHaveBeenCalledWith({ url: 'https://www.verebona.fr/legal/cguv/versions/2026-07-30-v1' });
  });

  it('Web : nouvel onglet, aucun appel natif', async () => {
    const openUrl = vi.fn(async () => ({ completed: true }));
    const windowOpen = vi.fn(() => true);
    const r = await openLegalLink('https://www.verebona.fr/legal/cguv', { policy: PREPROD, platform: null, appLauncher: { openUrl }, windowOpen });
    expect(r.ok && r.strategy).toBe('web-new-tab');
    expect(openUrl).not.toHaveBeenCalled();
    expect(windowOpen).toHaveBeenCalledWith('https://www.verebona.fr/legal/cguv');
  });

  it('MOB-LEGAL-08 : ouverture système impossible → échec explicite + adresse à copier', async () => {
    const r1 = await openLegalLink('https://www.verebona.fr/cgu', { policy: PREPROD, platform: 'ios', appLauncher: { openUrl: async () => ({ completed: false }) } });
    expect(r1).toMatchObject({ ok: false, reason: 'open_failed', copyUrl: 'https://www.verebona.fr/cgu' });
    expect(legalOpenFailureMessage(r1 as Extract<typeof r1, { ok: false }>)).toMatch(/Copiez le lien officiel/);
    const r2 = await openLegalLink('https://www.verebona.fr/cgu', { policy: PREPROD, platform: 'ios', appLauncher: { openUrl: async () => { throw new Error('x'); } } });
    expect(r2).toMatchObject({ ok: false, reason: 'open_failed' });
    // Binaire sans AppLauncher + archive de l'app : pas de chargement dans la vue.
    const windowOpen = vi.fn(() => true);
    const r3 = await openLegalLink('https://app.preprod.verebona.fr/cguv/versions/2026-07-30-v1', { policy: PREPROD, platform: 'ios', appLauncher: null, windowOpen });
    expect(r3).toMatchObject({ ok: false, reason: 'unavailable', copyUrl: 'https://app.preprod.verebona.fr/cguv/versions/2026-07-30-v1' });
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('domaine non autorisé : rien n’est ouvert ; copie de l’adresse officielle de repli seulement', async () => {
    const openUrl = vi.fn(async () => ({ completed: true }));
    const r = await openLegalLink('https://evil.example/cgu', { policy: PREPROD, platform: 'ios', appLauncher: { openUrl }, fallbackUrl: 'https://www.verebona.fr/legal/cguv' });
    expect(r).toEqual({ ok: false, reason: 'domain', strategy: null, copyUrl: 'https://www.verebona.fr/legal/cguv' });
    expect(openUrl).not.toHaveBeenCalled();
    expect(legalOpenFailureMessage(r as Extract<typeof r, { ok: false }>)).toMatch(/pas une adresse officielle/);
  });
});

describe('MOB-LEGAL-05/06 — inventaire des points d’entrée', () => {
  const FILES = [
    'src/components/account/LegalInformationCard.tsx',
    'src/components/account/PrivacyCard.tsx',
    'src/components/account/ReferralBlock.tsx',
    'src/components/shell/CguvReacceptanceScreen.tsx',
    'src/components/billing/ImmediateStartConsent.tsx',
    'src/components/upload-notice-banner.tsx',
    'src/components/Footer.tsx',
    'src/components/LandingFooter.tsx',
    'src/app/(auth)/signup/SignupForm.tsx',
    'src/app/(auth)/connexion-sociale/page.tsx',
    'src/app/(dashboard)/mon-compte/offres/page.tsx',
    'src/app/retractation/page.tsx',
  ];
  it.each(FILES)('%s : liens juridiques par `LegalLink`', (f) => {
    const src = read(f);
    expect(src).toMatch(/<LegalLink\b/);
    // Plus aucune balise brute vers un contenu légal résolu.
    expect(src).not.toMatch(/<a\s[^>]*href=\{(?:legal|legalLinks)\.(?:cguv|confidentialite|mentionsLegales|sousTraitants|parrainage)\}/);
    expect(src).not.toMatch(/<a\s[^>]*href=\{[^}]*permalink/i);
  });

  it('Mon compte › Informations légales : version acceptée = permalien EXACT (repli seulement s’il manque)', () => {
    const src = read('src/components/account/LegalInformationCard.tsx');
    expect(src).toMatch(/<LegalLink\s+href=\{latest\.permalinkUrl\}\s+fallbackHref=\{legal\.cguv\}/);
    expect(src).toMatch(/<LegalLink\s+href=\{a\.permalinkUrl\}\s+fallbackHref=\{legal\.cguv\}/);
  });

  it('LegalLink : navigation de la vue toujours empêchée dans l’app ; jamais Browser.open', () => {
    const src = read('src/components/legal/LegalLink.tsx');
    expect(src).toMatch(/if \(isNativeApp\(\)\) \{\s*\n\s*\/\/[^\n]*\n\s*e\.preventDefault\(\);/);
    const lib = read('src/lib/legal/open-legal-link.ts');
    expect(lib).toMatch(/NATIVE_PLUGINS\.appLauncher/);
    expect(lib).not.toMatch(/NATIVE_PLUGINS\.browser/);
    expect(NATIVE_PLUGINS.appLauncher).toBe('AppLauncher');
  });

  it('coque mobile : @capacitor/app-launcher déclaré et enregistré (iOS SPM, Android Gradle)', () => {
    const pkg = JSON.parse(read('mobile/package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@capacitor/app-launcher']).toMatch(/^8\.\d+\.\d+$/);
    expect(read('mobile/ios/App/CapApp-SPM/Package.swift')).toMatch(/\.product\(name: "CapacitorAppLauncher", package: "CapacitorAppLauncher"\)/);
    expect(read('mobile/android/capacitor.settings.gradle')).toMatch(/include ':capacitor-app-launcher'/);
    expect(read('mobile/android/app/capacitor.build.gradle')).toMatch(/implementation project\(':capacitor-app-launcher'\)/);
  });

  it('serveur : origines juridiques admises exposées à la liste blanche', () => {
    expect(read('src/app/api/legal/links/route.ts')).toMatch(/allowedOrigins: \[\.\.\.allowedOrigins\]/);
    expect(read('src/hooks/useLegalLinks.ts')).toMatch(/registerServerLegalOrigins\(d\?\.allowedOrigins\)/);
  });
});

describe('Retour à l’accueil — Web seulement (connexion, inscription)', () => {
  it('décision : masqué dès que le serveur OU Capacitor signale l’app', () => {
    expect(showWebBackHomeLink(false, false)).toBe(true);
    expect(showWebBackHomeLink(true, false)).toBe(false);
    expect(showWebBackHomeLink(false, true)).toBe(false);
  });

  it('premier rendu (serveur) : absent dans l’app, présent sur le Web — aucun élément caché par CSS', () => {
    const web = renderToStaticMarkup(createElement(NativeShellProvider, { native: false }, createElement(AuthBackHomeLink)));
    expect(web).toContain('Retour à l&#x27;accueil');
    expect(web).toContain('data-testid="auth-back-home"');
    const app = renderToStaticMarkup(createElement(NativeShellProvider, { native: true }, createElement(AuthBackHomeLink)));
    expect(app).toBe('');
  });

  it.each([
    'src/app/(auth)/login/page.tsx',
    'src/app/(auth)/signup/SignupForm.tsx',
    'src/app/(auth)/signup/SignupClosed.tsx',
    'src/app/(auth)/signup/SignupInvitationInvalid.tsx',
  ])('%s : composant partagé, plus de lien codé en dur', (f) => {
    // Tout autre « Retour à l'accueil » (bouton) est enveloppé par <WebOnly>.
    const src = read(f).replace(/<WebOnly>[\s\S]*?<\/WebOnly>/g, '');
    expect(read(f)).toMatch(/<AuthBackHomeLink \/>/);
    expect(src).not.toMatch(/Retour à l(?:'|&apos;)accueil/);
    expect(src).not.toMatch(/hidden[^"]*Retour/);
  });

  it('layout des pages d’authentification : indication native décidée au rendu serveur (agent utilisateur)', () => {
    const layout = read('src/app/(auth)/layout.tsx');
    expect(layout).toMatch(/isNativeAppUserAgent\(\(await headers\(\)\)\.get\('user-agent'\)\)/);
    expect(layout).toMatch(/<NativeShellProvider native=\{native\}>/);
  });
});
