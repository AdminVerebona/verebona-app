import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        // Primaire : bleu plein, ressort — Ajouter / Créer / Enregistrer
        default:
          "bg-primary text-white border border-primary shadow-relief-md hover:bg-primary/90 hover:shadow-relief-lg hover:-translate-y-px",
          // Secondaire : transparent avec bordure — Annuler / Se connecter / Voir comment
            outline:
              "border border-[color:var(--border-subtle)] bg-transparent text-[color:var(--text-primary)] shadow-relief-sm hover:bg-black/5 hover:shadow-relief-md hover:-translate-y-px [.theme-beige_&]:border-gray-300 [.theme-beige_&]:text-[#3d3228] [.theme-beige_&]:hover:bg-black/5 [.public-page_&]:border-white/20 [.public-page_&]:text-white/80 [.public-page_&]:hover:bg-white/5",
            secondary:
              "border border-[color:var(--border-subtle)] bg-transparent text-[color:var(--text-primary)] shadow-relief-sm hover:bg-black/5 hover:shadow-relief-md hover:-translate-y-px [.theme-beige_&]:border-gray-300 [.theme-beige_&]:text-[#3d3228] [.theme-beige_&]:hover:bg-black/5 [.public-page_&]:border-white/20 [.public-page_&]:text-white/80 [.public-page_&]:hover:bg-white/5",
        // Destructif : outline rouge discret — Supprimer
        destructive:
          "bg-transparent text-destructive hover:bg-destructive/10 focus-visible:ring-destructive/30",
        ghost:
          "hover:bg-accent/10 text-[color:var(--text-primary)] dark:text-white dark:hover:bg-white/10",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-5 py-2 has-[>svg]:px-4",
        sm: "h-8 gap-1.5 px-4 has-[>svg]:px-3",
        lg: "h-10 px-6 has-[>svg]:px-5",
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
