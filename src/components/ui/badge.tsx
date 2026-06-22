import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        success:
          "border-transparent bg-emerald-500 text-white [a&]:hover:bg-emerald-600 rounded-full px-3 py-1 font-semibold shadow-sm",
          active:
            "border-transparent bg-gradient-to-br from-[#10b981] to-[#14b8a6] text-white rounded-full px-3 py-1 font-semibold shadow-[0_2px_8px_rgba(16,185,129,0.3)]",
          sold:
            "bg-[rgba(148,163,184,0.15)] text-[#94a3b8] border border-[rgba(148,163,184,0.3)] rounded-full px-3 py-1 font-medium shadow-sm",
          premium:
            "bg-[rgba(37,99,235,0.15)] text-[#bfdbfe] border border-[rgba(59,130,246,0.3)] rounded-full px-3 py-1 font-medium shadow-sm",
          inactive:
            "bg-[rgba(239,68,68,0.15)] text-[#fca5a5] border border-[rgba(239,68,68,0.3)] rounded-full px-3 py-1 font-medium shadow-sm",
          pending:
            "bg-[rgba(245,158,11,0.15)] text-[#fcd34d] border border-[rgba(245,158,11,0.3)] rounded-full px-3 py-1 font-medium shadow-sm",
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
