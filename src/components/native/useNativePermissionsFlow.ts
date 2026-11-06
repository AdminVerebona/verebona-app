'use client';

/**
 * Autorisations de première connexion mobile — lot 113J. Relie le contrôleur
 * `lib/native/native-permissions-flow` à la session, à l'écran courant, au
 * réseau et aux écrans bloquants. Ne rend RIEN : aucune fenêtre, aucun toast
 * Verebona — seules les demandes natives du téléphone apparaissent, l'une
 * après l'autre (biométrie, puis notifications).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { useSession } from '@/hooks/useSession';
import { reacceptanceStatusOf } from '@/lib/legal/reacceptance-gate';
import { sharedNativePermissions } from '@/lib/native/native-permissions-flow';
import { clearLegacyPushPromptKey } from '@/lib/native/push-onboarding';

type Features = Record<string, boolean> | null;

export function useNativePermissionsFlow(features: Features, blocked: boolean, offline: boolean): void {
  const ctl = sharedNativePermissions();
  const snap = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot, ctl.getSnapshot);
  const pathname = usePathname();
  const { status, user } = useSession();
  const userId = status === 'authenticated' ? (user?.id ?? null) : null;
  const legalRequired = reacceptanceStatusOf(user?.legalReacceptance) === 'required';
  // Configuration pas encore lue : fonction active (défaut serveur).
  const biometricsOn = features ? features.biometrics !== false : true;
  const pushOn = features ? features.push !== false : true;

  useEffect(() => { clearLegacyPushPromptKey(); }, []);

  // Déclenchement dès la session établie sur un écran utile ; une étape à la fois.
  useEffect(() => {
    ctl.sync({ userId, biometricsOn, pushOn, pathname, legalRequired, blocked, offline });
  }, [ctl, snap, userId, biometricsOn, pushOn, pathname, legalRequired, blocked, offline]);
}
