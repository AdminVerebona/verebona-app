"use client"

import { Sparkles, Lock, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { AutoEnrichmentEvent } from '@/services/home/HomeSummaryService';
import Link from 'next/link';

interface Props {
  events: AutoEnrichmentEvent[];
  locked?: boolean;
}

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

const LOCKED_EXAMPLES: AutoEnrichmentEvent[] = [
  { id: 'ex1', richText: 'Verebona a complété **6 informations** sur votre appartement.' },
  { id: 'ex2', richText: 'Un événement a été ajouté à votre agenda : **Révision chaudière**.' },
  { id: 'ex3', richText: 'Un fournisseur a été identifié automatiquement.' },
  { id: 'ex4', richText: 'Ce document a été rattaché à votre chaudière.' },
];

export function EnrichissementAutomatiqueBlock({ events, locked = false }: Props) {
  const router = useRouter();

  if (!locked && events.length === 0) return null;

  const displayEvents = locked ? LOCKED_EXAMPLES : events;

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">
          Verebona a organisé pour vous
        </h3>
      </div>

      <div className="space-y-2">
        {/* Synthèse par comptage */}
        <div className="flex items-start gap-3">
          <span className="block w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0 mt-[5px]" />
          <span className="flex-1 text-xs text-[color:var(--text-secondary)] leading-snug">
            <strong className="font-semibold text-[color:var(--text-primary)]">{displayEvents.length}</strong>
            {displayEvents.length === 1
              ? ' information ajoutée à vos biens'
              : ' informations ajoutées à vos biens'}
          </span>
        </div>

        {/* Détail des événements (max 3) */}
        {displayEvents.slice(0, 3).map(event => {
          const href = event.assetId
            ? `/assets/${event.assetId}?tab=details${event.fieldKey ? `&highlight=${event.fieldKey}` : ''}`
            : null;
          const inner = (
            <div className="flex items-start gap-3">
              <span className="block w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0 mt-[5px]" />
              <p className="flex-1 text-xs text-[color:var(--text-secondary)] leading-snug">
                <RichText text={event.richText} />
              </p>
            </div>
          );
          return href ? (
            <Link
              key={event.id}
              href={href}
              className="block hover:opacity-80 transition-opacity"
            >
              {inner}
            </Link>
          ) : (
            <div key={event.id}>{inner}</div>
          );
        })}

        {/* CTA Voir le détail */}
        <div className="pt-1">
          <Link
            href="/mon-compte/enrichissements"
            className="inline-flex items-center gap-1 text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
          >
            Voir le détail
            <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      {/* Notice lock pour non-abonnés */}
      {locked && (
        <div className="mt-4 flex flex-col items-center gap-3">
          <div className="flex items-center gap-2 text-[color:var(--text-muted)]">
            <Lock className="w-4 h-4" />
            <span className="text-sm font-medium">Fonctionnalité Premium</span>
          </div>
          <button
            onClick={() => router.push('/mon-compte/offres')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white transition-colors shadow-sm"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Passer à Premium
          </button>
        </div>
      )}
    </div>
  );
}
