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
 * Une correction modifie le MÊME fait (`PUT /api/documents/:id/periodes`),
 * quelle que soit la fiche : les deux tiroirs se relisent
 * (`business-periods-mutated`). Rien n'est affiché quand aucune période n'est
 * pertinente. Aucun « expiré », aucun statut présumé, aucune réanalyse.
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarRange, FileText, Pencil } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/lib/api-client";
import { useWriteGuard } from "@/contexts/WriteGuardContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BUSINESS_PERIOD_LABELS, COVERAGE_HISTORY_TITLE, PERIOD_CORRECT_ACTION, PERIOD_INVALID_MESSAGE, PERIOD_SAVED_TOAST,
  PERIOD_USER_MENTION, orderedBounds, parsePartialInput, partialToInput,
  type BusinessPeriodKind, type PartialDate,
} from "@/lib/documents/business-periods";

/** Événement de fenêtre : une période a changé (les tiroirs ouverts se relisent). */
export const BUSINESS_PERIODS_MUTATED = "business-periods-mutated";

interface PeriodView {
  id: number;
  kind: BusinessPeriodKind;
  segment: number;
  start: PartialDate | null;
  end: PartialDate | null;
  line: string;
  userCorrected: boolean;
}
interface CoverageEntry extends PeriodView { fileId: number; documentTitle: string }
interface DocumentPeriodsView {
  documentId: number;
  principal: { kind: BusinessPeriodKind; line: string; segments: PeriodView[] } | null;
  secondary: PeriodView[];
  coverageHistories: Array<{ operationId: number; coverages: CoverageEntry[] }>;
}

// ── Édition d'une période ───────────────────────────────────────────────────

function PeriodEditor({ fileId, period, onDone }: { fileId: number; period: PeriodView; onDone: (saved: boolean) => void }) {
  const [debut, setDebut] = useState(partialToInput(period.start));
  const [fin, setFin] = useState(partialToInput(period.end));
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
      await apiClient.put(`/api/documents/${fileId}/periodes`, { periodId: period.id, start, end });
      toast.success(PERIOD_SAVED_TOAST);
      window.dispatchEvent(new CustomEvent(BUSINESS_PERIODS_MUTATED, { detail: { fileId } }));
      onDone(true);
    } catch (err: any) {
      if (err?.status !== 403) setErreur(err?.serverMessage || PERIOD_INVALID_MESSAGE);
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
      {erreur && <p className="text-xs text-[color:var(--danger)]" role="alert">{erreur}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => onDone(false)} disabled={busy}>Annuler</Button>
        <Button type="button" size="sm" onClick={() => { void enregistrer(); }} disabled={busy}>Enregistrer</Button>
      </div>
    </div>
  );
}

/** Ligne d'une période + action « Corriger » (protégée en lecture seule par la garde d'écriture). */
function PeriodRow({ fileId, period, text, muted, onSaved }: {
  fileId: number; period: PeriodView; text?: string; muted?: boolean; onSaved: () => void;
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
        {!edition && (
          <button
            type="button"
            onClick={() => garder(() => setEdition(true))}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] min-h-[32px]"
            aria-label={`${PERIOD_CORRECT_ACTION} : ${period.line}`}
          >
            <Pencil className="w-3 h-3" />{PERIOD_CORRECT_ACTION}
          </button>
        )}
      </div>
      {edition && <PeriodEditor fileId={fileId} period={period} onDone={(ok) => { setEdition(false); if (ok) onSaved(); }} />}
    </div>
  );
}

// ── Historique de couverture ────────────────────────────────────────────────

function CoverageHistoryList({ coverages, currentFileId, onOpenDocument, onSaved }: {
  coverages: CoverageEntry[]; currentFileId?: number; onOpenDocument?: (fileId: number) => void; onSaved: () => void;
}) {
  return (
    <div className="space-y-2" data-testid="coverage-history">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><CalendarRange className="w-3.5 h-3.5" />{COVERAGE_HISTORY_TITLE}</p>
      <ol className="space-y-2">
        {coverages.map((c) => (
          <li key={c.id} className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-3 py-2" data-testid="coverage-history-entry">
            <PeriodRow fileId={c.fileId} period={c} onSaved={onSaved} />
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
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Tiroir du document ──────────────────────────────────────────────────────

export function DocumentBusinessPeriodField({ documentId, refreshKey, onOpenDocument }: {
  documentId: number; refreshKey?: number; onOpenDocument?: (fileId: number) => void;
}) {
  const [view, setView] = useState<DocumentPeriodsView | null>(null);
  const charger = useCallback(async () => {
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

  if (!view || (!view.principal && !view.secondary.length && !view.coverageHistories.length)) return null;
  const p = view.principal;
  return (
    <div className="space-y-2" data-testid="document-business-periods">
      {p && (p.segments.length > 1 ? (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5 text-sm text-[color:var(--text-primary)]" data-testid="business-period-principal">
            <CalendarRange className="w-3.5 h-3.5 text-muted-foreground" />{p.line}
          </p>
          <div className="pl-5 space-y-1">
            {p.segments.map((s) => <PeriodRow key={s.id} fileId={documentId} period={s} muted onSaved={charger} />)}
          </div>
        </div>
      ) : p.segments[0] ? (
        <div className="flex items-start gap-1.5" data-testid="business-period-principal">
          <CalendarRange className="mt-0.5 w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <div className="flex-1 min-w-0"><PeriodRow fileId={documentId} period={p.segments[0]} onSaved={charger} /></div>
        </div>
      ) : null)}
      {view.secondary.length > 0 && (
        <div className="pl-5 space-y-1" data-testid="business-period-secondary">
          {view.secondary.map((s) => <PeriodRow key={s.id} fileId={documentId} period={s} muted onSaved={charger} />)}
        </div>
      )}
      {view.coverageHistories.map((h) => (
        <CoverageHistoryList key={h.operationId} coverages={h.coverages} currentFileId={documentId} onOpenDocument={onOpenDocument} onSaved={charger} />
      ))}
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
      <CoverageHistoryList coverages={coverages} onOpenDocument={onOpenDocument} onSaved={charger} />
    </div>
  );
}
