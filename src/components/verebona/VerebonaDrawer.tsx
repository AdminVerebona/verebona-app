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
import { VerebonaThreads } from './VerebonaThreads';
import { useWriteGuard } from '@/contexts/WriteGuardContext';

export interface VerebonaDrawerProps {
  pageContext?: Record<string, string>;
  suggestions?: Array<{ id: string; label: string }>;
}

export function VerebonaDrawer({ pageContext, suggestions = [] }: VerebonaDrawerProps) {
  const [open, setOpen] = useState(false);
  const { garder, signalerRefus } = useWriteGuard();

  const [dimmed, setDimmed] = useState(false);
  const dimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const v = useVerebona(pageContext, {
    // Refus serveur malgré la garde (droits pas encore connus du client) :
    // on ferme le tiroir pour laisser la fenêtre de fin d'essai lisible.
    onWriteBlocked: (info) => {
      setOpen(false);
      signalerRefus(info);
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // TOUTE QUESTION PASSE PAR LA GARDE
  //
  // Seul le bouton flottant était gardé. Les autres entrées — barre de
  // recherche, suggestions de l'accueil, centre d'aide, bouton « Envoyer »,
  // choix de clarification — envoyaient la question sans contrôle.
  //
  // `envoyer` rend `false` quand la question est refusée : le champ de
  // saisie garde alors son texte, qui n'est pas perdu.
  // ══════════════════════════════════════════════════════════════════════
  const envoyer = (texte: string): false | Promise<boolean> => {
    let autorise = false;
    garder(() => { autorise = true; });
    if (!autorise) {
      setOpen(false);
      return false;
    }
    // Promesse : le champ restaure le texte si la question n'aboutit pas (§7.6).
    return v.send(texte);
  };

  // Fermer le tiroir pendant un traitement ANNULE la demande côté serveur
  // (§7.8) : sa réponse ne sera ni affichée ni enregistrée.
  const changerOuverture = (ouvert: boolean) => {
    if (!ouvert && v.isLoading) v.cancel();
    setOpen(ouvert);
  };

  // Ouverture programmée (bulle d'accueil, centre d'aide…), avec question optionnelle.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ question?: string; context?: { intent?: string; assetId?: number } }>).detail;
      let autorise = false;
      garder(() => { autorise = true; });
      if (!autorise) return;
      setOpen(true);
      // La barre de recherche n'ouvre le tiroir qu'à « Entrée », avec une
      // question complète : elle part donc directement au modèle.
      //
      // Un mécanisme de pré-remplissage existait ici — retiré avec l'ouverture
      // à la frappe qui le justifiait.
      // Question rapide de la mascotte : la question part telle quelle, avec
      // son contexte structuré (CDC Mascotte SEC-005).
      if (detail?.question) {
        const ctx: Record<string, string> = {};
        if (detail.context?.intent) ctx.intent = detail.context.intent;
        if (detail.context?.assetId) ctx.assetId = String(detail.context.assetId);
        v.send(detail.question, Object.keys(ctx).length ? ctx : undefined);
      }
    };
    window.addEventListener('verebona:open', handler);
    return () => window.removeEventListener('verebona:open', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.send, garder]);

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
    <Drawer open={open} onOpenChange={changerOuverture} direction="right">
      {/* Garde à l'OUVERTURE, non à l'envoi : ouvrir l'assistant pour refuser
          la question une fois rédigée ferait perdre la saisie. Même principe
          que les tiroirs d'édition. */}
      {!open && (
        <DrawerTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              let autorise = false;
              garder(() => { autorise = true; });
              if (!autorise) e.preventDefault();
            }}
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
              className="select-none animate-[vb-float_6s_ease-in-out_infinite] motion-reduce:animate-none [filter:drop-shadow(0_14px_24px_rgba(4,10,26,.6))]"
            />
          </button>
        </DrawerTrigger>
      )}

      <DrawerContent className="ml-auto flex h-full w-full max-w-md flex-col sm:w-[28rem]">
        <DrawerHeader className="flex items-center justify-between border-b">
          <DrawerTitle className="flex items-center gap-2">
            {/* §7.4 : le tiroir s'intitule « Verebona » ; « Demander à
                Verebona » reste le libellé du point d'entrée (§7.1). */}
            <VerebonaMascot pose={v.isLoading ? 'thinking' : 'idle'} size={24} />
            Verebona
          </DrawerTitle>
          <DrawerClose aria-label="Fermer l'assistant" className="rounded p-1 hover:bg-muted">✕</DrawerClose>
        </DrawerHeader>

        <VerebonaThreads
          threads={v.threads}
          currentId={v.conversationId}
          disabled={v.isLoading}
          onSelect={(id) => { void v.selectConversation(id); }}
          onNew={() => { void v.newConversation(); }}
          onClear={() => { void v.clear(); }}
        />

        <div className="flex-1 overflow-hidden" aria-live="polite">
          {v.messages.length === 0 ? (
            <VerebonaSuggestions suggestions={suggestions} onPick={(label) => { void envoyer(label); }} />
          ) : (
            <VerebonaConversation
              messages={v.messages}
              isLoading={v.isLoading}
              onFeedback={v.sendFeedback}
              onClarify={(clarificationId, choice) => {
                // Même garde que l'envoi d'une question.
                let autorise = false;
                garder(() => { autorise = true; });
                if (!autorise) { setOpen(false); return; }
                void v.answerClarification(clarificationId, choice);
              }}
              onConfirmPlan={(planId) => {
                // Une confirmation EST une écriture : même garde que l'UI.
                let autorise = false;
                garder(() => { autorise = true; });
                if (!autorise) { setOpen(false); return; }
                void v.confirmPlan(planId);
              }}
              onCancelPlan={(planId) => { void v.cancelPlan(planId); }}
              onRetry={(fromMessageId) => {
                // « Réessayer » renvoie une question : même garde que l'envoi.
                let autorise = false;
                garder(() => { autorise = true; });
                if (!autorise) { setOpen(false); return; }
                void v.retry(fromMessageId);
              }}
            />
          )}
        </div>

        <VerebonaComposer
          isLoading={v.isLoading}
          onSend={envoyer}
          onCancel={v.cancel}
        />
      </DrawerContent>
    </Drawer>
  );
}
