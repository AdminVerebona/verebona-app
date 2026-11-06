'use client';

/**
 * Proposition unique d'activation du déverrouillage biométrique — lot 107A
 * (#640). Règles, ordre (biométrie D'ABORD, lot 111T) et mémorisation :
 * `lib/native/biometric-offer-flow`. Ce hook ne fait que relier le contrôleur
 * à la session, à l'écran courant et aux toasts.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { useSession } from '@/hooks/useSession';
import { reacceptanceStatusOf } from '@/lib/legal/reacceptance-gate';
import {
  biometricOfferView, sharedBiometricOffer, type BiometricOfferContext, type BiometricOfferView,
} from '@/lib/native/biometric-offer-flow';

type Features = Record<string, boolean> | null;

export interface BiometricOffer extends BiometricOfferView {
  activate: () => void;
  later: () => void;
}

export function useBiometricOffer(features: Features, blocked: boolean): BiometricOffer {
  const ctl = sharedBiometricOffer();
  const snap = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot, ctl.getSnapshot);
  const pathname = usePathname();
  const { status, user } = useSession();
  const userId = status === 'authenticated' ? (user?.id ?? null) : null;
  const legalRequired = reacceptanceStatusOf(user?.legalReacceptance) === 'required';
  const featureOn = features ? features.biometrics !== false : true;

  const ctx: BiometricOfferContext = { userId, featureOn, pathname, legalRequired, blocked };
  const view = biometricOfferView(snap, ctx);

  // Évaluation dès la session établie sur un écran utile (et retrait si le compte change).
  useEffect(() => {
    ctl.sync({ userId, featureOn, pathname, legalRequired, blocked });
  }, [ctl, snap, userId, featureOn, pathname, legalRequired, blocked]);

  // Proposition notée seulement une fois la fenêtre réellement affichée.
  const shownFor = view.visible ? snap.offer?.userId ?? null : null;
  useEffect(() => {
    if (shownFor !== null) ctl.presented(shownFor);
  }, [ctl, shownFor]);

  const activate = useCallback(() => {
    void ctl.activate().then((r) => {
      if (!r) return;
      const name = r.label === 'la biométrie' ? 'Le déverrouillage biométrique' : r.label;
      if (r.result === 'enabled') toast.success(`${name} est activé pour Verebona sur cet appareil.`);
      else if (r.result === 'storage_error') toast.error('Le réglage n’a pas pu être enregistré sur cet appareil. Vous pourrez réessayer dans Mon compte › Sécurité.');
      else toast.message('Rien n’a été activé. Vous pourrez le faire dans Mon compte › Sécurité.');
    });
  }, [ctl]);

  const later = useCallback(() => ctl.later(), [ctl]);

  return { ...view, activate, later };
}
