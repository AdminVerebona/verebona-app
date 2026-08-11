'use client';
/**
 * Drawer principal de l'assistant — CDC §7, refonte « Accueil Assistant ».
 *
 * Réutilise `@/components/ui/drawer` (vaul). Latéral en desktop, plein écran en
 * mobile. Accessible : focus piégé (géré par vaul), fermeture Échap, région live.
 *
 * Refonte :
 * - Le déclencheur est la mascotte 3D + pilule « Demander à Verebona » (plus de
 *   rond bleu). Il s'estompe pendant le scroll et disparaît drawer ouvert.
 * - Écoute l'événement global `verebona:open` (détail optionnel `{ question }`)
 *   émis par MascotGreeting, le centre d'aide, etc. — ouvre le drawer et envoie
 *   la question directement.
 */
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import {
  Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger, DrawerClose,
} from '@/components/ui/drawer';
import { useVerebona } from '@/lib/verebona/useVerebona';
import { VerebonaConversation } from './VerebonaConversation';
import { VerebonaComposer } from './VerebonaComposer';
import { VerebonaSuggestions } from './VerebonaSuggestions';
import { VerebonaMascot } from './VerebonaMascot';

export interface VerebonaDrawerProps {
  pageContext?: Record<string, string>;
  suggestions?: Array<{ id: string; label: string }>;
}

export function VerebonaDrawer({ pageContext, suggestions = [] }: VerebonaDrawerProps) {
  const [open, setOpen] = useState(false);
  const [dimmed, setDimmed] = useState(false);
  const dimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const v = useVerebona(pageContext);

  // Ouverture programmée (bulle d'accueil, centre d'aide…), avec question optionnelle.
  useEffect(() => {
    const handler = (e: Event) => {
      const q = (e as CustomEvent<{ question?: string }>).detail?.question;
      setOpen(true);
      if (q) v.send(q);
    };
    window.addEventListener('verebona:open', handler);
    return () => window.removeEventListener('verebona:open', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.send]);

  // Fondu du déclencheur pendant le scroll du contenu principal.
  useEffect(() => {
    const el = document.getElementById('main-scroll-container') ?? window;
    const onScroll = () => {
      setDimmed(true);
      if (dimTimer.current) clearTimeout(dimTimer.current);
      dimTimer.current = setTimeout(() => setDimmed(false), 450);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (dimTimer.current) clearTimeout(dimTimer.current);
    };
  }, []);

  return (
    <Drawer open={open} onOpenChange={setOpen} direction="right">
      {!open && (
        <DrawerTrigger asChild>
          <button
            type="button"
            aria-label="Demander à Verebona"
            className={`fixed bottom-5 right-6 z-40 flex items-center gap-2.5 transition-all duration-300 hover:-translate-y-0.5 ${dimmed ? 'opacity-25' : 'opacity-100'}`}
          >
            <span className="px-3.5 py-2 rounded-full bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] shadow-relief-lg text-[12.5px] font-semibold text-[color:var(--text-primary)]">
              Demander à Verebona
            </span>
            <Image
              src="/mascot/dialogue-bubble.webp"
              alt=""
              width={64}
              height={64}
              className="select-none animate-[vb-float_6s_ease-in-out_infinite] [filter:drop-shadow(0_14px_24px_rgba(4,10,26,.6))]"
            />
          </button>
        </DrawerTrigger>
      )}

      <DrawerContent className="ml-auto flex h-full w-full max-w-md flex-col sm:w-[28rem]">
        <DrawerHeader className="flex items-center justify-between border-b">
          <DrawerTitle className="flex items-center gap-2">
            <VerebonaMascot pose="idle" size={24} />
            Demander à Verebona
          </DrawerTitle>
          <DrawerClose aria-label="Fermer l'assistant" className="rounded p-1 hover:bg-muted">✕</DrawerClose>
        </DrawerHeader>

        <div className="flex-1 overflow-hidden" aria-live="polite">
          {v.messages.length === 0 ? (
            <VerebonaSuggestions suggestions={suggestions} onPick={(label) => v.send(label)} />
          ) : (
            <VerebonaConversation
              messages={v.messages}
              isLoading={v.isLoading}
              onFeedback={v.sendFeedback}
              onClarify={(label) => v.send(label)}
            />
          )}
        </div>

        <VerebonaComposer
          isLoading={v.isLoading}
          onSend={v.send}
          onCancel={v.cancel}
        />
      </DrawerContent>
    </Drawer>
  );
}
