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
 *
 * Carte #766 (E09) — la période est celle de LA DÉPENSE, pas toutes celles du justificatif : quand un
 * justificatif porte plusieurs périodes facturées (facture récapitulative), seule celle qui contient la
 * période propre de la ligne (établie par T1 / T3, lue par `?lignes=`) est affichée ; si ce lien n'est pas
 * établi, l'incertitude est écrite — jamais toutes les périodes sur chaque dépense, jamais une
 * association devinée. Les périodes multiples restent visibles et corrigeables sur le document. Aucune
 * règle d'imputation : le coût de possession n'est ni lu ni modifié.
 */
import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { EXPENSE_PERIOD_UNDETERMINED, expenseBillingPeriods, expenseLineHasReadablePeriod, type ExpenseLineOwnPeriod } from '@/lib/documents/business-periods';
import { BUSINESS_PERIODS_MUTATED, PeriodRow, type PeriodView } from '@/components/documents/BusinessPeriods';

export interface ExpensePeriodSummary {
  billing: PeriodView[];
  /** Carte #766 (E09) : période propre des lignes de ce justificatif (présent une fois lue). */
  linePeriods?: Record<string, ExpenseLineOwnPeriod>;
  /** Carte #766 (E09) : la période propre des lignes a été lue (ou n'était pas nécessaire). */
  linesReady?: boolean;
}

/** Ligne de dépense affichée : son identifiant et son justificatif. */
export interface ExpenseLineRef { id: string; fileId: number | null | undefined }

/**
 * Périodes des justificatifs des lignes affichées (une requête ; relue après une correction). Carte #766
 * (E09) : pour les justificatifs à PLUSIEURS périodes facturées seulement, une seconde requête lit la
 * période propre de leurs lignes (rien de plus n'est demandé pour le cas courant d'une seule période).
 */
export function useExpensePeriods(lines: ReadonlyArray<ExpenseLineRef>, enabled: boolean): Record<string, ExpensePeriodSummary> {
  const cle = useMemo(() => [...new Set(lines.map((l) => l.fileId).filter((x): x is number => typeof x === 'number' && x > 0))].sort((a, b) => a - b).slice(0, 300).join(','), [lines]);
  const [periods, setPeriods] = useState<Record<string, ExpensePeriodSummary>>({});
  const [parLigne, setParLigne] = useState<{ cle: string; periods: Record<string, ExpenseLineOwnPeriod> } | null>(null);
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
  // Lignes des justificatifs à plusieurs périodes facturées dont la période propre est lisible.
  const cleLignes = useMemo(() => [...new Set(lines
    .filter((l) => typeof l.fileId === 'number' && (periods[String(l.fileId)]?.billing.length ?? 0) > 1 && expenseLineHasReadablePeriod(l.id))
    .map((l) => l.id))].sort().slice(0, 300).join(','), [lines, periods]);
  useEffect(() => {
    if (!enabled || !cleLignes) return;
    let actif = true;
    apiClient.get<{ linePeriods?: Record<string, ExpenseLineOwnPeriod> }>(`/api/documents/periodes?lignes=${encodeURIComponent(cleLignes)}`)
      .then((r) => { if (actif) setParLigne({ cle: cleLignes, periods: r?.linePeriods ?? {} }); })
      // Lecture impossible : le lien n'est pas établi (l'incertitude sera affichée, jamais une association).
      .catch(() => { if (actif) setParLigne({ cle: cleLignes, periods: {} }); });
    return () => { actif = false; };
  }, [cleLignes, enabled, tour]);
  return useMemo(() => {
    const pret = !cleLignes || parLigne?.cle === cleLignes;
    const out: Record<string, ExpensePeriodSummary> = {};
    for (const [k, v] of Object.entries(periods)) out[k] = { ...v, linePeriods: parLigne?.periods ?? {}, linesReady: pret };
    return out;
  }, [periods, parLigne, cleLignes]);
}

/** Période facturée de LA dépense (rien si le justificatif n'en porte aucune). Carte #766 (E09). */
export function TcoExpensePeriod({ fileId, lineId, summary }: { fileId: number | null | undefined; lineId?: string; summary: ExpensePeriodSummary | undefined }) {
  const billing = summary?.billing ?? [];
  if (!fileId || !billing.length) return null;
  // Plusieurs périodes sur le justificatif : rien n'est affiché tant que la période propre des lignes n'est pas lue.
  if (billing.length > 1 && !summary?.linesReady) return null;
  const { periods, undetermined } = expenseBillingPeriods(billing, lineId ? summary?.linePeriods?.[lineId] : null);
  const rafraichi = () => { /* le composant d'édition signale déjà la mutation : la liste se relit */ };
  return (
    <div className="mt-0.5 space-y-0.5" data-tco-line-period={fileId}>
      {undetermined && <p className="text-xs text-muted-foreground" data-tco-line-period-undetermined>{EXPENSE_PERIOD_UNDETERMINED}</p>}
      {periods.map((p) => <PeriodRow key={p.id} fileId={fileId} period={p} muted onSaved={rafraichi} />)}
    </div>
  );
}
