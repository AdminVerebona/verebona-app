/**
 * Lot 35 — L35-4 : « Menu mobile non conforme : il y a les notifications et
 * il n'y a pas mon compte ». Le panneau mobile et le menu de l'avatar desktop
 * lisent la même liste (`accountMenuEntries`).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ usePathname: () => '/accueil', useRouter: () => ({ push: () => {} }) }));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => h('span', { 'data-cloche': '1' }) }));
(globalThis as { React?: typeof React }).React = React;

import { accountMenuEntries } from '@/lib/shell/account-menu';
const { MobileAccountPanel } = await import('@/components/mobile/mobile-account-panel');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const props = {
  open: true, onClose: () => {}, pathname: '/accueil', personName: 'Geo', email: 'g@example.fr', initials: 'GM',
  planLabel: 'Premium', accountName: null, isAdmin: true, theme: 'blue', onToggleTheme: () => {}, onOpenHelp: () => {}, onLogout: () => {},
};

describe('L35-4 — source unique des entrées', () => {
  it('L35-4 — ordre du menu desktop : Mon compte, Besoin d’aide ?, Administration (admin), Thème, Se déconnecter', () => {
    expect(accountMenuEntries({ isAdmin: true, theme: 'blue' }).map((e) => e.label))
      .toEqual(['Mon compte', 'Besoin d’aide ?', 'Administration', 'Thème clair', 'Se déconnecter']);
    expect(accountMenuEntries({ isAdmin: false, theme: 'light' }).map((e) => e.id))
      .toEqual(['account', 'help', 'theme', 'logout']);
    expect(accountMenuEntries({ isAdmin: false, theme: 'light' }).find((e) => e.id === 'theme')?.label).toBe('Thème sombre');
    expect(accountMenuEntries({ isAdmin: true, theme: 'blue' }).map((e) => e.label)).not.toContain('Notifications');
  });

  it('L35-4 — le menu desktop (TopBar) et le panneau mobile lisent tous deux accountMenuEntries', () => {
    const topBar = lire('src/components/TopBar.tsx');
    const mobile = lire('src/components/mobile/mobile-account-panel.tsx');
    expect(topBar).toContain('accountMenuEntries({ isAdmin, theme, withHelp: !!onOpenHelp })');
    expect(mobile).toContain('accountMenuEntries({ isAdmin, theme })');
    // Plus de liste locale ni de libellé codé en dur côté mobile ou desktop.
    for (const src of [topBar, mobile]) {
      expect(src).not.toMatch(/<span>Mon compte<\/span>|label: 'Notifications'|>Se déconnecter</);
    }
  });
});

describe('L35-4 — panneau mobile', () => {
  it('L35-4 — « Mon compte » présent, « Notifications » absent ; la cloche reste en en-tête', () => {
    const html = renderToStaticMarkup(h(MobileAccountPanel, props));
    expect(html).toContain('>Mon compte<');
    expect(html).toContain('href="/mon-compte"');
    expect(html).not.toContain('>Notifications<');
    expect(html).not.toContain('href="/mon-compte/notifications"');
    expect(html).toContain('data-cloche="1"');
  });

  it('L35-4 — entrées dans l’ordre du desktop, déconnexion en dernier', () => {
    const html = renderToStaticMarkup(h(MobileAccountPanel, props));
    const pos = ['>Mon compte<', '>Besoin d’aide ?<', '>Administration<', '>Thème clair<', '>Se déconnecter<'].map((t) => html.indexOf(t));
    expect(pos.every((p) => p > -1)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(renderToStaticMarkup(h(MobileAccountPanel, { ...props, isAdmin: false }))).not.toContain('Administration');
  });

  it('L35-4 — la carte d’identité est un en-tête non cliquable, comme sur ordinateur ; un seul lien vers Mon compte', () => {
    const html = renderToStaticMarkup(h(MobileAccountPanel, props));
    expect(html).toMatch(/<div data-testid="account-identity"/);
    expect(html.match(/href="\/mon-compte"/g)).toHaveLength(1);
    const carte = html.slice(html.indexOf('data-testid="account-identity"'), html.indexOf('<nav'));
    expect(carte).toContain('>Geo<');
    expect(carte).toContain('>g@example.fr<');
    expect(carte).toContain('>Premium<');
    expect(carte).not.toContain('href=');
  });
});
