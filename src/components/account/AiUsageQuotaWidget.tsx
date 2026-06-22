'use client';

/**
 * Widget quotas IA — Mon compte > Abonnement
 * CDC §3 — affiche seulement "Biens actifs" et "Documents analysés"
 * Format: 142 / 500, barre de progression, CTA "Changer d'offre" à ≥ 90%
 */
import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';
import { Skeleton } from '@/components/ui/skeleton';
import { Home, FileText, AlertTriangle, Lock } from 'lucide-react';
import type { AccountAiUsageResponse } from '@/types/ai-usage';

interface AiUsageQuotaWidgetProps {
  isDuoMember?: boolean;
}

function QuotaBar({ percent, blocked }: { percent: number; blocked: boolean }) {
  return (
    <div className="h-1.5 rounded-full bg-muted/60 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${
          blocked || percent >= 100 ? 'bg-destructive' :
          percent >= 90 ? 'bg-amber-500' :
          percent >= 70 ? 'bg-yellow-500' :
          'bg-violet-500'
        }`}
        style={{ width: `${Math.min(100, percent)}%` }}
      />
    </div>
  );
}

export function AiUsageQuotaWidget({ isDuoMember = false }: AiUsageQuotaWidgetProps) {
  const [data, setData] = useState<AccountAiUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient.get<AccountAiUsageResponse>('/api/account/ai-usage')
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-20 rounded-lg" />
        <Skeleton className="h-20 rounded-lg" />
      </div>
    );
  }

  if (!data) return null;

  const {
    assetsCount, assetsQuota, assetsPercent,
    documentsAnalyzedCount, documentsAnalyzedQuota, documentsPercent,
    isAnyQuotaBlocked,
  } = data;

  const assetsBlocked = assetsCount >= assetsQuota;
  const docsBlocked = documentsAnalyzedCount >= documentsAnalyzedQuota;

  return (
    <div className="space-y-3">
      {/* Bannière quota bloqué — message différencié limite commerciale */}
      {isAnyQuotaBlocked && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-200">
            <p className="font-semibold">Limite de votre offre atteinte</p>
            <p className="text-amber-300/80 mt-0.5">
              {assetsBlocked && docsBlocked
                ? 'Votre quota de biens et de documents analysés est atteint.'
                : assetsBlocked
                ? 'Votre quota de biens actifs est atteint.'
                : 'Votre quota de documents analysés est atteint.'
              }{' '}
              Passez à une offre supérieure pour continuer.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {/* Biens actifs */}
        <div className="rounded-lg bg-muted/40 border border-border px-3 py-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Home className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">Biens actifs</p>
            {assetsBlocked && <Lock className="w-3 h-3 text-amber-400 ml-auto" />}
          </div>
          <p className="text-sm font-semibold">
            {assetsCount}
            {assetsQuota < 999999 && (
              <span className="font-normal text-muted-foreground"> / {assetsQuota}</span>
            )}
          </p>
          {assetsQuota < 999999 && (
            <QuotaBar percent={assetsPercent} blocked={assetsBlocked} />
          )}
        </div>

        {/* Documents analysés — libellé obligatoire CDC */}
        <div className="rounded-lg bg-muted/40 border border-border px-3 py-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">Documents analysés</p>
            {docsBlocked && <Lock className="w-3 h-3 text-amber-400 ml-auto" />}
          </div>
          <p className="text-sm font-semibold">
            {documentsAnalyzedCount}
            {documentsAnalyzedQuota > 0 && (
              <span className="font-normal text-muted-foreground"> / {documentsAnalyzedQuota}</span>
            )}
          </p>
          {documentsAnalyzedQuota > 0 && (
            <QuotaBar percent={documentsPercent} blocked={docsBlocked} />
          )}
        </div>
      </div>
    </div>
  );
}
