"use client"

/**
 * Écran de préparation d'un dossier prêt à l'emploi — CDC V12 §5 (écran
 * large, pas un tiroir), §22 (PREP-HEA / NAV / ZON / ITE / RÉS / MOB / ACC),
 * FLOW-*-01 à 11, §17 (prepare / estimate / génération §17.2), §15.3.
 *
 *   Bureau : en-tête fixe, colonne gauche 65 % (sections du PDF, éléments,
 *            modes PDF / ZIP, informations complémentaires, blocs CIL),
 *            colonne droite 35 % collante (résumé, estimation, alertes,
 *            boutons, progression, résultat).
 *   Mobile : plein écran, résumé repliable en haut, sections en accordéon,
 *            actions fixes en bas, confirmation de fermeture (PREP-MOB-*).
 *
 * États (§5.3) : `lib/exports/preparation-state.ts`. Réseau : `api.ts`
 * (remplaçable : aperçu, tests).
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import NextLink from 'next/link';
import {
  AlertTriangle, ArrowLeft, Check, ChevronDown, Crown, FileText, History, Loader2, RefreshCw, X,
} from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AssetAdditionalInfosSection } from '@/components/assets/AssetAdditionalInfosSection';
import { OFFERS_PATH } from '@/lib/write-blocked';
import { cn } from '@/lib/utils';
import {
  buildChoices, buildEstimateBody, buildGenerateBody, generateDecision, initialPrepState, isEditable,
  needsCloseConfirmation, prepReducer, sectionCounts, estimateRetryDelayMs, MAX_AUTO_ESTIMATE_RETRIES,
  type AutosaveStatus, type PrepAction,
} from '@/lib/exports/preparation-state';
import { PREP_MESSAGES } from '@/services/exports/v12/preparation/messages';
import type { ItemMode, OutputFormat, PrepSection } from '@/services/exports/v12/preparation/types';
import { httpPreparationApi, toFailure, type PreparationApi } from './api';
import { CilBlocksPanel } from './CilBlocksPanel';
import { SaleAdsPanel } from './SaleAdsPanel';
import { createSaleAdsRefresher } from './sale-ads-refresh';
import { PreparationSection } from './PreparationSection';
import { GenerateButtons, PreparationSummary } from './PreparationSummary';
import { Callout, Eyebrow, Pill, formatDate } from './ui';

const ESTIMATE_DEBOUNCE_MS = 400;
const POLL_MS = 2000;

interface Props {
  assetId: number;
  exportType: string;
  /** Fermeture ; `href` : lien interne suivi après confirmation (PREP-MOB-008). */
  onClose: (href?: string) => void;
  /** Accès réseau (par défaut : API de l'application). */
  api?: PreparationApi;
  /** Aperçu : actions rejouées après le chargement (états figés). */
  afterLoad?: PrepAction[];
}

/** État de la file d'enregistrement du formulaire → statut de l'écran (MSG-PREP-006). */
export function toAutosaveStatus(s: 'idle' | 'pending' | 'saving' | 'saved' | 'error'): AutosaveStatus {
  return s === 'pending' || s === 'saving' ? 'saving' : s;
}

function AutosaveBadge({ status }: { status: AutosaveStatus }) {
  if (status === 'saving') return <Pill tone="neutral"><Loader2 className="animate-spin" aria-hidden />Enregistrement…</Pill>;
  if (status === 'saved') return <Pill tone="success"><Check aria-hidden />Enregistré</Pill>;
  if (status === 'error') return <Pill tone="danger"><AlertTriangle aria-hidden />Échec de l’enregistrement</Pill>;
  return null;
}

const ELIGIBILITY: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  ready: { label: 'Prêt à générer', tone: 'success' },
  partial: { label: 'À compléter', tone: 'warning' },
  unavailable: { label: 'Indisponible', tone: 'danger' },
};

const STATUS_LABELS: Record<string, string> = {
  queued: 'en attente', generating: 'en cours', ready: 'prêt', partial: 'partiel', failed: 'échec', expired: 'expiré', deleted: 'fichier supprimé',
};

export function ExportPreparationScreen({ assetId, exportType, onClose, api: apiProp, afterLoad }: Props) {
  const api = useMemo(() => apiProp ?? httpPreparationApi(assetId), [apiProp, assetId]);
  const [state, dispatch] = useReducer(prepReducer, initialPrepState);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useRef(state);
  stateRef.current = state;
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  /** Lien interne demandé pendant une préparation modifiée : suivi après confirmation. */
  const pendingHref = useRef<string | null>(null);
  const [mobile, setMobile] = useState(false);
  // Même tableau d'une préparation à l'autre : le formulaire ne se recharge pas à chaque rafraîchissement.
  const infoCache = useRef(new Map<string, PrepSection['infoSections']>());
  const stableInfo = (arr: PrepSection['infoSections']) => {
    const k = arr.join(',');
    if (!infoCache.current.has(k)) infoCache.current.set(k, arr);
    return infoCache.current.get(k)!;
  };

  // ── Chargement (FLOW-*-01/02/03) ──────────────────────────────────────────
  const load = useCallback(async (keepSelections = false) => {
    const current = stateRef.current;
    if (!keepSelections) dispatch({ type: 'LOAD_START' });
    try {
      const mobile = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023px)').matches;
      const prep = await api.prepare({
        exportType,
        clientContext: { viewport: mobile ? 'mobile' : 'desktop' },
        ...(keepSelections && current.prep ? { includeCurrentSelections: true, choices: buildChoices(current, 'ZIP') } : {}),
      });
      dispatch({ type: keepSelections ? 'RELOAD_SUCCESS' : 'LOAD_SUCCESS', prep });
      if (!keepSelections) {
        // Bureau : sections à contenu dépliées ; mobile : accordéon (PREP-MOB-002).
        const open: Record<string, boolean> = {};
        let firstItems = true;
        for (const s of prep.sections) {
          const content = s.items.length > 0 || s.infoSections.length > 0 || s.cil || !!s.fedBy || !!s.itemType;
          if (!content) continue;
          if (!mobile) open[s.id] = true;
          else if (s.cil || s.infoSections.length > 0) open[s.id] = true;
          else if (s.items.length > 0 && firstItems) { open[s.id] = true; firstItems = false; }
        }
        setExpanded(open);
      }
      for (const a of afterLoad ?? []) dispatch(a);
    } catch (err) {
      const f = toFailure(err);
      // Rechargement en échec : la préparation en cours reste utilisable.
      if (!keepSelections) dispatch({ type: 'LOAD_FAILURE', code: f.code, message: f.message });
    }
  }, [api, exportType, afterLoad]);

  useEffect(() => { void load(); }, [load]);

  // Titre focalisé au chargement (lecteurs d'écran, écran modal sur mobile).
  const loaded = !!state.prep;
  useEffect(() => { if (loaded) titleRef.current?.focus(); }, [loaded]);

  // ── Mobile : écran plein écran MODAL — arrière-plan inerte (PREP-MOB-001, accessibilité).
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 1023px)');
    if (!mq) return;
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (!mobile || !root || !loaded) return;
    const made: Element[] = [];
    // Tous les frères de chaque ancêtre deviennent inertes (sauf les portails ouverts ensuite).
    for (let el: Element | null = root; el && el !== document.body; el = el.parentElement) {
      for (const sib of Array.from(el.parentElement?.children ?? [])) {
        if (sib === el || sib.hasAttribute('inert') || sib.tagName === 'SCRIPT') continue;
        if (sib.hasAttribute('data-radix-portal') || sib.querySelector?.('[role="dialog"],[role="alertdialog"],[role="listbox"]')) continue;
        sib.setAttribute('inert', '');
        made.push(sib);
      }
    }
    return () => { for (const el of made) el.removeAttribute('inert'); };
  }, [mobile, loaded]);

  // ── Informations enregistrées : préparation rafraîchie (contenu des sections, §6.2).
  const lastAutosave = useRef(state.autosave);
  useEffect(() => {
    const prev = lastAutosave.current;
    lastAutosave.current = state.autosave;
    if (state.autosave !== 'saved' || prev === 'saved' || !isEditable(state)) return;
    const t = setTimeout(() => { if (stateRef.current.autosave === 'saved') void load(true); }, 600);
    return () => clearTimeout(t);
  }, [state, load]);

  // ── Estimation en échec : nouvelles tentatives espacées (2, 4, 8 s), plafonnées.
  useEffect(() => {
    if (state.status !== 'estimate_failed' || state.estimateFailures > MAX_AUTO_ESTIMATE_RETRIES) return;
    const t = setTimeout(() => dispatch({ type: 'RETRY_ESTIMATE' }), estimateRetryDelayMs(state.estimateFailures));
    return () => clearTimeout(t);
  }, [state.status, state.estimateFailures]);

  // ── Estimation après chaque modification (FLOW-*-08) ──────────────────────
  useEffect(() => {
    if (state.status !== 'ready_modified' || !state.prep) return;
    const revision = state.revision;
    const t = setTimeout(async () => {
      dispatch({ type: 'ESTIMATE_START' });
      try {
        const r = await api.estimate(buildEstimateBody(stateRef.current));
        dispatch({ type: 'ESTIMATE_SUCCESS', revision, estimate: r.estimate, actions: r.actions, messages: r.messages });
      } catch {
        dispatch({ type: 'ESTIMATE_FAILURE', revision });
      }
    }, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [state.status, state.revision, state.prep, api]);

  // ── Suivi de la génération (§15.3) ────────────────────────────────────────
  const publicId = state.generation?.publicId ?? null;
  const generating = state.status === 'generating' || (state.status === 'cancel_confirm' && state.returnTo === 'generating');
  useEffect(() => {
    if (!generating || !publicId) return;
    let stop = false;
    const tick = async () => {
      try {
        const g = await api.poll(publicId);
        if (stop) return;
        dispatch({
          type: 'GENERATION_UPDATE',
          dto: {
            generationStatus: g.generationStatus, outputFormat: g.outputFormat, currentStep: g.currentStep ?? null,
            downloadUrl: g.downloadUrl, downloadZipUrl: g.downloadZipUrl, errorMessage: g.errorMessage, expiresAt: g.expiresAt,
            excludedFiles: (g.excludedFiles ?? []).map((x) => ({ label: x.label, reasonLabel: x.reasonLabel })),
          },
        });
      } catch { /* réseau : nouvelle tentative au prochain tour */ }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(id); };
  }, [generating, publicId, api]);

  useEffect(() => {
    if (!generating) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [generating]);

  // ── Enregistrement des informations complémentaires (MSG-PREP-006) ───────
  const onSaveStateChange = useCallback((st: 'idle' | 'pending' | 'saving' | 'saved' | 'error') => dispatch({ type: 'AUTOSAVE', status: toAutosaveStatus(st) }), []);

  // VENTE-RULE-002 : un champ COMMERCIAL enregistré → annonces recomposées
  // (choix conservés), 2,5 s après la dernière saisie enregistrée.
  const loadRef = useRef(load);
  loadRef.current = load;
  const adsRefresher = useMemo(() => createSaleAdsRefresher(() => {
    if (stateRef.current.prep?.saleAds) void loadRef.current(true);
  }), []);
  useEffect(() => () => adsRefresher.cancel(), [adsRefresher]);
  const onSectionsSaved = useCallback((sections: string[]) => adsRefresher.onSectionsSaved(sections), [adsRefresher]);

  // Quitter la page avec des choix non générés : avertissement du navigateur.
  useEffect(() => {
    if (!needsCloseConfirmation(state)) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [state]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const requestClose = useCallback((target?: unknown) => {
    // Appelé aussi comme gestionnaire de clic : seul un lien (chaîne) est retenu.
    const href = typeof target === 'string' ? target : undefined;
    if (needsCloseConfirmation(stateRef.current)) { pendingHref.current = href ?? null; dispatch({ type: 'REQUEST_CLOSE' }); }
    else onClose(href);
  }, [onClose]);

  // Liens internes (historique, fil d'Ariane, navigation) : même confirmation.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!needsCloseConfirmation(stateRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      requestClose(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [requestClose]);

  const doGenerate = useCallback(async (format: OutputFormat, acknowledged: boolean) => {
    const body = buildGenerateBody(stateRef.current, format, acknowledged);
    dispatch({ type: 'GENERATE_START', format, now: Date.now() });
    setNow(Date.now());
    setSummaryOpen(true);
    try {
      const r = await api.generate(body);
      dispatch({ type: 'GENERATE_ACCEPTED', publicId: r.generationPublicId, generationStatus: r.generationStatus });
    } catch (err) {
      const f = toFailure(err);
      const d = (f.details ?? {}) as { blocking?: Array<{ code: string; type: 'blocking'; message: string }>; zipOnlyItems?: Array<{ key: string; label: string }> };
      // Refus : blocages et pièces ZIP du serveur repris, confirmation « PDF seul »
      // ouverte si c'est elle qui manque, puis nouvelle estimation (réducteur).
      dispatch({ type: 'GENERATE_REJECTED', code: f.code, message: f.message, blocking: d.blocking, zipOnlyItems: d.zipOnlyItems });
    }
  }, [api]);

  const onGenerate = useCallback((format: OutputFormat) => {
    const d = generateDecision(stateRef.current, format);
    if (d === 'confirm_pdf_only') dispatch({ type: 'OPEN_PDF_ONLY_CONFIRM' });
    else if (d === 'go') void doGenerate(format, false);
  }, [doGenerate]);

  const onToggle = useCallback((key: string, selected: boolean) => dispatch({ type: 'TOGGLE_ITEM', key, selected }), []);
  const onMode = useCallback((key: string, mode: ItemMode) => dispatch({ type: 'SET_MODE', key, mode }), []);
  const viewUrl = useCallback((fileId: number) => api.viewUrl(fileId), [api]);
  const scrollTo = (id: string) => {
    setExpanded((e) => ({ ...e, [id]: true }));
    requestAnimationFrame(() => document.getElementById(`prep-sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const prep = state.prep;
  const editable = isEditable(state) && state.status !== 'cancel_confirm';
  const closingWhileGenerating = state.status === 'cancel_confirm' && state.returnTo === 'generating';

  // ── Erreurs de chargement (accès, éligibilité, offre) ─────────────────────
  if (state.status === 'failed' && !prep) {
    const premium = /PREMIUM|SUBSCRIPTION|TRIAL|PLAN/i.test(state.error?.code ?? '');
    const notEligible = state.error?.code === 'NOT_ELIGIBLE' || state.error?.code === 'INVALID_EXPORT_TYPE';
    return (
      <div className="mx-auto max-w-xl py-10">
        <Button variant="ghost" size="sm" onClick={() => onClose()} className="mb-6"><ArrowLeft aria-hidden />Retour aux exports</Button>
        <Callout tone={premium ? 'info' : notEligible ? 'warning' : 'danger'} icon={premium ? <Crown /> : <AlertTriangle />} role="alert">
          <p className="font-semibold">{premium ? 'Fonctionnalité Premium' : notEligible ? 'Dossier indisponible pour ce bien' : 'La préparation n’a pas pu être chargée'}</p>
          <p className="mt-1">{state.error?.message}</p>
        </Callout>
        <div className="mt-4 flex gap-2">
          {premium ? <Button asChild><NextLink href={OFFERS_PATH}>Passer à Premium ou Premium Duo</NextLink></Button>
            : !notEligible && <Button onClick={() => void load()}><RefreshCw aria-hidden />Réessayer</Button>}
        </div>
      </div>
    );
  }

  // ── Squelette (loading_preparation) ───────────────────────────────────────
  if (!prep) {
    return (
      <div className="space-y-6" aria-busy="true" aria-live="polite">
        <span className="sr-only">Préparation du dossier en cours…</span>
        <Skeleton className="h-16 w-full rounded-xl" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,65fr)_minmax(0,35fr)]">
          <div className="space-y-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  // ALT-003 : un seuil bloquant prime sur l'éligibilité affichée.
  const elig = (state.estimate?.blocking.length ?? 0) > 0 ? { label: 'Seuil dépassé', tone: 'danger' as const } : ELIGIBILITY[prep.eligibility.status];
  const numbered = (() => {
    let n = 0;
    return (s: PrepSection) => (s.id === 'cover' || s.id === 'references' ? null : String(++n).padStart(2, '0'));
  })();
  const hasInfo = prep.sections.some((s) => s.infoSections.length > 0);
  const empty = prep.messages.find((m) => m.code === 'MSG-PREP-001');

  return (
    <div
      ref={rootRef}
      data-fullscreen-screen
      {...(mobile ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'prep-title' } : {})}
      className="fixed inset-0 z-50 flex flex-col bg-background lg:static lg:z-auto lg:block lg:bg-transparent"
    >
      {/* ── En-tête (PREP-HEADER, PREP-HEA-001 à 010) ── */}
      <header className="sticky top-0 z-10 shrink-0 border-b border-border bg-background/95 px-4 py-3 backdrop-blur lg:-mx-8 lg:-mt-8 lg:mb-6 lg:px-8 lg:py-4">
        <div className="flex items-start gap-3">
          <Button type="button" variant="ghost" size="icon" onClick={requestClose} className="-ml-2 shrink-0 lg:hidden" aria-label="Fermer la préparation"><X aria-hidden /></Button>
          <div className="min-w-0 flex-1">
            <Eyebrow>Dossier prêt à l’emploi · préparation</Eyebrow>
            <h1 id="prep-title" ref={titleRef} tabIndex={-1} className="mt-0.5 truncate text-lg font-semibold tracking-tight outline-none lg:text-2xl">{prep.dossier.label}</h1>
            <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
              <span className="font-medium text-foreground">{prep.asset.name}</span>
              {' · '}{prep.asset.familyLabel}{prep.asset.categoryLabel ? ` · ${prep.asset.categoryLabel}` : ''}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Pill tone={elig.tone}>{elig.label}</Pill>
              {state.modified && !['generating', 'generated_pdf', 'generated_zip', 'generated_partial'].includes(state.status) && <Pill tone="info">Préparation modifiée</Pill>}
              {hasInfo && <AutosaveBadge status={state.autosave} />}
              {prep.lastGeneration ? (
                <span className="text-[11px] text-muted-foreground">
                  Dernier dossier le {formatDate(prep.lastGeneration.createdAt)}
                  {prep.lastGeneration.authorName ? ` par ${prep.lastGeneration.authorName}` : ''}
                  {` · ${STATUS_LABELS[prep.lastGeneration.status] ?? prep.lastGeneration.status}`}
                </span>
              ) : <span className="text-[11px] text-muted-foreground">Jamais généré</span>}
            </div>
          </div>
          <div className="hidden shrink-0 items-center gap-2 lg:flex">
            <Button asChild variant="ghost" size="sm"><NextLink href={`/assets/${assetId}?tab=exports#historique`}><History aria-hidden />Historique</NextLink></Button>
            <Button type="button" variant="outline" size="sm" onClick={requestClose}><X aria-hidden />Fermer</Button>
          </div>
          <NextLink href={`/assets/${assetId}?tab=exports#historique`} className="shrink-0 rounded-full p-2 text-muted-foreground hover:text-foreground lg:hidden" aria-label="Historique des exports"><History className="size-4" aria-hidden /></NextLink>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-28 lg:overflow-visible lg:pb-0">
        {/* ── Résumé repliable (mobile, PREP-MOB-003) ── */}
        <div className="border-b border-border bg-card/60 lg:hidden">
          <button
            type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left" aria-expanded={summaryOpen} aria-controls="prep-mobile-summary"
            onClick={() => setSummaryOpen((v) => !v)}
          >
            <FileText className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1 text-[13px]">
              <span className="font-semibold">{state.estimate?.outputFormat === 'ZIP' ? 'PDF + ZIP' : 'PDF seul'}</span>
              <span className="text-muted-foreground"> · ≈ {state.estimate?.estimatedPages ?? '—'} pages · {(state.estimate?.pdfDocuments ?? 0) + (state.estimate?.zipDocuments ?? 0)} documents · {(state.estimate?.pdfPhotos ?? 0) + (state.estimate?.zipPhotos ?? 0)} photos</span>
              {(state.estimate?.blocking.length ?? 0) > 0 && <span className="ml-1 text-[color:var(--text-danger)]">· seuil dépassé</span>}
            </span>
            <span className="text-[11px] text-muted-foreground">{summaryOpen ? 'Masquer' : 'Résumé'}</span>
            <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', summaryOpen && 'rotate-180')} aria-hidden />
          </button>
          {summaryOpen && (
            <div id="prep-mobile-summary" className="px-4 pb-4">
              <PreparationSummary state={state} assetId={assetId} now={now} onGenerate={onGenerate} onCancel={requestClose} onBackToEdit={() => dispatch({ type: 'BACK_TO_EDIT' })} onRetry={() => dispatch({ type: 'BACK_TO_EDIT' })} onRetryEstimate={() => dispatch({ type: 'RETRY_ESTIMATE' })} showActions={false} />
            </div>
          )}
        </div>

        <div className="px-4 py-4 lg:grid lg:grid-cols-[minmax(0,65fr)_minmax(320px,35fr)] lg:gap-6 lg:p-0">
          {/* ── Colonne gauche : sections (65 %) ── */}
          <div className="min-w-0 space-y-3">
            {/* Navigation des sections (PREP-NAV-001/002, bureau). */}
            <nav aria-label="Sections du dossier" className="hidden flex-wrap gap-1.5 pb-1 lg:flex">
              {prep.sections.filter((s) => s.id !== 'cover' && s.id !== 'references').map((s) => {
                const on = s.required || state.sections[s.id] !== false;
                const c = sectionCounts(state, s);
                return (
                  <button key={s.id} type="button" onClick={() => scrollTo(s.id)} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] outline-none transition-colors hover:border-[color:var(--border-info)] focus-visible:ring-2 focus-visible:ring-ring/60', on ? 'border-border text-foreground' : 'border-border/50 text-muted-foreground line-through decoration-muted-foreground/40')}>
                    <span className={cn('size-1.5 rounded-full', on ? 'bg-primary' : 'bg-muted-foreground/40')} aria-hidden />
                    {s.label}{c.total > 0 && <span className="tabular-nums text-muted-foreground">{c.selected}/{c.total}</span>}
                    <span className="sr-only">{on ? ' (incluse)' : ' (non incluse)'}</span>
                  </button>
                );
              })}
            </nav>

            {empty && (
              <Callout tone="info" icon={<FileText />}>
                <p>{empty.text}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline" className="h-8"><NextLink href={`/assets/${assetId}?tab=details`}>Compléter la fiche du bien</NextLink></Button>
                  <Button asChild size="sm" variant="outline" className="h-8"><NextLink href={`/assets/${assetId}?tab=documents`}>Ajouter des documents</NextLink></Button>
                </div>
              </Callout>
            )}
            {state.autosave === 'error' && <Callout tone="danger" icon={<AlertTriangle />} role="alert">{PREP_MESSAGES['MSG-PREP-006']}</Callout>}

            <div className="space-y-3">
              {prep.sections.map((s) => (
                <PreparationSection
                  key={s.id}
                  section={s}
                  no={numbered(s)}
                  state={state}
                  editable={editable}
                  expanded={!!expanded[s.id]}
                  photoCap={prep.photoCap}
                  onExpand={(id, open) => setExpanded((e) => ({ ...e, [id]: open }))}
                  onEnable={(id, enabled) => dispatch({ type: 'SET_SECTION', id, enabled })}
                  onAll={(id) => dispatch({ type: 'SECTION_ALL', id })}
                  onNone={(id) => dispatch({ type: 'SECTION_NONE', id })}
                  onRestore={(id) => dispatch({ type: 'SECTION_RESTORE', id })}
                  onToggle={onToggle}
                  onMode={onMode}
                  onSelectLinked={(keys) => dispatch({ type: 'SELECT_LINKED', keys })}
                  viewUrl={viewUrl}
                  emptyAction={s.itemType === 'document' || s.itemType === 'photo' ? (
                    <NextLink href={`/assets/${assetId}?tab=documents`} className="ml-1 font-medium text-primary underline-offset-2 hover:underline">Ajouter {s.itemType === 'photo' ? 'des photos' : 'des documents'}</NextLink>
                  ) : undefined}
                >
                  {s.cil && prep.cil ? (
                    <CilBlocksPanel cil={prep.cil} assetId={assetId} api={api} disabled={!editable} onChanged={() => load(true)} />
                  ) : s.infoSections.length > 0 ? (
                    <AssetAdditionalInfosSection assetId={assetId} category={prep.asset.family} sections={stableInfo(s.infoSections)} variant="embedded" readOnly={!editable} onSaveStateChange={onSaveStateChange} onSectionsSaved={prep.saleAds ? onSectionsSaved : undefined} />
                  ) : null}
                </PreparationSection>
              ))}
              {/* VENTE-RULE-002 : annonces hors PDF, dans l'interface. */}
              {prep.saleAds && <SaleAdsPanel ads={prep.saleAds} />}
            </div>
          </div>

          {/* ── Colonne droite : résumé collant (35 %) ── */}
          <aside aria-label="Résumé et génération" className="hidden lg:block">
            <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-md)]">
              <PreparationSummary state={state} assetId={assetId} now={now} onGenerate={onGenerate} onCancel={requestClose} onBackToEdit={() => dispatch({ type: 'BACK_TO_EDIT' })} onRetry={() => dispatch({ type: 'BACK_TO_EDIT' })} onRetryEstimate={() => dispatch({ type: 'RETRY_ESTIMATE' })} />
            </div>
          </aside>
        </div>
      </div>

      {/* ── Actions fixes (mobile, PREP-MOB-004) ── */}
      {!['generating', 'generated_pdf', 'generated_zip', 'generated_partial', 'expired', 'file_deleted'].includes(state.status) && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:hidden">
          <GenerateButtons state={state} onGenerate={onGenerate} onCancel={requestClose} layout="bar" />
        </div>
      )}

      {/* ── ALT-002 : confirmation « PDF seul » (PREP-RÉS-011) ── */}
      <AlertDialog open={state.confirmPdfOnly} onOpenChange={(o) => { if (!o) dispatch({ type: 'CLOSE_PDF_ONLY_CONFIRM' }); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Générer le PDF seul ?</AlertDialogTitle>
            <AlertDialogDescription>{PREP_MESSAGES['MSG-PREP-002']}</AlertDialogDescription>
          </AlertDialogHeader>
          {(state.estimate?.zipOnlyItems.length ?? 0) > 0 && (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border p-2.5 text-xs">
              {state.estimate!.zipOnlyItems.map((z) => <li key={z.key} className="truncate">· {z.label}</li>)}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Revenir à la préparation</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doGenerate('PDF', true)}>Continuer sans ces pièces</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirmation de fermeture (cancel_confirm, PREP-MOB-008) ── */}
      <AlertDialog open={state.status === 'cancel_confirm'} onOpenChange={(o) => { if (!o) { pendingHref.current = null; dispatch({ type: 'CANCEL_CLOSE' }); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{closingWhileGenerating ? 'Fermer pendant la génération ?' : 'Quitter la préparation ?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {closingWhileGenerating
                ? 'La génération continue : le dossier apparaîtra dans l’historique des exports dès qu’il sera prêt.'
                : 'Vos choix de sections et de pièces ne sont pas conservés. Les informations complémentaires saisies sont déjà enregistrées dans la fiche du bien.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Rester</AlertDialogCancel>
            <AlertDialogAction onClick={() => onClose(pendingHref.current ?? undefined)}>{closingWhileGenerating ? 'Fermer' : 'Quitter sans générer'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
