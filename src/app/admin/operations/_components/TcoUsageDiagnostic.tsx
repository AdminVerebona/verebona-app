"use client";

/**
 * Lot 108C (ticket TCO-646 §E) — BO › Opérations › « Coût de possession » :
 * diagnostic LECTURE SEULE des dépenses d'usage. Pour chaque catégorie et
 * période : forfait applicable (F, prorata), dépenses réelles rapprochées (R,
 * lignes et fondement du classement), complément estimé max(0, F − R) et
 * contribution ; état des forfaits (révision, conflit, devise) ; dépenses à
 * classer. Mêmes données que la fiche (moteur `tco/usage-complement`), aucune
 * règle ici. Desktop : tableau ; mobile : cartes. Jetons de la charte.
 */
import type { TcoResult } from '@/services/business-operations/tco/model';
import { USAGE_BUDGET_STATUS_LABELS, USAGE_COMPLEMENT_WARNING_LABELS } from '@/services/business-operations/tco/usage-complement';

const eur = (c: number | null | undefined) => (c == null ? '—' : (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }));

export function TcoUsageDiagnostic({ t }: { t: Omit<TcoResult, 'entries'> }) {
  const c = t.usage?.complement;
  if (!c || (!t.usage.items.length && !c.windows.length)) return null;
  return (
    <div className="rounded-lg border p-3 text-xs space-y-3" data-bo-tco-usage>
      <p className="font-medium text-sm">Dépenses d’usage — complément estimé (forfait − réel, par catégorie et période échue)</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <p>Coût réel documenté : <span className="tabular-nums font-medium">{eur(c.documentedCents)}</span></p>
        <p>Complément estimé : <span className="tabular-nums font-medium" data-bo-tco-usage-complement={c.estimatedComplementCents}>{eur(c.estimatedComplementCents)}</span></p>
        <p>TCO avec estimations : <span className="tabular-nums font-medium">{eur(c.totalWithEstimatesCents)}</span></p>
        <p>Forfaits échus / réel rapproché : <span className="tabular-nums">{eur(c.forfaitCents)} / {eur(c.matchedRealCents)}</span></p>
      </div>
      {c.warnings.length > 0 && (
        <ul className="list-disc pl-5 space-y-0.5 text-[color:var(--text-warning-soft)]">
          {c.warnings.map((w) => <li key={w}>{w} — {USAGE_COMPLEMENT_WARNING_LABELS[w]}</li>)}
        </ul>
      )}
      <ul className="space-y-1" data-bo-tco-usage-budgets>
        {t.usage.items.map((b) => {
          const s = c.budgets.find((x) => x.budgetId === b.id);
          return (
            <li key={b.id} className="rounded border p-2 break-words">
              Forfait #{b.id} · {b.category}{b.label ? ` « ${b.label} »` : ''} · {(b.amountMinor / 100).toLocaleString('fr-FR')} {b.currency} {b.periodicity}
              {' · '}{b.validFrom ?? 'depuis l’achat'} → {b.validTo ?? 'sans fin'}
              {b.revisesBudgetId != null ? ` · révise #${b.revisesBudgetId}` : ''}
              {s ? ` · ${s.status} (${USAGE_BUDGET_STATUS_LABELS[s.status]}) · complément ${eur(s.complementCents)}` : ''}
              {s?.revisedBy != null ? ` · révisé par #${s.revisedBy}` : ''}
              {s && s.overlapWith.length ? ` · conflit avec #${s.overlapWith.join(', #')}` : ''}
            </li>
          );
        })}
      </ul>
      {c.windows.length > 0 && (
        <>
          <div className="space-y-2 md:hidden">
            {c.windows.map((w) => (
              <div key={`${w.key}|${w.periodStart}`} className="rounded border p-2 space-y-0.5" data-bo-tco-usage-window={`${w.key}|${w.periodStart}`}>
                <p className="font-medium break-words">{w.key} · {w.periodStart} → {w.periodEnd}{w.closed ? '' : ' (en cours, non comptée)'}</p>
                <p className="tabular-nums">F {eur(w.forfaitCents)}{w.prorated ? ` (${w.coveredDays}/${w.periodDays} j)` : ''} · R {eur(w.realCents)} · complément {eur(w.complementCents)} · contribution {eur(w.contributionCents)}</p>
                <p className="text-muted-foreground break-all">Forfaits #{w.budgetIds.join(', #')} · lignes : {w.lines.map((l) => `${l.lineId} (${l.basis})`).join(', ') || 'aucune'}</p>
              </div>
            ))}
          </div>
          <div className="hidden md:block overflow-x-auto rounded border">
            <table className="w-full">
              <thead className="bg-muted/40 text-left text-muted-foreground">
                <tr><th className="p-2">Catégorie</th><th className="p-2">Période</th><th className="p-2 text-right">F</th><th className="p-2 text-right">R</th><th className="p-2 text-right">Complément</th><th className="p-2 text-right">Contribution</th><th className="p-2">Forfaits · lignes réelles</th></tr>
              </thead>
              <tbody>
                {c.windows.map((w) => (
                  <tr key={`${w.key}|${w.periodStart}`} className="border-t align-top" data-bo-tco-usage-window={`${w.key}|${w.periodStart}`}>
                    <td className="p-2">{w.key}</td>
                    <td className="p-2">{w.periodStart} → {w.periodEnd}{w.closed ? '' : ' (en cours, non comptée)'}{w.prorated ? ` · prorata ${w.coveredDays}/${w.periodDays} j` : ''}</td>
                    <td className="p-2 text-right tabular-nums">{eur(w.forfaitCents)}</td>
                    <td className="p-2 text-right tabular-nums">{eur(w.realCents)}</td>
                    <td className="p-2 text-right tabular-nums">{eur(w.complementCents)}</td>
                    <td className="p-2 text-right tabular-nums">{eur(w.contributionCents)}</td>
                    <td className="p-2 break-all">#{w.budgetIds.join(', #')} · {w.lines.map((l) => `${l.lineId} (${l.basis})`).join(', ') || 'aucune'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {(c.unclassified.length > 0 || c.undated.length > 0) && (
        <p className="text-muted-foreground break-all">
          {c.unclassified.length ? `À classer : ${c.unclassified.map((u) => `${u.lineId}${u.ambiguous.length ? ` [${u.ambiguous.join('/')}]` : ''}`).join(', ')}. ` : ''}
          {c.undated.length ? `Sans date : ${c.undated.map((u) => u.lineId).join(', ')}.` : ''}
        </p>
      )}
    </div>
  );
}
