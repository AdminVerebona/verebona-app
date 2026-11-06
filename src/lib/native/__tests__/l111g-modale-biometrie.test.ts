/**
 * Lot 111G — présentation de la proposition d'activation biométrique (#640).
 *
 *   L111G-TYPE  biométrie présentée : iOS Face ID / Touch ID, Android capteur
 *               unique seulement, sinon générique (jamais Face ID supposé) ;
 *   L111G-TEXT  libellés par type, aucune promesse de connexion serveur ;
 *   L111G-REND  rendu : fenêtre centrée sur fond assombri, Safe Areas, rôle
 *               dialog modal, aria-labelledby / describedby, titre focalisable,
 *               symbole adapté, deux actions ;
 *   L111G-SRC   pas de minuterie ni de fermeture par le fond, focus initial sur
 *               le titre, comportement et conditions d'affichage inchangés.
 * Le comportement réel (focus, centrage, texte agrandi) est vérifié en
 * navigateur (procédure dans docs/exploitation/recette-111g-modale-biometrie.md).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BiometricOfferCard } from '@/components/native/BiometricOfferCard';
import {
  BIOMETRIC_OFFER_LATER, BIOMETRIC_OFFER_LEAD, biometricOfferKind, biometricOfferTexts, presentationBiometryType,
  readBiometryTypes, type BiometricOfferKind,
} from '@/lib/native/biometric-offer-presentation';

// JSX classique sous Vitest (même procédé que l100d).
(globalThis as { React?: typeof React }).React = React;

const ROOT = resolve(__dirname, '../../../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const code = (p: string) => read(p).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');

const render = (type: number | null, platform: 'ios' | 'android' | null, busy = false) =>
  renderToStaticMarkup(h(BiometricOfferCard, { type, platform, busy, onActivate: () => {}, onLater: () => {} }));

describe('L111G-TYPE — biométrie réellement disponible', () => {
  it('iOS : Face ID (2) et Touch ID (1) tels que lus ; autre valeur → générique', () => {
    expect(presentationBiometryType('ios', 2, [2])).toBe(2);
    expect(presentationBiometryType('ios', 1, null)).toBe(1);
    expect(presentationBiometryType('ios', 0, [])).toBeNull();
    expect(presentationBiometryType('ios', 4, [4])).toBeNull(); // Optic ID (visionOS) : jamais présenté comme Face ID
    expect(presentationBiometryType('ios', null, null)).toBeNull();
  });

  it('Android : capteur précis seulement s’il est le seul déclaré', () => {
    expect(presentationBiometryType('android', 3, [3])).toBe(3);
    expect(presentationBiometryType('android', 4, [4])).toBe(4);
    expect(presentationBiometryType('android', 5, [5])).toBe(5);
    expect(presentationBiometryType('android', 3, [3, 4])).toBeNull(); // empreinte ET visage : celui enregistré est inconnu
    expect(presentationBiometryType('android', 3, null)).toBeNull(); // liste inconnue
    expect(presentationBiometryType('android', 3, [4])).toBeNull(); // incohérent
    expect(presentationBiometryType('android', 2, [2])).toBeNull(); // valeur iOS sur Android
    expect(presentationBiometryType('android', 0, [])).toBeNull();
  });

  it('nature de l’icône', () => {
    expect(biometricOfferKind('ios', 2)).toBe('face-id');
    expect(biometricOfferKind('ios', 1)).toBe('touch-id');
    expect(biometricOfferKind('ios', null)).toBe('generic');
    expect(biometricOfferKind('android', 3)).toBe('fingerprint');
    expect(biometricOfferKind('android', 4)).toBe('face');
    expect(biometricOfferKind('android', 5)).toBe('iris');
    expect(biometricOfferKind('android', null)).toBe('generic');
    expect(biometricOfferKind('android', 2)).toBe('generic');
    expect(biometricOfferKind(null, 2)).toBe('generic');
  });

  describe('lecture des capteurs (plugin existant, aucune invite)', () => {
    afterEach(() => { vi.unstubAllGlobals(); });
    const stub = (checkBiometry: () => Promise<unknown>) => vi.stubGlobal('window', {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { BiometricAuthNative: { checkBiometry } } },
    });
    it('liste lue, valeurs non numériques ignorées', async () => {
      stub(async () => ({ biometryType: 3, biometryTypes: [3, 'x', 4] }));
      expect(await readBiometryTypes()).toEqual([3, 4]);
    });
    it('plugin absent, erreur ou réponse inattendue → null', async () => {
      expect(await readBiometryTypes()).toBeNull();
      stub(async () => { throw new Error('boom'); });
      expect(await readBiometryTypes()).toBeNull();
      stub(async () => ({ biometryType: 3 }));
      expect(await readBiometryTypes()).toBeNull();
    });
  });
});

describe('L111G-TEXT — libellés', () => {
  it('Face ID, Touch ID, Android', () => {
    expect(biometricOfferTexts('face-id')).toEqual({
      title: 'Activer Face ID\u00a0?', description: 'Déverrouillez Verebona plus rapidement sur cet appareil.',
      activate: 'Activer Face ID', later: 'Plus tard',
    });
    expect(biometricOfferTexts('touch-id').title).toBe('Activer Touch ID\u00a0?');
    expect(biometricOfferTexts('touch-id').activate).toBe('Activer Touch ID');
    expect(biometricOfferTexts('generic').title).toBe('Activer le déverrouillage biométrique\u00a0?');
    expect(biometricOfferTexts('generic').activate).toBe('Activer la biométrie');
    expect(biometricOfferTexts('fingerprint').title).toBe('Activer le déverrouillage par empreinte\u00a0?');
    expect(biometricOfferTexts('face').title).toBe('Activer le déverrouillage par le visage\u00a0?');
    expect(biometricOfferTexts('iris').title).toBe('Activer le déverrouillage par l’iris\u00a0?');
  });

  it('jamais de promesse de connexion serveur ; « Face ID » seulement pour Face ID', () => {
    const kinds: BiometricOfferKind[] = ['face-id', 'touch-id', 'fingerprint', 'face', 'iris', 'generic'];
    for (const k of kinds) {
      const all = Object.values(biometricOfferTexts(k)).join(' ');
      expect(all, k).not.toMatch(/connexion|connecter|serveur|identifiant|mot de passe|double authentification|MFA|2FA/i);
      if (k !== 'face-id') expect(all, k).not.toMatch(/Face ID/);
    }
    expect(BIOMETRIC_OFFER_LEAD).toMatch(/sur cet appareil/);
    expect(BIOMETRIC_OFFER_LATER).toBe('Plus tard');
  });
});

describe('L111G-REND — rendu', () => {
  it('fenêtre centrée sur fond assombri, dans les Safe Areas (plus de panneau ancré en bas)', () => {
    const html = render(2, 'ios');
    const backdrop = html.match(/<div data-testid="biometric-offer-backdrop"[^>]*>/)![0];
    expect(backdrop).toMatch(/fixed inset-0/);
    expect(backdrop).toMatch(/items-center/);
    expect(backdrop).toMatch(/justify-center/);
    expect(backdrop).toMatch(/bg-\[color:var\(--veil\)\]/);
    for (const side of ['top', 'right', 'bottom', 'left']) expect(backdrop).toContain(`var(--vb-safe-${side})`);
    expect(html).not.toMatch(/inset-x-3|bottom:\s*max\(/);
    const dialog = html.match(/<div[^>]*role="dialog"[^>]*>/)![0];
    expect(dialog).toMatch(/max-h-full/); // jamais plus haute que la zone visible
    expect(dialog).toMatch(/overflow-y-auto/); // texte très agrandi : défile, rien n'est coupé
    expect(dialog).toMatch(/max-w-\[22rem\]/);
  });

  it('dialogue modal titré et décrit, titre focalisable', () => {
    const html = render(1, 'ios');
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/aria-labelledby="vb-bio-offer-title"/);
    expect(html).toMatch(/aria-describedby="vb-bio-offer-desc"/);
    expect(html).toMatch(/<h2 id="vb-bio-offer-title" tabindex="-1"[^>]*>Activer Touch ID\u00a0\?<\/h2>/);
    expect(html).toMatch(/id="vb-bio-offer-desc"/);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('icône et libellés selon la biométrie', () => {
    const cases: Array<[number | null, 'ios' | 'android' | null, BiometricOfferKind, string]> = [
      [2, 'ios', 'face-id', 'Activer Face ID'],
      [1, 'ios', 'touch-id', 'Activer Touch ID'],
      [null, 'ios', 'generic', 'Activer la biométrie'],
      [3, 'android', 'fingerprint', 'Activer l’empreinte digitale'],
      [4, 'android', 'face', 'Activer la reconnaissance du visage'],
      [null, 'android', 'generic', 'Activer la biométrie'],
    ];
    for (const [type, platform, kind, activate] of cases) {
      const html = render(type, platform);
      expect(html, kind).toContain(`data-kind="${kind}"`);
      expect(html, kind).toContain(`data-glyph="${kind}"`);
      expect(html, kind).toContain(`>${activate}</button>`);
      expect(html, kind).toContain('>Plus tard</button>');
      if (kind !== 'face-id') expect(html, kind).not.toMatch(/Face ID/);
    }
  });

  it('pendant la vérification native : deux boutons inactifs (pas de double appel)', () => {
    const html = render(2, 'ios', true);
    expect(html).toMatch(/aria-busy="true"/);
    expect((html.match(/<button[^>]*disabled=""/g) ?? []).length).toBe(2);
  });
});

describe('L111G-SRC — comportement inchangé, pas de fermeture automatique', () => {
  // Lot 111T : la forme de la fenêtre est commune (NativeOfferDialog) aux deux invitations.
  const card = code('src/components/native/BiometricOfferCard.tsx');
  const shell = code('src/components/native/NativeOfferDialog.tsx');
  const glyph = code('src/components/native/BiometricGlyph.tsx');
  const flow = code('src/lib/native/biometric-offer-flow.ts');

  it('aucune minuterie, aucune fermeture par le fond ni par Échap', () => {
    for (const src of [card, shell, glyph]) expect(src).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    expect(card + shell).not.toMatch(/Escape/);
    expect(shell.match(/onClick=/g)).toHaveLength(2); // seulement l'action principale et « Plus tard »
    expect(shell).toMatch(/onClick=\{onPrimary\}/);
    expect(shell).toMatch(/onClick=\{onLater\}/);
    expect(card).toMatch(/onPrimary=\{onActivate\}/);
    expect(card).toMatch(/onLater=\{onLater\}/);
  });

  it('focus initial sur le titre', () => {
    expect(shell).toMatch(/title\.current\?\.focus\(\)/);
  });

  it('pas d’image de tiers', () => {
    expect(card + shell + glyph).not.toMatch(/<img|lucide-react|\.png|\.svg['"]/);
  });

  it('conditions d’affichage et mémorisation (lot 111T : notée à l’affichage réel)', () => {
    expect(flow).toMatch(/shouldOfferBiometrics\(\{ \.\.\.c, sessionStatus: 'authenticated', setting \}\)/);
    expect(flow).toMatch(/deps\.defer\(userId, 'offered'\)/);
    expect(flow).toMatch(/changeBiometrics\(true, userId\)/);
    expect(flow).toMatch(/deps\.defer\(o\.userId, 'later'\)/);
    expect(flow).toMatch(/const visible = mine && !c\.blocked/);
  });
});
