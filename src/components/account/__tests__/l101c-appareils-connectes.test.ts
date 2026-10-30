/**
 * Lot 101C — retour PO du 30/10/2026 : « Liste des appareils connectés : ne
 * doit pas être visible immédiatement dans le bloc sécurité. Le mettre dans
 * un sous-bloc fermé par défaut avec le bouton de déconnexion etc. »
 *
 * Sans navigateur (le rendu réel est vérifié par
 * `l101c-appareils-connectes-navigateur.test.ts`) : résumé de l'en-tête,
 * rendu serveur FERMÉ, liens d'e-mail et retour de confirmation vers l'ancre.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// Composants `ui/*` compilés en JSX classique par vitest.
(globalThis as { React?: typeof React }).React = React;
const { CollapsibleSubBlock } = await import('@/components/ui/collapsible-sub-block');
const { CONNECTED_DEVICES_ANCHOR, devicesSummary } = await import('@/components/account/security/SecurityCard');
import { NEW_DEVICE_LOGIN_LINK, getCatalogEntry } from '@/lib/notifications/catalog';
import { informationsRedirectTarget } from '@/app/(dashboard)/mon-compte/informations/redirect-target';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('L101C — résumé de l’en-tête du sous-bloc fermé', () => {
  it('nombre d’appareils et « dont celui-ci »', () => {
    expect(devicesSummary([{ current: true }, { current: false }])).toBe('2 appareils · dont celui-ci');
    expect(devicesSummary([{ current: true }])).toBe('1 appareil · celui-ci');
    expect(devicesSummary([{ current: false }, { current: false }, { current: false }])).toBe('3 appareils');
    expect(devicesSummary([])).toBe('Aucun appareil');
    expect(devicesSummary(null)).toBe('Chargement…');
    expect(devicesSummary(null, true)).toBe('Liste indisponible pour le moment');
  });
});

describe('L101C — sous-bloc repliable', () => {
  const rendu = renderToStaticMarkup(h(CollapsibleSubBlock, {
    anchorId: 'appareils-connectes', title: 'Appareils connectés', summary: '2 appareils · dont celui-ci',
    children: h('ul', null, h('li', null, 'PC Windows'), h('li', null, 'Déconnecter tous les autres appareils')),
  }));

  it('FERMÉ par défaut : contenu absent, zone masquée, bouton aria-expanded=false relié par aria-controls', () => {
    expect(rendu).not.toContain('PC Windows');
    expect(rendu).not.toContain('Déconnecter tous les autres appareils');
    const ctrl = /<button[^>]*aria-controls="([^"]+)"[^>]*aria-expanded="false"/.exec(rendu);
    expect(ctrl).not.toBeNull();
    expect(rendu).toMatch(new RegExp(`id="${ctrl![1]}"[^>]*hidden`));
    expect(rendu).toContain('type="button"');
  });

  it('en-tête : titre de section (h3) contenant le bouton, résumé, chevron décoratif, zone tactile ≥ 44 px', () => {
    expect(rendu).toMatch(/<h3[^>]*><button/);
    expect(rendu).toContain('Appareils connectés');
    expect(rendu).toContain('2 appareils · dont celui-ci');
    expect(rendu).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(rendu).toMatch(/<button[^>]*min-h-11/);
    expect(rendu).toContain('id="appareils-connectes"');
  });

  it('état jamais mémorisé (ni stockage navigateur ni préférence) ; même mécanique Radix que les tiroirs', () => {
    const src = read('src/components/ui/collapsible-sub-block.tsx');
    expect(src).not.toMatch(/localStorage|sessionStorage|cookie/);
    expect(src).toContain('React.useState(false)');
    expect(src).toContain('from "./collapsible"');
    expect(src).toMatch(/window\.location\.hash !== `#\$\{anchorId\}`/);
    expect(src).toContain('scrollIntoView');
  });
});

describe('L101C — carte Sécurité', () => {
  const card = read('src/components/account/security/SecurityCard.tsx');

  it('la liste, « Déconnecter », le conseil et « tous les autres » sont DANS le sous-bloc repliable', () => {
    expect(CONNECTED_DEVICES_ANCHOR).toBe('appareils-connectes');
    const debut = card.indexOf('<CollapsibleSubBlock');
    const fin = card.indexOf('</CollapsibleSubBlock>');
    expect(debut).toBeGreaterThan(0);
    expect(card.slice(debut, fin)).toContain('<DevicesList');
    expect(card.slice(debut, fin)).toContain('title="Appareils connectés"');
    const liste = card.slice(card.indexOf('function DevicesList'), card.indexOf('/* ── Carte'));
    for (const t of ['aria-label="Appareils connectés"', 'Déconnecter', 'Un appareil inconnu ?', 'Déconnecter tous les autres appareils']) expect(liste).toContain(t);
    // Plus d'ancien bloc toujours ouvert.
    expect(card).not.toMatch(/<SubBlock[^>]*title="Appareils connectés"/);
  });

  it('la carte Sécurité s’ouvre aussi sur l’ancre du sous-bloc ; la liste est relue à l’ouverture', () => {
    expect(card).toContain('innerAnchorIds={[CONNECTED_DEVICES_ANCHOR]}');
    expect(read('src/components/ui/collapsible-card.tsx')).toMatch(/innerAnchorIds/);
    expect(card).toMatch(/onOpenChange=\{\(o\) => \{ if \(o\) void load\(false\); \}\}/);
  });

  it('révocation inchangée : mêmes routes', () => {
    expect(card).toContain("apiClient.delete(`/api/users/me/sessions/${encodeURIComponent(s.id)}`)");
    expect(card).toContain("'/api/users/me/sessions/revoke-others'");
  });
});

describe('L101C — liens vers le sous-bloc', () => {
  it('e-mails « nouvel appareil » et « autres appareils déconnectés » : ancre du sous-bloc, sur /mon-compte', () => {
    expect(NEW_DEVICE_LOGIN_LINK).toBe('/mon-compte#appareils-connectes');
    for (const t of ['NEW_DEVICE_LOGIN', 'OTHER_SESSIONS_REVOKED'] as const) {
      expect(getCatalogEntry(t)!.deepLink({})).toBe('/mon-compte#appareils-connectes');
    }
  });

  it('anciens liens /mon-compte/informations… : paramètres et ancre conservés par la redirection', () => {
    expect(informationsRedirectTarget('', '#securite')).toBe('/mon-compte?tab=informations#securite');
    expect(informationsRedirectTarget('?securite=reauth&provider=google&resume=revoke-others', '#securite'))
      .toBe('/mon-compte?securite=reauth&provider=google&resume=revoke-others&tab=informations#securite');
    expect(informationsRedirectTarget('', '#appareils-connectes')).toBe('/mon-compte?tab=informations#appareils-connectes');
    expect(informationsRedirectTarget('', '')).toBe('/mon-compte?tab=informations');
    expect(read('src/app/(dashboard)/mon-compte/informations/page.tsx')).toContain('informationsRedirectTarget(window.location.search, window.location.hash)');
  });

  it('retour d’une confirmation Google / Apple après « tous les autres » : le sous-bloc se rouvre, rien n’est rejoué', () => {
    expect(read('src/app/api/users/me/auth-identities/[provider]/reauth/route.ts')).toMatch(/RESUMABLE = new Set\(\[[^\]]*'revoke-others'/);
    const block = read('src/components/account/security/SignInMethodsBlock.tsx');
    expect(block).toContain("else if (resume === 'revoke-others') window.location.hash = 'appareils-connectes';");
    expect(read('src/components/account/security/SecurityCard.tsx')).toMatch(/'Avant de déconnecter vos autres appareils\.',[\s\S]{0,160}'revoke-others',/);
  });
});
