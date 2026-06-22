"use client"

import type { HomeItem } from '@/services/home/HomeSummaryService';

interface Props {
  items: HomeItem[];
  onItemClick?: (item: HomeItem) => void;
}

// ── Couleur du point selon le badge ──────────────────────────────────────────

function dotColor(badge: string): string {
  if (badge.includes('Document')) return 'bg-emerald-400';
  if (badge.includes('Export')) return 'bg-indigo-400';
  if (badge.includes('Analyse')) return 'bg-blue-400';
  if (badge.includes('Bien')) return 'bg-teal-400';
  if (badge === 'Agenda') return 'bg-amber-400';
  return 'bg-[#94a3b8]';
}

// ── Rendu texte riche : **gras** → <strong> ───────────────────────────────────

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

export function ActiviteRecenteBlock({ items, onItemClick }: Props) {
  if (items.length === 0) return null;

  const displayItems = items.slice(0, 3);

  return (
    <div className="w-full">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-3">
        Activité récente
      </h3>

      <div className="space-y-2">
        {displayItems.map(item => {
          const isClickable = item.objectType !== 'system';

          return (
            <div
              key={item.id}
              onClick={isClickable ? () => onItemClick?.(item) : undefined}
              className={`flex items-start gap-3 ${
                isClickable
                  ? 'cursor-pointer hover:bg-[rgba(255,255,255,0.02)] transition-colors rounded-lg px-3 -mx-3'
                  : ''
              }`}
            >
              {/* Point coloré */}
              <div className="flex-shrink-0 mt-[5px]">
                <span className={`block w-1.5 h-1.5 rounded-full ${dotColor(item.badge)}`} />
              </div>

              {/* Texte */}
              <p className="flex-1 min-w-0 text-xs text-[color:var(--text-secondary)] leading-snug">
                {item.richText
                  ? <RichText text={item.richText} />
                  : <strong className="font-semibold text-[color:var(--text-primary)]">{item.title}</strong>
                }
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}