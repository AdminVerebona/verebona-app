'use client';

/**
 * Fenêtre CENTRÉE des invitations de première connexion mobile — présentation
 * du lot 111G (proposition biométrique), mise en commun au lot 111T pour que
 * l'invitation aux notifications ait exactement la même forme.
 *
 * Fond légèrement assombri, fenêtre dans la zone visible hors encarts système
 * (Safe Areas), largeur bornée, contenu défilant si le texte est très agrandi
 * ou l'écran couché, boutons pleine largeur qui passent à la ligne.
 * Hiérarchie : symbole, titre, courte explication, action principale,
 * « Plus tard ».
 *
 * Aucune fermeture automatique ni par toucher du fond / Échap : le choix reste
 * explicite. Accessibilité : `dialog` modal titré et décrit, focus initial sur
 * le titre (VoiceOver / TalkBack l'annoncent), un champ encore actif est
 * quitté (le clavier se referme), Tab reste dans la fenêtre, focus rendu à
 * l'élément précédent à la fermeture.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  /** `data-testid` de la fenêtre (le fond reçoit `<testId>-backdrop`). */
  testId: string;
  /** Préfixe des identifiants `<idPrefix>-title` / `<idPrefix>-desc`. */
  idPrefix: string;
  /** Attribut `data-kind` facultatif (nature de l'invitation). */
  kind?: string;
  icon: ReactNode;
  title: string;
  description: ReactNode;
  primaryLabel: string;
  laterLabel: string;
  busy: boolean;
  onPrimary: () => void;
  onLater: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function NativeOfferDialog({
  testId, idPrefix, kind, icon, title: titleText, description, primaryLabel, laterLabel, busy, onPrimary, onLater,
}: Props) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const title = useRef<HTMLHeadingElement | null>(null);
  const titleId = `${idPrefix}-title`;
  const descId = `${idPrefix}-desc`;

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
      data-testid={`${testId}-backdrop`}
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
        aria-labelledby={titleId}
        aria-describedby={descId}
        aria-busy={busy || undefined}
        data-testid={testId}
        data-kind={kind}
        onKeyDown={keepFocusInside}
        className="flex max-h-full w-full max-w-[22rem] flex-col overflow-y-auto overscroll-contain rounded-3xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-[16px] py-[24px] text-center [overflow-wrap:anywhere] text-[color:var(--text-primary)] shadow-xl min-[380px]:px-[24px]"
      >
        <div className="mx-auto mb-4 flex size-[56px] shrink-0 items-center justify-center rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
          {icon}
        </div>
        <h2
          id={titleId}
          ref={title}
          tabIndex={-1}
          className="text-lg font-semibold leading-snug outline-none [overflow-wrap:anywhere]"
        >
          {titleText}
        </h2>
        <div id={descId} className="mt-2 space-y-2">
          {description}
        </div>
        <div className="mt-5 flex flex-col gap-2">
          <Button
            size="lg"
            className="h-auto min-h-12 w-full whitespace-normal px-[12px] py-3 leading-snug"
            onClick={onPrimary}
            disabled={busy}
          >
            {primaryLabel}
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className="h-auto min-h-12 w-full whitespace-normal px-[12px] py-3 leading-snug"
            onClick={onLater}
            disabled={busy}
          >
            {laterLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
