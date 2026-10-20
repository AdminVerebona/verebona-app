/**
 * Lot 62 — L62-DECO : « le bouton Se déconnecter est KO : le clic ne fait
 * rien et l'app freeze, obligé de quitter » (iPhone, application installée,
 * menu du profil mobile).
 *
 * Deux causes, chacune suffisante pour figer l'écran :
 *
 *  1. Le panneau du compte (z-[60]) restait OUVERT quand « Se déconnecter »
 *     ouvrait la confirmation (fenêtre Radix, z-50) : elle s'affichait SOUS
 *     le panneau, tandis que Radix rendait le reste de la page inerte
 *     (pointer-events: none sur <body>, piège du focus). Aucun tap n'aboutit,
 *     pas de touche Échap sur iPhone : figé.
 *  2. Après la déconnexion, la page partait vers le site vitrine (autre
 *     domaine). Dans la WebView Capacitor, cette navigation est annulée et
 *     confiée à Safari : l'écran « Déconnexion… » (sans bouton) restait affiché.
 *
 * Environnement `node` : l'arbre React du panneau est parcouru sans rendu
 * DOM ; `useState` est remplacé pour observer l'ordre des actions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ReactActual from 'react';

const etat = vi.hoisted(() => ({ value: false as unknown, calls: [] as string[] }));
vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  return {
    ...actual,
    default: actual,
    useState: (init: unknown) => [etat.value ?? init, (v: unknown) => { etat.calls.push(`confirmer:${String(v)}`); }],
  };
});
vi.mock('next/navigation', () => ({ usePathname: () => '/accueil', useRouter: () => ({ push: () => {} }) }));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => null }));
(globalThis as { React?: typeof ReactActual }).React = ReactActual;

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
function* parcourir(n: unknown): Generator<El> {
  if (Array.isArray(n)) { for (const c of n) yield* parcourir(c); return; }
  if (!n || typeof n !== 'object' || !('props' in n)) return;
  const el = n as El;
  yield el;
  yield* parcourir(el.props.children);
}
const texte = (n: unknown): string => {
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map(texte).join('');
  if (n && typeof n === 'object' && 'props' in n) return texte((n as El).props.children);
  return '';
};

async function panneau(overrides: Record<string, unknown> = {}) {
  const { MobileAccountPanel } = await import('@/components/mobile/mobile-account-panel');
  const props = {
    open: true, onClose: () => etat.calls.push('fermer-panneau'), pathname: '/accueil', personName: 'Geo',
    email: 'g@example.fr', initials: 'GM', planLabel: 'Premium', accountName: null, isAdmin: true, theme: 'blue',
    onToggleTheme: () => {}, onOpenHelp: () => {}, onLogout: () => etat.calls.push('deconnexion'), showBell: false,
    ...overrides,
  };
  return MobileAccountPanel(props as Parameters<typeof MobileAccountPanel>[0]);
}

afterEach(() => { etat.value = false; etat.calls = []; });

describe('L62-DECO — menu du profil mobile (web mobile et application installée)', () => {
  it('L62-DECO-01 — « Se déconnecter » ferme le panneau AVANT d’ouvrir la confirmation (jamais la fenêtre sous le panneau)', async () => {
    const arbre = await panneau();
    const bouton = [...parcourir(arbre)].find((e) => e.type === 'button' && texte(e.props.children) === 'Se déconnecter');
    expect(bouton).toBeDefined();
    (bouton!.props.onClick as () => void)();
    expect(etat.calls).toEqual(['fermer-panneau', 'confirmer:true']);
  });

  it('L62-DECO-02 — confirmer déconnecte une seule fois ; la confirmation reste montée panneau fermé', async () => {
    etat.value = true; // confirmation ouverte
    const arbre = await panneau({ open: false });
    const dialogues = [...parcourir(arbre)].filter((e) => typeof e.type === 'function' && (e.type as { name?: string }).name === 'ConfirmLogoutDialog');
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0].props.open).toBe(true);
    (dialogues[0].props.onConfirm as () => void)();
    expect(etat.calls).toEqual(['deconnexion']);
  });

  it('L62-DECO-03 — couches : la confirmation (z-50) est plus basse que le panneau (z-[60]) — d’où la fermeture préalable', () => {
    expect(lire('src/components/mobile/mobile-account-panel.tsx')).toContain('fixed inset-0 z-[60] md:hidden');
    expect(lire('src/components/ui/alert-dialog.tsx')).toMatch(/fixed inset-0 z-50/);
  });
});

describe('L62-DECO — sortie après déconnexion (application installée / navigateur)', () => {
  const fenetre = (o: { protocol?: string; native?: boolean | 'throw' } = {}) => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const loc = { href: 'https://app.verebona.fr/accueil', protocol: o.protocol ?? 'https:', replaced: [] as string[], replace(u: string) { this.replaced.push(u); } };
    const w = {
      location: loc,
      setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
      Capacitor: o.native === undefined ? undefined : { isNativePlatform: () => { if (o.native === 'throw') throw new Error('pont'); return o.native as boolean; } },
    };
    return { w, loc, timers };
  };

  it('L62-DECO-04 — application installée (Capacitor) : retour à /login DANS l’application, jamais vers le site vitrine', async () => {
    const { leaveAfterLogout } = await import('@/lib/shell/logout-exit');
    const { w, loc, timers } = fenetre({ native: true });
    expect(leaveAfterLogout(w)).toBe('/login');
    expect(loc.href).toBe('/login');
    expect(timers).toHaveLength(0);
  });

  it('L62-DECO-05 — détection par le protocole capacitor:// et pont natif défaillant', async () => {
    const { isNativeAppShell } = await import('@/lib/shell/logout-exit');
    expect(isNativeAppShell(fenetre({ protocol: 'capacitor:' }).w)).toBe(true);
    expect(isNativeAppShell(fenetre({ native: 'throw', protocol: 'capacitor:' }).w)).toBe(true);
    expect(isNativeAppShell(fenetre({ native: 'throw' }).w)).toBe(false);
    expect(isNativeAppShell(fenetre({ native: false }).w)).toBe(false);
    expect(isNativeAppShell(fenetre().w)).toBe(false);
  });

  it('L62-DECO-06 — navigateur (ordinateur, web mobile) : site vitrine comme avant, repli /login si la navigation n’a pas eu lieu', async () => {
    const { leaveAfterLogout, LOGOUT_EXIT_FALLBACK_MS } = await import('@/lib/shell/logout-exit');
    const { publicSiteUrl } = await import('@/lib/external-urls');
    const { w, loc, timers } = fenetre();
    expect(leaveAfterLogout(w)).toBe(publicSiteUrl('/'));
    expect(loc.href).toBe(publicSiteUrl('/'));
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(LOGOUT_EXIT_FALLBACK_MS);
    timers[0].fn(); // page toujours là : navigation interceptée
    expect(loc.replaced).toEqual(['/login']);
  });

  it('L62-DECO-07 — la coquille (desktop ET mobile) sort par leaveAfterLogout, plus par une navigation directe vers le site vitrine', () => {
    const layout = lire('src/components/DashboardLayout.tsx');
    expect(layout).toContain('leaveAfterLogout()');
    expect(layout).not.toMatch(/window\.location\.href\s*=\s*publicSiteUrl/);
    // Une seule procédure de déconnexion pour TopBar (desktop), le panneau
    // mobile et (lot 72D) l'écran « sans espace ».
    expect(layout.match(/onLogout=\{handleLogout\}/g)).toHaveLength(3);
  });

  it('L62-DECO-08 — desktop : la confirmation est hors du menu de l’avatar et au-dessus de l’en-tête (z-[33] < z-50)', () => {
    const topbar = lire('src/components/TopBar.tsx');
    const finMenu = topbar.indexOf('</DropdownMenu>');
    expect(finMenu).toBeGreaterThan(0);
    expect(topbar.indexOf('<ConfirmLogoutDialog')).toBeGreaterThan(finMenu);
    expect(topbar).toContain('relative z-[33] hidden h-[60px]');
    expect(topbar).not.toMatch(/z-\[(5[1-9]|[6-9]\d|\d{3,})\]/);
  });
});
