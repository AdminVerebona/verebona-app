"use client"

import Link from 'next/link';
import { Clock } from 'lucide-react';

interface SidebarPlanCardProps {
  /** Jours d'essai restants. `null`/`undefined` hors essai en cours
   *  (`/api/users/me` ne le renseigne que pour un essai `active`). */
  trialDaysLeft?: number | null;
}

/** Durée de l'essai, pour la jauge (cf. `TRIAL_DURATION_DAYS`, trial.service). */
const TRIAL_DAYS = 7;

/**
 * Carte en bas de la barre latérale (masquée quand la barre est repliée).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AFFICHÉE UNIQUEMENT PENDANT LA PÉRIODE D'ESSAI
 *
 * La carte connaissait trois états : essai en cours, essai terminé, et
 * Standard (« Plan gratuit — Passer à Premium »). Seul le premier est
 * conservé : il annonce une échéance que l'utilisateur doit connaître.
 *
 * Les deux autres sont supprimés :
 *   - « Plan gratuit » était faux — Standard est une offre payante ;
 *   - l'essai terminé est déjà signalé par le bandeau d'essai
 *     (`TrialBanner`) et par la fenêtre de blocage d'écriture, qui mènent
 *     tous deux au choix d'une offre.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function SidebarPlanCard({ trialDaysLeft }: SidebarPlanCardProps) {
  if (typeof trialDaysLeft !== 'number' || trialDaysLeft < 0) return null;

  return (
    <div className="mx-3 mb-2 rounded-[14px] bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] px-3.5 py-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Clock className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-xs font-semibold text-[color:var(--text-primary)]">Essai gratuit</span>
        <span className="ml-auto text-[10.5px] font-bold text-amber-400">J-{trialDaysLeft}</span>
      </div>
      <p className="text-[11px] leading-relaxed text-[color:var(--text-muted)] mb-2">
        2 biens et 30 documents inclus, sans carte bancaire.
      </p>
      <div className="h-[5px] rounded-full bg-[color:var(--bg-page)] overflow-hidden mb-2.5">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-400"
          style={{ width: `${Math.max(6, Math.min(100, ((TRIAL_DAYS - trialDaysLeft) / TRIAL_DAYS) * 100))}%` }}
        />
      </div>
      {/* Même libellé et même destination que le bandeau d'accueil. */}
      <Link
        href="/mon-compte/offres"
        className="block w-full h-8 leading-8 text-center rounded-full bg-gradient-to-br from-indigo-500 to-blue-600 text-white text-[11.5px] font-semibold hover:-translate-y-px hover:shadow-relief-glow transition-all"
      >
        Choisir une offre
      </Link>
    </div>
  );
}
