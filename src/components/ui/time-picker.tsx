"use client"

import * as React from "react"
import { Clock } from "lucide-react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Input } from "./input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover"

interface TimePickerProps {
  value?: string
  onChange?: (time: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  id?: string
}

export function TimePicker({
  value,
  onChange,
  placeholder = "HH:MM",
  disabled = false,
  className,
  id,
}: TimePickerProps) {
  const [open, setOpen] = React.useState(false)
  const [inputValue, setInputValue] = React.useState(value || "")

  React.useEffect(() => {
    setInputValue(value || "")
  }, [value])

  const handleTimeChange = (time: string) => {
    const validTime = /^\d{1,2}:\d{2}$/.test(time) || /^\d{1,2}$/.test(time)
    if (validTime || time === "") {
      setInputValue(time)
      if (/^\d{1,2}:\d{2}$/.test(time)) {
        onChange?.(time)
        setOpen(false)
      }
    }
  }

  const handleHourMinuteChange = (hours: string, minutes: string) => {
    const h = hours.padStart(2, "0")
    const m = minutes.padStart(2, "0")
    const time = `${h}:${m}`
    setInputValue(time)
    onChange?.(time)
  }

  const parts = inputValue.split(":")
  const hours = parseInt(parts[0]) || 0
  const minutes = parseInt(parts[1]) || 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          className={cn(
            "w-full justify-start text-left font-normal rounded-md input-field",
            !value && "text-muted-foreground",
            className
          )}
        >
          <Clock className="mr-2 h-4 w-4 flex-shrink-0" />
          <span>{value || placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-4" align="start">
        <div className="space-y-4">
          <div className="text-sm font-semibold">Sélectionner l'heure</div>
          <div className="flex gap-2 items-center">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">Heures</label>
              <Input
                type="number"
                min="0"
                max="23"
                value={hours}
                onChange={(e) => {
                  const h = Math.min(23, Math.max(0, parseInt(e.target.value) || 0))
                  handleHourMinuteChange(h.toString(), minutes.toString())
                }}
                className="text-center"
              />
            </div>
            <div className="text-lg font-bold pt-6">:</div>
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">Minutes</label>
              <Input
                type="number"
                min="0"
                max="59"
                step="5"
                value={minutes}
                onChange={(e) => {
                  const m = Math.min(59, Math.max(0, parseInt(e.target.value) || 0))
                  handleHourMinuteChange(hours.toString(), m.toString())
                }}
                className="text-center"
              />
            </div>
          </div>
          <Button
            size="sm"
            className="w-full"
            onClick={() => setOpen(false)}
          >
            Valider
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
