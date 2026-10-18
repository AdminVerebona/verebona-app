import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

/**
 * Bouton — charte « Sérénité » 2026 §5 (lot 66).
 *
 * Rayon 12 px, bordure 1 px, aucune ombre ni déplacement (pas de translation
 * au survol, pas de réduction d'échelle à la pression). Primaire : fond
 * pétrole, texte blanc 700, survol #10383E (pétrole clair / encre en thème
 * sombre). Secondaire : fond carte, contour pétrole, texte pétrole 600.
 * Transitions 180 ms sur le fond et la couleur seulement. Focus : anneau
 * 3 px cuivre texte décalé (règle globale, globals.css).
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[12px] text-sm font-semibold border border-transparent transition-[background-color,color,border-color] duration-[180ms] ease-[cubic-bezier(.2,.7,.2,1)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // Primaire : pétrole plein — Ajouter / Créer / Enregistrer
        default:
          "bg-[color:var(--accent)] text-[color:var(--on-accent)] font-bold hover:bg-[color:var(--accent-hover)]",
        // Secondaire : fond carte, contour pétrole — Annuler / Se connecter / Voir comment
        outline:
          "border-[color:var(--accent)] bg-[color:var(--bg-card)] text-[color:var(--accent)] hover:bg-[color:var(--accent-soft)]",
        secondary:
          "border-[color:var(--border)] bg-[color:var(--bg-card)] text-[color:var(--text-primary)] hover:border-[color:var(--accent)] hover:text-[color:var(--accent)]",
        // Destructif : texte rouge accessible, libellé écrit — Supprimer
        destructive:
          "bg-transparent text-[color:var(--danger)] hover:bg-[color:var(--danger-soft)]",
        ghost:
          "bg-transparent text-[color:var(--text-primary)] hover:bg-[color:var(--accent-soft)] hover:text-[color:var(--accent)]",
        link: "border-0 text-[color:var(--accent)] underline-offset-4 hover:underline hover:text-[color:var(--accent-hover)]",
      },
      size: {
        default: "h-9 px-5 py-2 has-[>svg]:px-4",
        sm: "h-8 gap-1.5 px-4 has-[>svg]:px-3",
        lg: "h-12 px-[26px] text-base has-[>svg]:px-5",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
