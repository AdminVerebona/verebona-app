"use client"

import Link from 'next/link';
import { Clock, Crown } from 'lucide-react';

interface SidebarPlanCardProps {
  /** Plan normalisé en MAJUSCULES : STANDARD | PREMIUM | PREMIUM_DUO | PREMIUM_PRO. */
  plan: string;
  /** Jours d'essai restants (null/undefined si pas en essai). */
  trialDaysLeft?: number | null;
  /** Quotas biens (utilisé / max) pour la carte STANDARD. */
  assetsUsed?: number;
  assetsMax?: number;
}

/**
 * Carte d'incitation en bas de sidebar (masquée quand la sidebar est repliée).
 * - Essai en cours : « Essai gratuit · J-x » + jauge ambre + « Choisir une offre » → /mon-compte.
 * - STANDARD : « Plan gratuit » + jauge Biens pleine + « Passer à Premium » → /mon-compte.
 * - PREMIUM / PREMIUM_DUO : rien.
 */
// Valeurs par défaut alignées sur le CDC §2 : l'offre Standard ouvre 2 biens,
// pas 3. `DashboardLayout` ne passe pas encore ces props — le repli doit donc
// être juste.
export function SidebarPlanCard({ plan, trialDaysLeft, assetsUsed = 0, assetsMax = 2 }: SidebarPlanCardProps) {
  const isTrial = typeof trialDaysLeft === 'number' && trialDaysLeft >= 0;
  if (!isTrial && plan !== 'STANDARD') return null;

  return (
    <div className="mx-3 mb-2 rounded-[14px] bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] px-3.5 py-3">
      {isTrial ? (
        <>
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
              style={{ width: `${Math.max(6, Math.min(100, ((7 - trialDaysLeft) / 7) * 100))}%` }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Crown className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-xs font-semibold text-[color:var(--text-primary)]">Plan gratuit</span>
          </div>
          <div className="flex text-[11px] text-[color:var(--text-muted)] mb-1">
            <span>Biens</span>
            <span className="ml-auto font-medium text-[color:var(--text-primary)]">{assetsUsed} / {assetsMax}</span>
          </div>
          <div className="h-[5px] rounded-full bg-[color:var(--bg-page)] overflow-hidden mb-2.5">
            <div
              className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-blue-500"
              style={{ width: `${Math.min(100, (assetsUsed / assetsMax) * 100)}%` }}
            />
          </div>
        </>
      )}
      <Link
        href="/mon-compte"
        className="block w-full h-8 leading-8 text-center rounded-full bg-gradient-to-br from-indigo-500 to-blue-600 text-white text-[11.5px] font-semibold hover:-translate-y-px hover:shadow-relief-glow transition-all"
      >
        {isTrial ? 'Choisir une offre' : 'Passer à Premium'}
      </Link>
    </div>
  );
}
