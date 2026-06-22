"use client"

import * as React from "react"
import { Calendar as CalendarIcon } from "lucide-react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"

interface YearPickerProps {
  value?: string
  onChange?: (year: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  id?: string
  min?: number
  max?: number
}

export function YearPicker({
  value,
  onChange,
  placeholder = "Sélectionnez une année",
  disabled = false,
  className,
  id,
  min = 1900,
  max,
}: YearPickerProps) {
  const [open, setOpen] = React.useState(false)

  const currentYear = new Date().getFullYear()
  const maxYear = max || currentYear
  const minYear = min

  const years = Array.from(
    { length: maxYear - minYear + 1 },
    (_, i) => maxYear - i
  )

  const displayValue = value ? `${value}` : placeholder

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          className={cn(
            "w-full justify-start text-left font-normal",
            !value && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 flex-shrink-0" />
          <span>{displayValue}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-4" align="start">
        <div className="space-y-3">
          <div className="text-sm font-semibold px-1">Sélectionner une année</div>
          <Select
            value={value || ""}
            onValueChange={(year) => {
              onChange?.(year)
              setOpen(false)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Année" />
            </SelectTrigger>
            <SelectContent className="max-h-[300px]">
              {years.map((year) => (
                <SelectItem key={year} value={year.toString()}>
                  {year}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  )
}
