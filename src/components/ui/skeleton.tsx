import * as React from "react"
import { cn } from "../../lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-[color:var(--border-subtle)] animate-pulse rounded-[8px]", className)}
      {...props}
    />
  )
}

export { Skeleton }
