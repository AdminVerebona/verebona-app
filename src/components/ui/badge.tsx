import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

/**
 * Pastille — charte « Sérénité » 2026 §5 (lot 66).
 *
 * Rayon 999, 12 px, 600, libellé TOUJOURS écrit (jamais une couleur seule).
 *   - neutre (défaut, `secondary`, `active`, `premium`) : brume + pétrole ;
 *   - attention (`pending`) : cuivre-soft + cuivre texte ;
 *   - retard strict / erreur (`destructive`, `inactive`) : rouge accessible ;
 *   - `recommended` : uniquement « Recommandé » (12 px gras minimum) —
 *     blanc sur cuivre TEXTE #AA4E38 en clair (5,45:1 ; jamais sur le cuivre
 *     doux, 3,45:1), encre #1B2529 sur cuivre sombre #E2896F en sombre
 *     (5,99:1) : jetons --badge-recommended / --on-badge-recommended (lot 67) ;
 *   - `outline`, `sold` : contour, texte secondaire.
 * Les noms de variantes historiques sont conservés (appelants inchangés).
 */
const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-[9px] py-[3px] text-xs leading-[1.4] font-semibold w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none aria-invalid:border-destructive transition-[color,background-color] duration-[180ms] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[color:var(--accent-soft)] text-[color:var(--accent)]",
        neutral:
          "border-transparent bg-[color:var(--accent-soft)] text-[color:var(--accent)]",
        secondary:
          "border-transparent bg-[color:var(--accent-soft)] text-[color:var(--accent)]",
        attention:
          "border-[color:var(--attention-edge)] bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)]",
        destructive:
          "border-[color:var(--danger-edge)] bg-[color:var(--danger-soft)] text-[color:var(--danger)]",
        outline:
          "border-[color:var(--border)] bg-transparent text-[color:var(--text-muted)]",
        recommended:
          "border-transparent bg-[color:var(--badge-recommended)] text-[color:var(--on-badge-recommended)] font-bold",
        // Historiques — mêmes rôles, couleurs de la charte (le pétrole confirme).
        success:
          "border-transparent bg-[color:var(--accent-soft)] text-[color:var(--accent)] px-3 py-1",
        active:
          "border-transparent bg-[color:var(--accent-soft)] text-[color:var(--accent)] px-3 py-1",
        sold:
          "border-[color:var(--border)] bg-transparent text-[color:var(--text-muted)] px-3 py-1 font-medium",
        premium:
          "border-[color:var(--bubble-edge)] bg-[color:var(--accent-soft)] text-[color:var(--accent)] px-3 py-1 font-medium",
        inactive:
          "border-[color:var(--danger-edge)] bg-[color:var(--danger-soft)] text-[color:var(--danger)] px-3 py-1 font-medium",
        pending:
          "border-[color:var(--attention-edge)] bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)] px-3 py-1 font-medium",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
