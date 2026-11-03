'use client';

/**
 * Verrou et déverrouillage automatique de l'application native — lot 107A.
 * Branche le contrôleur (`lib/native/unlock-controller.ts`) sur :
 *   · le cycle de vie natif (`App.appStateChange` : arrière-plan / retour ;
 *     démarrage à froid = montage du module) ;
 *   · la session partagée (`SessionProvider`) : relue à chaque verrou ;
 *   · Face ID / Touch ID / biométrie Android et code du téléphone ;
 *   · la navigation (liens profonds, notifications différés pendant le verrou).
 * Chargé UNIQUEMENT dans l'application iOS / Android (NativeBridgeRuntime).
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/hooks/useSession';
import { useSessionStore } from '@/contexts/SessionContext';
import { apiClient } from '@/lib/api-client';
import { NATIVE_PLUGINS, listenNative, nativePlatform, nativePlugin } from '@/lib/native/bridge';
import { appBuildEnv } from '@/lib/native/shell-info';
import {
  biometryShortLabel, clearBackgroundAt, readBackgroundAt, rememberBackgroundAt, retryLabel, verifyUserDetailed,
} from '@/lib/native/app-lock';
import { resolveUnlockBiometry } from '@/lib/native/biometric-consent';
import { setLockCover } from '@/lib/native/lock-boot';
import { createUnlockController, type UnlockController } from '@/lib/native/unlock-controller';
import type { FallbackAction, SessionKnown, UnlockMethod, UnlockState } from '@/lib/native/unlock-machine';

type Features = Record<string, boolean> | null;

export interface NativeUnlock {
  state: UnlockState;
  locked: boolean;
  shortLabel: string;
  retryLabel: string;
  onAction: (a: FallbackAction) => void;
  /** Navigation interne : différée tant que l'app est verrouillée. */
  open: (path: string) => void;
}

function currentPath(): string {
  if (typeof window === 'undefined') return '/accueil';
  return `${window.location.pathname}${window.location.search}` || '/accueil';
}

export function useNativeUnlock(featuresRef: MutableRefObject<Features>): NativeUnlock {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const store = useSessionStore();
  const { status, user } = useSession();
  const [labels, setLabels] = useState(() => {
    const platform = nativePlatform();
    return { short: biometryShortLabel(null, platform), retry: retryLabel(null, platform) };
  });

  const controllerRef = useRef<UnlockController | null>(null);
  if (!controllerRef.current) {
    const platform = nativePlatform();
    const debug = appBuildEnv() !== 'prod';
    controllerRef.current = createUnlockController({
      now: () => Date.now(),
      readBackgroundAt,
      persistBackgroundAt: (at) => rememberBackgroundAt(at),
      clearBackgroundAt,
      async readMethod(userId): Promise<UnlockMethod> {
        const featureOn = featuresRef.current ? featuresRef.current.biometrics !== false : true;
        const r = await resolveUnlockBiometry(userId, featureOn);
        setLabels({ short: biometryShortLabel(r.type, platform), retry: retryLabel(r.type, platform) });
        return {
          biometry: r.active,
          biometryAvailable: r.available,
          deviceSecure: r.deviceSecure,
          whyNot: r.active ? undefined : r.reactivate ? 'reactivate' : r.enabled ? 'unavailable' : 'not_enabled',
        };
      },
      prompt: (mode) => verifyUserDetailed({ biometryOnly: mode === 'biometry', reason: 'Déverrouiller Verebona' }),
      async verifySession() {
        await store.refetch();
        const snap = store.getSnapshot();
        return { status: snap.status as SessionKnown, userId: snap.user?.id ?? null };
      },
      navigate: (path) => routerRef.current.push(path),
      signInAgain(returnPath) {
        const target = returnPath ?? currentPath();
        // Connexion complète demandée par l'utilisateur : la préférence
        // biométrique de l'appareil est conservée.
        void apiClient.signOut({ keepBiometrics: true }).finally(() => {
          window.location.assign(`/login?returnUrl=${encodeURIComponent(target)}`);
        });
      },
      exitSession: () => { void apiClient.handleAuthFailure({}); },
      onCover: setLockCover,
      // Codes stables, aucun identifiant ni secret (diagnostic sur appareil de préproduction).
      log: debug ? (code, detail) => { console.info(`[verebona:unlock] ${code}`, detail ?? {}); } : undefined,
    });
  }
  const controller = controllerRef.current;
  const [state, setState] = useState<UnlockState>(() => controller.getState());

  // Démarrage à froid / rechargement de la vue : décision AVANT tout le reste.
  useEffect(() => {
    const off = controller.subscribe(setState);
    controller.boot();
    setState(controller.getState());
    return off;
  }, [controller]);

  // Session partagée → machine (premier chargement, changement de compte, fin de session).
  const userId = user?.id ?? null;
  useEffect(() => {
    controller.dispatch({ type: 'SESSION', status: status as SessionKnown, userId });
  }, [controller, status, userId]);

  // Cycle de vie natif.
  useEffect(() => {
    const off = listenNative<{ isActive: boolean }>(nativePlugin(NATIVE_PLUGINS.app), 'appStateChange', (s) => {
      if (s.isActive) controller.resume();
      else controller.background();
    });
    return () => { void off.then((f) => f()); };
  }, [controller]);

  const onAction = useCallback((a: FallbackAction) => {
    if (a === 'retry_biometry') controller.dispatch({ type: 'RETRY' });
    else if (a === 'other_method') controller.dispatch({ type: 'OTHER_METHOD' });
    else if (a === 'device_credential') controller.dispatch({ type: 'DEVICE_CREDENTIAL' });
    else controller.dispatch({ type: 'SIGN_IN' });
  }, [controller]);

  const open = useCallback((path: string) => controller.dispatch({ type: 'NAVIGATE', path }), [controller]);

  return {
    state,
    locked: state.phase !== 'unlocked',
    shortLabel: labels.short,
    retryLabel: labels.retry,
    onAction,
    open,
  };
}
