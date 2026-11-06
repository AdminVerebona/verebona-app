'use client';

/**
 * Invitation « Autoriser les notifications ? » — lot 109G, présentation revue
 * au lot 111T : même fenêtre CENTRÉE sur fond assombri que la proposition
 * biométrique (`NativeOfferDialog`, lot 111G), plus de carte en bas d'écran.
 * Affichée APRÈS l'étape biométrique, jamais en même temps.
 *
 * La demande système n'est faite que sur « Autoriser les notifications » ;
 * boutons inactifs pendant la demande (pas de double appel). « Plus tard »
 * ferme sans aucune demande système.
 */
import { Bell } from 'lucide-react';
import {
  PUSH_ONBOARDING_ALLOW, PUSH_ONBOARDING_LATER, PUSH_ONBOARDING_TEXT, PUSH_ONBOARDING_TITLE,
} from '@/lib/native/push-onboarding';
import { NativeOfferDialog } from './NativeOfferDialog';

interface Props {
  busy: boolean;
  onAllow: () => void;
  onLater: () => void;
}

export function PushOnboardingCard({ busy, onAllow, onLater }: Props) {
  return (
    <NativeOfferDialog
      testId="push-onboarding"
      idPrefix="vb-push"
      kind="notifications"
      icon={<Bell className="size-[28px]" aria-hidden />}
      title={PUSH_ONBOARDING_TITLE}
      description={<p className="text-[0.9375rem] leading-normal">{PUSH_ONBOARDING_TEXT}</p>}
      primaryLabel={PUSH_ONBOARDING_ALLOW}
      laterLabel={PUSH_ONBOARDING_LATER}
      busy={busy}
      onPrimary={onAllow}
      onLater={onLater}
    />
  );
}
