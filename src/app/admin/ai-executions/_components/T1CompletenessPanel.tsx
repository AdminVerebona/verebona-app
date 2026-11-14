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
import { COVERAGE_ISSUES, COVERAGE_ISSUE_LABEL, type CoverageIssue } from '@/services/ai/source-analysis/source-units/coverage-issue';
import { T1CompletenessUnits } from './T1CompletenessUnits';

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
  /** Lot 114H (#775) : issue actuelle (recalculée), motif vérifiable et prochaine action réelle. */
  issue?: { issue: CoverageIssue; label: string; reason: string; nextAction: string; actionable: boolean };
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
interface Totals {
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
  /** Lot 114H (#775) : documents de la période par issue actuelle. */
  byIssue?: Record<CoverageIssue, number>;
  byIssueTruncated?: boolean;
}

/** Lot 114H (#775, P1-C) : bilan cumulé de la réévaluation automatique du stock (compteurs seulement). */
export interface ReassessmentReport {
  rulesVersion: number; available: boolean; documents: number; byOutcome: Record<string, number>;
  transitions: Array<{ from: string; to: string; documents: number }>;
  unitsRequalified: number; alertsClosed: number; alertsMaintained: number; alertsOpened: number;
  retriesScheduled: number; retriesCancelled: number; errors: number; remaining: number; openAlerts: number;
  totalDurationMs: number; aiCalls: number; aiCost: number; firstAt: string | null; lastAt: string | null;
}

/** Issues d'une réévaluation — libellés BO (textes nouveaux, à valider par le PO). */
export const REASSESSMENT_OUTCOME_LABEL: Record<string, string> = {
  RESOLVED: 'devenue(s) complète(s)',
  RECONCILED: 'réconciliée(s) sur preuve (résidu restant)',
  REPAIR_SCHEDULED: 'réparation ciblée programmée',
  STILL_UNRESOLVED: 'encore non résolue(s)',
  UNVERIFIABLE: 'non vérifiable(s) (incertitude conservée)',
  FINAL_GAP: 'lacune réelle sans reprise admissible',
  UNCHANGED: 'inchangée(s)',
  ERROR: 'en erreur',
};

/** Bilan de la réévaluation, en lignes courtes (pure ; compteurs seulement). */
export function reassessmentText(r: ReassessmentReport | null | undefined): string[] {
  if (!r || !r.available) return [];
  if (r.documents === 0 && r.remaining === 0 && r.alertsClosed === 0) return [`Réévaluation du stock (règles v${r.rulesVersion}) : aucun document concerné.`];
  const issues = Object.entries(r.byOutcome).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${REASSESSMENT_OUTCOME_LABEL[k] ?? k}`).join(' · ');
  const lignes = [
    `Réévaluation du stock sans IA (règles v${r.rulesVersion}) : ${r.documents} document(s) examiné(s)${issues ? ` — ${issues}` : ''} · ${r.remaining} restant(s)`,
    `Unités requalifiées sur preuve : ${r.unitsRequalified} · reprises ciblées programmées : ${r.retriesScheduled} · échéances retirées (plus de reprise admissible) : ${r.retriesCancelled}`,
    `Alertes de Supervision : ${r.alertsClosed} close(s) (cause disparue) · ${r.alertsMaintained} maintenue(s) · ${r.alertsOpened} ouverte(s) · ${r.openAlerts} encore active(s)`,
    `Durée cumulée : ${Math.round(r.totalDurationMs / 1000)} s · appels IA : ${r.aiCalls} · coût IA : ${r.aiCost}`
      + `${r.lastAt ? ` · dernier passage ${new Date(r.lastAt).toLocaleString('fr-FR')}` : ''}`,
  ];
  if (r.transitions.length > 0) lignes.push(`États avant → après : ${r.transitions.slice(0, 8).map((t) => `${t.from} → ${t.to} (${t.documents})`).join(' · ')}`);
  return lignes;
}

/** Documents de la période par issue actuelle (pure). */
export function issuesText(byIssue: Record<string, number> | undefined | null, truncated?: boolean): string {
  if (!byIssue) return '';
  const parts = COVERAGE_ISSUES.filter((i) => (byIssue[i] ?? 0) > 0).map((i) => `${byIssue[i]} ${COVERAGE_ISSUE_LABEL[i]}`);
  return parts.length ? `État actuel : ${parts.join(' · ')}${truncated ? ' (documents les plus récents)' : ''}` : '';
}

const QUALITY_LABEL: Record<Quality, string> = {
  COMPLETE: 'complète',
  COMPLETE_WITH_UNRESOLVED: 'complète, part non structurée conservée',
  // Lot 53 (D19) : couverture du document original non vérifiable — jamais « complète ».
  VERIFICATION_INCOMPLETE: 'vérification incomplète — pages non vérifiables',
  // Lot 114H (#775) : cet état n'existe plus sans reprise admissible (règle unique des reprises).
  INCOMPLETE_RETRYABLE: 'incomplète — reprise programmée',
  INCOMPLETE_FINAL: 'incomplète — définitive',
};

const ANOMALY_LABEL: Record<string, string> = {
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
function followupOf(r: Pick<Row, 'qualityState' | 'sourceVerification' | 'verification' | 'retryAttempts' | 'nextRetryAt'>, maxRetries?: number) {
  const d = r.verification ?? {};
  return verificationFollowup({
    qualityState: r.qualityState, sourceVerification: r.sourceVerification ?? null, verificationReason: d.verificationReason ?? null,
    pagesUnverified: d.pagesUnverified ?? null, pagesExpected: d.pagesExpected ?? null,
    retryAttempts: r.retryAttempts, maxRetries, retryScheduled: !!r.nextRetryAt,
    // Lot 109K (COR-01) : motif exact page par page.
    pageDetails: (d as { pageDetails?: Array<{ page: number; status: string; reason: string }> }).pageDetails ?? null,
  });
}

/** Lot 109K (COR-02) : décision de la propagation d'une réparation T1 (journal 1145). */
const PROPAGATION_LABEL: Record<string, string> = {
  NO_NEW_FACT: 'aucun fait nouveau',
  NO_BUSINESS_IMPACT: 'sans incidence métier',
  NO_CANDIDATE: 'aucun candidat établi',
  UNCHANGED: 'candidats inchangés',
  DUPLICATE_STATE: 'état déjà signalé',
  RATE_LIMITED: 'plafond de fréquence atteint',
  SUPERSEDED: 'candidat réévalué (nouvelle version)',
  DISABLED: 'désactivée',
  ERROR: 'en échec',
};

const VERIFICATION_LABEL: Record<string, string> = {
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
  // Lot 109K (COR-02) : dernière propagation d'une réparation vers les candidats et T3 (décision, faits, statut T3).
  const prop = (d as { repairPropagation?: { decision?: string; newFacts?: number; categories?: string[]; candidates?: unknown[]; t3?: { status?: string } } }).repairPropagation;
  if (prop?.decision) {
    parts.push(`propagation de la réparation : ${PROPAGATION_LABEL[prop.decision] ?? prop.decision}${prop.newFacts ? `, ${prop.newFacts} fait(s) nouveau(x)` : ''}`
      + `${prop.categories?.length ? ` (${prop.categories.join(', ').toLowerCase()})` : ''}${prop.candidates?.length ? `, ${prop.candidates.length} candidat(s) examiné(s)` : ''}`
      + `${prop.t3?.status && prop.t3.status !== 'NONE' ? `, T3 ${prop.t3.status === 'REQUESTED' ? 'demandé' : 'à son prochain passage'}` : ''}`);
  }
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

const ECHEC_REPRISE = 'échec de la reprise';

export function T1CompletenessPanel({ days = 7 }: { days?: number }) {
  const [data, setData] = useState<Overview | null>(null);
  const [anomaly, setAnomaly] = useState<string>('');
  const [reprises, setReprises] = useState<Record<number, string>>({});
  // Lot 113AN : rapport de complétude unité par unité d'un document (ligne de la liste ou numéro saisi).
  const [detail, setDetail] = useState<number | null>(null);
  const [saisie, setSaisie] = useState('');
  const [bilan, setBilan] = useState<ReassessmentReport | null>(null);
  const [refus, setRefus] = useState<Record<number, string>>({});

  // Lot 53 (D19) : reprise manuelle d'une vérification incomplète (relecture du fichier, tracée).
  const relancer = (fileId: number) => {
    setReprises((x) => ({ ...x, [fileId]: 'en cours…' }));
    // Lot 114H (#775, P1-B) : l'écran dit l'issue réelle — relancée, déjà en file, ou refusée (motif du serveur).
    apiClient.post<{ ok: boolean; queued: boolean; alreadyRunning?: boolean }>('/api/admin/ai/t1-completeness/retry', { fileId })
      .then((r) => setReprises((x) => ({ ...x, [fileId]: !r.queued ? ECHEC_REPRISE : r.alreadyRunning ? 'analyse déjà en file' : 'analyse relancée' })))
      .catch((e: unknown) => {
        const motif = (e as { serverMessage?: string } | null)?.serverMessage;
        setRefus((x) => ({ ...x, [fileId]: motif ?? '' }));
        setReprises((x) => ({ ...x, [fileId]: ECHEC_REPRISE }));
      });
  };

  // Lot 114H (#775, P1-C) : bilan de la réévaluation automatique du stock.
  useEffect(() => {
    let annule = false;
    apiClient.get<ReassessmentReport>('/api/admin/ai/t1-completeness/reassessment')
      .then((r) => { if (!annule) setBilan(r); })
      .catch(() => { if (!annule) setBilan(null); });
    return () => { annule = true; };
  }, []);

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
  // Lot 113AN : recherche d'un document (même sans anomalie, ex. « complète, part non structurée conservée »).
  const recherche = (
    <div className="flex flex-wrap items-center gap-2" data-testid="t1-completeness-lookup">
      <label className="text-xs text-[color:var(--text-secondary)]" htmlFor="t1-completeness-file">Unités d’un document n°</label>
      <input id="t1-completeness-file" inputMode="numeric" value={saisie} onChange={(e) => setSaisie(e.target.value.replace(/\D/g, ''))}
        className="w-24 text-xs rounded border border-input bg-[color:var(--bg-input)] px-2 py-0.5 text-[color:var(--text-primary)]" />
      <button type="button" disabled={!saisie} onClick={() => setDetail(Number(saisie))}
        className="text-xs rounded border border-[color:var(--border-subtle)] px-2 py-0.5 text-[color:var(--text-secondary)] disabled:opacity-60">Afficher</button>
      {detail !== null && !data.rows.slice(0, 20).some((r) => r.fileId === detail) && <div className="w-full"><T1CompletenessUnits key={detail} fileId={detail} /></div>}
    </div>
  );
  const reevaluation = reassessmentText(bilan).length > 0 && (
    <ul className="text-xs text-[color:var(--text-muted)] space-y-0.5" data-testid="t1-coverage-reassessment">
      {reassessmentText(bilan).map((l) => <li key={l} className="break-words">{l}</li>)}
    </ul>
  );
  if (anomalies.length === 0 && !anomaly) {
    return <div className="rounded-xl border border-[color:var(--border-subtle)] p-4 space-y-2" data-testid="t1-completeness-panel">{recherche}{reevaluation}</div>;
  }

  return (
    <div className="rounded-xl border border-[color:var(--border-warning)] bg-[color:var(--bg-warning)] p-4 space-y-2" data-testid="t1-completeness-panel">
      <h2 className="vb-app-section flex items-center gap-2">
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
      {issuesText(data.byIssue, data.byIssueTruncated) && (
        <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="t1-completeness-issues">{issuesText(data.byIssue, data.byIssueTruncated)}</p>
      )}
      {reevaluation}
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
      {recherche}
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
              {r.issue && (
                <span className="block break-words" data-testid="t1-coverage-issue">
                  <span className="font-medium text-[color:var(--text-primary)]">État actuel : {r.issue.label}</span>
                  {` · Motif : ${r.issue.reason} · Prochaine action : ${r.issue.nextAction}`}
                </span>
              )}
              {diagnosticsText(r) && <span className="block break-words text-[color:var(--text-muted)]">{diagnosticsText(r)}</span>}
              <button type="button" onClick={() => setDetail(detail === r.fileId ? null : r.fileId)}
                className="mt-0.5 text-xs rounded border border-[color:var(--border-subtle)] px-2 py-0.5 text-[color:var(--text-secondary)]">
                {detail === r.fileId ? 'Masquer les unités' : 'Unités'}
              </button>
              {detail === r.fileId && <T1CompletenessUnits fileId={r.fileId} />}
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
                      <button type="button" onClick={() => relancer(r.fileId)} disabled={!!reprises[r.fileId] && reprises[r.fileId] !== ECHEC_REPRISE}
                        className="ml-2 text-xs rounded border border-[color:var(--border-subtle)] px-2 py-0.5 text-[color:var(--text-secondary)] disabled:opacity-60">
                        {reprises[r.fileId] ?? 'Relancer l’analyse'}
                      </button>
                    )}
                    {reprises[r.fileId] === ECHEC_REPRISE && refus[r.fileId] && <span className="ml-2 text-[color:var(--text-primary)]" role="alert">{refus[r.fileId]}</span>}
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
