import * as React from "react"

import { cn } from "../../lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-[color:var(--accent)] aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full rounded-[12px] border bg-[color:var(--field-bg)] px-3 py-2 text-base text-foreground transition-[color,border-color] duration-[180ms] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
