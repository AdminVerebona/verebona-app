"use client";

/**
 * Détail d'une exécution métier — lot 84D (CDC Pilotage IA V2 P3 : BO-03,
 * BO-08, BO-10, LOG-07, LOG-08 ; décision PO 15).
 *
 * Tiroir (composant de base 81F : zones sûres, retour Android, X tactile) :
 *   · traitement, objet, état final, origine, dates (règle de période) ;
 *   · CE QUI MANQUE et la cause (établie, ou « non établie » — jamais devinée) ;
 *   · tentatives et appels (TOUS, quel que soit le modèle) avec l'état de
 *     capture de chaque échange ; le CONTENU (prompt, contexte, réponse)
 *     reste derrière l'accès existant `AI_MODEL_OUTPUT_ADMIN_IDS`, vérifié
 *     côté serveur et journalisé ;
 *   · écritures (rapports d'exécution, lignes à la demande — accès journalisé) ;
 *   · relance EXISTANTE applicable (File IA, complétude T1, Supervision T6) ;
 *   · copie et export JSON unitaire.
 * Présentation pure (`ExecutionDetailView`) testable sans réseau.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { apiClient } from '@/lib/api-client';
import type { BusinessExecutionDetailDto, RelaunchOption } from '@/services/ai/business-execution/detail-model';
import { BusinessOutcomeBadge, nativeText } from './BusinessExecutionsPanel';
import { CopyBlockButton } from './CopyJson';
import { ModelOutputs } from './ExecutionDiagnosisPanel';
import { ExecutionReportView } from './ExecutionReportPanel';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : '—');
const cost = (m: number | null) => (m === null ? 'tarif inconnu' : m === 0 ? '0' : `${(m / 1_000_000).toFixed(4)} $`);
const CAPTURE: Record<string, string> = {
  CAPTURED: 'capturé', PARTIAL: 'capture partielle', NOT_CAPTURED: 'non capturé', MASKED: 'capturé, masqué', NOT_SENT: 'aucun envoi', NO_RESPONSE: 'aucune réponse',
};

interface RelaunchState { [kind: string]: 'running' | 'done' | 'error' | undefined }

/** Rendu pur du détail (les actions sont injectées). */
export function ExecutionDetailView({ d, onRelaunch, relaunch = {}, onOpenCall }: {
  d: BusinessExecutionDetailDto;
  onRelaunch?: (o: RelaunchOption) => void;
  relaunch?: RelaunchState;
  onOpenCall?: (usageEventId: number) => void;
}) {
  const x = d.execution;
  const [reportOpen, setReportOpen] = useState<number | null>(null);
  const traces = [...new Map(d.calls.filter((c) => c.traceId).map((c) => [c.traceId as string, c.id])).entries()];
  return (
    <div className="space-y-4 min-w-0" data-testid="execution-detail">
      <section className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <BusinessOutcomeBadge x={x} />
          <span className="text-sm font-medium text-[color:var(--text-primary)]">{x.treatment}{x.mode ? ` · ${x.mode}` : ''} · {x.natureLabel}</span>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-[color:var(--text-muted)]">Objet</dt><dd className="break-all text-[color:var(--text-secondary)]">{x.objectType ?? '—'} {x.objectId ?? ''}{x.accountId !== null ? ` · compte ${x.accountId}` : ''}</dd>
          <dt className="text-[color:var(--text-muted)]">Origine</dt><dd className="text-[color:var(--text-secondary)]">{x.originLabel}{x.resumptions ? ` · ${x.resumptions} reprise(s)` : ''}</dd>
          <dt className="text-[color:var(--text-muted)]">Déclenchée · terminée</dt><dd className="text-[color:var(--text-secondary)]">{fmt(x.triggeredAt)} · {fmt(x.finishedAt)}</dd>
          <dt className="text-[color:var(--text-muted)]">Date de référence</dt><dd className="text-[color:var(--text-secondary)]">{fmt(x.referenceAt)} (fin si finale, sinon dernière activité)</dd>
          <dt className="text-[color:var(--text-muted)]">Résultat natif</dt><dd className="break-all text-[color:var(--text-secondary)]">{nativeText(x)}</dd>
          {x.previousExecutionId && <><dt className="text-[color:var(--text-muted)]">Exécution précédente</dt><dd className="break-all font-mono text-[color:var(--text-secondary)]">{x.previousExecutionId}</dd></>}
          <dt className="text-[color:var(--text-muted)]">Identifiant</dt><dd className="break-all font-mono text-[color:var(--text-secondary)]">{x.id}</dd>
        </dl>
      </section>

      <section className="space-y-1" data-testid="execution-missing">
        <h3 className="vb-app-subsection">Ce qui manque</h3>
        {d.missing.length === 0
          ? <p className="text-xs text-[color:var(--text-muted)]">{x.outcome === 'NOT_FINAL' ? 'Exécution non finale : aucune issue établie à ce stade.' : 'Rien : les résultats et contrôles obligatoires sont satisfaits.'}</p>
          : <ul className="list-disc pl-4 text-xs text-[color:var(--text-secondary)] space-y-0.5">{d.missing.map((m, i) => <li key={i} className="break-words">{m}</li>)}</ul>}
        <p className="text-xs text-[color:var(--text-secondary)] break-words" data-testid="execution-cause">
          Cause : {d.cause ?? (d.causeUnknown ? 'non établie (aucune preuve enregistrée : rien n’est supposé)' : '—')}
        </p>
      </section>

      <section className="space-y-1.5" data-testid="execution-calls">
        <h3 className="vb-app-subsection">Tentatives et appels ({d.calls.length}{d.callsTruncated ? '+' : ''})</h3>
        {d.jobs.length > 0 && (
          <ul className="text-xs text-[color:var(--text-secondary)] space-y-0.5">
            {d.jobs.map((j) => (
              <li key={j.id} className="break-words">
                Travail {j.id} · {j.status}{j.businessResult ? ` · ${j.businessResult}` : ''} · {j.attempts} tentative(s) · origine {j.origin ?? '—'}
                {j.lastError && <span className="text-[color:var(--text-danger)]"> — {j.lastError}</span>}
              </li>
            ))}
          </ul>
        )}
        {d.calls.length === 0
          ? <p className="text-xs text-[color:var(--text-muted)]">Aucun appel au modèle rattaché (traitement tranché sans IA, ou appels antérieurs à la corrélation : non déterminable).</p>
          : (
            <ul className="divide-y divide-[color:var(--border-subtle)] rounded-lg border border-[color:var(--border-subtle)]">
              {d.calls.map((c) => (
                <li key={c.id} className="p-2 text-xs space-y-0.5 min-w-0" data-testid="execution-call">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={c.status === 'success' ? 'text-[color:var(--text-success)]' : 'text-[color:var(--text-danger)]'}>{c.status === 'success' ? 'succès' : 'échec'}</span>
                    <span className="text-[color:var(--text-primary)]">{c.operationCode ?? '—'}</span>
                    <span className="text-[color:var(--text-muted)] break-all">{c.model ?? 'modèle inconnu'}{c.modelRank ? ` (${c.modelRank})` : ''}{c.callKind === 'repair' ? ' · réparation' : ''}</span>
                    {onOpenCall && <button type="button" onClick={() => onOpenCall(c.id)} className="text-[color:var(--accent)] hover:underline">appel #{c.id}</button>}
                  </p>
                  <p className="text-[color:var(--text-muted)] break-words">
                    {fmt(c.createdAt)} · {c.durationMs ?? '—'} ms · {cost(c.costMicros)}{c.errorCode ? ` · ${c.errorCode}` : ''}
                    {' · '}échange : {c.captureStatus ? `${CAPTURE[c.captureStatus] ?? c.captureStatus}${c.promptChars != null ? ` (prompt ${c.promptChars} car., réponse ${c.responseChars ?? 0} car.)` : ''}` : 'non conservé historiquement'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        {traces.length > 0 && (
          d.canReadContents
            ? (
              <div className="space-y-2" data-testid="execution-contents">
                {traces.map(([t, callId]) => (
                  <div key={t} className="space-y-1 min-w-0">
                    <p className="text-xs text-[color:var(--text-muted)] break-all">Trace {t}</p>
                    <ModelOutputs callId={callId} />
                  </div>
                ))}
              </div>
            )
            : (
              <p className="text-xs text-[color:var(--text-muted)]" data-testid="execution-contents-restricted">
                Contenu des échanges (prompt, contexte, réponse) : accès réservé aux administrateurs habilités (AI_MODEL_OUTPUT_ADMIN_IDS).
              </p>
            )
        )}
      </section>

      <section className="space-y-1.5" data-testid="execution-writes">
        <h3 className="vb-app-subsection">Écritures</h3>
        {d.reports.length === 0
          ? <p className="text-xs text-[color:var(--text-muted)]">Aucun rapport d’exécution rattaché (T2, T4, T6 : écritures propres au traitement, voir le résultat natif).</p>
          : d.reports.map((r) => (
            <div key={r.id} className="text-xs space-y-1 min-w-0">
              <p className="flex flex-wrap items-center gap-x-2 text-[color:var(--text-secondary)]">
                <span>Rapport {r.id} · {r.status}</span>
                <span className="text-[color:var(--text-muted)] break-words">{Object.entries(r.writes).map(([k, n]) => `${k} : ${n}`).join(' · ') || 'aucune ligne'}</span>
                {r.failedSteps.length > 0 && <span className="text-[color:var(--text-danger)]">étapes en échec : {r.failedSteps.join(', ')}</span>}
                <button type="button" className="text-[color:var(--accent)] hover:underline" onClick={() => setReportOpen(reportOpen === r.id ? null : r.id)}>
                  {reportOpen === r.id ? 'Masquer les écritures' : 'Voir les écritures'}
                </button>
              </p>
              {reportOpen === r.id && <ExecutionReportView reportId={r.id} />}
            </div>
          ))}
      </section>

      <section className="space-y-1.5" data-testid="execution-relaunch">
        <h3 className="vb-app-subsection">Relance</h3>
        {d.relaunch.length === 0
          ? <p className="text-xs text-[color:var(--text-muted)]">Aucune relance existante n’est applicable à cette exécution.</p>
          : d.relaunch.map((o) => (
            <div key={o.kind} className="flex flex-wrap items-center gap-2">
              {o.endpoint
                ? (
                  <Button size="sm" variant="outline" disabled={!onRelaunch || relaunch[o.kind] === 'running' || relaunch[o.kind] === 'done'}
                    onClick={() => onRelaunch?.(o)} data-testid={`relaunch-${o.kind}`}>
                    {relaunch[o.kind] === 'running' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}
                    {o.label}
                  </Button>
                )
                : o.href && <Link href={o.href} className="text-sm text-[color:var(--accent)] hover:underline">{o.label}</Link>}
              <span className="text-xs text-[color:var(--text-muted)] min-w-0 break-words">
                {relaunch[o.kind] === 'done' ? 'Relance acceptée (journalisée).' : relaunch[o.kind] === 'error' ? 'Relance refusée (voir le message).' : o.note}
              </span>
            </div>
          ))}
      </section>
    </div>
  );
}

/** Tiroir du détail : lecture, relance existante, export unitaire. */
export function BusinessExecutionDetailSheet({ id, onClose, onOpenCall }: { id: string | null; onClose: () => void; onOpenCall?: (usageEventId: number) => void }) {
  const [d, setD] = useState<BusinessExecutionDetailDto | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [relaunch, setRelaunch] = useState<RelaunchState>({});

  useEffect(() => {
    if (!id) return;
    let vivant = true;
    setD(null); setErreur(null); setRelaunch({});
    apiClient.get<BusinessExecutionDetailDto>(`/api/admin/ai/business-executions/${encodeURIComponent(id)}`)
      .then((r) => { if (vivant) setD(r); })
      .catch((e: { message?: string }) => { if (vivant) setErreur(e?.message ?? 'Détail indisponible.'); });
    return () => { vivant = false; };
  }, [id]);

  const relancer = async (o: RelaunchOption) => {
    if (!o.endpoint) return;
    setRelaunch((r) => ({ ...r, [o.kind]: 'running' }));
    try {
      await apiClient.post(o.endpoint, o.body ?? {});
      setRelaunch((r) => ({ ...r, [o.kind]: 'done' }));
      toast.success('Relance acceptée.');
    } catch (e) {
      setRelaunch((r) => ({ ...r, [o.kind]: 'error' }));
      toast.error((e as Error).message || 'Relance refusée.');
    }
  };

  const exportUrl = (contenus: boolean) => `/api/admin/ai/business-executions/${encodeURIComponent(id ?? '')}/export?download=1${contenus ? '&contenus=1' : ''}`;

  return (
    <Sheet open={id !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 gap-0 overflow-hidden" data-execution-detail-sheet>
        <div className="px-4 pt-4 pb-3 border-b border-[color:var(--border-subtle)] space-y-1.5">
          <SheetTitle className="break-words">Exécution {id}</SheetTitle>
          <SheetDescription className="text-xs">Détail, causes, appels, écritures et relance — consultation journalisée.</SheetDescription>
          {d && (
            <div className="flex flex-wrap gap-2">
              <CopyBlockButton value={d} label="l’exécution" />
              <a href={exportUrl(false)} className="inline-flex items-center gap-1 text-xs text-[color:var(--accent)] hover:underline" data-testid="unit-export">
                <Download className="w-3.5 h-3.5" /> Export JSON
              </a>
              {d.canReadContents && (
                <a href={exportUrl(true)} className="inline-flex items-center gap-1 text-xs text-[color:var(--accent)] hover:underline" data-testid="unit-export-contents">
                  <Download className="w-3.5 h-3.5" /> Export JSON avec échanges
                </a>
              )}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {erreur && <p className="text-sm text-[color:var(--text-danger)] break-words">{erreur}</p>}
          {!d && !erreur && <p className="text-sm text-[color:var(--text-muted)] flex items-center"><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Chargement…</p>}
          {d && <ExecutionDetailView d={d} onRelaunch={relancer} relaunch={relaunch} onOpenCall={onOpenCall} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
