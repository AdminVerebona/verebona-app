"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { maxScrollTop, scrollAllToTop, SCROLL_TOP_THRESHOLD } from "@/lib/shell/scroll-to-top";

/**
 * Flèche « Retour en haut ».
 *
 * Lot 34 (point 8) — le clic ne faisait rien sur mobile :
 *   · le bandeau fixe de la barre basse (z-50, dégradé + « + ») recouvrait
 *     le bouton (z-40) : il laisse désormais passer les touchers et la
 *     flèche est posée AU-DESSUS de la barre, plus haut dans la pile ;
 *   · le défilement se fait dans `#main-scroll-container` (pas `window`) :
 *     on remonte chaque élément réellement défilé (`scrollAllToTop`).
 */
export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const check = () => setVisible(maxScrollTop(document, window.scrollY) > SCROLL_TOP_THRESHOLD);
    // Capture : reçoit aussi le défilement des conteneurs (il ne remonte pas à window).
    window.addEventListener("scroll", check, { passive: true, capture: true });
    check();
    return () => window.removeEventListener("scroll", check, { capture: true });
  }, []);

  const scrollToTop = () => {
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollAllToTop(document, window, !reduce);
  };

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={scrollToTop}
          aria-label="Retour en haut"
          data-scroll-to-top
          className={[
            // Au-dessus du bandeau de la barre basse (z-50) : jamais recouvert.
            "fixed z-[60] touch-manipulation",
            // mobile : au-dessus de la barre basse (marge sûre + hauteur de la barre)
            "right-4 bottom-[calc(max(20px,env(safe-area-inset-bottom))+96px)]",
            "md:right-6 md:bottom-6",      // desktop: coin bas-droit
            "w-10 h-10 rounded-full p-0",
            "bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)]",
            "shadow-relief-md hover:shadow-relief-lg",
            "flex items-center justify-center",
            "text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]",
            "hover:-translate-y-px",
            "transition-all duration-200",
            visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
          ].join(" ")}
        >
          <ArrowUp className="w-5 h-5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="left"
        sideOffset={8}
        className="bg-[color:var(--bg-card)]/90 text-[color:var(--text-muted)] border border-[color:var(--border-subtle)] shadow-sm text-[11px] px-2 py-1 rounded-md [&>[data-radix-popper-arrow]]:hidden"
      >
        Retour en haut
      </TooltipContent>
    </Tooltip>
  );
}
