'use client';

/**
 * Proposition unique d'activation du déverrouillage biométrique — lot 107A
 * (#640). Évaluée une fois par compte et par lancement, dès qu'une session
 * est réellement établie sur un écran de l'application (jamais sur un écran
 * de connexion, de consentement CGUV, ni pendant le verrou). Aussi pour les
 * installations existantes : un compte encore jamais sollicité sur cet
 * appareil reçoit la proposition une fois.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { useSession } from '@/hooks/useSession';
import { nativePlatform } from '@/lib/native/bridge';
import { reacceptanceStatusOf } from '@/lib/legal/reacceptance-gate';
import {
  changeBiometrics, deferBiometrics, isBiometricOfferPath, readBiometricSetting, shouldOfferBiometrics,
} from '@/lib/native/biometric-consent';

type Features = Record<string, boolean> | null;

export interface BiometricOffer {
  visible: boolean;
  /** Une proposition a été montrée pendant ce lancement (pas d'autre invitation empilée). */
  shownThisRun: boolean;
  type: number | null;
  busy: boolean;
  activate: () => void;
  later: () => void;
}

/**
 * `held` (lot 109G) : une invitation prioritaire (notifications) est attendue
 * ou a été présentée pendant ce lancement — la proposition n'est ni évaluée
 * ni notée ; le compte reste « jamais proposé » et la reçoit au lancement
 * suivant. Réglages et règles de sécurité de la biométrie inchangés.
 */
export function useBiometricOffer(features: Features, blocked: boolean, held = false): BiometricOffer {
  const pathname = usePathname();
  const { status, user } = useSession();
  const [offer, setOffer] = useState<{ userId: number; type: number | null; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [shownThisRun, setShownThisRun] = useState(false);
  const evaluated = useRef<Set<number>>(new Set());

  const userId = user?.id ?? null;
  const legalRequired = reacceptanceStatusOf(user?.legalReacceptance) === 'required';
  const featureOn = features ? features.biometrics !== false : true;

  // Identité courante, relue à l'arrivée de la lecture asynchrone : une
  // navigation pendant la lecture (redirection après connexion) ne perd pas
  // la proposition ; un changement de compte l'abandonne.
  const currentUser = useRef<number | null>(userId);
  currentUser.current = status === 'authenticated' ? userId : null;

  useEffect(() => {
    if (offer || userId === null || status !== 'authenticated' || blocked || held || legalRequired || !featureOn) return;
    if (!isBiometricOfferPath(pathname) || evaluated.current.has(userId)) return;
    evaluated.current.add(userId);
    const input = { featureOn, sessionStatus: status, userId, pathname, legalRequired, blocked };
    void (async () => {
      const setting = await readBiometricSetting(nativePlatform(), userId, featureOn);
      if (currentUser.current !== userId || !shouldOfferBiometrics({ ...input, setting })) return;
      // Proposition UNIQUE : notée dès l'affichage (même si l'app est fermée sans réponse).
      await deferBiometrics(userId, 'offered');
      if (currentUser.current !== userId) return;
      setOffer({ userId, type: setting.type, label: setting.shortLabel });
      setShownThisRun(true);
    })();
  }, [offer, userId, status, blocked, held, legalRequired, featureOn, pathname]);

  // Compte changé ou session terminée : la proposition de l'autre compte disparaît.
  useEffect(() => {
    if (offer && (userId !== offer.userId || status === 'unauthenticated')) setOffer(null);
  }, [offer, userId, status]);

  const activate = useCallback(() => {
    if (!offer || busy) return;
    setBusy(true);
    void changeBiometrics(true, offer.userId).then((r) => {
      const name = offer.label === 'la biométrie' ? 'Le déverrouillage biométrique' : offer.label;
      if (r === 'enabled') toast.success(`${name} est activé pour Verebona sur cet appareil.`);
      else if (r === 'storage_error') toast.error('Le réglage n’a pas pu être enregistré sur cet appareil. Vous pourrez réessayer dans Mon compte › Sécurité.');
      else toast.message('Rien n’a été activé. Vous pourrez le faire dans Mon compte › Sécurité.');
    }).finally(() => { setBusy(false); setOffer(null); });
  }, [offer, busy]);

  const later = useCallback(() => {
    if (!offer) return;
    void deferBiometrics(offer.userId, 'later');
    setOffer(null);
  }, [offer]);

  return { visible: !!offer && !blocked, shownThisRun, type: offer?.type ?? null, busy, activate, later };
}
