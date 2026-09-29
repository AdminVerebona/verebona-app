"use client"

/**
 * Résumé fixe de la préparation — CDC V12 §5.2 (PREP-ESTIMATE,
 * PREP-ACTIONS, PREP-PROGRESS, PREP-RESULT), §22.5 (PREP-RÉS-001 à 013),
 * §6.3 (seuils), §15.3 (suivi du job), ALT-003, ALT-004.
 *
 * Format final (PDF, ou PDF + ZIP dès qu'une pièce est en mode ZIP —
 * ZIP-001), pages et taille estimées, pièces PDF / ZIP, alertes et seuils,
 * plan du dossier (titres et numéros du PDF), boutons de génération ; puis,
 * pendant et après la génération : étapes, téléchargement, fichiers exclus
 * d'une génération partielle, erreur compréhensible.
 */

import NextLink from 'next/link';
import { AlertTriangle, CheckCircle2, Circle, Clock, Download, FileDown, History, Info, Loader2, Package, PencilLine, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  dossierOutline, formatBytes, generateDecision, progressSteps, type PrepState,
} from '@/lib/exports/preparation-state';
import { PREP_MESSAGES } from '@/services/exports/v12/preparation/messages';
import type { OutputFormat } from '@/services/exports/v12/preparation/types';
import { Callout, Eyebrow, Pill, formatDateTime } from './ui';

/** Génération longue (MSG-PREP-008) au-delà de ce délai. */
export const LONG_GENERATION_MS = 20_000;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[.06em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums">{value}{hint && <span className="ml-1 text-[11px] font-normal text-muted-foreground">{hint}</span>}</dd>
    </div>
  );
}

/** Raison pour laquelle la génération est impossible (affichée sous les boutons). */
export function blockedReason(s: PrepState): string | null {
  if (!s.prep) return null;
  if (s.autosave === 'error') return PREP_MESSAGES['MSG-PREP-006'];
  if (s.autosave === 'saving') return 'Enregistrement des informations en cours…';
  if (s.prep.cil?.globalStatus === 'action_required') return 'Complétez les blocs bloquants du CIL (B1, B3, B8) pour générer.';
  if (s.estimate?.blocking.length) return 'Seuil dépassé : réduisez la sélection ou passez des pièces en ZIP.';
  if (s.status === 'estimating' || s.status === 'ready_modified') return 'Estimation en cours…';
  if (s.status === 'estimate_failed') return 'Estimation indisponible : recalculez-la pour générer.';
  return null;
}

export function GenerateButtons({ state, onGenerate, onCancel, layout = 'stack' }: {
  state: PrepState;
  onGenerate: (f: OutputFormat) => void;
  onCancel: () => void;
  layout?: 'stack' | 'bar';
}) {
  const zipNatural = state.estimate?.outputFormat === 'ZIP';
  const pdf = generateDecision(state, 'PDF');
  const zip = generateDecision(state, 'ZIP');
  const reason = blockedReason(state);
  const reasonId = `prep-generate-reason-${layout}`;
  const pdfBtn = (
    <Button key="pdf" type="button" variant={zipNatural ? 'outline' : 'default'} className={cn(layout === 'stack' && 'w-full')} disabled={pdf === 'blocked'} onClick={() => onGenerate('PDF')} aria-describedby={reason ? reasonId : undefined}>
      <FileDown aria-hidden />Générer le PDF
    </Button>
  );
  const zipBtn = (
    <Button key="zip" type="button" variant={zipNatural ? 'default' : 'outline'} className={cn(layout === 'stack' && 'w-full')} disabled={zip === 'blocked'} onClick={() => onGenerate('ZIP')} aria-describedby={reason ? reasonId : (!zipNatural ? 'prep-zip-hint' : undefined)}>
      <Package aria-hidden />Générer PDF + ZIP
    </Button>
  );
  return (
    <div className={cn(layout === 'stack' ? 'space-y-2' : 'flex flex-wrap items-center gap-2')}>
      {layout === 'bar' ? (
        <>
          <Button type="button" variant="ghost" onClick={onCancel} className="shrink-0">Annuler</Button>
          <div className="flex flex-1 justify-end gap-2">{zipNatural ? [pdfBtn, zipBtn] : [pdfBtn]}</div>
        </>
      ) : (
        <>
          {zipNatural ? <>{zipBtn}{pdfBtn}</> : <>{pdfBtn}{zipBtn}</>}
          {!zipNatural && <p id="prep-zip-hint" className="text-[11px] leading-snug text-muted-foreground">Le ZIP est proposé dès qu’une pièce est en mode ZIP.</p>}
          <Button type="button" variant="ghost" className="w-full" onClick={onCancel}>Annuler</Button>
        </>
      )}
      {reason && <p id={reasonId} role="status" className={cn('text-[11px] leading-snug text-[color:var(--text-warning)]', layout === 'bar' && 'order-first w-full')}>{reason}</p>}
    </div>
  );
}

function GenerationPanel({ state, assetId, now, onBackToEdit, onRetry, onClose }: {
  state: PrepState; assetId: number; now: number; onBackToEdit: () => void; onRetry: () => void; onClose: () => void;
}) {
  const g = state.generation;
  const historyHref = `/assets/${assetId}?tab=exports#historique`;
  if (state.status === 'generating') {
    const steps = progressSteps(g);
    const long = (g && now - g.startedAt > LONG_GENERATION_MS) || state.estimate?.longGeneration;
    return (
      <div className="space-y-4" aria-live="polite">
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
          <p className="text-sm font-semibold">{g?.generationStatus === 'queued' || !g?.currentStep ? 'Génération en attente…' : 'Génération en cours…'}</p>
        </div>
        <ol className="space-y-2">
          {steps.map((st) => (
            <li key={st.id} className="flex items-center gap-2.5 text-[13px]">
              {st.state === 'done' ? <CheckCircle2 className="size-4 text-[color:var(--text-success)]" aria-hidden />
                : st.state === 'current' ? <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
                  : <Circle className="size-4 text-muted-foreground/50" aria-hidden />}
              <span className={cn(st.state === 'todo' && 'text-muted-foreground', st.state === 'current' && 'font-medium')}>{st.label}</span>
              <span className="sr-only">{st.state === 'done' ? ' : terminé' : st.state === 'current' ? ' : en cours' : ' : à venir'}</span>
            </li>
          ))}
        </ol>
        {long && <Callout tone="info" icon={<Clock />}>{PREP_MESSAGES['MSG-PREP-008']}</Callout>}
        <p className="text-[11px] leading-snug text-muted-foreground">Vous pouvez fermer cet écran : la génération continue et le dossier apparaîtra dans l’historique des exports.</p>
        <Button type="button" variant="outline" className="w-full" onClick={onClose}>Fermer</Button>
      </div>
    );
  }
  if (state.status === 'generated_pdf' || state.status === 'generated_zip' || state.status === 'generated_partial') {
    const partial = state.status === 'generated_partial';
    return (
      <div className="space-y-4" aria-live="polite">
        <Callout tone={partial ? 'warning' : 'success'} icon={partial ? <AlertTriangle /> : <CheckCircle2 />} role="status">
          <p className="font-semibold">{partial ? 'Dossier généré partiellement' : 'Votre dossier est prêt'}</p>
          <p className="mt-0.5">{partial ? PREP_MESSAGES['MSG-PREP-007'] : `Téléchargeable pendant 30 jours${g?.expiresAt ? `, jusqu’au ${formatDateTime(g.expiresAt)}` : ''}.`}</p>
        </Callout>
        {partial && (g?.excludedFiles.length ?? 0) > 0 && (
          <div>
            <Eyebrow>Fichiers exclus</Eyebrow>
            <ul className="mt-1.5 space-y-1">
              {g!.excludedFiles.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-xs"><XCircle className="mt-px size-3.5 shrink-0 text-[color:var(--text-danger)]" aria-hidden /><span className="min-w-0"><span className="font-medium">{f.label}</span> — <span className="text-muted-foreground">{f.reasonLabel}</span></span></li>
              ))}
            </ul>
          </div>
        )}
        <div className="space-y-2">
          {g?.downloadUrl && <Button asChild className="w-full"><a href={g.downloadUrl} target="_blank" rel="noopener noreferrer"><Download aria-hidden />Télécharger le PDF</a></Button>}
          {g?.downloadZipUrl && <Button asChild variant={g.downloadUrl ? 'outline' : 'default'} className="w-full"><a href={g.downloadZipUrl} target="_blank" rel="noopener noreferrer"><Package aria-hidden />Télécharger le ZIP</a></Button>}
          <Button asChild variant="ghost" className="w-full"><NextLink href={historyHref}><History aria-hidden />Voir l’historique</NextLink></Button>
          <Button type="button" variant="ghost" className="w-full" onClick={onBackToEdit}><PencilLine aria-hidden />Modifier et générer à nouveau</Button>
        </div>
      </div>
    );
  }
  if (state.status === 'expired' || state.status === 'file_deleted') {
    return (
      <div className="space-y-3">
        <Callout tone="neutral" icon={<Info />}>{state.status === 'expired' ? 'Ce fichier a expiré : relancez une préparation pour obtenir un nouveau dossier.' : 'Le fichier de ce dossier a été supprimé ; l’entrée reste dans l’historique.'}</Callout>
        <Button type="button" className="w-full" onClick={onBackToEdit}>Préparer un nouveau dossier</Button>
      </div>
    );
  }
  if (state.status === 'failed' && state.prep) {
    return (
      <div className="space-y-3">
        <Callout tone="danger" icon={<XCircle />} role="alert">
          <p className="font-semibold">La génération n’a pas abouti</p>
          <p className="mt-0.5">{state.error?.message ?? 'La génération a échoué. Réessayez.'}</p>
        </Callout>
        <Button type="button" className="w-full" onClick={onRetry}><RefreshCw aria-hidden />Revenir à la préparation</Button>
      </div>
    );
  }
  return null;
}

export function PreparationSummary({ state, assetId, now, onGenerate, onCancel, onBackToEdit, onRetry, showActions = true, onRetryEstimate }: {
  state: PrepState;
  assetId: number;
  now: number;
  onGenerate: (f: OutputFormat) => void;
  onCancel: () => void;
  onBackToEdit: () => void;
  onRetry: () => void;
  showActions?: boolean;
  /** Estimation en échec : nouvelle tentative manuelle. */
  onRetryEstimate?: () => void;
}) {
  const e = state.estimate;
  const outline = dossierOutline(state);
  const inGeneration = ['generating', 'generated_pdf', 'generated_zip', 'generated_partial', 'expired', 'file_deleted'].includes(state.status) || (state.status === 'failed' && !!state.generation);
  const alerts = [...(e?.blocking ?? []), ...(e?.warnings ?? [])];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>Résumé du dossier</Eyebrow>
        {state.status === 'estimating'
          ? <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" aria-live="polite"><Loader2 className="size-3 animate-spin" aria-hidden />Recalcul…</span>
          : state.status === 'ready_modified' || state.status === 'estimation_ready' || state.status === 'blocked_threshold'
            ? state.modified && <Pill tone="info">Modifications non générées</Pill>
            : null}
      </div>

      <div>
        <p className="text-[11px] text-muted-foreground">Format final</p>
        <p className="mt-0.5 flex items-baseline gap-2 text-2xl font-semibold tracking-tight">
          {e?.outputFormat === 'ZIP' ? 'PDF + ZIP' : 'PDF seul'}
        </p>
        {e?.outputFormat === 'ZIP' && <p className="mt-0.5 text-[11px] text-muted-foreground">Archive : /pdf, /documents, /photos</p>}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-border bg-[var(--accent-soft)]/40 p-3.5">
        <Stat label="Pages estimées" value={e ? `≈ ${e.estimatedPages}` : '—'} />
        <Stat label="Taille estimée" value={e ? `≈ ${formatBytes(e.estimatedBytes)}` : '—'} />
        <Stat label="Documents PDF" value={String(e?.pdfDocuments ?? 0)} />
        <Stat label="Documents ZIP" value={String(e?.zipDocuments ?? 0)} />
        <Stat label="Photos PDF" value={String(e?.pdfPhotos ?? 0)} />
        <Stat label="Photos ZIP" value={String(e?.zipPhotos ?? 0)} />
        {(e?.events ?? 0) > 0 && <Stat label="Suivi" value={`${e!.events} élément${e!.events > 1 ? 's' : ''}`} />}
      </dl>

      {(alerts.length > 0 || state.messages.length > 0) && !inGeneration && (
        <div className="space-y-2" aria-live="polite">
          {e?.blocking.map((a) => <Callout key={a.code} tone="danger" icon={<AlertTriangle />} role="alert">{a.message}</Callout>)}
          {e?.warnings.map((a) => <Callout key={a.code} tone="warning" icon={<AlertTriangle />}>{a.message}</Callout>)}
          {state.messages.filter((m) => m.code !== 'MSG-PREP-004' && m.code !== 'MSG-PREP-001').map((m) => (
            <Callout key={m.code} tone={m.level === 'blocking' ? 'danger' : m.level === 'warning' ? 'warning' : 'info'} icon={m.level === 'info' ? <Info /> : <AlertTriangle />}>
              {m.text}
              {m.code === 'MSG-PREP-005' && e?.unavailable.length ? <span className="mt-1 block text-[11px] opacity-90">{e.unavailable.map((u) => u.label).join(', ')}</span> : null}
            </Callout>
          ))}
        </div>
      )}

      {!inGeneration && (
        <div>
          <Eyebrow>Plan du dossier</Eyebrow>
          <ol className="mt-2 space-y-1.5">
            {outline.map((o, i) => (
              <li key={`${o.label}-${i}`} className="flex items-baseline gap-2.5 text-[13px]">
                <span className="w-12 shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{o.no ?? ''}</span>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {inGeneration ? (
        <GenerationPanel state={state} assetId={assetId} now={now} onBackToEdit={onBackToEdit} onRetry={onRetry} onClose={onCancel} />
      ) : (
        <div className="space-y-3">
          {state.error && <Callout tone="danger" icon={<XCircle />} role="alert">{state.error.message}</Callout>}
          {state.status === 'estimate_failed' && (
            <Callout tone="warning" icon={<AlertTriangle />} role="alert">
              <p>L’estimation n’a pas pu être recalculée : la génération reste bloquée tant qu’elle n’est pas à jour.</p>
              {onRetryEstimate && (
                <button type="button" onClick={onRetryEstimate} className="mt-1.5 inline-flex items-center gap-1 font-semibold underline underline-offset-2">
                  <RefreshCw className="size-3.5" aria-hidden />Recalculer l’estimation
                </button>
              )}
            </Callout>
          )}
          {showActions && <GenerateButtons state={state} onGenerate={onGenerate} onCancel={onCancel} />}
        </div>
      )}
    </div>
  );
}
