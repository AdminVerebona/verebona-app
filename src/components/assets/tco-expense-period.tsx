"use client"

/**
 * Lot 113AB (Trello #725, §3 « Dépenses ») — PÉRIODE FACTURÉE d'une dépense,
 * visible et corrigeable depuis le détail de la dépense (sous-tiroirs
 * « Dépenses retenues » / « non retenues » du coût de possession ; desktop et
 * mobile, même composant ; jetons de couleur seulement).
 *
 *   · la période affichée est celle du JUSTIFICATIF de la dépense
 *     (`document_business_periods`, nature « facturation ») : le même fait
 *     que la fiche du document — « Corriger » passe par
 *     `PUT /api/documents/:fileId/periodes`, et tous les écrans ouverts se
 *     relisent (`business-periods-mutated`) ;
 *   · la correction ne touche ni la couverture, ni la durée contractuelle,
 *     ni l'imputation TCO (le moteur ne lit pas ce fait : montants, année et
 *     déduplication inchangés — test L113AB-E2E-03) ;
 *   · rien n'est affiché si le justificatif n'a pas de période facturée
 *     (achat ponctuel : aucun champ artificiel) ;
 *   · lecture seule : la garde d'écriture existante refuse « Corriger ».
 * Une seule requête pour toutes les lignes affichées (`GET /api/documents/periodes`).
 */
import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { SEVERAL_PERIODS_LABEL } from '@/lib/documents/business-periods';
import { BUSINESS_PERIODS_MUTATED, PeriodRow, type PeriodView } from '@/components/documents/BusinessPeriods';

export interface ExpensePeriodSummary { billing: PeriodView[] }

/** Périodes des justificatifs des lignes affichées (une requête ; relue après une correction). */
export function useExpensePeriods(fileIds: ReadonlyArray<number | null | undefined>, enabled: boolean): Record<string, ExpensePeriodSummary> {
  const cle = useMemo(() => [...new Set(fileIds.filter((x): x is number => typeof x === 'number' && x > 0))].sort((a, b) => a - b).slice(0, 300).join(','), [fileIds]);
  const [periods, setPeriods] = useState<Record<string, ExpensePeriodSummary>>({});
  const [tour, setTour] = useState(0);
  useEffect(() => {
    const h = () => setTour((t) => t + 1);
    window.addEventListener(BUSINESS_PERIODS_MUTATED, h);
    return () => window.removeEventListener(BUSINESS_PERIODS_MUTATED, h);
  }, []);
  useEffect(() => {
    if (!enabled || !cle) return;
    let actif = true;
    apiClient.get<{ periods: Record<string, ExpensePeriodSummary> }>(`/api/documents/periodes?ids=${cle}`)
      .then((r) => { if (actif) setPeriods(r?.periods ?? {}); })
      .catch(() => { /* période non affichée : la dépense reste consultable */ });
    return () => { actif = false; };
  }, [cle, enabled, tour]);
  return periods;
}

/** Période facturée du justificatif d'une dépense (rien si aucune). */
export function TcoExpensePeriod({ fileId, summary }: { fileId: number | null | undefined; summary: ExpensePeriodSummary | undefined }) {
  const billing = summary?.billing ?? [];
  if (!fileId || !billing.length) return null;
  const rafraichi = () => { /* le composant d'édition signale déjà la mutation : la liste se relit */ };
  return (
    <div className="mt-0.5 space-y-0.5" data-tco-line-period={fileId}>
      {billing.length > 1 && <p className="text-xs text-[color:var(--text-primary)]">{SEVERAL_PERIODS_LABEL}</p>}
      {billing.map((p) => <PeriodRow key={p.id} fileId={fileId} period={p} muted onSaved={rafraichi} />)}
    </div>
  );
}
