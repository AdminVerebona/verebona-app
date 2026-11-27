"use client";

/**
 * Lot 113W (Trello #724) — périodes métier : affichage et correction
 * (desktop et mobile, même composant ; charte Sérénité, jetons de couleur).
 *
 *   · `DocumentBusinessPeriodField` (tiroir du document) : UNE période
 *     principale (« Période couverte : du… au… », « Début de couverture : … »,
 *     « Plusieurs périodes concernées » + détail, « Période … : non
 *     renseignée »), les autres natures en détail, et l'historique de
 *     couverture de l'événement de référence quand d'autres justificatifs
 *     en portent ;
 *   · `AgendaCoverageHistory` (tiroir d'un élément d'agenda) : toutes les
 *     périodes de couverture établies de son événement de référence,
 *     chronologiques, chacune reliée à son justificatif.
 * Lot 113AA (#725, D11) : chaque couverture de l'historique porte sa
 * RÉSOLUTION calculée par le serveur (actualisée par un avenant, remplacée par
 * un rectificatif ou par votre choix, divergente) — affichée en petit sous la
 * ligne, jamais masquée ; un même fait porté par plusieurs justificatifs est
 * présenté une fois, avec ses autres justificatifs.
 * Une correction modifie le MÊME fait (`PUT /api/documents/:id/periodes`),
 * quelle que soit la fiche : les deux tiroirs se relisent
 * (`business-periods-mutated`). Rien n'est affiché quand aucune période n'est
 * pertinente. Aucun « expiré », aucun statut présumé, aucune réanalyse.
 *
 * Carte #766 :
 *   · E04 — l'éditeur EXISTANT porte une case « Durée indéterminée » : le statut établi est conservé
 *     quand on ne corrige que le début, et se modifie explicitement (aucun second parcours d'édition) ;
 *   · E11 — le bloc de la période garde UNE période principale ; le détail (périodes discontinues, autres
 *     natures) est affiché par `DocumentPeriodsDetail`, sous-section rattachée à « Notes / Description »,
 *     CALCULÉE à la lecture depuis les faits structurés — jamais écrite, concaténée ni réenregistrée dans
 *     les notes de l'utilisateur ou la description T1. La correction reste celle de la ligne existante.
 *
 * Carte #782 — ÉDITION UNIFIÉE. Une période est une donnée structurée normale, pas une anomalie :
 *   · dans le TIROIR du document, les lignes de période (principale, segments, autres natures,
 *     historiques de couverture) n'ont plus d'action : elles sont en lecture (`action="none"`) ;
 *     l'édition passe par le parcours général « Modifier » du document, où `useDocumentPeriodsEdit`
 *     et `DocumentPeriodsEditFields` présentent TOUTES les périodes du document (principale,
 *     segments discontinus et autres natures) avec dates partielles et durée indéterminée ;
 *   · là où aucun parcours « Modifier » général n'existe (détail d'une dépense, fiche de l'événement
 *     de référence, tiroir d'un élément d'agenda), la ligne garde son action, nommée « Modifier » ;
 *   · l'écriture reste la route du MÊME fait (`PUT /api/documents/:id/periodes`) et ses contrôles,
 *     par UN SEUL point d'appel (`enregistrerPeriode`) : rien n'est contourné, les notes et la
 *     description ne sont jamais touchées, et seules les périodes RÉELLEMENT modifiées sont écrites
 *     (une période inchangée n'est donc pas marquée « corrigée par vous » par un enregistrement).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarRange, FileText, Pencil } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/lib/api-client";
import { useWriteGuard } from "@/contexts/WriteGuardContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  BUSINESS_PERIOD_LABELS, COVERAGE_HISTORY_TITLE, PERIOD_DETAIL_TITLE, PERIOD_EDIT_ACTION, PERIOD_EDIT_SECTION_TITLE, PERIOD_INVALID_MESSAGE, PERIOD_OPEN_ENDED_LABEL, PERIOD_SAVED_TOAST,
  PERIOD_USER_MENTION, orderedBounds, parsePartialInput, partialToInput, periodEditBounds, periodEditChanged,
  type BusinessPeriodKind, type PartialDate, type PeriodEditBounds,
} from "@/lib/documents/business-periods";
import { readThrownError } from "@/lib/thrown-error";

/** Événement de fenêtre : une période a changé (les tiroirs ouverts se relisent). */
export const BUSINESS_PERIODS_MUTATED = "business-periods-mutated";

export interface PeriodView {
  id: number;
  kind: BusinessPeriodKind;
  segment: number;
  start: PartialDate | null;
  end: PartialDate | null;
  line: string;
  userCorrected: boolean;
  /** Carte #766 (E03 / E04) : durée indéterminée ÉTABLIE (≠ fin inconnue). */
  openEnded?: boolean;
}
export interface CoverageEntry extends PeriodView {
  fileId: number;
  documentTitle: string;
  resolution?: { status: "REPLACED" | "CONFLICT"; note: string };
  otherSources?: Array<{ fileId: number; documentTitle: string }>;
}
export interface DocumentPeriodsView {
  documentId: number;
  principal: { kind: BusinessPeriodKind; line: string; segments: PeriodView[] } | null;
  secondary: PeriodView[];
  coverageHistories: Array<{ operationId: number; coverages: CoverageEntry[] }>;
}

// ── Édition d'une période ───────────────────────────────────────────────────

/** Corps accepté par la route du MÊME fait (dates partielles ou absentes, durée indéterminée établie). */
export interface PeriodWriteBody { periodId: number; start: PartialDate | null; end: PartialDate | null; openEnded: boolean }

/**
 * Carte #782 — UNIQUE point d'écriture d'une période côté interface : la ligne (dépense, fiche de
 * l'événement de référence, agenda) et le parcours « Modifier » du document passent tous les deux par
 * ici. Les contrôles (autorisation, chronologie, même fait, `user_locked`, propagation) restent ceux
 * de la route ; aucune autre donnée du document n'est envoyée.
 */
async function enregistrerPeriode(fileId: number, body: PeriodWriteBody): Promise<void> {
  await apiClient.put(`/api/documents/${fileId}/periodes`, body);
}

function PeriodEditor({ fileId, period, onDone }: { fileId: number; period: PeriodView; onDone: (saved: boolean) => void }) {
  const [debut, setDebut] = useState(partialToInput(period.start));
  const [fin, setFin] = useState(partialToInput(period.end));
  // Carte #766 (E04) : le statut établi est repris tel quel ; il ne change que si l'utilisateur y touche.
  const [indeterminee, setIndeterminee] = useState(period.openEnded === true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labels = BUSINESS_PERIOD_LABELS[period.kind];

  const enregistrer = async () => {
    const start = parsePartialInput(debut);
    const end = parsePartialInput(fin);
    if (start === undefined || end === undefined || !orderedBounds(start, end)) { setErreur(PERIOD_INVALID_MESSAGE); return; }
    setBusy(true);
    setErreur(null);
    try {
      // Une fin saisie exclut la durée indéterminée ; sinon la case dit explicitement ce qui est voulu.
      await enregistrerPeriode(fileId, { periodId: period.id, start, end, openEnded: end === null ? indeterminee : false });
      toast.success(PERIOD_SAVED_TOAST);
      window.dispatchEvent(new CustomEvent(BUSINESS_PERIODS_MUTATED, { detail: { fileId } }));
      onDone(true);
    } catch (err: unknown) {
      const failure = readThrownError(err);
      if (failure.status !== 403) setErreur(failure.serverMessage || PERIOD_INVALID_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-page)] p-3 space-y-2" data-testid="business-period-editor">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs text-muted-foreground space-y-1">
          <span>{labels.start}</span>
          <Input value={debut} onChange={(e) => setDebut(e.target.value)} inputMode="numeric" placeholder="JJ/MM/AAAA" aria-label={labels.start} />
        </label>
        <label className="text-xs text-muted-foreground space-y-1">
          <span>{labels.end}</span>
          <Input value={fin} onChange={(e) => setFin(e.target.value)} inputMode="numeric" placeholder="JJ/MM/AAAA" aria-label={labels.end} />
        </label>
      </div>
      <label className="flex min-h-[32px] cursor-pointer items-center gap-2 text-xs text-muted-foreground" data-testid="business-period-open-ended">
        <Checkbox checked={indeterminee && !fin.trim()} disabled={!!fin.trim()} onCheckedChange={(v) => setIndeterminee(v === true)} aria-label={PERIOD_OPEN_ENDED_LABEL} />
        <span>{PERIOD_OPEN_ENDED_LABEL}</span>
      </label>
      {erreur && <p className="text-xs text-[color:var(--danger)]" role="alert">{erreur}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => onDone(false)} disabled={busy}>Annuler</Button>
        <Button type="button" size="sm" onClick={() => { void enregistrer(); }} disabled={busy}>Enregistrer</Button>
      </div>
    </div>
  );
}

/**
 * Carte #782 — action d'une ligne de période :
 *   · `edit` : action explicite « Modifier » (écrans SANS parcours « Modifier » général : détail d'une
 *     dépense, fiche de l'événement de référence, tiroir d'un élément d'agenda) ;
 *   · `none` : aucune action — la ligne est en LECTURE (tiroir du document, dont le parcours général
 *     « Modifier » porte l'édition de toutes les périodes).
 * Aucun « Corriger » : jamais de faux indicateur d'anomalie sur une donnée structurée normale.
 */
export type PeriodRowAction = 'edit' | 'none';

/** Ligne d'une période, avec ou sans action d'édition (protégée en lecture seule par la garde d'écriture). Lot 113AB : réutilisée (dépense, fiche de l'événement de référence). */
export function PeriodRow({ fileId, period, text, muted, action = 'edit', onSaved }: {
  fileId: number; period: PeriodView; text?: string; muted?: boolean; action?: PeriodRowAction; onSaved: () => void;
}) {
  const [edition, setEdition] = useState(false);
  const { garder } = useWriteGuard();
  return (
    <div data-testid="business-period-row">
      <div className="flex items-start justify-between gap-2">
        <span className={muted ? "text-xs text-muted-foreground" : "text-sm text-[color:var(--text-primary)]"}>
          {text ?? period.line}
          {period.userCorrected && <span className="ml-1.5 text-[11px] text-muted-foreground">· {PERIOD_USER_MENTION}</span>}
        </span>
        {action === 'edit' && !edition && (
          <button
            type="button"
            onClick={() => garder(() => setEdition(true))}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] min-h-[32px]"
            aria-label={`${PERIOD_EDIT_ACTION} : ${period.line}`}
            data-testid="business-period-edit-action"
          >
            <Pencil className="w-3 h-3" />{PERIOD_EDIT_ACTION}
          </button>
        )}
      </div>
      {edition && <PeriodEditor fileId={fileId} period={period} onDone={(ok) => { setEdition(false); if (ok) onSaved(); }} />}
    </div>
  );
}

// ── Historique de couverture ────────────────────────────────────────────────

/** Lot 113AB : réutilisée par la fiche de l'événement de référence. */
export function CoverageHistoryList({ coverages, currentFileId, onOpenDocument, action = 'edit', onSaved }: {
  coverages: CoverageEntry[]; currentFileId?: number; onOpenDocument?: (fileId: number) => void; action?: PeriodRowAction; onSaved: () => void;
}) {
  return (
    <div className="space-y-2" data-testid="coverage-history">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><CalendarRange className="w-3.5 h-3.5" />{COVERAGE_HISTORY_TITLE}</p>
      <ol className="space-y-2">
        {coverages.map((c) => (
          <li key={c.id} className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-3 py-2" data-testid="coverage-history-entry">
            <PeriodRow fileId={c.fileId} period={c} muted={c.resolution?.status === "REPLACED"} action={action} onSaved={onSaved} />
            {c.resolution && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="coverage-history-resolution">{c.resolution.note}</p>
            )}
            {c.fileId !== currentFileId && onOpenDocument ? (
              <button
                type="button"
                onClick={() => onOpenDocument(c.fileId)}
                className="mt-1 inline-flex max-w-full items-center gap-1.5 text-xs text-[color:var(--accent)] hover:underline"
                aria-label={`Ouvrir le document : ${c.documentTitle}`}
              >
                <FileText className="w-3 h-3 shrink-0" /><span className="truncate">{c.documentTitle}</span>
              </button>
            ) : (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><FileText className="w-3 h-3 shrink-0" /><span className="truncate">{c.documentTitle}</span></p>
            )}
            {(c.otherSources ?? []).map((o) => (o.fileId !== currentFileId && onOpenDocument ? (
              <button
                key={o.fileId}
                type="button"
                onClick={() => onOpenDocument(o.fileId)}
                className="mt-1 flex max-w-full items-center gap-1.5 text-xs text-[color:var(--accent)] hover:underline"
                aria-label={`Ouvrir le document : ${o.documentTitle}`}
              >
                <FileText className="w-3 h-3 shrink-0" /><span className="truncate">{o.documentTitle}</span>
              </button>
            ) : (
              <p key={o.fileId} className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><FileText className="w-3 h-3 shrink-0" /><span className="truncate">{o.documentTitle}</span></p>
            )))}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Tiroir du document ──────────────────────────────────────────────────────

/**
 * Carte #766 (E11) — périodes d'un document, lues UNE fois pour le bloc de la période principale et pour
 * la sous-section de détail rattachée à « Notes / Description » (relues après une correction).
 */
export function useDocumentPeriods(documentId: number | null | undefined, refreshKey?: number): { view: DocumentPeriodsView | null; reload: () => void } {
  const [view, setView] = useState<DocumentPeriodsView | null>(null);
  const charger = useCallback(async () => {
    if (!documentId) { setView(null); return; }
    try {
      const r = await apiClient.get<{ periods: DocumentPeriodsView }>(`/api/documents/${documentId}/periodes`);
      setView(r?.periods ?? null);
    } catch {
      setView(null);
    }
  }, [documentId]);
  useEffect(() => { void charger(); }, [charger, refreshKey]);
  useEffect(() => {
    const h = () => { void charger(); };
    window.addEventListener(BUSINESS_PERIODS_MUTATED, h);
    return () => window.removeEventListener(BUSINESS_PERIODS_MUTATED, h);
  }, [charger]);
  return { view, reload: () => { void charger(); } };
}

/**
 * Bloc de la période du document : UNE période principale (une ligne, ou « Plusieurs périodes
 * concernées ») et l'historique de couverture. Le détail est dans `DocumentPeriodsDetail` (carte #766, E11).
 */
export function DocumentBusinessPeriodField({ documentId, periods, onOpenDocument }: {
  documentId: number; periods: { view: DocumentPeriodsView | null; reload: () => void }; onOpenDocument?: (fileId: number) => void;
}) {
  const { view, reload } = periods;
  if (!view || view.documentId !== documentId || (!view.principal && !view.coverageHistories.length)) return null;
  const p = view.principal;
  return (
    <div className="space-y-2" data-testid="document-business-periods">
      {p && (p.segments.length > 1 ? (
        <p className="flex items-center gap-1.5 text-sm text-[color:var(--text-primary)]" data-testid="business-period-principal">
          <CalendarRange className="w-3.5 h-3.5 text-muted-foreground" />{p.line}
        </p>
      ) : p.segments[0] ? (
        <div className="flex items-start gap-1.5" data-testid="business-period-principal">
          <CalendarRange className="mt-0.5 w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          {/* Carte #782 : lecture seule dans le tiroir — l'édition est dans le parcours « Modifier ». */}
          <div className="flex-1 min-w-0"><PeriodRow fileId={documentId} period={p.segments[0]} action="none" onSaved={reload} /></div>
        </div>
      ) : null)}
      {/* Carte #782 : les couvertures des AUTRES justificatifs restent consultables et s'ouvrent par leur
          document (lien ci-dessous) ; aucune action « Corriger » dans le tiroir. */}
      {view.coverageHistories.map((h) => (
        <CoverageHistoryList key={h.operationId} coverages={h.coverages} currentFileId={documentId} onOpenDocument={onOpenDocument} action="none" onSaved={reload} />
      ))}
    </div>
  );
}

/**
 * Carte #766 (E11) — détail des périodes, rattaché à la zone « Notes / Description » du document : périodes
 * discontinues de la nature principale, puis autres natures. Affichage CALCULÉ depuis les faits structurés
 * à chaque lecture : rien n'est écrit dans les notes de l'utilisateur ni dans la description T1. Rien n'est
 * affiché s'il n'y a pas de détail. La correction est celle de la ligne existante (même fait, même route).
 */
export function DocumentPeriodsDetail({ documentId, periods }: { documentId: number; periods: { view: DocumentPeriodsView | null; reload: () => void } }) {
  // Carte #782 : lecture seule (le parcours « Modifier » du document porte l'édition de ces périodes).
  const { view, reload } = periods;
  if (!view || view.documentId !== documentId) return null;
  const segments = view.principal && view.principal.segments.length > 1 ? view.principal.segments : [];
  if (!segments.length && !view.secondary.length) return null;
  return (
    <div className="pt-1 space-y-1" data-testid="document-periods-detail">
      <p className="vb-app-label flex items-center gap-1"><CalendarRange className="w-3 h-3" />{PERIOD_DETAIL_TITLE}</p>
      {segments.length > 0 && (
        <div className="space-y-1" data-testid="business-period-segments">
          {segments.map((s) => <PeriodRow key={s.id} fileId={documentId} period={s} muted action="none" onSaved={reload} />)}
        </div>
      )}
      {view.secondary.length > 0 && (
        <div className="space-y-1" data-testid="business-period-secondary">
          {view.secondary.map((s) => <PeriodRow key={s.id} fileId={documentId} period={s} muted action="none" onSaved={reload} />)}
        </div>
      )}
    </div>
  );
}

// ── Tiroir d'un élément d'agenda ────────────────────────────────────────────

export function AgendaCoverageHistory({ itemId, onOpenDocument }: { itemId: number; onOpenDocument?: (fileId: number) => void }) {
  const [coverages, setCoverages] = useState<CoverageEntry[]>([]);
  const charger = useCallback(async () => {
    try {
      const r = await apiClient.get<{ history: { coverages: CoverageEntry[] } | null }>(`/api/agenda/${itemId}/periodes`);
      setCoverages(r?.history?.coverages ?? []);
    } catch {
      setCoverages([]);
    }
  }, [itemId]);
  useEffect(() => { void charger(); }, [charger]);
  useEffect(() => {
    const h = () => { void charger(); };
    window.addEventListener(BUSINESS_PERIODS_MUTATED, h);
    window.addEventListener("agenda-mutated", h);
    return () => { window.removeEventListener(BUSINESS_PERIODS_MUTATED, h); window.removeEventListener("agenda-mutated", h); };
  }, [charger]);
  if (!coverages.length) return null;
  return (
    <div className="mt-4">
      {/* Carte #782 : aucun parcours « Modifier » général ici — la ligne garde son action, nommée « Modifier ». */}
      <CoverageHistoryList coverages={coverages} onOpenDocument={onOpenDocument} action="edit" onSaved={charger} />
    </div>
  );
}

// ── Carte #782 : périodes dans le parcours « Modifier » du document ─────────

/** Une période du document en cours d'édition : bornes SAISIES (forme française) et durée indéterminée. */
export interface PeriodDraft {
  id: number;
  kind: BusinessPeriodKind;
  /** Libellé établi de la période (identité de la ligne éditée). */
  line: string;
  start: string;
  end: string;
  openEnded: boolean;
}

export interface DocumentPeriodsEditor {
  /** Périodes PROPRES au document : principale (tous ses segments) puis autres natures. */
  drafts: PeriodDraft[];
  /** Message par période (format illisible, chronologie, refus du serveur). */
  erreurs: Record<number, string>;
  modifier: (id: number, patch: Partial<Pick<PeriodDraft, 'start' | 'end' | 'openEnded'>>) => void;
  /** Reprend les valeurs établies (entrée en édition, annulation). */
  reinitialiser: () => void;
  /** Saisies lisibles et bornes ordonnées ? N'écrit rien. */
  valider: () => boolean;
  /** Écrit les périodes RÉELLEMENT modifiées, une par une, par la route du même fait. */
  enregistrer: (fileId: number) => Promise<boolean>;
}

/** Périodes propres au document (jamais celles des autres justificatifs d'un historique de couverture). */
function ownPeriods(view: DocumentPeriodsView | null): PeriodView[] {
  if (!view) return [];
  return [...(view.principal?.segments ?? []), ...view.secondary];
}

/**
 * Carte #782 — état d'édition des périodes du document pour le parcours général « Modifier » : les
 * périodes multiples, les segments discontinus et les autres natures y sont TOUS accessibles. Aucune
 * période n'est créée ni supprimée ici (la création d'une nature a son propre contrôle serveur), et une
 * période laissée telle quelle n'est pas réécrite : elle ne devient donc pas « corrigée par vous ».
 */
export function useDocumentPeriodsEdit(periods: { view: DocumentPeriodsView | null; reload: () => void }): DocumentPeriodsEditor {
  const { view, reload } = periods;
  const [drafts, setDrafts] = useState<PeriodDraft[]>([]);
  const [erreurs, setErreurs] = useState<Record<number, string>>({});
  const [arme, setArme] = useState(false);
  const bases = useRef<Map<number, PeriodEditBounds>>(new Map());
  // Vue la plus récente, sans relancer la reprise à chaque relecture (une saisie en cours est conservée).
  const vueRef = useRef<DocumentPeriodsView | null>(view);
  useEffect(() => { vueRef.current = view; }, [view]);

  const capturer = useCallback((v: DocumentPeriodsView | null) => {
    const own = ownPeriods(v);
    bases.current = new Map(own.map((p) => [p.id, { start: p.start, end: p.end, openEnded: p.openEnded === true }]));
    setDrafts(own.map((p) => ({
      id: p.id, kind: p.kind, line: p.line,
      start: partialToInput(p.start), end: partialToInput(p.end), openEnded: p.openEnded === true,
    })));
    setErreurs({});
  }, []);

  const reinitialiser = useCallback(() => { setArme(true); capturer(vueRef.current); }, [capturer]);

  // Périodes lues APRÈS l'entrée en édition : elles sont reprises (aucune saisie n'est écrasée, la
  // liste étant vide) — un parcours « Modifier » ouvert tôt n'oublie donc aucune période.
  useEffect(() => {
    if (arme && drafts.length === 0 && ownPeriods(view).length > 0) capturer(view);
  }, [arme, drafts.length, view, capturer]);

  const modifier = useCallback<DocumentPeriodsEditor['modifier']>((id, patch) => {
    setDrafts((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    setErreurs((prev) => (prev[id] ? { ...prev, [id]: '' } : prev));
  }, []);

  const valider = useCallback(() => {
    const errs: Record<number, string> = {};
    for (const d of drafts) if (!periodEditBounds(d)) errs[d.id] = PERIOD_INVALID_MESSAGE;
    setErreurs(errs);
    return Object.keys(errs).length === 0;
  }, [drafts]);

  const enregistrer = useCallback(async (fileId: number) => {
    const aEcrire: PeriodWriteBody[] = [];
    const errs: Record<number, string> = {};
    for (const d of drafts) {
      const v = periodEditBounds(d);
      if (!v) { errs[d.id] = PERIOD_INVALID_MESSAGE; continue; }
      const b = bases.current.get(d.id);
      if (b && !periodEditChanged(b, v)) continue;
      aEcrire.push({ periodId: d.id, start: v.start, end: v.end, openEnded: v.openEnded });
    }
    if (Object.keys(errs).length) { setErreurs(errs); return false; }
    setErreurs({});
    if (!aEcrire.length) return true;
    for (const body of aEcrire) {
      try {
        await enregistrerPeriode(fileId, body);
        bases.current.set(body.periodId, { start: body.start, end: body.end, openEnded: body.openEnded });
      } catch (err: unknown) {
        const e = err as { status?: number; serverMessage?: string };
        // 403 : la garde d'écriture affiche déjà sa fenêtre — aucun message par-dessus.
        if (e?.status !== 403) setErreurs({ [body.periodId]: e?.serverMessage || PERIOD_INVALID_MESSAGE });
        // Les périodes déjà écrites le restent : les écrans ouverts se relisent avant de signaler l'échec.
        window.dispatchEvent(new CustomEvent(BUSINESS_PERIODS_MUTATED, { detail: { fileId } }));
        reload();
        return false;
      }
    }
    window.dispatchEvent(new CustomEvent(BUSINESS_PERIODS_MUTATED, { detail: { fileId } }));
    reload();
    return true;
  }, [drafts, reload]);

  return { drafts, erreurs, modifier, reinitialiser, valider, enregistrer };
}

/**
 * Carte #782 — champs des périodes DANS le formulaire « Modifier le document » (desktop et mobile,
 * mêmes composants de saisie que le reste du formulaire ; jetons de couleur seulement). Dates
 * partielles acceptées (JJ/MM/AAAA, MM/AAAA, AAAA), valeur absente, durée indéterminée explicite.
 * Rien n'est affiché quand le document ne porte aucune période.
 */
export function DocumentPeriodsEditFields({ editor, idPrefix, disabled }: {
  editor: DocumentPeriodsEditor; idPrefix: string; disabled?: boolean;
}) {
  if (!editor.drafts.length) return null;
  return (
    <div className="space-y-2" data-testid="document-periods-edit">
      <p className="text-xs font-medium text-muted-foreground">{PERIOD_EDIT_SECTION_TITLE}</p>
      {editor.drafts.map((d) => {
        const labels = BUSINESS_PERIOD_LABELS[d.kind];
        const finSaisie = d.end.trim().length > 0;
        return (
          <div
            key={d.id}
            className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-page)] p-3 space-y-2"
            data-testid="document-period-edit-row"
          >
            <p className="text-xs font-medium text-[color:var(--text-primary)]">{d.line}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="text-xs text-muted-foreground space-y-1" htmlFor={`${idPrefix}-periode-${d.id}-debut`}>
                <span>{labels.start}</span>
                <Input
                  id={`${idPrefix}-periode-${d.id}-debut`}
                  value={d.start}
                  onChange={(e) => editor.modifier(d.id, { start: e.target.value })}
                  inputMode="numeric"
                  placeholder="JJ/MM/AAAA"
                  aria-label={`${labels.start} : ${d.line}`}
                  disabled={disabled}
                />
              </label>
              <label className="text-xs text-muted-foreground space-y-1" htmlFor={`${idPrefix}-periode-${d.id}-fin`}>
                <span>{labels.end}</span>
                <Input
                  id={`${idPrefix}-periode-${d.id}-fin`}
                  value={d.end}
                  onChange={(e) => editor.modifier(d.id, { end: e.target.value })}
                  inputMode="numeric"
                  placeholder="JJ/MM/AAAA"
                  aria-label={`${labels.end} : ${d.line}`}
                  disabled={disabled}
                />
              </label>
            </div>
            <label className="flex min-h-[32px] cursor-pointer items-center gap-2 text-xs text-muted-foreground" data-testid="document-period-edit-open-ended">
              <Checkbox
                checked={d.openEnded && !finSaisie}
                disabled={disabled || finSaisie}
                onCheckedChange={(v) => editor.modifier(d.id, { openEnded: v === true })}
                aria-label={`${PERIOD_OPEN_ENDED_LABEL} : ${d.line}`}
              />
              <span>{PERIOD_OPEN_ENDED_LABEL}</span>
            </label>
            {editor.erreurs[d.id] && <p className="text-xs text-[color:var(--danger)]" role="alert">{editor.erreurs[d.id]}</p>}
          </div>
        );
      })}
    </div>
  );
}
