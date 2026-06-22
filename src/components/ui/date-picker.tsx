"use client"

import * as React from "react"
import { format } from "date-fns"
import { fr } from "date-fns/locale"
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Calendar } from "./calendar"
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

interface DatePickerProps {
  value?: string
  onChange?: (date: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  id?: string
  min?: string
  max?: string
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Sélectionnez une date",
  disabled = false,
  className,
  id,
  min,
  max,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  const [month, setMonth] = React.useState<Date>(
    value ? new Date(value) : new Date()
  )

  // Sync month with external value
  React.useEffect(() => {
    if (value) setMonth(new Date(value))
  }, [value])

  const selectedDate = value ? new Date(value) : undefined

  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      const formattedDate = format(date, "yyyy-MM-dd")
      onChange?.(formattedDate)
      setOpen(false)
    }
  }

  const minDate = min ? new Date(min) : undefined
  const maxDate = max ? new Date(max) : undefined

  const currentYear = new Date().getFullYear()
  const years = Array.from({ length: 201 }, (_, i) => currentYear - 100 + i)

  const months = [
    "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
    "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"
  ]

  const handleMonthChange = (monthIndex: string) => {
    const newMonth = new Date(month)
    newMonth.setMonth(parseInt(monthIndex))
    setMonth(newMonth)
  }

  const handleYearChange = (year: string) => {
    const newMonth = new Date(month)
    newMonth.setFullYear(parseInt(year))
    setMonth(newMonth)
  }

  const goToPreviousMonth = () => {
    const newMonth = new Date(month)
    newMonth.setMonth(newMonth.getMonth() - 1)
    setMonth(newMonth)
  }

  const goToNextMonth = () => {
    const newMonth = new Date(month)
    newMonth.setMonth(newMonth.getMonth() + 1)
    setMonth(newMonth)
  }

  const displayValue = value
    ? format(new Date(value), "dd/MM/yyyy")
    : null

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen(true)}
          className={cn(
            "flex items-center gap-2 w-full rounded-md border border-input input-field px-3 py-2 text-sm ring-offset-background",
            "hover:bg-input/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "transition-colors cursor-pointer text-left",
            disabled && "opacity-50 cursor-not-allowed pointer-events-none",
            className
          )}
        >
          <CalendarIcon className="h-4 w-4 text-foreground/70 flex-shrink-0" />
          <span className={cn("flex-1", !displayValue && "text-muted-foreground")}>
            {displayValue || placeholder}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="p-3 border-b">
          <div className="flex items-center justify-between gap-2 mb-2">
            <Button variant="outline" size="icon" className="h-7 w-7" onClick={goToPreviousMonth} type="button">
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <div className="flex gap-2 flex-1">
              <Select value={month.getMonth().toString()} onValueChange={handleMonthChange}>
                <SelectTrigger className="h-7 text-sm flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {months.map((monthName, index) => (
                    <SelectItem key={index} value={index.toString()}>{monthName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={month.getFullYear().toString()} onValueChange={handleYearChange}>
                <SelectTrigger className="h-7 text-sm w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-[200px]">
                  {years.map((year) => (
                    <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button variant="outline" size="icon" className="h-7 w-7" onClick={goToNextMonth} type="button">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Calendar
          mode="single"
          selected={selectedDate}
          onSelect={handleDateSelect}
          month={month}
          onMonthChange={setMonth}
          disabled={(date) => {
            if (disabled) return true
            if (minDate && date < minDate) return true
            if (maxDate && date > maxDate) return true
            return false
          }}
          locale={fr}
          className="p-3"
        />

        {value && (
          <div className="p-3 border-t">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              type="button"
              onClick={() => { onChange?.(""); setOpen(false); }}
            >
              Effacer la date
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
