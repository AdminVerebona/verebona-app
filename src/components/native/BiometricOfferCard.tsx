'use client';

/**
 * Proposition d'activation du déverrouillage biométrique — lot 107A (#640),
 * présentation revue au lot 111G.
 *
 * Fenêtre CENTRÉE (dialogue modal, plus de panneau ancré en bas) sur un fond
 * légèrement assombri, dans la zone visible hors encarts système (Safe Areas).
 * Hiérarchie : symbole adapté à la biométrie réellement disponible, titre,
 * courte explication, action principale, « Plus tard ». Compacte sur petit
 * écran : largeur bornée, contenu défilant si le texte est très agrandi ou
 * l'écran couché ; boutons pleine largeur qui passent à la ligne.
 *
 * Comportement INCHANGÉ (lot 107A) : affichée une fois par appareil et par
 * compte (`useBiometricOffer`), « Activer » lance la vérification native et
 * n'enregistre le choix qu'après succès, « Plus tard » ferme sans activer.
 * Aucune fermeture automatique ni par toucher du fond : le choix reste
 * explicite. Accessibilité : `dialog` modal titré et décrit, focus initial
 * sur le titre (VoiceOver / TalkBack l'annoncent), Tab reste dans la fenêtre,
 * focus rendu à l'élément précédent à la fermeture.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { BIOMETRIC_SHARED_DEVICE_NOTE } from '@/lib/native/biometric-consent';
import { nativePlatform } from '@/lib/native/bridge';
import {
  BIOMETRIC_OFFER_SETTINGS_NOTE, biometricOfferKind, biometricOfferTexts,
} from '@/lib/native/biometric-offer-presentation';
import { BiometricGlyph } from './BiometricGlyph';

interface Props {
  /** `BiometryType` à présenter (null = générique, jamais Face ID par défaut). */
  type: number | null;
  busy: boolean;
  onActivate: () => void;
  onLater: () => void;
  /** Plateforme (tests de rendu) ; par défaut celle de l'application native. */
  platform?: 'ios' | 'android' | null;
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function BiometricOfferCard({ type, busy, onActivate, onLater, platform }: Props) {
  const kind = biometricOfferKind(platform === undefined ? nativePlatform() : platform, type);
  const t = biometricOfferTexts(kind);
  const dialog = useRef<HTMLDivElement | null>(null);
  const title = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Un champ encore actif (clavier ouvert après la connexion) est quitté : le
    // clavier se referme et ne masque pas la fenêtre.
    previous?.blur();
    title.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  const keepFocusInside = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !dialog.current) return;
    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === title.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div
      data-testid="biometric-offer-backdrop"
      className="fixed inset-0 z-[998] flex items-center justify-center bg-[color:var(--veil)]"
      style={{
        paddingTop: 'calc(var(--vb-safe-top) + 16px)',
        paddingRight: 'calc(var(--vb-safe-right) + 16px)',
        paddingBottom: 'calc(var(--vb-safe-bottom) + 16px)',
        paddingLeft: 'calc(var(--vb-safe-left) + 16px)',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vb-bio-offer-title"
        aria-describedby="vb-bio-offer-desc"
        aria-busy={busy || undefined}
        data-testid="biometric-offer"
        data-kind={kind}
        onKeyDown={keepFocusInside}
        className="flex max-h-full w-full max-w-[22rem] flex-col overflow-y-auto overscroll-contain rounded-3xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-[16px] py-[24px] text-center [overflow-wrap:anywhere] text-[color:var(--text-primary)] shadow-xl min-[380px]:px-[24px]"
      >
        <div className="mx-auto mb-4 flex size-[56px] shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
          <BiometricGlyph kind={kind} className="size-[32px]" />
        </div>
        <h2
          id="vb-bio-offer-title"
          ref={title}
          tabIndex={-1}
          className="text-lg font-semibold leading-snug outline-none [overflow-wrap:anywhere]"
        >
          {t.title}
        </h2>
        <div id="vb-bio-offer-desc" className="mt-2 space-y-2">
          <p className="text-[0.9375rem] leading-normal">{t.description}</p>
          <p className="text-xs leading-normal text-[color:var(--text-muted)]">
            {BIOMETRIC_SHARED_DEVICE_NOTE} {BIOMETRIC_OFFER_SETTINGS_NOTE}
          </p>
        </div>
        <div className="mt-5 flex flex-col gap-2">
          <Button
            size="lg"
            className="h-auto min-h-12 w-full whitespace-normal px-[12px] py-3 leading-snug"
            onClick={onActivate}
            disabled={busy}
          >
            {t.activate}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className="h-auto min-h-12 w-full whitespace-normal px-[12px] py-3 leading-snug"
            onClick={onLater}
            disabled={busy}
          >
            {t.later}
          </Button>
        </div>
      </div>
    </div>
  );
}
