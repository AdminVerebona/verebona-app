"use client";

/**
 * Exécutions métier — lot 83C (CDC Pilotage IA V2, phase P2).
 *
 * Remplace le bloc « Échecs des sept derniers jours », qui additionnait des
 * APPELS en échec et les présentait comme autant d'échecs (BO-04, SEM-05) :
 * chaque exécution métier est désormais comptée UNE fois, selon son issue
 * finale calculée depuis les états natifs (Réussie / Incomplète / Échouée /
 * non finale). Les incidents d'appels restent consultables, dans un volet
 * TECHNIQUE replié, sans être confondus avec des documents en échec.
 *
 * Phase P2 seulement : récapitulatif par traitement et liste courte des
 * exécutions échouées et incomplètes (cause, résultat natif, appels). Les
 * deux cartes, le Journal complet et les exports sont la phase P3.
 *
 * Desktop et mobile : grille qui passe en une colonne, lignes qui
 * s'enroulent, aucune largeur fixe.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import type { BusinessExecutionDto } from '@/services/ai/business-execution/dto';
import type { BusinessOutcome, TreatmentSummary } from '@/services/ai/business-execution/types';

const BADGE: Record<BusinessOutcome, string> = {
  SUCCEEDED: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  INCOMPLETE: 'bg-[color:var(--bg-warning)] text-[color:var(--text-warning-soft)] border-[color:var(--border-warning)]',
  FAILED: 'bg-[color:var(--bg-danger)] text-[color:var(--text-danger)] border-[color:var(--border-danger)]',
  NOT_FINAL: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)] border-[color:var(--border-subtle)]',
  VOID: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
  UNDETERMINED: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)] border-[color:var(--border-subtle)]',
};

/** Qualification administrative d'une exécution métier (pastille). */
export function BusinessOutcomeBadge({ x, title }: { x: Pick<BusinessExecutionDto, 'outcome' | 'label' | 'cause'>; title?: string }) {
  return (
    <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${BADGE[x.outcome]}`}
      title={title ?? x.cause ?? undefined} data-testid="business-outcome">
      {x.label}
    </span>
  );
}

/** Résultat natif lisible (OP-04 : jamais perdu). */
export function nativeText(x: Pick<BusinessExecutionDto, 'native'>): string {
  const n = x.native;
  return [n.source, n.status, n.result].filter(Boolean).join(' · ');
}

/** Ligne compacte d'une exécution métier (liste, détail d'appel, File IA). */
export function BusinessExecutionLine({ x, onOpenCall }: { x: BusinessExecutionDto; onOpenCall?: (usageEventId: number) => void }) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <BusinessOutcomeBadge x={x} />
        <span className="text-sm font-medium text-[color:var(--text-primary)]">{x.treatment}{x.mode ? ` · ${x.mode}` : ''}</span>
        {x.objectType && <span className="text-xs text-[color:var(--text-secondary)]">{x.objectType} {x.objectId}</span>}
        {x.accountId !== null && <span className="text-xs text-[color:var(--text-muted)]">compte {x.accountId}</span>}
        {x.nature === 'TECHNICAL' && <span className="text-xs px-1.5 py-0.5 rounded bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)]">technique</span>}
        <span className="text-xs text-[color:var(--text-muted)] sm:ml-auto">{new Date(x.referenceAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}</span>
      </div>
      {x.cause && <p className="text-xs text-[color:var(--text-secondary)] break-words">{x.cause}</p>}
      <p className="text-xs text-[color:var(--text-muted)] break-all">
        Résultat natif : {nativeText(x)} · origine {x.originLabel}
        {x.resumptions > 0 && ` · ${x.resumptions} reprise${x.resumptions > 1 ? 's' : ''}`}
        {x.previousExecutionId && ` · exécution précédente ${x.previousExecutionId}`}
        {x.calls && ` · ${x.calls.calls} appel${x.calls.calls > 1 ? 's' : ''}${x.calls.failedCalls ? ` dont ${x.calls.failedCalls} en échec` : ''}${x.calls.repairCalls ? `, ${x.calls.repairCalls} réparation(s)` : ''}`}
        {' · '}<span className="font-mono">{x.id}</span>
      </p>
      {onOpenCall && x.calls && x.calls.usageEventIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {x.calls.usageEventIds.slice(0, 8).map((u) => (
            <button key={u} type="button" onClick={() => onOpenCall(u)}
              className="text-xs text-[color:var(--accent)] hover:underline">appel #{u}</button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ListResponse {
  readAt: string;
  period: { from: string; to: string; rule: string };
  summary: TreatmentSummary[];
  total: number;
  rows: BusinessExecutionDto[];
  truncated: string[];
  unavailable: Array<{ treatment: string; message: string }>;
}

/**
 * Récapitulatif des exécutions métier (7 derniers jours par défaut) et
 * exécutions échouées / incomplètes. `treatment` / `accountId` : filtres de
 * l'écran. `children` : volet technique replié (incidents d'appels).
 */
export function BusinessExecutionsPanel({ treatment, accountId, onOpenCall, children }: {
  treatment?: string; accountId?: string; onOpenCall?: (usageEventId: number) => void; children?: React.ReactNode;
}) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState<'FAILED' | 'INCOMPLETE' | null>(null);
  const [liste, setListe] = useState<BusinessExecutionDto[] | null>(null);
  const [chargement, setChargement] = useState(false);

  const params = useCallback((extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ days: '7', limit: '1', ...extra });
    if (treatment) q.set('treatment', treatment);
    if (accountId) q.set('accountId', accountId);
    return q;
  }, [treatment, accountId]);

  useEffect(() => {
    let vivant = true;
    setData(null);
    setErreur(null);
    apiClient.get<ListResponse>(`/api/admin/ai/business-executions?${params()}`)
      .then((d) => { if (vivant) setData(d); })
      .catch((e: { message?: string }) => { if (vivant) setErreur(e?.message ?? 'lecture impossible'); });
    return () => { vivant = false; };
  }, [params]);

  const ouvrir = async (o: 'FAILED' | 'INCOMPLETE') => {
    if (ouvert === o) { setOuvert(null); return; }
    setOuvert(o);
    setListe(null);
    setChargement(true);
    try {
      const d = await apiClient.get<ListResponse>(`/api/admin/ai/business-executions?${params({ outcome: o, limit: '30' })}`);
      setListe(d.rows);
    } catch {
      setListe([]);
    } finally {
      setChargement(false);
    }
  };

  const totaux = (data?.summary ?? []).reduce((a, s) => ({ failed: a.failed + s.failed, incomplete: a.incomplete + s.incomplete }), { failed: 0, incomplete: 0 });

  return (
    <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-4 space-y-3" data-testid="business-executions-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="vb-app-section">Exécutions métier — 7 derniers jours</h2>
        {data && (
          <span className="text-xs text-[color:var(--text-muted)]" title={data.period.rule}>
            issue finale, chaque exécution comptée une fois · lu à {new Date(data.readAt).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' })}
          </span>
        )}
      </div>
      {erreur && <p className="text-sm text-[color:var(--text-danger)]">Exécutions métier indisponibles : {erreur}</p>}
      {!data && !erreur && (
        <p className="text-sm text-[color:var(--text-muted)] flex items-center"><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Calcul…</p>
      )}
      {data && (
        <>
          <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
            {data.summary.map((s) => (
              <div key={s.treatment} className="rounded-lg border border-[color:var(--border-subtle)] px-3 py-2 text-xs space-y-0.5">
                <p className="text-sm font-semibold text-[color:var(--text-primary)]">{s.treatment}</p>
                <p className="text-[color:var(--text-secondary)]">
                  <span className="text-[color:var(--text-success)]">{s.succeeded} réussie{s.succeeded > 1 ? 's' : ''}</span>
                  {' · '}<span className={s.incomplete ? 'text-[color:var(--text-warning-soft)]' : ''}>{s.incomplete} incomplète{s.incomplete > 1 ? 's' : ''}</span>
                  {' · '}<span className={s.failed ? 'text-[color:var(--text-danger)]' : ''}>{s.failed} échouée{s.failed > 1 ? 's' : ''}</span>
                </p>
                <p className="text-[color:var(--text-muted)]">
                  {s.notFinal} non finale{s.notFinal > 1 ? 's' : ''}
                  {s.void > 0 && ` · ${s.void} sans objet`}
                  {s.undetermined > 0 && ` · ${s.undetermined} non déterminable${s.undetermined > 1 ? 's' : ''}`}
                  {s.technical > 0 && ` · ${s.technical} technique${s.technical > 1 ? 's' : ''}`}
                </p>
              </div>
            ))}
          </div>
          {(data.truncated.length > 0 || data.unavailable.length > 0) && (
            <p className="text-xs text-[color:var(--text-warning-soft)]">
              {data.truncated.length > 0 && `Lecture plafonnée (${data.truncated.join(', ')}) : récapitulatif partiel. `}
              {data.unavailable.map((u) => `${u.treatment} illisible (${u.message})`).join(' · ')}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {(['FAILED', 'INCOMPLETE'] as const).map((o) => (
              <button key={o} type="button" onClick={() => void ouvrir(o)} aria-expanded={ouvert === o}
                className="flex items-center gap-1 text-sm text-[color:var(--text-secondary)] hover:underline">
                {ouvert === o ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                {o === 'FAILED' ? `Échouées (${totaux.failed})` : `Incomplètes (${totaux.incomplete})`}
              </button>
            ))}
          </div>
          {ouvert && (
            <div className="divide-y divide-[color:var(--border-subtle)] rounded-lg border border-[color:var(--border-subtle)]">
              {chargement && <p className="p-3 text-sm text-[color:var(--text-muted)]">Chargement…</p>}
              {liste?.length === 0 && <p className="p-3 text-sm text-[color:var(--text-muted)]">Aucune exécution.</p>}
              {liste?.map((x) => <div key={x.id} className="p-3"><BusinessExecutionLine x={x} onOpenCall={onOpenCall} /></div>)}
            </div>
          )}
        </>
      )}
      {children}
    </div>
  );
}
