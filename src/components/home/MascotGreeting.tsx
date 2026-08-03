"use client"

import Image from 'next/image';
import type { HomeSummaryPayload } from '@/services/home/HomeSummaryService';

interface MascotGreetingProps {
  situation: HomeSummaryPayload['situation'];
  userName: string;
  /** Questions rapides ; envoyées telles quelles à l'assistant Verebona. */
  quickQuestions?: string[];
}

const DEFAULT_QUESTIONS = [
  'Que dois-je faire aujourd\u2019hui ?',
  'Quelle est ma prochaine échéance ?',
  'Où en est l\u2019analyse de mes documents ?',
];

const EMPTY_QUESTIONS = [
  'Comment ajouter un bien ?',
  'Que puis-je suivre avec Verebona ?',
  'L\u2019analyse automatique, c\u2019est quoi ?',
];

function askVerebona(question: string) {
  window.dispatchEvent(new CustomEvent('verebona:open', { detail: { question } }));
}

/**
 * Bandeau d'accueil : mascotte 3D (pose dialogue) + bulle de parole.
 * Remplace SituationMessage sur /accueil — la mascotte « dit » le résumé de situation.
 */
export function MascotGreeting({ situation, userName, quickQuestions }: MascotGreetingProps) {
  const isEmpty = situation.status === 'empty';
  const questions = quickQuestions ?? (isEmpty ? EMPTY_QUESTIONS : DEFAULT_QUESTIONS);
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="flex items-center gap-6">
      <Image
        src="/mascot/dialogue-bubble.webp"
        alt="Verebona"
        width={124}
        height={124}
        priority
        className="flex-shrink-0 select-none animate-[vb-float_6s_ease-in-out_infinite] [filter:drop-shadow(0_20px_32px_rgba(4,10,26,.6))]"
      />
      <div className="flex-1 min-w-0 rounded-[22px] rounded-bl-md bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] shadow-relief-md px-5 py-4">
        <h1 className="text-[21px] font-semibold tracking-tight text-[color:var(--text-primary)]">
          Bonjour, <span className="text-[color:var(--accent)]">{userName}</span>
        </h1>
        <p className="text-xs text-[color:var(--text-muted)] mb-2">{today}</p>
        <p className="text-[13.5px] leading-relaxed text-[color:var(--text-muted)] mb-3 max-w-2xl">
          {isEmpty ? (
            <>Bienvenue ! <strong className="text-[color:var(--text-primary)] font-semibold">Ajoutez votre premier bien</strong>, puis importez ses documents : j'en extrais les informations utiles et je surveille les échéances pour vous.</>
          ) : (
            situation.message /* résumé serveur : « X éléments attendent une action, dont une échéance en retard. » */
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {questions.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => askVerebona(q)}
              className="px-3.5 py-1.5 rounded-full border border-[color:var(--border-subtle)] text-[12.5px] text-[color:var(--text-primary)] hover:bg-[color:var(--accent-soft)] hover:border-[color:var(--text-muted)] transition-all"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* Ajouter une fois dans globals.css :
@keyframes vb-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-9px) } }
*/
