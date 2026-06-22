"use client"

import * as React from "react"
import { Plus, Minus } from "lucide-react"
import { cn } from "../../lib/utils"
import { Input } from "./input"
import { Button } from "./button"

interface NumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  showButtons?: boolean
  suffix?: string
  prefix?: string
}

const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ className, showButtons = false, suffix, prefix, value, onChange, onInput, ...props }, ref) => {
    const [displayValue, setDisplayValue] = React.useState(value?.toString() || "")

    React.useEffect(() => {
      setDisplayValue(value?.toString() || "")
    }, [value])

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value
      const normalized = raw.replace(/,/g, '.')
      setDisplayValue(normalized)
      // Normalize commas to dots so consumers can safely use Number() / parseFloat()
      Object.defineProperty(e.target, 'value', {
        value: normalized,
        writable: true,
      })
      onChange?.(e)
    }

    const handleInput = (e: React.FormEvent<HTMLInputElement>) => {
      const input = e.currentTarget
      input.value = input.value.replace(/[^\d.,-]/g, '')
    }

    const increment = () => {
      const currentValue = parseFloat(displayValue) || 0
      const newValue = currentValue + (props.step ? parseFloat(props.step.toString()) : 1)
      const event = new Event("change", { bubbles: true })
      const input = ref && typeof ref === "object" ? ref.current : null
      if (input) {
        input.value = newValue.toString()
        input.dispatchEvent(event)
      }
      setDisplayValue(newValue.toString())
    }

    const decrement = () => {
      const currentValue = parseFloat(displayValue) || 0
      const newValue = currentValue - (props.step ? parseFloat(props.step.toString()) : 1)
      const event = new Event("change", { bubbles: true })
      const input = ref && typeof ref === "object" ? ref.current : null
      if (input) {
        input.value = newValue.toString()
        input.dispatchEvent(event)
      }
      setDisplayValue(newValue.toString())
    }

    return (
      <div className={cn("relative", className)}>
        <div className="relative flex-1">
          {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground z-10">{prefix}</span>}
          <Input
            ref={ref}
            type="text"
            inputMode="decimal"
            value={displayValue}
            onChange={handleChange}
            onInput={handleInput}
            className={cn(
              "text-right",
              prefix && "pl-8",
              showButtons ? "pr-20" : (suffix ? "pr-12" : "pr-10")
            )}
            {...props}
          />
          {showButtons && (
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={decrement}
                className="h-7 w-7 p-0"
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={increment}
                className="h-7 w-7 p-0"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {suffix && !showButtons && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">{suffix}</span>}
        </div>
      </div>
    )
  }
)
NumberInput.displayName = "NumberInput"

export { NumberInput }
