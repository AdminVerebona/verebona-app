"use client";

import React from "react";
import { cn } from "../../lib/utils";

interface TickerItem {
  id: string;
  content: string;
  icon?: React.ReactNode;
  type?: "info" | "warning" | "success" | "error";
}

interface TickerProps {
  items: TickerItem[];
  speed?: number;
  className?: string;
  pauseOnHover?: boolean;
}

/**
 * Ticker component - Bandeau défilant pour afficher des informations importantes
 * Usage: <Ticker items={[...]} speed={30} pauseOnHover />
 */
export function Ticker({ 
  items, 
  speed = 30, 
  className = "",
  pauseOnHover = true 
}: TickerProps) {
  if (!items || items.length === 0) return null;

  const getTypeStyles = (type?: string) => {
    switch (type) {
      case "warning":
        return "bg-warning/10 text-warning border-warning/20";
      case "success":
        return "bg-success/10 text-success border-success/20";
      case "error":
        return "bg-destructive/10 text-destructive border-destructive/20";
      default:
        return "bg-primary/10 text-primary border-primary/20";
    }
  };

  // Duplicate items for seamless loop
  const duplicatedItems = [...items, ...items];

  return (
    <div 
      className={cn(
        "relative overflow-hidden border-y bg-card",
        className
      )}
    >
      <div
        className={cn(
          "flex gap-8 py-3 animate-ticker",
          pauseOnHover && "hover:[animation-play-state:paused]"
        )}
        style={{
          animationDuration: `${speed}s`,
        }}
      >
        {duplicatedItems.map((item, index) => (
          <div
            key={`${item.id}-${index}`}
            className={cn(
              "flex items-center gap-2 px-4 py-1.5 rounded-full border whitespace-nowrap text-sm font-medium shrink-0",
              getTypeStyles(item.type)
            )}
          >
            {item.icon && <span className="shrink-0">{item.icon}</span>}
            <span>{item.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Animation CSS personnalisée pour le ticker
 * Ajouter dans globals.css si nécessaire
 */
