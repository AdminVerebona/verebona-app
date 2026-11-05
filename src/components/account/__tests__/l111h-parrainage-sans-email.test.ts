/**
 * Lot 111H — Mon compte › Parrainage sans « Inviter par email » (décision PO) :
 * le formulaire (titre, champ, bouton, séparateur, états, validation, appel
 * `/api/referral/send-email`) est retiré ; code, lien, copies, « Partager mon
 * invitation » et « Voir les conditions du parrainage » restent. Repli de
 * partage sur le Web : copie de l'invitation complète, puis e-mail préparé.
 *
 *   L111H-UI-01  rendu : bloc e-mail absent, actions conservées, partage en
 *                dernière ligne (ni séparateur ni espace résiduel)
 *   L111H-UI-02  source : plus d'état, de validation ni d'appel de l'ancien formulaire
 *   L111H-SH-01  partage natif / navigateur : bon lien transmis, sans ressaisie
 *   L111H-SH-02  repli sans Web Share : copie exacte texte + lien
 *   L111H-SH-03  repli si la copie est refusée : e-mail préparé (mailto)
 *   L111H-SRV-01 route d'envoi conservée (BO, gabarit, journal) ; Duo intact
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ReferralLinkActions,
  ReferralSummary,
  REFERRAL_SHARE_TITLE,
  referralInvitationMailto,
  referralInvitationMessage,
  referralShareText,
  shareReferralInvitation,
} from '@/components/account/ReferralBlock';

(globalThis as { React?: typeof React }).React = React;
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const decode = (h: string) => h.replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const LINK = { code: 'NUMY4D4M', url: 'https://app.verebona.fr/r/NUMY4D4M' };
const noop = () => {};
const render = (canShare: boolean) => decode(renderToStaticMarkup(createElement('div', null,
  createElement(ReferralSummary),
  createElement(ReferralLinkActions, {
    ...LINK, canShare, codeCopied: false, linkCopied: false,
    onCopyCode: noop, onCopyLink: noop, onShare: noop,
  }),
)));

describe('L111H-UI-01 — rendu de la section (lien créé)', () => {
  for (const canShare of [true, false]) {
    const html = render(canShare);
    const label = canShare ? 'Partager mon invitation' : 'Copier mon invitation';

    it(`bloc « Inviter par email » absent (partage ${canShare ? 'natif' : 'indisponible'})`, () => {
      expect(html).not.toMatch(/Inviter par e-?mail/i);
      expect(html).not.toContain('Adresse email du filleul');
      expect(html).not.toContain('Envoyer l\'invitation');
      expect(html).not.toMatch(/<input\b/);
      expect(html).not.toContain('type="email"');
      expect(html).not.toMatch(/border-t\b/);
    });

    it(`actions conservées : code, lien, copies, ${label}, conditions`, () => {
      expect(html).toContain(LINK.code);
      expect(html).toContain(LINK.url);
      expect(html).toContain('data-testid="referral-copy-code"');
      expect(html).toContain('Copier le code');
      expect(html).toContain('data-testid="referral-copy-link"');
      expect(html).toContain('Copier le lien');
      expect(html).toContain('data-testid="referral-share"');
      expect(html).toContain(label);
      expect(html).toContain('data-testid="referral-terms-link"');
      expect(html.replace(/<[^>]+>/g, '')).toContain('Voir les conditions du parrainage');
    });

    it('le partage est la dernière ligne de la section (bas sans vide)', () => {
      const tail = html.slice(html.indexOf('data-testid="referral-share"'));
      expect(tail).toMatch(/^[^]*?<\/button><\/div>$/);
      expect(tail.match(/<button\b/g) ?? []).toHaveLength(0);
    });
  }
});

describe('L111H-UI-02 — source du bloc : ancien formulaire entièrement retiré', () => {
  const bloc = code(read('src/components/account/ReferralBlock.tsx'));
  it('plus d’état, de validation, d’appel ni d’import propres au formulaire', () => {
    for (const s of [
      '/api/referral/send-email', 'setEmail', 'sendingEmail', 'handleSendInvitation', 'emailRegex',
      'INVITATION_ERROR', 'serverMessage', "from '@/components/ui/input'", 'Send,', '<Send',
    ]) expect(bloc, s).not.toContain(s);
  });
  it('texte partagé inchangé (lot 100D) ; le lien vient de l’API (aucune règle modifiée)', () => {
    expect(referralShareText('ABC')).toBe('Je vous invite à découvrir Verebona, l’espace qui garde en ordre vos biens et leurs documents. Mon code de parrainage : ABC');
    expect(bloc).toContain("apiClient.get<any>('/api/referral/me')");
  });
});

describe('L111H-SH — « Partager mon invitation »', () => {
  it('SH-01 partage natif / navigateur : titre, texte et LIEN transmis tels quels', async () => {
    const share = vi.fn(async () => 'shared' as const);
    const copy = vi.fn(async () => {});
    const openMailto = vi.fn();
    expect(await shareReferralInvitation(LINK, { share, copy, openMailto })).toBe('shared');
    expect(share).toHaveBeenCalledWith({ title: REFERRAL_SHARE_TITLE, text: referralShareText(LINK.code), url: LINK.url });
    expect(copy).not.toHaveBeenCalled();
    expect(openMailto).not.toHaveBeenCalled();
  });

  it('SH-01 bis feuille fermée par l’utilisateur : rien d’autre (ni copie ni e-mail)', async () => {
    const copy = vi.fn(async () => {});
    const openMailto = vi.fn();
    expect(await shareReferralInvitation(LINK, { share: async () => 'cancelled', copy, openMailto })).toBe('cancelled');
    expect(copy).not.toHaveBeenCalled();
    expect(openMailto).not.toHaveBeenCalled();
  });

  it('SH-02 navigator.share absent : copie exacte de l’invitation (texte + lien)', async () => {
    const copy = vi.fn(async (_t: string) => {});
    const openMailto = vi.fn();
    expect(await shareReferralInvitation(LINK, { share: async () => 'unavailable', copy, openMailto })).toBe('copied');
    expect(copy).toHaveBeenCalledWith(`${referralShareText(LINK.code)}\n${LINK.url}`);
    expect(referralInvitationMessage(LINK.code, LINK.url)).toBe(`${referralShareText(LINK.code)}\n${LINK.url}`);
    expect(openMailto).not.toHaveBeenCalled();
  });

  it('SH-03 copie refusée (ou presse-papiers absent) : e-mail préparé avec le lien', async () => {
    const openMailto = vi.fn();
    const copy = () => { throw new TypeError('clipboard undefined'); };
    expect(await shareReferralInvitation(LINK, { share: async () => 'unavailable', copy, openMailto })).toBe('mailto');
    const href = openMailto.mock.calls[0][0] as string;
    expect(href).toBe(referralInvitationMailto(LINK.code, LINK.url));
    expect(href.startsWith('mailto:?subject=')).toBe(true);
    const body = decodeURIComponent(href.split('&body=')[1]);
    expect(body).toContain(LINK.url);
    expect(body).toContain(LINK.code);
    expect(decodeURIComponent(href.split('subject=')[1].split('&')[0])).toBe(REFERRAL_SHARE_TITLE);
  });
});

describe('L111H-SRV-01 — services non supprimés sans vérification', () => {
  it('route d’envoi par e-mail conservée (gabarit BO, journal, table) — suppression proposée au PO', () => {
    expect(existsSync(join(process.cwd(), 'src/app/api/referral/send-email/route.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'src/services/referral/referral-invitation.service.ts'))).toBe(true);
  });
  it('invitations Premium Duo indépendantes et intactes', () => {
    const duo = read('src/app/api/duo/invitation/route.ts');
    expect(duo).not.toContain('/api/referral/send-email');
    expect(duo).not.toContain('referral-invitation.service');
  });
});
