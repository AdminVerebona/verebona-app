/**
 * Charte graphique centralisée par plan (Standard / Premium / Premium Duo / Premium Pro)
 * Source unique de vérité pour les couleurs, icônes et labels des plans
 */

import { PlanType } from '@/types/domain';
import { Zap, Crown, Users } from 'lucide-react';

interface PlanColors {
  /** Couleur de l'icône (ex: text-[color:var(--accent)]) */
  icon: string;
  /** Couleur de la bordure (ex: border-[color:var(--border-info)]) */
  border: string;
  /** Couleur du badge/background (ex: bg-[color:var(--accent)]) */
  badge: string;
  /** Couleur du background semi-transparent (ex: bg-[color:var(--accent-soft)]) */
  bg: string;
  /** Couleur du texte (ex: text-[color:var(--accent)]) */
  text: string;
  /** Couleur du ring/focus (ex: ring-[color:var(--border-info)]) */
  ring: string;
  /** Historique (variante sombre) : vide — les jetons suivent le thème. */
  bgDark: string;
  /** Historique (variante sombre) : vide — les jetons suivent le thème. */
  textDark: string;
}

interface PlanTheme {
  colors: PlanColors;
  icon: React.ElementType;
  label: string;
  description?: string;
}

/**
 * Couleurs par plan — charte « Sérénité » 2026 (lot 66B1) : jetons du thème
 * (clair / sombre automatiques), plus de palette brute.
 * - STANDARD : neutre (texte secondaire, fond discret)
 * - PREMIUM, PREMIUM_PRO, PREMIUM_DUO : pétrole (brume + pétrole). Le plan se
 *   distingue par son LIBELLÉ et son icône, jamais par la seule couleur.
 */
export const PLAN_THEMES: Record<PlanType, PlanTheme> = {
  STANDARD: {
    colors: {
      icon: 'text-[color:var(--text-muted)]',
      border: 'border-border',
      badge: '',
      bg: 'bg-[color:var(--bg-subtle)]',
      text: 'text-[color:var(--text-muted)]',
      ring: 'ring-[color:var(--border)]',
      bgDark: '',
      textDark: '',
    },
    icon: Zap,
    label: 'Standard',
    description: '2 biens actifs',
  },
  PREMIUM: {
    colors: {
      icon: 'text-[color:var(--accent)]',
      border: 'border-[color:var(--border-info)]',
      badge: 'bg-[color:var(--accent)]',
      bg: 'bg-[color:var(--accent-soft)]',
      text: 'text-[color:var(--accent)]',
      ring: 'ring-[color:var(--border-info)]',
      bgDark: '',
      textDark: '',
    },
    icon: Crown,
    label: 'Premium',
    description: 'Biens illimités',
  },
  PREMIUM_DUO: {
    colors: {
      icon: 'text-[color:var(--text-success)]',
      border: 'border-[color:var(--border-success)]',
      badge: 'bg-[color:var(--accent)]',
      bg: 'bg-[color:var(--bg-success)]',
      text: 'text-[color:var(--text-success)]',
      ring: 'ring-[color:var(--border-success)]',
      bgDark: '',
      textDark: '',
    },
    icon: Users,
    label: 'Premium Duo',
    description: '15 biens actifs + 2 membres',
  },
  PREMIUM_PRO: {
    colors: {
      icon: 'text-[color:var(--accent)]',
      border: 'border-[color:var(--border-info)]',
      badge: 'bg-[color:var(--accent)]',
      bg: 'bg-[color:var(--accent-soft)]',
      text: 'text-[color:var(--accent)]',
      ring: 'ring-[color:var(--border-info)]',
      bgDark: '',
      textDark: '',
    },
    icon: Crown,
    label: 'Premium Pro',
    description: 'Biens illimités + accès Pro',
  },
};

/**
 * Récupère la charte complète pour un plan
 */
export function getPlanTheme(plan: PlanType | string | null | undefined): PlanTheme {
  if (!plan) return PLAN_THEMES.STANDARD;
  const key = (plan as string).toUpperCase() as keyof typeof PLAN_THEMES;
  return PLAN_THEMES[key] || PLAN_THEMES.STANDARD;
}
