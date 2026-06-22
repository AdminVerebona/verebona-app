/**
 * Charte graphique centralisée par plan (Standard / Premium / Premium Duo / Premium Pro)
 * Source unique de vérité pour les couleurs, icônes et labels des plans
 */

import { PlanType } from '@/types/domain';
import { Zap, Crown, Users } from 'lucide-react';

export interface PlanColors {
  /** Couleur de l'icône (ex: text-blue-400) */
  icon: string;
  /** Couleur de la bordure (ex: border-blue-500/40) */
  border: string;
  /** Couleur du badge/background (ex: bg-blue-600) */
  badge: string;
  /** Couleur du background semi-transparent (ex: bg-blue-500/15) */
  bg: string;
  /** Couleur du texte (ex: text-blue-400) */
  text: string;
  /** Couleur du ring/focus (ex: ring-blue-500/40) */
  ring: string;
  /** Couleur du background semi-transparent pour dark mode (ex: dark:bg-blue-900/30) */
  bgDark: string;
  /** Couleur du texte pour dark mode (ex: dark:text-blue-400) */
  textDark: string;
}

export interface PlanTheme {
  colors: PlanColors;
  icon: React.ElementType;
  label: string;
  description?: string;
}

/**
 * Palette de couleurs cohérente par plan
 * - STANDARD : Gris (slate)
 * - PREMIUM : Bleu
 * - PREMIUM_DUO : Vert (emerald)
 * - PREMIUM_PRO : Bleu (idem Premium)
 * Note : le violet est réservé aux fonctionnalités IA
 */
export const PLAN_THEMES: Record<PlanType, PlanTheme> = {
  STANDARD: {
    colors: {
      icon: 'text-slate-400',
      border: 'border-border',
      badge: '',
      bg: 'bg-slate-500/5',
      text: 'text-slate-400',
      ring: 'ring-slate-500/40',
      bgDark: 'dark:bg-slate-900/20',
      textDark: 'dark:text-slate-400',
    },
    icon: Zap,
    label: 'Standard',
    description: '2 biens actifs',
  },
  PREMIUM: {
    colors: {
      icon: 'text-blue-400',
      border: 'border-blue-500/40',
      badge: 'bg-blue-600',
      bg: 'bg-blue-500/15',
      text: 'text-blue-400',
      ring: 'ring-blue-500/40',
      bgDark: 'dark:bg-blue-900/30',
      textDark: 'dark:text-blue-400',
    },
    icon: Crown,
    label: 'Premium',
    description: 'Biens illimités',
  },
  PREMIUM_DUO: {
    colors: {
      icon: 'text-emerald-400',
      border: 'border-emerald-500/40',
      badge: 'bg-emerald-600',
      bg: 'bg-emerald-500/15',
      text: 'text-emerald-400',
      ring: 'ring-emerald-500/40',
      bgDark: 'dark:bg-emerald-900/40',
      textDark: 'dark:text-emerald-300',
    },
    icon: Users,
    label: 'Premium Duo',
    description: '15 biens actifs + 2 membres',
  },
  PREMIUM_PRO: {
    colors: {
      icon: 'text-blue-400',
      border: 'border-blue-500/40',
      badge: 'bg-blue-600',
      bg: 'bg-blue-500/15',
      text: 'text-blue-400',
      ring: 'ring-blue-500/40',
      bgDark: 'dark:bg-blue-900/30',
      textDark: 'dark:text-blue-400',
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

/**
 * Récupère seulement les couleurs pour un plan
 */
export function getPlanColors(plan: PlanType | string | null | undefined): PlanColors {
  return getPlanTheme(plan).colors;
}

/**
 * Récupère le label d'affichage pour un plan
 */
export function getPlanLabel(plan: PlanType | string | null | undefined): string {
  return getPlanTheme(plan).label;
}

/**
 * Récupère l'icône Lucide pour un plan
 */
export function getPlanIcon(plan: PlanType | string | null | undefined) {
  return getPlanTheme(plan).icon;
}
