"use client";

/**
 * Rapport d'exécution T1 / T3 — lot 58C (ticket « Reporting exhaustif des
 * exécutions T1 et T3 »). Affiché dans le détail d'une exécution (appels du
 * même job ou de la même trace) et depuis l'onglet « Rapports T1/T3 » (passages
 * T3 sans appel modèle). Même composant en desktop et en mobile : colonne
 * unique, valeurs repliables, aucune largeur fixe.
 *
 * · résultat RÉEL de chaque écriture (écrit / non enregistré / échec /
 *   examiné non modifié / décidé non confirmé / non examiné / relu) — une
 *   décision n'est jamais affichée comme une écriture réussie ;
 * · emplacement BDD exact (table, enregistrement, colonne ou chemin JSON),
 *   valeur écrite complète (contenu long : relu en direct, sinon « non tracé ») ;
 * · navigation T1 → preuve → décision T3 → champ final (rapports corrélés) ;
 * · export JSON exhaustif (flux, aucune troncature).
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { CopyBlockButton } from './CopyJson';

export interface ReportSummaryDto {
  id: number; accountId: number; treatment: string; scope: string; jobId: number | null; traceIds: string[];
  fileId: number | null; assetId: number | null; targetType: string | null; targetId: number | null;
  analysisRunId: number | null; extractionId: number | null; reconciliationRunId: number | null; accountRunId: number | null;
  originT1ReportId: number | null; status: string; reportComplete: boolean; reportError: string | null;
  counters: Record<string, number>; steps: Array<{ step: string; status: string; error?: string | null; detail?: Record<string, unknown> | null }>;
  sources: Record<string, unknown>; entryCount: number; entriesReportId: number | null; createdAt: string;
}
interface EntryDto {
  seq: number; section: string; tableName: string | null; recordId: string | null; columnPath: string | null;
  fieldKey: string | null; label: string | null; entityType: string | null; entityId: number | null;
  oldValue: unknown; value: unknown; valueType: string | null; ref: { sha256: string; chars: number } | null;
  recordStatus: string | null; writeResult: string; reasonCode: string | null; reason: string | null; links: Record<string, unknown> | null;
}
interface DetailDto {
  report: ReportSummaryDto;
  breakdown: Array<{ section: string; writeResult: string; count: number }>;
  correlations: { origin: ReportSummaryDto | null; followups: ReportSummaryDto[]; previousForSameDocument: ReportSummaryDto[] };
  entries: EntryDto[]; total: number; offset: number; limit: number;
}

export const WRITE_RESULT_LABEL: Record<string, string> = {
  WRITTEN: 'Écrit (confirmé en base)',
  NOT_PERSISTED: 'Non enregistré',
  FAILED: 'Écriture en échec',
  NOT_WRITTEN: 'Examiné, non modifié',
  DECIDED_NOT_CONFIRMED: 'Décidé, non confirmé',
  NOT_EXAMINED: 'Non examiné',
  OBSERVED: 'Valeur en place relue',
};
const RESULT_TONE: Record<string, string> = {
  WRITTEN: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  NOT_PERSISTED: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
  FAILED: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
  DECIDED_NOT_CONFIRMED: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
  NOT_WRITTEN: 'bg-[color:var(--bg-input)] text-[color:var(--text-secondary)] border-[color:var(--border-subtle)]',
  NOT_EXAMINED: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] border-[color:var(--border-warning)]',
  OBSERVED: 'bg-[color:var(--bg-input)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
};
export const STATUS_LABEL: Record<string, string> = {
  SUCCESS: 'Réussi', PARTIAL: 'Partiel — anomalies', FAILED: 'Échec', NO_CHANGE: 'Sans modification',
};
const STATUS_TONE: Record<string, string> = {
  SUCCESS: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  PARTIAL: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] border-[color:var(--border-warning)]',
  FAILED: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
  NO_CHANGE: 'bg-[color:var(--bg-input)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
};
const SECTION_LABEL: Record<string, string> = {
  ANALYSIS_RUN: 'Run d’analyse', PROPOSAL: 'Propositions', EXTRACTION: 'Extraction brute', FACT: 'Faits / attributs',
  DECLARED: 'Déclaré non enregistré', TABLE: 'Tableaux', CELL: 'Cellules', SOURCE_UNIT: 'Unités du document',
  UNRESOLVED: 'Faits non résolus', COVERAGE: 'Couverture', OPERATION_CANDIDATE: 'Candidats Opération',
  PROJECTION: 'Projection sur fiche', EVIDENCE: 'Preuves', DOCUMENT: 'Document', LINK: 'Liens document ↔ biens',
  RULE: 'Règles « À traiter »', FIELD: 'Champs examinés', NOT_EXAMINED: 'Données non examinées',
  // Lot 60 (T6) : chaque échéance candidate, affichée OU écartée, et la justification IA référencée.
  INTERPELLATION: 'Interpellations T6 (affichées, différées, écartées)', INTERPELLATION_AI: 'Évaluations IA (justification)',
  // Lot 61 : extract brut déterministe (couche texte par page), écrit avant le modèle.
  RAW_EXTRACT: 'Extract brut (lecture déterministe)',
  // Lot 61 : section « Harmonisation documentaire » (T3) — propositions IA et renommages confirmés distincts.
  NAMING_RENAME: 'Harmonisation documentaire — renommages (proposition IA → issue en base)',
  NAMING_FAMILY: 'Harmonisation documentaire — familles (analyse IA)',
  NAMING_GROUP: 'Harmonisation documentaire — lots non examinés',
};

/** Lot 61 : phases T1 séparées (extraction, structuration, persistance). */
const PHASE_LABEL: Record<string, string> = { extraction: 'Extraction', structuring: 'Structuration', persistence: 'Persistance' };
const PHASE_STATE: Record<string, { label: string; tone: string }> = {
  SUCCEEDED: { label: 'réussie', tone: RESULT_TONE.WRITTEN },
  PARTIAL: { label: 'partielle', tone: RESULT_TONE.NOT_EXAMINED },
  FAILED: { label: 'en échec', tone: RESULT_TONE.FAILED },
  NOT_RUN: { label: 'non exécutée', tone: RESULT_TONE.OBSERVED },
};

/** Statut séparé des trois phases T1 (`sources.phases` du rapport), desktop et mobile. */
export function T1PhasesLine({ phases }: { phases: unknown }) {
  if (!phases || typeof phases !== 'object') return null;
  const p = phases as Record<string, { state?: string; detail?: Record<string, unknown> } | undefined>;
  return (
    <div className="space-y-1" data-testid="execution-report-phases">
      <p className="font-medium text-[color:var(--text-primary)]">Phases</p>
      <div className="flex flex-wrap gap-1">
        {(['extraction', 'structuring', 'persistence'] as const).map((k) => {
          const st = PHASE_STATE[p[k]?.state ?? 'NOT_RUN'] ?? PHASE_STATE.NOT_RUN;
          return <span key={k} className={pill(st.tone)} data-testid={`execution-report-phase-${k}`}>{PHASE_LABEL[k]} · {st.label}</span>;
        })}
      </div>
      {(['extraction', 'structuring', 'persistence'] as const).map((k) => p[k]?.detail && Object.keys(p[k]!.detail!).length > 0 ? (
        <p key={k} className="text-[color:var(--text-muted)] break-all">{PHASE_LABEL[k]} : {JSON.stringify(p[k]!.detail)}</p>
      ) : null)}
    </div>
  );
}

const pill = (tone: string) => `text-xs px-2 py-0.5 rounded-full border ${tone}`;
const fmt = (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));
export const reportTitle = (r: Pick<ReportSummaryDto, 'id' | 'treatment' | 'scope' | 'fileId' | 'targetId' | 'assetId'>) =>
  `${r.treatment} #${r.id} · ${r.treatment === 'T1' ? `document ${r.fileId ?? '—'}`
    // Lot 60 : décision d'interpellation de l'accueil, pour un utilisateur (ou le compte en pré-génération).
    : r.treatment === 'T6' ? `accueil · ${r.targetId != null ? `utilisateur ${r.targetId}` : 'compte (pré-génération)'}`
    // Lot 61 : harmonisation documentaire du passage T3 du compte.
    : r.scope === 'DOCUMENT_NAMING' ? `harmonisation documentaire · compte ${r.targetId ?? '—'}`
    : `${r.scope === 'ASSET' ? 'bien' : r.scope === 'EQUIPMENT' ? 'équipement' : 'pièce'} ${r.targetId ?? r.assetId ?? '—'}`}`;

/** En-tête compact d'un rapport (liste, corrélations). */
export function ReportHeaderLine({ r, onOpen }: { r: ReportSummaryDto; onOpen?: (id: number) => void }) {
  const c = r.counters ?? {};
  const resume = r.treatment === 'T1'
    ? `${c.factsPersisted ?? 0}/${c.factsDeclared ?? 0} fait(s) enregistré(s) · ${c.evidenceWritten ?? 0} preuve(s) · ${c.factsNotPersisted ?? 0} non enregistré(s)`
    : r.treatment === 'T6'
      ? `${c.candidates ?? 0} échéance(s) évaluée(s) · ${c.shown ?? 0} affichée(s) · ${c.deferred ?? 0} différée(s) · ${c.suppressed ?? 0} écartée(s) · seuil ${c.thresholdDays ?? '—'} j`
    : r.scope === 'DOCUMENT_NAMING'
      ? `${c.groupsExamined ?? 0} lot(s) examiné(s) · ${c.documentsExamined ?? 0} document(s) · ${c.families ?? 0} famille(s) (${c.inconsistentFamilies ?? 0} incohérente(s)) · ${c.proposals ?? 0} proposition(s) IA · ${c.written ?? 0} renommage(s) écrit(s) confirmé(s) · ${c.refused ?? 0} refusé(s) · ${c.conflicts ?? 0} conflit(s)${c.promptUnavailable ? ' · prompt T3 sans branche DOCUMENT_NAMING' : ''}`
    : `${c.examined ?? 0} champ(s) examiné(s) · ${c.written ?? 0} écrit(s) confirmé(s) · ${c.failed ?? 0} échec(s) · ${c.notExamined ?? 0} non examiné(s)`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={pill(STATUS_TONE[r.status] ?? STATUS_TONE.NO_CHANGE)}>{STATUS_LABEL[r.status] ?? r.status}</span>
      {onOpen ? (
        <button type="button" className="font-medium text-[color:var(--accent)] hover:underline" onClick={() => onOpen(r.id)}>{reportTitle(r)}</button>
      ) : <span className="font-medium text-[color:var(--text-primary)]">{reportTitle(r)}</span>}
      <span className="text-[color:var(--text-muted)]">{resume}</span>
      {!r.reportComplete && <span className="text-[color:var(--text-danger)]">rapport incomplet : {r.reportError ?? 'motif inconnu'}</span>}
      <span className="text-[color:var(--text-muted)]">{new Date(r.createdAt).toLocaleString('fr-FR')}</span>
    </div>
  );
}

/** Rapports rattachés à un appel du détail d'exécution. */
export function LinkedExecutionReports({ callId, treatment }: { callId: number; treatment: string | null }) {
  const [data, setData] = useState<{ available: boolean; reports: ReportSummaryDto[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let vivant = true;
    apiClient.get<{ available: boolean; reports: ReportSummaryDto[] }>(`/api/admin/ai/executions/${callId}/reports`)
      .then((d) => { if (vivant) setData(d); })
      .catch(() => { if (vivant) setData({ available: false, reports: [] }); });
    return () => { vivant = false; };
  }, [callId]);
  if (treatment !== 'T1' && treatment !== 'T3' && treatment !== 'T6') return null;
  return (
    <section className="space-y-2" data-testid="execution-reports">
      <h3 className="vb-app-subsection">Rapport d&apos;exécution {treatment} (données BDD)</h3>
      {!data ? (
        <p className="text-xs text-[color:var(--text-muted)] flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement…</p>
      ) : data.reports.length === 0 ? (
        <p className="text-xs text-[color:var(--text-warning-soft)]" data-testid="execution-report-not-traced">
          Non tracé : aucun rapport n&apos;a été enregistré pour cette exécution (exécution antérieure au lot 58C, ou rapport non écrit).
          Rien n&apos;est reconstitué.
        </p>
      ) : (
        <div className="space-y-2">
          {data.reports.map((r) => (
            <div key={r.id} className="rounded-lg border border-[color:var(--border-subtle)] p-2 space-y-2">
              <ReportHeaderLine r={r} onOpen={(id) => setOpen(open === id ? null : id)} />
              {open === r.id && <ExecutionReportView reportId={r.id} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Détail complet d'un rapport : étapes, sources, répartition, lignes, corrélations, export. */
export function ExecutionReportView({ reportId: initialId }: { reportId: number }) {
  const [reportId, setReportId] = useState(initialId);
  const [detail, setDetail] = useState<DetailDto | null>(null);
  const [filter, setFilter] = useState<{ section?: string; writeResult?: string }>({});
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const LIMIT = 100;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ offset: String(offset), limit: String(LIMIT) });
      if (filter.section) q.set('section', filter.section);
      if (filter.writeResult) q.set('writeResult', filter.writeResult);
      setDetail(await apiClient.get<DetailDto>(`/api/admin/ai/execution-reports/${reportId}?${q}`));
    } catch {
      toast.error('Rapport indisponible.');
    } finally { setLoading(false); }
  }, [reportId, offset, filter]);
  useEffect(() => { load(); }, [load]);

  const aller = (id: number) => { setReportId(id); setOffset(0); setFilter({}); };

  if (!detail) {
    return <p className="text-xs text-[color:var(--text-muted)] flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement du rapport…</p>;
  }
  const { report: r, correlations: corr } = detail;
  const anomalies = detail.breakdown.filter((b) => ['NOT_PERSISTED', 'FAILED', 'DECIDED_NOT_CONFIRMED', 'NOT_EXAMINED'].includes(b.writeResult));
  return (
    <div className="space-y-3 text-xs" data-testid="execution-report-view">
      <div className="flex flex-wrap items-center gap-2">
        <ReportHeaderLine r={r} />
        <span className="flex-1" />
        <a href={`/api/admin/ai/execution-reports/${r.id}/export?download=1`} className="inline-flex" data-testid="execution-report-export">
          <Button size="sm" variant="outline" type="button"><Download className="w-3.5 h-3.5 mr-1.5" /> Export JSON complet</Button>
        </a>
      </div>
      <p className="text-[color:var(--text-muted)] break-all">
        Compte {r.accountId}{r.jobId != null && ` · job ${r.jobId}`}{r.analysisRunId != null && ` · run d’analyse ${r.analysisRunId}`}
        {r.extractionId != null && ` · extraction ${r.extractionId}`}{r.reconciliationRunId != null && ` · run T3 ${r.reconciliationRunId}`}
        {r.accountRunId != null && ` · passage compte ${r.accountRunId}`}{r.traceIds.length > 0 && ` · trace ${r.traceIds.join(', ')}`}
      </p>
      {r.entriesReportId && (
        <p className="text-[color:var(--text-muted)]">Passage identique au rapport #{r.entriesReportId} (aucune écriture) : ses lignes sont affichées.</p>
      )}

      {/* Corrélation T1 ↔ T3 et historique des analyses du document */}
      {(corr.origin || corr.followups.length > 0 || corr.previousForSameDocument.length > 0) && (
        <div className="space-y-1">
          {corr.origin && <div><span className="text-[color:var(--text-muted)]">Analyse T1 d’origine : </span><ReportHeaderLine r={corr.origin} onOpen={aller} /></div>}
          {corr.followups.length > 0 && <p className="text-[color:var(--text-muted)]">Passages T3 déclenchés ensuite :</p>}
          {corr.followups.map((f) => <ReportHeaderLine key={f.id} r={f} onOpen={aller} />)}
          {corr.previousForSameDocument.length > 0 && <p className="text-[color:var(--text-muted)]">Autres analyses de ce document (rapports conservés) :</p>}
          {corr.previousForSameDocument.map((f) => <ReportHeaderLine key={f.id} r={f} onOpen={aller} />)}
        </div>
      )}

      {r.treatment === 'T1' && <T1PhasesLine phases={(r.sources ?? {}).phases} />}
      <div>
        <p className="font-medium text-[color:var(--text-primary)]">Étapes</p>
        <ul className="space-y-0.5">
          {r.steps.map((s, i) => (
            <li key={i} className={s.status === 'FAILED' ? 'text-[color:var(--text-danger)]' : 'text-[color:var(--text-secondary)]'}>
              {s.status === 'FAILED' ? <AlertTriangle className="inline w-3 h-3 mr-1" /> : null}
              {s.step} · {s.status === 'OK' ? 'OK' : s.status === 'FAILED' ? 'ÉCHEC' : 'ignorée'}{s.error ? ` — ${s.error}` : ''}
              {s.detail ? <span className="text-[color:var(--text-muted)]"> {JSON.stringify(s.detail)}</span> : null}
            </li>
          ))}
        </ul>
      </div>
      {Object.keys(r.sources ?? {}).length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium text-[color:var(--text-primary)]">Sources de connaissance{r.treatment === 'T3' ? ' consultées / non consultées' : ''}</summary>
          <div className="mt-1 flex items-start gap-1">
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[color:var(--text-secondary)]">{JSON.stringify(r.sources, null, 2)}</pre>
            <CopyBlockButton value={r.sources} label="les sources" />
          </div>
        </details>
      )}

      {anomalies.length > 0 && (
        <p className="text-[color:var(--text-danger)]" data-testid="execution-report-anomalies">
          Anomalies : {anomalies.map((a) => `${a.count} × ${SECTION_LABEL[a.section] ?? a.section} — ${WRITE_RESULT_LABEL[a.writeResult] ?? a.writeResult}`).join(' · ')}
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        <button type="button" onClick={() => { setFilter({}); setOffset(0); }}
          className={pill(!filter.section && !filter.writeResult ? RESULT_TONE.WRITTEN : RESULT_TONE.OBSERVED)}>Tout ({r.entriesReportId ? detail.total : r.entryCount})</button>
        {detail.breakdown.map((b) => (
          <button key={`${b.section}-${b.writeResult}`} type="button" onClick={() => { setFilter({ section: b.section, writeResult: b.writeResult }); setOffset(0); }}
            className={pill(filter.section === b.section && filter.writeResult === b.writeResult ? (RESULT_TONE[b.writeResult] ?? RESULT_TONE.OBSERVED) : RESULT_TONE.OBSERVED)}>
            {SECTION_LABEL[b.section] ?? b.section} · {WRITE_RESULT_LABEL[b.writeResult] ?? b.writeResult} ({b.count})
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-[color:var(--text-muted)] flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement…</p>
      ) : (
        <ul className="divide-y divide-[color:var(--border-subtle)] rounded-lg border border-[color:var(--border-subtle)]">
          {detail.entries.length === 0 && <li className="p-2 text-[color:var(--text-muted)]">Aucune ligne.</li>}
          {detail.entries.map((e) => <EntryRow key={e.seq} e={e} reportId={r.id} onOpenReport={aller} />)}
        </ul>
      )}
      {detail.total > LIMIT && (
        <div className="flex items-center justify-between">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}><ChevronLeft className="w-3.5 h-3.5" /></Button>
          <span className="text-[color:var(--text-muted)]">{offset + 1} – {Math.min(offset + LIMIT, detail.total)} sur {detail.total}</span>
          <Button size="sm" variant="outline" disabled={offset + LIMIT >= detail.total} onClick={() => setOffset(offset + LIMIT)}><ChevronRight className="w-3.5 h-3.5" /></Button>
        </div>
      )}
    </div>
  );
}

function EntryRow({ e, reportId, onOpenReport }: { e: EntryDto; reportId: number; onOpenReport: (id: number) => void }) {
  const [content, setContent] = useState<{ state: string; content?: unknown; reason?: string } | null>(null);
  const t1 = typeof e.links?.t1ReportId === 'number' ? e.links.t1ReportId as number : null;
  const charger = async () => {
    try {
      const r = await apiClient.get<{ content: { state: string; content?: unknown; reason?: string } }>(`/api/admin/ai/execution-reports/${reportId}?seq=${e.seq}`);
      setContent(r.content);
    } catch { toast.error('Contenu indisponible.'); }
  };
  return (
    <li className="p-2 space-y-1" data-testid="execution-report-entry" data-write-result={e.writeResult}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={pill(RESULT_TONE[e.writeResult] ?? RESULT_TONE.OBSERVED)}>{WRITE_RESULT_LABEL[e.writeResult] ?? e.writeResult}</span>
        <span className="text-[color:var(--text-muted)]">{SECTION_LABEL[e.section] ?? e.section}</span>
        {(e.fieldKey || e.label) && <span className="font-medium text-[color:var(--text-primary)] break-all">{e.label ?? ''}{e.label && e.fieldKey ? ' · ' : ''}{e.fieldKey ?? ''}</span>}
        {e.entityType && <span className="text-[color:var(--text-muted)]">→ {e.entityType}{e.entityId != null ? ` #${e.entityId}` : ' (sans cible)'}</span>}
      </div>
      <p className="text-[color:var(--text-muted)] break-all">
        {e.tableName ?? '—'}{e.recordId ? ` #${e.recordId}` : ''}{e.columnPath ? ` · ${e.columnPath}` : ''}
        {e.valueType ? ` · ${e.valueType}` : ''}{e.recordStatus ? ` · statut ${e.recordStatus}` : ''}
      </p>
      {e.oldValue !== null && e.oldValue !== undefined && (
        <p className="text-[color:var(--text-secondary)] break-all">Ancienne valeur : <span className="whitespace-pre-wrap">{fmt(e.oldValue)}</span></p>
      )}
      {e.ref ? (
        <div className="text-[color:var(--text-secondary)]">
          Contenu référencé ({e.ref.chars.toLocaleString('fr-FR')} caractères, SHA-256 {e.ref.sha256.slice(0, 12)}…)
          {' '}<button type="button" className="text-[color:var(--accent)] hover:underline" onClick={charger}>Afficher le contenu complet</button>
          {content && (content.state === 'TRACED'
            ? <div className="mt-1 flex items-start gap-1"><pre className="min-w-0 flex-1 whitespace-pre-wrap break-all max-h-80 overflow-y-auto">{fmt(content.content)}</pre><CopyBlockButton value={content.content} label="le contenu" /></div>
            : <p className="text-[color:var(--text-warning-soft)]">Non tracé : {content.reason}</p>)}
        </div>
      ) : e.value !== null && e.value !== undefined ? (
        <div className="flex items-start gap-1 text-[color:var(--text-secondary)]">
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all">{(e.section === 'FIELD' || e.section === 'NAMING_RENAME') && e.writeResult !== 'WRITTEN' ? `Valeur proposée (non écrite) : ${fmt(e.value)}` : fmt(e.value)}</pre>
          <CopyBlockButton value={e.value} label="la valeur" />
        </div>
      ) : null}
      {(e.reasonCode || e.reason) && (
        <p className={['FAILED', 'NOT_PERSISTED', 'DECIDED_NOT_CONFIRMED'].includes(e.writeResult) ? 'text-[color:var(--text-danger)]' : 'text-[color:var(--text-secondary)]'}>
          Motif : {e.reasonCode ?? ''}{e.reason ? ` — ${e.reason}` : ''}
        </p>
      )}
      {e.links && (
        <details>
          <summary className="cursor-pointer text-[color:var(--text-muted)]">Traçabilité (preuve, fait, décision, JSON complet)</summary>
          <div className="mt-1 flex items-start gap-1">
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[color:var(--text-secondary)]">{JSON.stringify(e.links, null, 2)}</pre>
            <CopyBlockButton value={e} label="la ligne" />
          </div>
        </details>
      )}
      {t1 != null && t1 !== reportId && (
        <button type="button" className="text-[color:var(--accent)] hover:underline" onClick={() => onOpenReport(t1)}>Ouvrir le rapport T1 #{t1} de la preuve</button>
      )}
    </li>
  );
}

/** Onglet « Rapports T1/T3 » : tous les rapports, y compris passages T3 sans appel modèle. */
export function ExecutionReportsTab({ accountId }: { accountId: string }) {
  const [treatment, setTreatment] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ rows: ReportSummaryDto[]; total: number; available: boolean } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const q = new URLSearchParams({ offset: String(offset), limit: '50' });
    if (treatment) q.set('treatment', treatment);
    if (status) q.set('status', status);
    if (accountId) q.set('accountId', accountId);
    apiClient.get<{ rows: ReportSummaryDto[]; total: number; available: boolean }>(`/api/admin/ai/execution-reports?${q}`)
      .then(setData).catch(() => toast.error('Rapports indisponibles.'));
  }, [treatment, status, offset, accountId]);
  const SELECT = 'rounded-lg border border-[color:var(--input)] bg-[color:var(--bg-input)] px-3 py-2 text-sm text-[color:var(--text-primary)]';
  return (
    <div className="space-y-3" data-testid="execution-reports-tab">
      <div className="flex flex-wrap gap-2">
        <select value={treatment} onChange={(e) => { setTreatment(e.target.value); setOffset(0); }} className={SELECT} aria-label="Traitement">
          <option value="">T1, T3 et T6</option><option value="T1">T1 (documents)</option><option value="T3">T3 (biens, entités)</option>
          <option value="T6">T6 (interpellations de l’accueil)</option>
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} className={SELECT} aria-label="Statut">
          <option value="">Tous les statuts</option>
          {Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span className="text-sm text-[color:var(--text-muted)] ml-auto">{data?.total ?? 0} rapport(s)</span>
      </div>
      {data && !data.available && <p className="text-sm text-[color:var(--text-warning-soft)]">Migration 0421 non appliquée : aucun rapport.</p>}
      <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] divide-y divide-[color:var(--border-subtle)]">
        {data?.rows.length === 0 && <p className="p-4 text-sm text-[color:var(--text-muted)]">Aucun rapport. Les exécutions antérieures au lot 58C sont « non tracées ».</p>}
        {data?.rows.map((r) => (
          <div key={r.id} className="px-3 py-2 space-y-2">
            <ReportHeaderLine r={r} onOpen={(id) => setOpen(open === id ? null : id)} />
            {open === r.id && <ExecutionReportView reportId={r.id} />}
          </div>
        ))}
      </div>
      {(data?.total ?? 0) > 50 && (
        <div className="flex items-center justify-between">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}><ChevronLeft className="w-3.5 h-3.5" /></Button>
          <span className="text-sm text-[color:var(--text-muted)]">{offset + 1} – {Math.min(offset + 50, data!.total)} sur {data!.total}</span>
          <Button size="sm" variant="outline" disabled={offset + 50 >= data!.total} onClick={() => setOffset(offset + 50)}><ChevronRight className="w-3.5 h-3.5" /></Button>
        </div>
      )}
    </div>
  );
}
