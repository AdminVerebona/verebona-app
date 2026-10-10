/**
 * Navigation mobile — maquette Direction D v2 (« La mascotte »), répartition 2b.
 *
 *  · barre basse : cinq onglets répartis également, « + » détaché au-dessus ;
 *  · avatar : panneau du compte seul (carte d'identité → Mon compte,
 *    notifications, aide, administration si admin, thème, déconnexion
 *    confirmée) ; lot 26 : plus d'en-tête « Bonjour » ni de mascotte.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/agenda', useRouter: () => ({ push: () => {} }) }));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('../mobile-actions-sheet', () => ({ MobileActionsSheet: () => null }));

// Le harnais (environnement node) compile le JSX en `React.createElement`.
(globalThis as { React?: typeof React }).React = React;

const { BottomNavigation, NAV_ITEMS } = await import('../bottom-navigation');
const { MobileAccountPanel } = await import('../mobile-account-panel');

describe('barre basse', () => {
  it('cinq onglets dans l’ordre de la maquette', () => {
    expect(NAV_ITEMS.map((i) => i.name)).toEqual(['Accueil', 'Biens', 'Agenda', 'Documents', 'À traiter']);
  });

  it('grille de cinq, « + » hors de la grille, onglet actif marqué', () => {
    const html = renderToStaticMarkup(h(BottomNavigation, { toProcessCount: 3 }));
    expect(html).toContain('grid-cols-5');
    expect(html.indexOf('aria-label="Ajouter un bien, un document ou une échéance"')).toBeLessThan(html.indexOf('<nav'));
    expect(html).toMatch(/href="\/agenda"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/agenda"/);
    expect(html).toContain('aria-label="À traiter, 3"');
  });
});

describe('panneau du compte', () => {
  const props = {
    open: true, onClose: () => {}, pathname: '/accueil', greetingName: 'fab', personName: 'Fabien M.', initials: 'FM',
    planLabel: 'Premium', accountName: null, isAdmin: false, theme: 'blue', onToggleTheme: () => {}, onOpenHelp: () => {}, onLogout: () => {},
  };

  it('compte seulement, sans navigation', () => {
    const html = renderToStaticMarkup(h(MobileAccountPanel, props));
    for (const t of ['Mon compte', 'Besoin d’aide ?', 'Thème clair', 'Se déconnecter']) expect(html).toContain(t);
    expect(html).not.toContain('/agenda');
    expect(html).not.toContain('Administration');
  });

  it('lot 26 — AC5 : plus d’en-tête « Bonjour / Compte et réglages » ni de mascotte ; fermeture conservée', () => {
    const html = renderToStaticMarkup(h(MobileAccountPanel, props));
    expect(html).not.toContain('Bonjour');
    expect(html).not.toContain('>Compte et réglages<');
    expect(html).not.toContain('welcome-wave');
    expect(html).toContain('aria-label="Fermer"');
    // La cloche et la fermeture partagent une rangée alignée à droite.
    const rangee = html.slice(html.indexOf('class="flex items-center justify-end'));
    expect(rangee.indexOf('aria-label="Fermer"')).toBeGreaterThan(-1);
    expect(rangee.indexOf('aria-label="Fermer"')).toBeLessThan(rangee.indexOf('</div>'));
  });

  it('lot 26 — AC6, révisé lot 35 (L35-4) : un seul accès à Mon compte, l’entrée explicite ; la carte reste l’identité (nom + offre)', () => {
    const html = renderToStaticMarkup(h(MobileAccountPanel, props));
    expect(html.match(/href="\/mon-compte"/g)).toHaveLength(1);
    expect(html).toContain('>Mon compte<');
    expect(html).toContain('Fabien M.');
    expect(html).toContain('>Premium<');
    expect(html).not.toContain('href="/mon-compte/notifications"');
    const surMonCompte = renderToStaticMarkup(h(MobileAccountPanel, { ...props, pathname: '/mon-compte' }));
    expect(surMonCompte).toMatch(/href="\/mon-compte"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/mon-compte"/);
  });

  it('administration pour un administrateur ; fermé : rien', () => {
    expect(renderToStaticMarkup(h(MobileAccountPanel, { ...props, isAdmin: true }))).toContain('href="/admin"');
    expect(renderToStaticMarkup(h(MobileAccountPanel, { ...props, open: false }))).not.toContain('Compte et réglages');
  });
});
