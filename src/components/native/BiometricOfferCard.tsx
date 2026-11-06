'use client';

/**
 * Proposition d'activation du déverrouillage biométrique — lot 107A (#640),
 * présentation revue au lot 111G.
 *
 * Fenêtre CENTRÉE (dialogue modal, plus de panneau ancré en bas) sur un fond
 * légèrement assombri : forme commune `NativeOfferDialog` (lot 111T, partagée
 * avec l'invitation aux notifications). Symbole adapté à la biométrie
 * réellement disponible, titre, courte explication, action principale,
 * « Plus tard ».
 *
 * Comportement (lot 107A) : « Activer » lance la vérification native et
 * n'enregistre le choix qu'après succès, « Plus tard » ferme sans activer.
 * Ordre et mémorisation : `lib/native/biometric-offer-flow` (lot 111T :
 * biométrie D'ABORD, puis notifications dans la même session).
 */
import { BIOMETRIC_SHARED_DEVICE_NOTE } from '@/lib/native/biometric-consent';
import { nativePlatform } from '@/lib/native/bridge';
import {
  BIOMETRIC_OFFER_SETTINGS_NOTE, biometricOfferKind, biometricOfferTexts,
} from '@/lib/native/biometric-offer-presentation';
import { BiometricGlyph } from './BiometricGlyph';
import { NativeOfferDialog } from './NativeOfferDialog';

interface Props {
  /** `BiometryType` à présenter (null = générique, jamais Face ID par défaut). */
  type: number | null;
  busy: boolean;
  onActivate: () => void;
  onLater: () => void;
  /** Plateforme (tests de rendu) ; par défaut celle de l'application native. */
  platform?: 'ios' | 'android' | null;
}

export function BiometricOfferCard({ type, busy, onActivate, onLater, platform }: Props) {
  const kind = biometricOfferKind(platform === undefined ? nativePlatform() : platform, type);
  const t = biometricOfferTexts(kind);
  return (
    <NativeOfferDialog
      testId="biometric-offer"
      idPrefix="vb-bio-offer"
      kind={kind}
      icon={<BiometricGlyph kind={kind} className="size-[32px]" />}
      title={t.title}
      description={(
        <>
          <p className="text-[0.9375rem] leading-normal">{t.description}</p>
          <p className="text-xs leading-normal text-[color:var(--text-muted)]">
            {BIOMETRIC_SHARED_DEVICE_NOTE} {BIOMETRIC_OFFER_SETTINGS_NOTE}
          </p>
        </>
      )}
      primaryLabel={t.activate}
      laterLabel={t.later}
      busy={busy}
      onPrimary={onActivate}
      onLater={onLater}
    />
  );
}
