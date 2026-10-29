/**
 * Lot 97 — raccord avec le registre des sessions (sous-lot 92) : mêmes noms
 * d'en-têtes (valeurs en minuscules acceptées), gestionnaire isolé pour
 * `onSessionRevoked`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const appels = vi.hoisted(() => [] as unknown[]);
vi.mock('@/lib/mobile/push-installations', () => ({
  deactivatePushForSession: async (ref: unknown) => { appels.push(ref); return 1; },
  transferPushSession: async (from: string, to: string, userId: number | null) => { appels.push({ transfert: [from, to, userId] }); return 1; },
}));

import { readClientContext } from '@/lib/mobile/client-context';
import { onSessionRevokedPushHandler, registerMobilePushSessionHook } from '@/lib/mobile/session-revocation-hook';
import { notifySessionsRevoked, onSessionRevoked, type RevokedSessionInfo } from '@/lib/auth/session-hooks';
import { readSessionClient } from '@/lib/auth/session-client';

describe('L97 — raccord sous-lot 92', () => {
  it('en-têtes du registre : web|pwa|ios|android en minuscules, installation UUID', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    for (const [v, attendu] of [['web', 'WEB'], ['pwa', 'PWA'], ['ios', 'IOS'], ['android', 'ANDROID']] as const) {
      const c = readClientContext(new NextRequest('http://x/api/a', { headers: { 'X-Verebona-Client': v, 'X-Verebona-App-Version': '1.0.0', 'X-Verebona-Installation-Id': id } }));
      expect(c.client).toBe(attendu);
      expect(c.installationId).toBe(id);
    }
  });

  it('gestionnaire : sid / installation / utilisateur transmis ; rien sans identifiant', async () => {
    appels.length = 0;
    let hook: ((s: unknown) => unknown) | null = null;
    registerMobilePushSessionHook((h) => { hook = h as never; });
    await (hook as unknown as (s: unknown) => Promise<number>)({ sid: 'sid-1', installationId: '0f8fad5b-d9cb-469f-a165-70867728950e', userId: 7 });
    expect(appels).toEqual([{ sessionId: 'sid-1', installationId: '0f8fad5b-d9cb-469f-a165-70867728950e', userId: 7 }]);
    expect(await onSessionRevokedPushHandler(null)).toBe(0);
    await onSessionRevokedPushHandler({ sessionId: 'sid-2', installationId: 'pas un id' });
    expect(appels[1]).toEqual({ sessionId: 'sid-2', installationId: null, userId: null });
  });

  it('intégration 92 + 97 : branché sur onSessionRevoked au démarrage, une seule fois ; remplacement du même appareil ignoré', async () => {
    const boot = readFileSync(join(process.cwd(), 'src/instrumentation-node.ts'), 'utf8');
    expect(boot).toContain("registerMobilePushSessionHook((h) => onSessionRevoked(h, { key: 'mobile-push' }))");
    appels.length = 0;
    const off: Array<() => void> = [];
    // Démarrage rejoué : la clé remplace l'enregistrement précédent.
    registerMobilePushSessionHook((h) => off.push(onSessionRevoked(h, { key: 'mobile-push' })));
    registerMobilePushSessionHook((h) => off.push(onSessionRevoked(h, { key: 'mobile-push' })));
    const info = (over: Partial<RevokedSessionInfo>): RevokedSessionInfo => ({
      sid: 'sid-9', userId: 9, deviceKey: null, clientType: 'IOS', reason: 'LOGOUT', scope: 'logout', sameDeviceContinues: false, ...over,
    });
    await notifySessionsRevoked([info({})]);
    expect(appels).toEqual([{ sessionId: 'sid-9', installationId: null, userId: 9 }]);
    await notifySessionsRevoked([info({ scope: 'replaced', sameDeviceContinues: true })]);
    expect(appels).toHaveLength(1);
    // Lot 94 (M2) : remplacement sur le même appareil → le push suit la session neuve, sans être coupé.
    await notifySessionsRevoked([info({ scope: 'replaced', sameDeviceContinues: true, replacedBySid: 'sid-10' })]);
    expect(appels).toEqual([{ sessionId: 'sid-9', installationId: null, userId: 9 }, { transfert: ['sid-9', 'sid-10', 9] }]);
    off.forEach((f) => f());
  });

  it('lot 94 (M2) : registre des crochets unique par processus (globalThis), même après rechargement du module', async () => {
    appels.length = 0;
    const off = onSessionRevoked((s) => onSessionRevokedPushHandler(s), { key: 'mobile-push' });
    vi.resetModules();
    const autreExemplaire = await import('@/lib/auth/session-hooks');
    await autreExemplaire.notifySessionsRevoked([{
      sid: 'sid-g', userId: 3, deviceKey: null, clientType: 'ANDROID', reason: 'USER_REVOKED', scope: 'single', sameDeviceContinues: false,
    }]);
    off();
    expect(appels).toEqual([{ sessionId: 'sid-g', installationId: null, userId: 3 }]);
  });

  it('intégration 92 + 97 : une seule lecture des en-têtes (registre des sessions = client-context)', () => {
    const req = (h: Record<string, string>) => ({ headers: new Headers(h), cookies: { get: () => undefined } });
    const c = readSessionClient(req({ 'x-verebona-client': 'ANDROID', 'x-verebona-app-version': '1.4 (52)', 'x-verebona-installation-id': 'abcdefghijklmnop_1234' }));
    // Lot 96B (P5) : l'identifiant d'installation DÉCLARÉ ne fait pas l'appareil (cookie signé seulement).
    expect(c).toMatchObject({ clientType: 'ANDROID', appVersion: '1.4.0 (52)', deviceSource: null, deviceKey: null });
    expect(readFileSync(join(process.cwd(), 'src/lib/auth/session-client.ts'), 'utf8')).toContain("from '@/lib/mobile/client-context'");
  });

  it('intégration 92 + 93 + 97 : middleware et retour après connexion (requête conservée, Google / Apple compris)', async () => {
    const mw = readFileSync(join(process.cwd(), 'src/middleware.ts'), 'utf8');
    // 97 : contrôle de version mobile AVANT le CSRF ; retour avec la requête.
    expect(mw.indexOf('mobileVersionGate(request, pathname)')).toBeGreaterThan(-1);
    expect(mw.indexOf('mobileVersionGate(request, pathname)')).toBeLessThan(mw.indexOf('Protection CSRF'));
    expect(mw).toContain("loginUrl.searchParams.set('returnUrl', `${pathname}${request.nextUrl.search}`)");
    // 93 : parcours Google / Apple sans session ; seul le retour Apple (POST) est exempté d'origine.
    expect(mw).toContain("pathname.startsWith('/api/auth/oauth/')");
    const { verifyRequestOrigin } = await import('@/lib/csrf');
    const post = (path: string) => new NextRequest(`http://localhost:3000${path}`, { method: 'POST', headers: { origin: 'https://appleid.apple.com' } });
    expect(verifyRequestOrigin(post('/api/auth/oauth/apple/callback')).allowed).toBe(true);
    expect(verifyRequestOrigin(post('/api/mobile/push-installations')).allowed).toBe(false);
    // La destination avec requête survit au parcours Google / Apple.
    const { socialStartUrl } = await import('@/components/auth/SocialSignInButtons');
    const { contextFromQuery } = await import('@/lib/auth/oauth/flow');
    const url = socialStartUrl('google', { intent: 'login', returnUrl: '/documents?drawer=12' });
    expect(contextFromQuery(new URLSearchParams(url.split('?')[1]))).toMatchObject({ returnUrl: '/documents?drawer=12' });
    // Le navigateur (Web / PWA) et le retour fournisseur ne sont jamais soumis au contrôle de version.
    const { isExemptFromVersionGate } = await import('@/lib/mobile/mobile-config');
    expect(isExemptFromVersionGate('/api/auth/refresh')).toBe(true);
  });
});
