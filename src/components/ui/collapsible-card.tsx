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
  description?: React.ReactNode
  /**
   * Contenu toujours visible sous l'en-tête, même tiroir fermé — pour ce qui
   * ne doit jamais être masqué (ex. lien de rétractation, cf. WithdrawalCard).
   * Placé hors du déclencheur : un lien n'est pas imbriqué dans un bouton.
   */
  headerExtra?: React.ReactNode
  /** Fermé par défaut. */
  defaultOpen?: boolean
  className?: string
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
  defaultOpen = false,
  className,
  contentClassName,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = React.useState(defaultOpen)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className={cn("gap-0", className)}>
        <div className="px-6">
          <CollapsibleTrigger
            className="group flex w-full items-start gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2 font-semibold leading-none">
                {icon}
                {title}
              </div>
              {description && (
                <div className="text-sm text-muted-foreground">{description}</div>
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
