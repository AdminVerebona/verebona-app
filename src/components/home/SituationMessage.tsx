"use client"

import type { HomeSituation } from '@/services/home/HomeSummaryService';

interface Props {
  situation: HomeSituation;
  userName?: string;
}

/** Transforme **gras** en <strong> */
function renderRich(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="text-[color:var(--text-primary)] font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function SituationMessage({ situation, userName }: Props) {
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 18 ? 'Bonjour' : 'Bonsoir';
  })();

  const date = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const isActionsRequired = situation.status === 'actions_required';
  const message = situation.richMessage || situation.message;

  return (
    <div className="space-y-1">
      <h2 className="text-xl sm:text-2xl font-semibold text-[color:var(--text-primary)] leading-tight">
        {greeting}{' '}
        <span className="text-blue-500 dark:text-blue-400">
          {userName || 'vous'}
        </span>
        ,
      </h2>
      <p className="text-xs sm:text-sm text-[color:var(--text-muted)]">{date}</p>

      {/* Résumé humain unifié */}
      <p className={`text-sm mt-2 leading-relaxed ${
        isActionsRequired
          ? 'text-[color:var(--text-secondary)]'
          : 'text-[color:var(--text-muted)]'
      }`}>
        {renderRich(message)}
      </p>
    </div>
  );
}
