"use client"

import * as React from "react"
import { Plus, Minus } from "lucide-react"
import { cn } from "../../lib/utils"
import { parseNumberInput, stepNumberInput, type NumberParseOptions } from "../../lib/number-input"
import { Input } from "./input"
import { Button } from "./button"

/**
 * Champ numérique partagé — lot 58A (BUG P1 troncature des montants).
 *
 * Champ CONTRÔLÉ à valeur TEXTUELLE : le texte tapé, collé ou corrigé est
 * transmis tel quel au parent (`onValueChange`) et réaffiché tel quel ; la
 * conversion en nombre se fait à la validation par `parseNumberInput`
 * (`@/lib/number-input`). Le composant ne modifie jamais `input.value` ni ne
 * redéfinit la propriété `value` de l'élément (cause du bug : la redéfinition
 * remplaçait le suivi de valeur de React, plus aucun `onChange` après la
 * première frappe).
 *
 * Un texte invalide ou ambigu affiche un message explicite sous le champ
 * (après sortie du champ, ou dès que `showError` est vrai — tentative
 * d'enregistrement).
 */
interface NumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange" | "min" | "max" | "step"> {
  /** Texte affiché (jamais un nombre) — voir `formatNumberForInput`. */
  value: string
  onValueChange: (text: string) => void
  /** Règles de lecture (montant : `MONEY_INPUT`). */
  parseOptions?: NumberParseOptions
  /** Affiche l'erreur sans attendre la sortie du champ. */
  showError?: boolean
  showButtons?: boolean
  /** Pas des boutons +/- (défaut 1). */
  step?: number
  suffix?: string
  prefix?: string
}

const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ className, showButtons = false, suffix, prefix, value, onValueChange, parseOptions, showError = false, step = 1, onBlur, id, ...props }, ref) => {
    const [touched, setTouched] = React.useState(false)
    const autoId = React.useId()
    const errorId = `${id ?? autoId}-error`
    const lu = parseNumberInput(value, parseOptions)
    const error = !lu.ok && (touched || showError) ? lu.error : null

    return (
      <div className={cn("relative", className)}>
        <div className="relative flex-1">
          {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground z-10">{prefix}</span>}
          <Input
            ref={ref}
            id={id}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            {...props}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            onBlur={(e) => { setTouched(true); onBlur?.(e) }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={cn(
              "text-right tabular-nums",
              prefix && "pl-8",
              showButtons ? "pr-20" : (suffix ? "pr-12" : "pr-10")
            )}
          />
          {showButtons && (
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onValueChange(stepNumberInput(value, -step, parseOptions))}
                className="h-7 w-7 p-0"
                disabled={props.disabled}
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onValueChange(stepNumberInput(value, step, parseOptions))}
                className="h-7 w-7 p-0"
                disabled={props.disabled}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {suffix && !showButtons && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">{suffix}</span>}
        </div>
        {error && <p id={errorId} role="alert" className="mt-1 text-xs text-destructive text-left">{error}</p>}
      </div>
    )
  }
)
NumberInput.displayName = "NumberInput"

export { NumberInput }
