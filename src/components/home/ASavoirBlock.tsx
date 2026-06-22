"use client"

import { CheckCircle2, Sparkles } from 'lucide-react';
import type { HomeItem } from '@/services/home/HomeSummaryService';

interface Props {
  items: HomeItem[];
  onItemClick?: (item: HomeItem) => void;
}

// Rendu du texte riche : **gras** → <strong>
function RichText({ text }: { text: string }) {
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return (
    <span>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <strong key={i} className="font-semibold text-[color:var(--text-primary)]">{part}</strong>
          : <span key={i}>{part}</span>
      )}
    </span>
  );
}

export function ASavoirBlock({ items, onItemClick }: Props) {
  if (items.length === 0) return null;

  return (
    <div className="w-full">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-4">À savoir</h3>

      <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-5 space-y-4">
        {items.map(item => {
          const isSparkle = item.iconType === 'sparkle';
          const isClickable = item.objectType !== 'system';

          const content = (
            <div className="flex items-start gap-3">
              {/* Icône */}
              <div className="flex-shrink-0 mt-0.5">
                {isSparkle ? (
                  <Sparkles className="w-4 h-4 text-violet-400" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                )}
              </div>

              {/* Texte */}
              <p className="text-sm text-[color:var(--text-secondary)] leading-relaxed">
                {item.richText
                  ? <RichText text={item.richText} />
                  : item.title
                }
              </p>
            </div>
          );

          return isClickable ? (
            <button
              key={item.id}
              onClick={() => onItemClick?.(item)}
              className="w-full text-left hover:opacity-80 transition-opacity"
            >
              {content}
            </button>
          ) : (
            <div key={item.id}>{content}</div>
          );
        })}
      </div>
    </div>
  );
}

