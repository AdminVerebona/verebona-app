/**
 * Coquille et session — APP-PERF-02 (CA-03), APP-PERF-04 (CA-02),
 * APP-PERF-21 (sortie bornée).
 *
 * · reprise explicite sur indisponibilité, sans redirection pendant le rendu ;
 * · premier rendu identique serveur/client (aucune identité lue dans le
 *   localStorage avant hydratation) ;
 * · déconnexion par la procédure unique et bornée.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ usePathname: () => '/accueil', useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

import { LogoutStatusScreen, SessionUnavailableScreen } from '@/components/shell/SessionStateScreen';
import { SessionProvider } from '@/contexts/SessionContext';
import { useSession } from '@/hooks/useSession';
import { SessionStore } from '@/lib/session/session-store';

// Le harnais (environnement node) compile le JSX en `React.createElement`.
(globalThis as { React?: typeof React }).React = React;

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('écrans d’état de session', () => {
  it('indisponibilité : bouton « Réessayer » et référence, pas de chargement permanent', () => {
    const html = renderToStaticMarkup(createElement(SessionUnavailableScreen, { onRetry: () => {}, requestId: 'req-42' }));
    expect(html).toContain('Réessayer');
    expect(html).toContain('Référence : req-42');
    expect(html).toContain('role="alert"');
  });

  it('sortie non confirmée : réessayer ou quitter, sans annoncer de révocation', () => {
    const html = renderToStaticMarkup(createElement(LogoutStatusScreen, { state: 'failed', onRetry: () => {}, onLeave: () => {} }));
    expect(html).toContain('Déconnexion non confirmée');
    expect(html).toContain('Réessayer la déconnexion');
    expect(html).toContain('Quitter quand même');
    expect(html).not.toMatch(/déconnecté avec succès/i);
  });
});

describe('useSession — premier rendu', () => {
  it('rendu serveur : « checking » sans identité, quel que soit l’état du magasin', async () => {
    const store = new SessionStore({ fetchMe: async () => ({ id: 1 } as never) });
    await store.refetch();
    function Sonde() {
      const s = useSession({ required: true });
      return createElement('span', null, `${s.status}|${s.isLoading}|${s.user ? s.user.id : 'aucun'}`);
    }
    const html = renderToStaticMarkup(createElement(SessionProvider, { store, children: createElement(Sonde) }));
    expect(html).toContain('checking|true|aucun');
  });
});

describe('câblage', () => {
  it('useSession : plus de course de 4 s, de pseudo-vérification ni de lecture du localStorage', () => {
    const hook = sansCommentaires(read('src/hooks/useSession.ts'));
    expect(hook).not.toMatch(/Promise\.race|4000|hasToken|localStorage/);
    expect(hook).toMatch(/useSyncExternalStore\(store\.subscribe, store\.getSnapshot, serverSnapshot\)/);
    expect(hook).toMatch(/apiClient\.handleAuthFailure\(/);
  });

  it('DashboardLayout : aucune redirection pendant le rendu ; reprise sur indisponibilité', () => {
    const layout = sansCommentaires(read('src/components/DashboardLayout.tsx'));
    expect(layout).not.toMatch(/window\.location\.href = `\/login/);
    expect(layout).toMatch(/sessionResult\.status === 'temporarily-unavailable'/);
    expect(layout).toMatch(/<SessionUnavailableScreen/);
  });

  it('DashboardLayout : sortie par la procédure unique, push borné par elle', () => {
    const layout = sansCommentaires(read('src/components/DashboardLayout.tsx'));
    expect(layout).toMatch(/apiClient\.signOut\(\{ unsubscribePush: unsubscribeCurrentDevice \}\)/);
    expect(layout).not.toMatch(/await unsubscribeCurrentDevice\(\)/);
    expect(layout).not.toMatch(/apiClient\.post\('\/api\/auth\/logout'\)/);
  });

  it('push-client : la désinscription accepte un signal d’annulation', () => {
    expect(read('src/lib/push/push-client.ts')).toMatch(/export async function unsubscribeCurrentDevice\(signal\?: AbortSignal\)/);
  });

  it('logout serveur : résultat réel de la révocation rendu au client', () => {
    const route = read('src/app/api/auth/logout/route.ts');
    expect(route).toMatch(/revocation = 'failed'/);
    expect(route).toMatch(/revocation,/);
  });
});
