/**
 * Navigation mobile — maquette Direction D v2 (« La mascotte »), répartition 2b.
 *
 *  · barre basse : cinq onglets répartis également, « + » détaché au-dessus ;
 *  · avatar : panneau du compte seul (identité, notifications, Mon compte,
 *    aide, administration si admin, thème, déconnexion confirmée), la
 *    mascotte en tête.
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

  it('la mascotte salue par le nom d’utilisateur ; compte seulement, sans navigation', () => {
    const html = renderToStaticMarkup(h(MobileAccountPanel, props));
    expect(html).toContain('Bonjour, fab');
    expect(html).toContain('welcome-wave');
    for (const t of ['Mon compte', 'Notifications', 'Besoin d&#x27;aide ?', 'Thème clair', 'Se déconnecter']) expect(html).toContain(t);
    expect(html).not.toContain('/agenda');
    expect(html).not.toContain('Administration');
  });

  it('administration pour un administrateur ; fermé : rien', () => {
    expect(renderToStaticMarkup(h(MobileAccountPanel, { ...props, isAdmin: true }))).toContain('href="/admin"');
    expect(renderToStaticMarkup(h(MobileAccountPanel, { ...props, open: false }))).not.toContain('Compte et réglages');
  });
});
