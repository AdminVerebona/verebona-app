'use client';

/**
 * Invitation « Autoriser les notifications » à la première connexion — lot 109G.
 * Règles et persistance : `lib/native/push-onboarding`. Ce hook ne fait que
 * relier le contrôleur à la session, à l'écran courant et aux toasts.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { useSession } from '@/hooks/useSession';
import { nativePlatform } from '@/lib/native/bridge';
import { reacceptanceStatusOf } from '@/lib/legal/reacceptance-gate';
import {
  clearLegacyPushPromptKey, pushOnboardingView, pushRequestOutcomeMessage, sharedPushOnboarding,
  type PushOnboardingContext, type PushOnboardingView,
} from '@/lib/native/push-onboarding';

export interface PushOnboarding extends PushOnboardingView {
  allow: () => void;
  later: () => void;
}

export function usePushOnboarding(
  pushFeatureOn: boolean,
  blocked: boolean,
  offline: boolean,
  otherVisible: boolean,
): PushOnboarding {
  const ctl = sharedPushOnboarding();
  const snap = useSyncExternalStore(ctl.subscribe, ctl.getSnapshot, ctl.getSnapshot);
  const pathname = usePathname();
  const { status, user } = useSession();
  const userId = status === 'authenticated' ? (user?.id ?? null) : null;
  const legalRequired = reacceptanceStatusOf(user?.legalReacceptance) === 'required';

  const ctx: PushOnboardingContext = {
    userId, featureOn: pushFeatureOn, pathname, legalRequired, blocked, offline, otherVisible,
  };

  useEffect(() => { clearLegacyPushPromptKey(); }, []);

  // Décision du compte (permission OS + décision enregistrée) dès la session établie.
  useEffect(() => {
    if (userId !== null && pushFeatureOn) void ctl.evaluate(userId);
  }, [ctl, userId, pushFeatureOn]);

  // Présentation quand l'écran le permet (et retrait si le compte change).
  useEffect(() => {
    ctl.sync({ userId, featureOn: pushFeatureOn, pathname, legalRequired, blocked, offline, otherVisible });
  }, [ctl, snap, userId, pushFeatureOn, pathname, legalRequired, blocked, offline, otherVisible]);

  const allow = useCallback(() => {
    void ctl.allow().then((r) => {
      if (!r) return;
      const m = pushRequestOutcomeMessage(r, nativePlatform());
      if (m.kind === 'success') toast.success(m.text);
      else if (m.kind === 'error') toast.error(m.text);
      else toast.message(m.text);
    });
  }, [ctl]);

  const later = useCallback(() => ctl.later(), [ctl]);

  return { ...pushOnboardingView(snap, ctx), allow, later };
}
