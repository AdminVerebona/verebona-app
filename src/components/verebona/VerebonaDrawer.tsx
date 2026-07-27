'use client';
/**
 * Drawer principal de l'assistant — CDC §7.
 *
 * Réutilise `@/components/ui/drawer` (vaul) déjà présent dans le repo. Latéral en
 * desktop, plein écran en mobile. Accessible : focus piégé (géré par vaul), fermeture
 * Échap, région live pour les réponses (§33).
 */
import { useState } from 'react';
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
  const v = useVerebona(pageContext);

  return (
    <Drawer open={open} onOpenChange={setOpen} direction="right">
      <DrawerTrigger asChild>
        <button
          type="button"
          aria-label="Ouvrir l'assistant Verebona"
          className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:scale-105"
        >
          <VerebonaMascot pose="idle" size={32} />
        </button>
      </DrawerTrigger>

      <DrawerContent className="ml-auto flex h-full w-full max-w-md flex-col sm:w-[28rem]">
        <DrawerHeader className="flex items-center justify-between border-b">
          <DrawerTitle className="flex items-center gap-2">
            <VerebonaMascot pose="idle" size={24} />
            Verebona
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
