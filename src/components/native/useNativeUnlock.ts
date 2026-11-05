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
 *
 * Lot 111D : premier plan lu au démarrage (visibilité + état natif `App`),
 * reprise aussi sur `visibilitychange` (vue rechargée en arrière-plan), refus
 * « double authentification exigée » distingué d'une panne, journal technique
 * persistant sans donnée biométrique (`lib/native/unlock-journal`).
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/hooks/useSession';
import { useSessionStore } from '@/contexts/SessionContext';
import { apiClient } from '@/lib/api-client';
import { NATIVE_PLUGINS, listenNative, nativePlatform, nativePlugin } from '@/lib/native/bridge';
import { appBuildEnv, runtimeShellInfo } from '@/lib/native/shell-info';
import { appendUnlockJournal } from '@/lib/native/unlock-journal';
import {
  biometryShortLabel, clearBackgroundAt, readBackgroundAt, rememberBackgroundAt, retryLabel, verifyUserDetailed,
} from '@/lib/native/app-lock';
import { resolveUnlockBiometry } from '@/lib/native/biometric-consent';
import { setLockCover } from '@/lib/native/lock-boot';
import { createUnlockController, type UnlockController } from '@/lib/native/unlock-controller';
import { unlockSessionStatus, type FallbackAction, type UnlockMethod, type UnlockState } from '@/lib/native/unlock-machine';

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

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
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
  const { status, user, sessionError } = useSession();
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
          // 111D : lecture en échec → « indisponible pour le moment », jamais « non activé ».
          whyNot: r.active ? undefined : r.reactivate ? 'reactivate' : (r.enabled || r.stored === 'read_failed') ? 'unavailable' : 'not_enabled',
          diag: { stored: r.stored ?? null, type: r.type, enrollmentPlugin: r.enrollmentPlugin ?? null, featureOn },
        };
      },
      prompt: (mode) => verifyUserDetailed({ biometryOnly: mode === 'biometry', reason: 'Déverrouiller Verebona' }),
      async verifySession() {
        await store.refetch();
        const snap = store.getSnapshot();
        return { status: unlockSessionStatus(snap.status, snap.error?.code), userId: snap.user?.id ?? null };
      },
      navigate: (path) => routerRef.current.push(path),
      signInAgain(returnPath, reason) {
        const target = returnPath ?? currentPath();
        // Connexion complète demandée par l'utilisateur : la préférence
        // biométrique de l'appareil est conservée. 111D : motif « double
        // authentification » transmis à l'écran de connexion (lot 110B).
        const motif = reason === 'mfa_required' ? 'reason=mfa_required&' : '';
        void apiClient.signOut({ keepBiometrics: true }).finally(() => {
          window.location.assign(`/login?${motif}returnUrl=${encodeURIComponent(target)}`);
        });
      },
      exitSession: () => { void apiClient.handleAuthFailure({}); },
      onCover: setLockCover,
      isForeground: pageVisible,
      // Codes stables, aucun identifiant ni secret : journal local persistant
      // (préproduction ET production, lot 111D) + console en préproduction.
      log: (code, detail) => {
        appendUnlockJournal(code, detail);
        if (debug) console.info(`[verebona:unlock] ${code}`, detail ?? {});
      },
    });
  }
  const controller = controllerRef.current;
  const [state, setState] = useState<UnlockState>(() => controller.getState());

  // Démarrage à froid / rechargement de la vue : décision AVANT tout le reste.
  useEffect(() => {
    const off = controller.subscribe(setState);
    // Informations de build (diagnostic #642 bis) : version / build / canal du
    // binaire et plugins présents — aucune donnée de compte.
    const shell = runtimeShellInfo();
    appendUnlockJournal('UNLOCK_SHELL', {
      platform: shell?.platform ?? nativePlatform(), appVersion: shell?.appVersion ?? null, build: shell?.build ?? null, env: appBuildEnv(),
      biometricPlugin: nativePlugin(NATIVE_PLUGINS.biometric) !== null,
      secureStoragePlugin: nativePlugin(NATIVE_PLUGINS.secureStorage) !== null,
      enrollmentPlugin: nativePlugin(NATIVE_PLUGINS.biometricState) !== null,
    });
    controller.boot();
    setState(controller.getState());
    // 111D : la vue peut avoir été (re)chargée app en ARRIÈRE-PLAN (processus
    // Web fermé par iOS puis rechargé) : l'état natif fait foi. Plugin absent
    // ou en erreur : premier plan supposé (comportement antérieur).
    type AppStatePlugin = { getState?: () => Promise<{ isActive?: boolean }> };
    const app = nativePlugin<AppStatePlugin>(NATIVE_PLUGINS.app);
    if (app && typeof app.getState === 'function') {
      void app.getState()
        .then((r) => { if (r?.isActive === false) controller.backgroundProbe(); else controller.resume(); })
        .catch(() => controller.resume());
    } else if (!pageVisible()) {
      controller.backgroundProbe();
    }
    return off;
  }, [controller]);

  // Session partagée → machine (premier chargement, changement de compte, fin de session).
  const userId = user?.id ?? null;
  const unlockStatus = unlockSessionStatus(status, sessionError?.code);
  useEffect(() => {
    controller.dispatch({ type: 'SESSION', status: unlockStatus, userId });
  }, [controller, unlockStatus, userId]);

  // Cycle de vie natif.
  useEffect(() => {
    const off = listenNative<{ isActive: boolean }>(nativePlugin(NATIVE_PLUGINS.app), 'appStateChange', (s) => {
      if (s.isActive) controller.resume();
      else controller.background();
    });
    // 111D : retour visible de la page (signal Web, aussi pour une vue
    // rechargée en arrière-plan) — même reprise, une seule sollicitation.
    const onVisible = () => { if (pageVisible()) controller.resume(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      void off.then((f) => f());
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [controller]);

  const onAction = useCallback((a: FallbackAction) => {
    if (a === 'retry_biometry') controller.dispatch({ type: 'RETRY' });
    else if (a === 'other_method') controller.dispatch({ type: 'OTHER_METHOD' });
    else if (a === 'device_credential') controller.dispatch({ type: 'DEVICE_CREDENTIAL' });
    else if (a === 'retry_session') controller.dispatch({ type: 'RETRY_SESSION' });
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
