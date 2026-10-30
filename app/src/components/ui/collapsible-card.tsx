"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "../../lib/utils"
import { Card, CardContent } from "./card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible"

interface CollapsibleCardProps {
  /** Icône affichée devant le titre. */
  icon?: React.ReactNode
  title: React.ReactNode
  /** Une seule ligne (tronquée au-delà) : le tiroir fermé reste compact. */
  description?: React.ReactNode
  /**
   * Contenu toujours visible sous l'en-tête, même tiroir fermé. RÉSERVÉ aux
   * obligations légales (lien de rétractation, cf. WithdrawalCard) : le modèle
   * des tiroirs de Mon compte est « titre, une ligne, chevron » — aucun autre
   * bouton. Placé hors du déclencheur : un lien n'est pas imbriqué dans un bouton.
   */
  headerExtra?: React.ReactNode
  /**
   * Ancre de la carte. Un lien `…#<anchorId>` (notification, autre page)
   * ouvre le tiroir et le fait défiler à l'écran.
   */
  anchorId?: string
  /**
   * Ancres de sous-blocs (lot 101C, ex. `appareils-connectes`) : un lien
   * `…#<id>` ouvre aussi la carte ; le sous-bloc s'ouvre et défile lui-même.
   */
  innerAnchorIds?: readonly string[]
  /** Fermé par défaut. */
  defaultOpen?: boolean
  className?: string
  /** Classes du titre (ex. couleur d'une zone dangereuse). */
  titleClassName?: string
  contentClassName?: string
  children: React.ReactNode
}

/**
 * Carte « tiroir » : l'en-tête (titre, description, chevron) ouvre et ferme
 * le contenu. Accessible au clavier (bouton Radix, `aria-expanded`), et le
 * contenu fermé n'est pas rendu dans le flux (Radix Collapsible).
 */
export function CollapsibleCard({
  icon,
  title,
  description,
  headerExtra,
  anchorId,
  innerAnchorIds,
  defaultOpen = false,
  className,
  titleClassName,
  contentClassName,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = React.useState(defaultOpen)
  const ref = React.useRef<HTMLDivElement | null>(null)

  const inner = (innerAnchorIds ?? []).join(" ")

  // Arrivée par un lien profond : le tiroir visé s'ouvre et vient à l'écran.
  React.useEffect(() => {
    if (!anchorId || typeof window === "undefined") return
    const viser = () => {
      // Ancre d'un sous-bloc : la carte s'ouvre, le sous-bloc défile lui-même.
      if (inner && inner.split(" ").includes(window.location.hash.slice(1))) { setOpen(true); return }
      if (window.location.hash !== `#${anchorId}`) return
      setOpen(true)
      setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100)
    }
    viser()
    window.addEventListener("hashchange", viser)
    return () => window.removeEventListener("hashchange", viser)
  }, [anchorId, inner])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card ref={ref} id={anchorId} className={cn("gap-0", anchorId && "scroll-mt-24", className)}>
        <div className="px-6">
          <CollapsibleTrigger
            className="group flex w-full items-start gap-3 rounded-[10px] text-left outline-none"
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className={cn("flex items-center gap-2 text-[17px] font-bold leading-tight tracking-[-.01em]", titleClassName)}>
                {icon}
                {title}
              </div>
              {description && (
                <div className="truncate text-sm text-muted-foreground">{description}</div>
              )}
            </div>
            <ChevronDown
              aria-hidden
              className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>
          {headerExtra && <div className="mt-3">{headerExtra}</div>}
        </div>
        <CollapsibleContent>
          <CardContent className={cn("pt-6", contentClassName)}>{children}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
