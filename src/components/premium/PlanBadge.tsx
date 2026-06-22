/**
 * Badge affichant le plan actuel de l'utilisateur
 * Utilise la charte centralisée de couleurs par plan
 */

'use client';

import { Badge } from '@/components/ui/badge';
import { useFeatureFlags } from '@/hooks/useFeatureFlags';
import { getPlanTheme } from '@/lib/plan-theme';
import Link from 'next/link';

interface PlanBadgeProps {
  showLink?: boolean;
  className?: string;
}

export function PlanBadge({ showLink = true, className = '' }: PlanBadgeProps) {
  const { planType: rawPlanType } = useFeatureFlags();
  const planType = ((rawPlanType || 'STANDARD') as string).toUpperCase() as any;
  const theme = getPlanTheme(planType);
  const Icon = theme.icon;

  const badgeClass =
    planType === 'STANDARD' ? '!bg-slate-600'
    : planType === 'PREMIUM' ? '!bg-blue-600'
    : planType === 'PREMIUM_DUO' ? '!bg-emerald-600'
    : '!bg-blue-600';

  const badge = (
    <Badge
      className={`gap-1 text-white ${badgeClass} ${className}`}
    >
      <Icon className="w-3 h-3" />
      {theme.label}
    </Badge>
  );

  if (showLink) {
    return (
      <Link href="/mon-compte/offres" className="hover:opacity-80 transition-opacity">
        {badge}
      </Link>
    );
  }

  return badge;
}
