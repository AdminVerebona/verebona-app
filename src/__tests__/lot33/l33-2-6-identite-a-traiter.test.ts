/**
 * Lot 33 — L33-2 (identité du panneau du compte mobile alignée sur le menu
 * de l'avatar desktop) et L33-6 (phrase d'introduction de « À traiter »
 * retirée).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ usePathname: () => '/accueil', useRouter: () => ({ push: () => {} }) }));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => null }));
(globalThis as { React?: typeof React }).React = React;

import { formatUserDisplayName, formatUserInitials } from '@/lib/user-display-name';
import * as microcopy from '@/lib/referential/v2/microcopy';
const { MobileAccountPanel } = await import('@/components/mobile/mobile-account-panel');

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('L33-2 — même identité sur mobile et sur ordinateur', () => {
  it('L33-2 — nom d’affichage : `username` s’il est renseigné, sinon « Prénom N. »', () => {
    expect(formatUserDisplayName({ firstName: 'Geoffroy', lastName: 'Maupilier', username: 'Geoffroy' })).toBe('Geoffroy');
    expect(formatUserDisplayName({ firstName: 'Geoffroy', lastName: 'Maupilier', username: '  ' })).toBe('Geoffroy M.');
    expect(formatUserDisplayName({ firstName: 'Geoffroy', lastName: 'Maupilier', username: null })).toBe('Geoffroy M.');
    expect(formatUserDisplayName({ firstName: 'Geoffroy', lastName: '' })).toBe('Geoffroy');
    expect(formatUserDisplayName(null)).toBe('');
    expect(formatUserInitials({ firstName: 'geoffroy', lastName: 'maupilier' })).toBe('GM');
  });

  it('L33-2 — desktop (TopBar) et mobile (DashboardLayout → panneau) lisent la même fonction', () => {
    const topBar = lire('src/components/TopBar.tsx');
    expect(topBar).toContain('const displayName = formatUserDisplayName(user)');
    expect(topBar).toContain('const initials = formatUserInitials(user)');
    const layout = lire('src/components/DashboardLayout.tsx');
    expect(layout).toContain('formatUserDisplayName(user)');
    expect(layout).toContain('personName={userDisplayName}');
    expect(layout).toContain('email={user.email}');
    // Plus aucun format local « Prénom N. » dans la coquille.
    expect(topBar).not.toContain('lastName.charAt(0)');
    expect(layout).not.toContain('lastName.charAt(0)');
  });

  it('L33-2 — la carte mobile affiche le nom d’affichage puis l’e-mail, comme le menu desktop', () => {
    const user = { firstName: 'Geoffroy', lastName: 'Maupilier', username: 'Geoffroy', email: 'g@example.fr' };
    const html = renderToStaticMarkup(h(MobileAccountPanel, {
      open: true, onClose: () => {}, pathname: '/accueil',
      personName: formatUserDisplayName(user), email: user.email, initials: formatUserInitials(user),
      planLabel: 'Premium', accountName: null, isAdmin: false, theme: 'blue',
      onToggleTheme: () => {}, onOpenHelp: () => {}, onLogout: () => {}, showBell: false,
    }));
    // Lot 35 (L35-4) : la carte n'est plus un lien (en-tête d'identité comme sur ordinateur).
    expect(html).toContain('data-testid="account-identity"');
    expect(html).not.toContain('Geoffroy M.');
    expect(html).toContain('>g@example.fr<');
    expect(html.indexOf('>Geoffroy<')).toBeLessThan(html.indexOf('>g@example.fr<'));
    expect(html).toContain('>GM<');
  });
});

describe('L33-6 — « À traiter » sans phrase d’introduction', () => {
  it('L33-6 — la page n’affiche plus « N actions nécessitent votre attention… » ni ses variantes', () => {
    const page = lire('src/components/to-process/ToProcessQueue.tsx');
    expect(page).not.toContain('toProcessHeadline');
    expect('toProcessHeadline' in microcopy).toBe(false);
    const copy = lire('src/lib/referential/v2/microcopy.ts');
    for (const t of ['nécessitent votre attention', 'nécessite votre attention', 'affichées en premier', 'classées par type']) {
      expect(copy).not.toContain(t);
      expect(page).not.toContain(t);
    }
  });

  it('L33-6 — le reste est conservé : décompte, bascules, cartes, message de filtres', () => {
    const page = lire('src/components/to-process/ToProcessQueue.tsx');
    for (const t of ['Rien à traiter pour le moment', 'Par priorité', 'Par action', 'Cartes', 'Liste', '<ActionCard', '<ActionRow', 'TO_PROCESS_NO_FILTER_RESULT']) {
      expect(page).toContain(t);
    }
  });
});
