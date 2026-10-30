"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "../../lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible"

interface CollapsibleSubBlockProps {
  icon?: React.ReactNode
  title: string
  /** Résumé court à droite du titre (ex. « 2 appareils · dont celui-ci »). */
  summary?: React.ReactNode
  /**
   * Ancre du sous-bloc. Un lien `…#<anchorId>` (e-mail, autre page) l'ouvre
   * et le fait défiler à l'écran — la carte parente doit aussi s'ouvrir sur
   * cette ancre (`CollapsibleCard innerAnchorIds`).
   */
  anchorId?: string
  /** Prévenu à chaque ouverture / fermeture (ex. rafraîchir une liste). */
  onOpenChange?: (open: boolean) => void
  className?: string
  contentClassName?: string
  children: React.ReactNode
}

/**
 * Sous-bloc repliable d'une carte « tiroir » (lot 101C) : même mécanique que
 * `CollapsibleCard` (Radix Collapsible : bouton `aria-expanded`, clavier,
 * contenu fermé non rendu, ouverture par ancre). La zone de contenu reste
 * dans la page (vide et `hidden` une fois fermée) pour que `aria-controls`
 * désigne toujours un élément existant, ouvert ou fermé.
 * FERMÉ par défaut et jamais mémorisé : fermé à chaque visite.
 * En-tête : icône, titre, résumé court, chevron ; zone tactile ≥ 44 px.
 */
export function CollapsibleSubBlock({
  icon,
  title,
  summary,
  anchorId,
  onOpenChange,
  className,
  contentClassName,
  children,
}: CollapsibleSubBlockProps) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLElement | null>(null)
  const contentId = `${React.useId()}-contenu`
  const notify = React.useRef(onOpenChange)
  notify.current = onOpenChange

  const change = React.useCallback((v: boolean) => {
    setOpen(v)
    notify.current?.(v)
  }, [])

  // Arrivée par un lien profond : le sous-bloc visé s'ouvre et vient à l'écran.
  React.useEffect(() => {
    if (!anchorId || typeof window === "undefined") return
    const viser = () => {
      if (window.location.hash !== `#${anchorId}`) return
      change(true)
      setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150)
    }
    viser()
    window.addEventListener("hashchange", viser)
    return () => window.removeEventListener("hashchange", viser)
  }, [anchorId, change])

  return (
    <Collapsible open={open} onOpenChange={change}>
      <section
        ref={ref}
        id={anchorId}
        data-state={open ? "open" : "closed"}
        className={cn(
          "rounded-lg border border-[color:var(--border-subtle)] px-3 py-1 sm:px-4",
          anchorId && "scroll-mt-24",
          className,
        )}
      >
        <h3 className="text-sm font-semibold">
          <CollapsibleTrigger
            aria-controls={contentId}
            className="group -mx-1 flex min-h-11 w-[calc(100%+0.5rem)] items-center gap-2 rounded-[10px] px-1 py-2 text-left outline-none"
          >
            {icon}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
              <span>{title}</span>
              {summary != null && summary !== "" && (
                <span className="truncate text-xs font-normal text-[color:var(--text-muted)]" data-slot="sub-block-summary">
                  {summary}
                </span>
              )}
            </span>
            <ChevronDown
              aria-hidden
              className="h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>
        </h3>
        {/* `forceMount` garde la zone (cible d'aria-controls) ; fermée : vide et `hidden`. */}
        <CollapsibleContent forceMount id={contentId} hidden={!open} className={cn("pb-2", contentClassName)}>
          {open ? children : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}
