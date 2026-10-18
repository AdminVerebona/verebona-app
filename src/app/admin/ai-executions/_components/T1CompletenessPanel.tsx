'use client';
/**
 * Complétude T1 — lot 34F (ticket T1 « Monitoring »).
 *
 * Les anomalies FONCTIONNELLES de l'extraction (fin de document non lue,
 * extraction partielle, fait écarté, unité en échec, couverture incomplète)
 * ne sont plus de simples avertissements : elles sont comptées ici, avec les
 * documents concernés et leur état de qualité. Compteurs seulement, jamais le
 * contenu des documents. Masqué tant qu'aucune anomalie n'existe.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { verificationFollowup } from '@/services/ai/source-analysis/source-units/verification-followup';

type Quality = 'COMPLETE' | 'COMPLETE_WITH_UNRESOLVED' | 'VERIFICATION_INCOMPLETE' | 'INCOMPLETE_RETRYABLE' | 'INCOMPLETE_FINAL';

interface Row {
  fileId: number; accountId: number; title: string | null; qualityState: Quality; anomalies: string[];
  coverageRatio: number; totalUnits: number; unresolvedUnits: number; uncertainUnits: number; failedUnits: number;
  factsCount: number; droppedFactsCount: number; truncatedSectionsCount: number; repairPassCount: number;
  chunkCount: number; retryAttempts: number; updatedAt: string;
  /** Lot 49B : vérification de la source et diagnostics (compteurs, numéros de page). */
  sourceVerification?: string | null; verification?: Diagnostics | null;
  lastRetryAt?: string | null; lastRetryResult?: string | null;
  /** Lot 53 (D19) : reprise automatique programmée. */
  nextRetryAt?: string | null;
}
interface Diagnostics {
  verificationReason?: string | null;
  pagesExpected?: number | null; pagesVerified?: number; pagesMissing?: number[]; pagesUnverified?: number[]; pagesScanned?: number[];
  pendingRepairUnits?: number; exhaustedRepairUnits?: number; needsSourceUnits?: number;
  truncations?: number; originalsPreserved?: number; normalisationLosses?: number;
  /** Lot 54G : pages relues / citées non vérifiées, relectures du fichier, champs retirés, tableaux. */
  pagesReread?: number[]; pagesCitedUnverified?: number[];
  sourceRereads?: number; sourceRereadsFailed?: number; needsSourceExhausted?: number;
  prunedFields?: number; prunedOriginalsPreserved?: number; tablesUncertain?: number; tablesResolved?: number;
}
/** Lot 54G (§6) : totaux de la période (compteurs seulement). */
export interface Totals {
  documents: number;
  pagesExpected: number; pagesVerified: number; pagesMissing: number; pagesUnverified: number; pagesReread: number; pagesCitedUnverified: number;
  needsSourceUnits: number; sourceRereads: number; sourceRereadsFailed: number; sourceRereadResolved: number; needsSourceExhausted: number;
  pendingRepairUnits: number; exhaustedRepairUnits: number;
  prunedFields: number; prunedOriginalsPreserved: number; normalisationLosses: number;
  tablesUncertain: number; tablesResolved: number;
}
interface Overview {
  days: number; byQuality: Record<Quality, number>; byAnomaly: Record<string, number>;
  averageCoverage: number | null; repairPasses: number; rows: Row[]; unavailable?: boolean;
  bySourceVerification?: Record<string, number>;
  maxRetries?: number;
  totals?: Totals;
}

export const QUALITY_LABEL: Record<Quality, string> = {
  COMPLETE: 'complète',
  COMPLETE_WITH_UNRESOLVED: 'complète, part non structurée conservée',
  // Lot 53 (D19) : couverture du document original non vérifiable — jamais « complète ».
  VERIFICATION_INCOMPLETE: 'vérification incomplète — pages non vérifiables',
  INCOMPLETE_RETRYABLE: 'incomplète — reprise programmée',
  INCOMPLETE_FINAL: 'incomplète — définitive',
};

export const ANOMALY_LABEL: Record<string, string> = {
  FACTS_TRUNCATED: 'Fin de document non lue',
  PARTIAL_EXTRACTION: 'Extraction partielle',
  FACT_INVALID_DROPPED: 'Faits écartés (conservés)',
  SOURCE_UNIT_FAILED: 'Unités source en échec',
  COVERAGE_INCOMPLETE: 'Couverture incomplète',
  // Lot 49B : couverture réelle de la source, réparations, pertes de normalisation.
  PAGE_UNVERIFIED: 'Page ou zone non vérifiée',
  PAGE_MISSING: 'Page non restituée',
  REPAIR_PENDING: 'Réparation en attente',
  REPAIR_EXHAUSTED: 'Réparation épuisée',
  NORMALISATION_LOSS: 'Perte de normalisation',
  SOURCE_UNREADABLE: 'Source impossible à relire',
  COVERAGE_UNVERIFIED: 'Vérification incomplète',
};

/** Lot 53 (D19) : motif, pages, statut et prochaine action d'une vérification incomplète (pure). */
export function followupOf(r: Pick<Row, 'qualityState' | 'sourceVerification' | 'verification' | 'retryAttempts' | 'nextRetryAt'>, maxRetries?: number) {
  const d = r.verification ?? {};
  return verificationFollowup({
    qualityState: r.qualityState, sourceVerification: r.sourceVerification ?? null, verificationReason: d.verificationReason ?? null,
    pagesUnverified: d.pagesUnverified ?? null, pagesExpected: d.pagesExpected ?? null,
    retryAttempts: r.retryAttempts, maxRetries, retryScheduled: !!r.nextRetryAt,
  });
}

export const VERIFICATION_LABEL: Record<string, string> = {
  VERIFIED: 'source vérifiée',
  PARTIAL: 'source partiellement vérifiée',
  UNVERIFIABLE: 'source non vérifiable',
  NOT_APPLICABLE: 'texte préextrait',
  RECONSTRUCTED: 'couverture reconstruite (historique)',
};

/** Diagnostics d'une ligne (compteurs seulement, jamais de contenu). */
export function diagnosticsText(r: Pick<Row, 'sourceVerification' | 'verification' | 'lastRetryAt' | 'lastRetryResult'>): string {
  const d = r.verification ?? {};
  const parts: string[] = [];
  if (r.sourceVerification) parts.push(VERIFICATION_LABEL[r.sourceVerification] ?? r.sourceVerification);
  if (d.pagesExpected) parts.push(`pages ${d.pagesVerified ?? 0}/${d.pagesExpected} vérifiées`);
  if (d.pagesMissing?.length) parts.push(`manquantes : ${d.pagesMissing.slice(0, 10).join(', ')}`);
  if (d.pagesUnverified?.length) parts.push(`${d.pagesUnverified.length} non vérifiée(s)`);
  if (d.pendingRepairUnits) parts.push(`${d.pendingRepairUnits} réparation(s) en attente`);
  if (d.exhaustedRepairUnits) parts.push(`${d.exhaustedRepairUnits} épuisée(s)`);
  if (d.needsSourceUnits) parts.push(`${d.needsSourceUnits} à relire dans le fichier`);
  // Lot 54G (§6) : pages relues, citées sans être vérifiées, relectures du fichier, champs retirés, tableaux.
  if (d.pagesReread?.length) parts.push(`${d.pagesReread.length} page(s) relue(s)`);
  if (d.pagesCitedUnverified?.length) parts.push(`${d.pagesCitedUnverified.length} citée(s) non vérifiée(s)`);
  if (d.sourceRereads) parts.push(`${d.sourceRereads} relecture(s) du fichier${d.sourceRereadsFailed ? ` dont ${d.sourceRereadsFailed} sans levée` : ''}`);
  if (d.needsSourceExhausted) parts.push(`${d.needsSourceExhausted} relecture(s) épuisée(s)`);
  if (d.prunedFields) parts.push(`${d.prunedFields} champ(s) retiré(s) par la validation, ${d.prunedOriginalsPreserved ?? 0} original(aux) conservé(s)`);
  if (d.tablesUncertain) parts.push(`${d.tablesUncertain} tableau(x) incertain(s)`);
  if (d.tablesResolved) parts.push(`${d.tablesResolved} tableau(x) vérifié(s)`);
  if (d.truncations) parts.push(`${d.originalsPreserved ?? 0}/${d.truncations} original(aux) conservé(s)`);
  if (d.normalisationLosses) parts.push(`${d.normalisationLosses} perte(s) non compensée(s)`);
  if (r.lastRetryAt) parts.push(`dernière reprise ${new Date(r.lastRetryAt).toLocaleString('fr-FR')}${r.lastRetryResult ? ` (${r.lastRetryResult})` : ''}`);
  return parts.join(' · ');
}

/** Lot 54G (§6) : totaux de la période, en lignes courtes (pure ; compteurs seulement). */
export function totalsText(t: Totals | undefined | null): string[] {
  if (!t || !t.documents) return [];
  return [
    `Pages : ${t.pagesExpected} attendue(s) · ${t.pagesVerified} vérifiée(s) · ${t.pagesMissing} manquante(s) · ${t.pagesUnverified} non vérifiée(s)`
      + ` · ${t.pagesReread} relue(s) · ${t.pagesCitedUnverified} citée(s) non vérifiée(s)`,
    `Relecture du fichier : ${t.needsSourceUnits} unité(s) à relire · ${t.sourceRereads} relecture(s) exécutée(s)`
      + ` · ${t.sourceRereadResolved} levée(s) · ${t.sourceRereadsFailed} sans levée · ${t.needsSourceExhausted} épuisée(s)`,
    `Réparations : ${t.pendingRepairUnits} en attente · ${t.exhaustedRepairUnits} épuisée(s)`,
    `Validation : ${t.prunedFields} champ(s) retiré(s) · ${t.prunedOriginalsPreserved} original(aux) conservé(s)`
      + ` · ${t.normalisationLosses} perte(s) non compensée(s)`,
    `Tableaux : ${t.tablesUncertain} incertain(s) · ${t.tablesResolved} vérifié(s) par leurs lignes`,
  ];
}

export function T1CompletenessPanel({ days = 7 }: { days?: number }) {
  const [data, setData] = useState<Overview | null>(null);
  const [anomaly, setAnomaly] = useState<string>('');
  const [reprises, setReprises] = useState<Record<number, string>>({});

  // Lot 53 (D19) : reprise manuelle d'une vérification incomplète (relecture du fichier, tracée).
  const relancer = (fileId: number) => {
    setReprises((x) => ({ ...x, [fileId]: 'en cours…' }));
    apiClient.post<{ ok: boolean; queued: boolean }>('/api/admin/ai/t1-completeness/retry', { fileId })
      .then((r) => setReprises((x) => ({ ...x, [fileId]: r.queued ? 'analyse relancée' : 'déjà en file' })))
      .catch(() => setReprises((x) => ({ ...x, [fileId]: 'échec de la reprise' })));
  };

  useEffect(() => {
    let annule = false;
    const q = new URLSearchParams({ days: String(days) });
    if (anomaly) q.set('anomaly', anomaly);
    apiClient.get<Overview>(`/api/admin/ai/t1-completeness?${q}`)
      .then((r) => { if (!annule) setData(r); })
      .catch(() => { if (!annule) setData(null); });
    return () => { annule = true; };
  }, [days, anomaly]);

  if (!data || data.unavailable) return null;
  const anomalies = Object.entries(data.byAnomaly).filter(([, n]) => n > 0);
  if (anomalies.length === 0 && !anomaly) return null;

  return (
    <div className="rounded-xl border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-4 space-y-2" data-testid="t1-completeness-panel">
      <h2 className="text-sm font-semibold text-[color:var(--text-primary)] flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-[color:var(--text-warning-soft)]" />
        Complétude des analyses T1 ({data.days} derniers jours)
      </h2>
      <p className="text-xs text-[color:var(--text-muted)]">
        {data.byQuality.COMPLETE} complète(s) · {data.byQuality.COMPLETE_WITH_UNRESOLVED} avec part non structurée conservée ·{' '}
        {data.byQuality.VERIFICATION_INCOMPLETE ?? 0} vérification(s) incomplète(s) ·{' '}
        {data.byQuality.INCOMPLETE_RETRYABLE} en reprise · {data.byQuality.INCOMPLETE_FINAL} incomplète(s) définitive(s)
        {data.averageCoverage !== null && ` · couverture moyenne ${Math.round(data.averageCoverage * 100)} %`}
        {` · ${data.repairPasses} passe(s) de réparation ciblée`}
      </p>
      {totalsText(data.totals).length > 0 && (
        <ul className="text-xs text-[color:var(--text-muted)] space-y-0.5" data-testid="t1-completeness-totals">
          {totalsText(data.totals).map((l) => <li key={l} className="break-words">{l}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {anomalies.map(([code, n]) => (
          <button key={code} type="button" onClick={() => setAnomaly(anomaly === code ? '' : code)}
            className={`text-xs rounded border px-2 py-0.5 ${anomaly === code
              ? 'border-[color:var(--border-warning)] text-[color:var(--text-primary)]'
              : 'border-[color:var(--border-subtle)] text-[color:var(--text-secondary)]'}`}>
            {ANOMALY_LABEL[code] ?? code} <span className="font-medium text-[color:var(--text-primary)] tabular-nums">{n}</span>
          </button>
        ))}
      </div>
      {data.rows.length > 0 && (
        <ul className="divide-y divide-[color:var(--border-subtle)]">
          {data.rows.slice(0, 20).map((r) => (
            <li key={r.fileId} className="py-1 text-xs text-[color:var(--text-secondary)]">
              <span className="font-medium text-[color:var(--text-primary)]">Document {r.fileId}</span>
              {r.title && ` — ${r.title}`} · compte {r.accountId} · {QUALITY_LABEL[r.qualityState]}
              {` · couverture ${Math.round(r.coverageRatio * 100)} % (${r.totalUnits} unités`}
              {r.unresolvedUnits > 0 && `, ${r.unresolvedUnits} non structurée(s)`}
              {r.uncertainUnits > 0 && `, ${r.uncertainUnits} incertaine(s)`}
              {r.failedUnits > 0 && `, ${r.failedUnits} en échec`})
              {` · ${r.factsCount} fait(s)`}
              {r.droppedFactsCount > 0 && ` · ${r.droppedFactsCount} écarté(s) conservé(s)`}
              {r.repairPassCount > 0 && ` · ${r.repairPassCount} réparation(s)`}
              {r.chunkCount > 0 && ` · ${r.chunkCount} lot(s) de pages`}
              {r.retryAttempts > 0 && ` · ${r.retryAttempts} reprise(s)`}
              <span className="text-[color:var(--text-muted)]"> — {r.anomalies.map((a) => ANOMALY_LABEL[a] ?? a).join(', ')}</span>
              {diagnosticsText(r) && <span className="block break-words text-[color:var(--text-muted)]">{diagnosticsText(r)}</span>}
              {(() => {
                const f = followupOf(r, data.maxRetries);
                if (!f) return null;
                return (
                  <span className="block break-words" data-testid="t1-verification-followup">
                    <span className="font-medium text-[color:var(--text-primary)]">Statut : {f.status}</span>
                    {` · Motif : ${f.reason}`}
                    {f.pages && ` · Pages : ${f.pages.slice(0, 20).join(', ')}${f.pages.length > 20 ? '…' : ''}`}
                    {` · Prochaine action : ${f.nextAction}`}
                    {f.manualRetry && (
                      <button type="button" onClick={() => relancer(r.fileId)} disabled={!!reprises[r.fileId] && reprises[r.fileId] !== 'échec de la reprise'}
                        className="ml-2 text-xs rounded border border-[color:var(--border-subtle)] px-2 py-0.5 text-[color:var(--text-secondary)] disabled:opacity-60">
                        {reprises[r.fileId] ?? 'Relancer l’analyse'}
                      </button>
                    )}
                  </span>
                );
              })()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
