'use client';

/**
 * Invitation « Autoriser les notifications ? » — lot 109G. Non bloquante (carte
 * en bas d'écran, l'app reste utilisable), même présentation que la
 * proposition biométrique (lot 107A). La demande système n'est faite que sur
 * « Autoriser les notifications » ; boutons inactifs pendant la demande (pas
 * de double appel). Accessibilité : `dialog` titré et décrit.
 */
import { useEffect, useRef } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  PUSH_ONBOARDING_ALLOW, PUSH_ONBOARDING_LATER, PUSH_ONBOARDING_TEXT, PUSH_ONBOARDING_TITLE,
} from '@/lib/native/push-onboarding';

interface Props {
  busy: boolean;
  onAllow: () => void;
  onLater: () => void;
}

export function PushOnboardingCard({ busy, onAllow, onLater }: Props) {
  const allow = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { allow.current?.focus(); }, []);
  return (
    <div
      role="dialog"
      aria-labelledby="vb-push-title"
      aria-describedby="vb-push-desc"
      data-testid="push-onboarding"
      className="fixed inset-x-3 z-[998] rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 shadow-lg"
      style={{ bottom: 'max(1rem, calc(var(--vb-safe-bottom) + 4.5rem))' }}
    >
      <div className="flex items-start gap-3">
        <Bell className="mt-0.5 h-5 w-5 shrink-0 text-[color:var(--accent)]" aria-hidden />
        <div className="space-y-3">
          <p id="vb-push-title" className="text-sm font-medium">{PUSH_ONBOARDING_TITLE}</p>
          <p id="vb-push-desc" className="text-xs text-[color:var(--text-muted)]">{PUSH_ONBOARDING_TEXT}</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={allow} size="sm" onClick={onAllow} disabled={busy}>{PUSH_ONBOARDING_ALLOW}</Button>
            <Button size="sm" variant="outline" onClick={onLater} disabled={busy}>{PUSH_ONBOARDING_LATER}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
