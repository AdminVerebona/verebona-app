'use client';

/**
 * Écran de déverrouillage de l'application native — lot 107A.
 *
 * Plus d'écran statique de verrouillage ni de bouton préalable dans le
 * parcours normal : pendant la vérification automatique, rien n'est affiché
 * à part le voile neutre (et la fenêtre Face ID / Touch ID / biométrie du
 * système). Cet écran n'apparaît qu'en SECOURS (annulation, échec, blocage,
 * biométrie indisponible ou non activée) : un titre, une phrase courte, des
 * actions volontaires — jamais de relance automatique.
 *
 * Rendu dans <body> (portail) avec `data-vb-lock-screen` : seul élément
 * visible au-dessus du voile (`globals.css`, lot 107A). Accessibilité :
 * `alertdialog` modal, titre et message liés, focus placé sur la première
 * action à l'apparition (VoiceOver / TalkBack l'annoncent).
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LOCK_SCREEN_ATTRIBUTE } from '@/lib/native/lock-boot';
import {
  UNLOCK_FALLBACK_TITLE, fallbackActionLabel, fallbackMessage,
  type FallbackAction, type UnlockState,
} from '@/lib/native/unlock-machine';

interface Props {
  state: UnlockState;
  /** « Face ID », « Touch ID » ou « la biométrie ». */
  shortLabel: string;
  /** « Réessayer Face ID »… */
  retryLabel: string;
  onAction: (a: FallbackAction) => void;
}

export function NativeUnlockScreen({ state, shortLabel, retryLabel, onAction }: Props) {
  const firstAction = useRef<HTMLButtonElement | null>(null);
  const fallback = state.phase === 'fallback' ? state.fallback : null;

  useEffect(() => {
    if (fallback) firstAction.current?.focus();
  }, [fallback]);

  if (typeof document === 'undefined' || state.phase === 'unlocked' || state.phase === 'covered') return null;
  const lockScreen = { [LOCK_SCREEN_ATTRIBUTE]: '' };

  if (!fallback) {
    // Vérification en cours : voile seul ; une annonce discrète pour les lecteurs d'écran.
    return createPortal(
      <div {...lockScreen} role="status" aria-live="polite" className="sr-only">
        Déverrouillage de Verebona…
      </div>,
      document.body,
    );
  }

  const message = fallbackMessage(fallback, shortLabel);
  return createPortal(
    <div
      {...lockScreen}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="vb-unlock-title"
      aria-describedby="vb-unlock-message"
      data-testid="native-unlock-fallback"
      className="inset-0 flex items-center justify-center bg-[color:var(--bg-page)] p-6"
      style={{ paddingTop: 'max(1.5rem, var(--vb-safe-top))', paddingBottom: 'max(1.5rem, var(--vb-safe-bottom))' }}
    >
      <div className="w-full max-w-sm space-y-4 text-center">
        <ShieldCheck className="mx-auto h-10 w-10 text-[color:var(--accent)]" aria-hidden />
        <h1 id="vb-unlock-title" className="vb-app-title">{UNLOCK_FALLBACK_TITLE}</h1>
        <p id="vb-unlock-message" className="text-sm text-[color:var(--text-muted)]">{message}</p>
        <div className="space-y-2">
          {fallback.actions.map((a, i) => (
            <Button
              key={a}
              ref={i === 0 ? firstAction : undefined}
              className="w-full"
              variant={i === 0 ? 'default' : 'outline'}
              onClick={() => onAction(a)}
            >
              {fallbackActionLabel(a, retryLabel)}
            </Button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
