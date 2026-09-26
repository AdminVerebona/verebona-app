"use client";

import { Loader2 } from 'lucide-react';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import type { PeriodInfo } from '@/services/admin/kpi.service';
import { formatDateTime } from '@/lib/admin/format';

/** État de chargement / d'erreur commun aux vues (ERR-001). */
export function ViewState({ loading, error, onRetry, title }: {
  loading: boolean; error: string | null; onRetry: () => void; title: string;
}) {
  if (error) return <EcranEnErreur titre={title} message={error} onRetry={onRetry} />;
  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return null;
}

/** Rappel de la période et de la règle de comparaison (DASH-004, DASH-005). */
export function PeriodNote({ period }: { period: PeriodInfo }) {
  return (
    <p className="text-xs text-muted-foreground">
      {period.inProgress
        ? <>Période en cours, données au {formatDateTime(period.asOf)}. Flux comparés à la même durée écoulée de {period.prevLabel} ; stocks comparés à la fin de {period.prevLabel}.</>
        : <>Flux sur {period.label}, stocks à la fin de la période ; comparaison avec {period.prevLabel}.</>}
    </p>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground pt-2">{children}</h2>;
}
