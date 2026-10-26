"use client"

import * as React from "react"
import * as SheetPrimitive from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"

import { cn } from "../../lib/utils"
import { useSheetHistory } from "./sheet-history"

/**
 * Tiroir (Radix Dialog). Lot 81F : sur appareil tactile / application
 * native, le bouton « retour » ferme le tiroir comme Échap (sheet-history.ts).
 */
function Sheet({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : uncontrolledOpen
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!controlled) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange]
  )
  useSheetHistory(open)
  return <SheetPrimitive.Root data-slot="sheet" open={open} onOpenChange={handleOpenChange} {...props} />
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-[color:var(--veil)]",
        className
      )}
      {...props}
    />
  )
}

/**
 * Lot 81F — zones sûres, une seule fois pour TOUS les tiroirs.
 * L'application s'étend sous la barre d'état et la barre d'accueil
 * (`viewport-fit=cover`, `black-translucent`, WebView Capacitor en
 * recouvrement) : sans réserve, le X et le titre passaient sous l'heure et
 * la batterie, et iOS y capte les touchers (X inutilisable). Les encarts
 * (`--vb-safe-*`, globals.css) valent 0 hors mobile : aucun changement
 * desktop. Posés APRÈS la classe de l'appelant : un `p-0` local ne peut pas
 * les retirer.
 */
const SHEET_SAFE_AREA: Record<"top" | "right" | "bottom" | "left", string> = {
  right: "pt-[var(--vb-safe-top)] pb-[var(--vb-safe-bottom)] pr-[var(--vb-safe-right)]",
  left: "pt-[var(--vb-safe-top)] pb-[var(--vb-safe-bottom)] pl-[var(--vb-safe-left)]",
  top: "pt-[var(--vb-safe-top)] pl-[var(--vb-safe-left)] pr-[var(--vb-safe-right)]",
  bottom: "pb-[var(--vb-safe-bottom)] pl-[var(--vb-safe-left)] pr-[var(--vb-safe-right)]",
}

/**
 * Bouton de fermeture : 44 × 44 (cible tactile), même centre qu'avant
 * (8 px + 22 px = 30 px du coin), au-dessus de tout le contenu du tiroir.
 * Tiroir à droite (tous les tiroirs de l'application) : position FIXE, il
 * reste visible même quand le panneau défile lui-même (agenda) ; pendant
 * l'animation, le panneau transformé devient son repère, au même endroit.
 */
const SHEET_CLOSE_POSITION: Record<"top" | "right" | "bottom" | "left", string> = {
  right: "fixed top-[calc(var(--vb-safe-top)+0.5rem)] right-[calc(var(--vb-safe-right)+0.5rem)]",
  left: "absolute top-[calc(var(--vb-safe-top)+0.5rem)] right-2",
  top: "absolute top-[calc(var(--vb-safe-top)+0.5rem)] right-[calc(var(--vb-safe-right)+0.5rem)]",
  bottom: "absolute top-2 right-[calc(var(--vb-safe-right)+0.5rem)]",
}

function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-[var(--vb-shadow-card)] transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
          side === "right" &&
            "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
          side === "left" &&
            "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
          side === "top" &&
            "data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b",
          side === "bottom" &&
            "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto border-t",
          className,
          SHEET_SAFE_AREA[side],
          // Marge droite réservée au X dans le premier bloc (en-tête) : le
          // titre long ne passe plus dessous (8 px + 44 px).
          side !== "bottom" && "[&>:first-child]:pr-13"
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close
          data-slot="sheet-close"
          aria-label="Fermer"
          className={cn(
            SHEET_CLOSE_POSITION[side],
            "z-50 flex size-11 items-center justify-center rounded-[10px] text-[color:var(--text-muted)] transition-colors duration-[180ms] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--text-primary)] disabled:pointer-events-none"
          )}
        >
          <XIcon className="size-4" aria-hidden />
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-foreground text-[17px] font-bold tracking-[-.01em]", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
}
