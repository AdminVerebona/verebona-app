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

type Quality = 'COMPLETE' | 'COMPLETE_WITH_UNRESOLVED' | 'INCOMPLETE_RETRYABLE' | 'INCOMPLETE_FINAL';

interface Row {
  fileId: number; accountId: number; title: string | null; qualityState: Quality; anomalies: string[];
  coverageRatio: number; totalUnits: number; unresolvedUnits: number; uncertainUnits: number; failedUnits: number;
  factsCount: number; droppedFactsCount: number; truncatedSectionsCount: number; repairPassCount: number;
  chunkCount: number; retryAttempts: number; updatedAt: string;
  /** Lot 49B : vérification de la source et diagnostics (compteurs, numéros de page). */
  sourceVerification?: string | null; verification?: Diagnostics | null;
  lastRetryAt?: string | null; lastRetryResult?: string | null;
}
interface Diagnostics {
  pagesExpected?: number | null; pagesVerified?: number; pagesMissing?: number[]; pagesUnverified?: number[]; pagesScanned?: number[];
  pendingRepairUnits?: number; exhaustedRepairUnits?: number; needsSourceUnits?: number;
  truncations?: number; originalsPreserved?: number; normalisationLosses?: number;
}
interface Overview {
  days: number; byQuality: Record<Quality, number>; byAnomaly: Record<string, number>;
  averageCoverage: number | null; repairPasses: number; rows: Row[]; unavailable?: boolean;
  bySourceVerification?: Record<string, number>;
}

export const QUALITY_LABEL: Record<Quality, string> = {
  COMPLETE: 'complète',
  COMPLETE_WITH_UNRESOLVED: 'complète, part non structurée conservée',
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
};

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
  if (d.truncations) parts.push(`${d.originalsPreserved ?? 0}/${d.truncations} original(aux) conservé(s)`);
  if (d.normalisationLosses) parts.push(`${d.normalisationLosses} perte(s) non compensée(s)`);
  if (r.lastRetryAt) parts.push(`dernière reprise ${new Date(r.lastRetryAt).toLocaleString('fr-FR')}${r.lastRetryResult ? ` (${r.lastRetryResult})` : ''}`);
  return parts.join(' · ');
}

export function T1CompletenessPanel({ days = 7 }: { days?: number }) {
  const [data, setData] = useState<Overview | null>(null);
  const [anomaly, setAnomaly] = useState<string>('');

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
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2" data-testid="t1-completeness-panel">
      <h2 className="text-sm font-semibold text-[color:var(--text-primary)] flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-500" />
        Complétude des analyses T1 ({data.days} derniers jours)
      </h2>
      <p className="text-xs text-[color:var(--text-muted)]">
        {data.byQuality.COMPLETE} complète(s) · {data.byQuality.COMPLETE_WITH_UNRESOLVED} avec part non structurée conservée ·{' '}
        {data.byQuality.INCOMPLETE_RETRYABLE} en reprise · {data.byQuality.INCOMPLETE_FINAL} incomplète(s) définitive(s)
        {data.averageCoverage !== null && ` · couverture moyenne ${Math.round(data.averageCoverage * 100)} %`}
        {` · ${data.repairPasses} passe(s) de réparation ciblée`}
      </p>
      <div className="flex flex-wrap gap-2">
        {anomalies.map(([code, n]) => (
          <button key={code} type="button" onClick={() => setAnomaly(anomaly === code ? '' : code)}
            className={`text-xs rounded border px-2 py-0.5 ${anomaly === code
              ? 'border-amber-500/60 text-[color:var(--text-primary)]'
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
