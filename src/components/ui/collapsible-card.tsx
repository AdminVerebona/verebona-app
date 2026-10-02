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
  defaultOpen = false,
  className,
  titleClassName,
  contentClassName,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = React.useState(defaultOpen)
  const ref = React.useRef<HTMLDivElement | null>(null)

  // Arrivée par un lien profond : le tiroir visé s'ouvre et vient à l'écran.
  React.useEffect(() => {
    if (!anchorId || typeof window === "undefined") return
    const viser = () => {
      if (window.location.hash !== `#${anchorId}`) return
      setOpen(true)
      setTimeout(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100)
    }
    viser()
    window.addEventListener("hashchange", viser)
    return () => window.removeEventListener("hashchange", viser)
  }, [anchorId])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card ref={ref} id={anchorId} className={cn("gap-0", anchorId && "scroll-mt-24", className)}>
        <div className="px-6">
          <CollapsibleTrigger
            className="group flex w-full items-start gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className={cn("flex items-center gap-2 font-semibold leading-none", titleClassName)}>
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
