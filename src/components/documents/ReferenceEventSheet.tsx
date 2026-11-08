"use client";

/**
 * Lot 113AB (Trello #725, §3 « Opérations / contrats ») — FICHE DE
 * L'ÉVÉNEMENT DE RÉFÉRENCE, consultable même quand aucun élément d'agenda
 * ne le représente (desktop et mobile : même composant, `Sheet` pleine
 * largeur sur mobile ; charte Sérénité, jetons de couleur seulement).
 *
 *   · toutes les périodes de couverture établies, chronologiques, chacune
 *     reliée à son justificatif (lecture du lot 113W, la même que le tiroir
 *     Agenda et le tiroir du document) ; « Corriger » modifie le MÊME fait
 *     (`PUT /api/documents/:fileId/periodes`) : tous les tiroirs ouverts se
 *     relisent (`business-periods-mutated`) ;
 *   · les justificatifs de l'événement (ouvrent le tiroir du document) ;
 *   · l'élément d'agenda relié, s'il existe (« Ouvrir dans l'agenda »).
 * Sans couverture : rien pour une intervention ou un achat (aucun champ
 * artificiel) ; « Aucune période de couverture établie. » pour un contrat.
 * Aucune période facturée (chaque dépense garde la sienne), aucun statut
 * (« en cours », « expiré »), aucune prolongation. Lecture seule : la garde
 * d'écriture existante refuse « Corriger ». Le mot « Opération » n'apparaît
 * jamais.
 *
 * `ReferenceEventLink` : lien d'ouverture (ligne de dépense, tiroir du
 * document) ; `DocumentReferenceEvents` : liens du tiroir d'un document vers
 * les événements de référence SANS élément d'agenda (ceux qui en ont un
 * s'ouvrent déjà par l'agenda).
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, FileText, Layers } from "lucide-react";
import { toast } from "sonner";
import { apiClient } from "@/lib/api-client";
import { openDrawer } from "@/lib/drawers";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { COVERAGE_HISTORY_EMPTY, COVERAGE_HISTORY_TITLE } from "@/lib/documents/business-periods";
import {
  REFERENCE_EVENT_AGENDA_LINK, REFERENCE_EVENT_DOCUMENTS_TITLE, REFERENCE_EVENT_NOT_FOUND, REFERENCE_EVENT_TITLE,
} from "@/lib/documents/business-period-surfaces";
import { BUSINESS_PERIODS_MUTATED, CoverageHistoryList, type CoverageEntry } from "./BusinessPeriods";

/** Texte du lien d'ouverture (repris du lot 113X, « Voir l'événement de référence »). */
export const REFERENCE_EVENT_OPEN_LABEL = "Voir l’événement de référence";

interface ReferenceEventView {
  id: number;
  label: string;
  typeCode: string | null;
  provider: string | null;
  coverages: CoverageEntry[];
  documents: Array<{ fileId: number; title: string; date: string | null }>;
  agendaItemId: number | null;
}

const jj = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : null);

export function ReferenceEventSheet({ operationId, open, onOpenChange }: { operationId: number; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [view, setView] = useState<ReferenceEventView | null>(null);
  const [loading, setLoading] = useState(false);
  const charger = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiClient.get<{ reference: ReferenceEventView }>(`/api/evenements-reference/${operationId}`);
      setView(r?.reference ?? null);
    } catch {
      setView(null);
      toast.error(REFERENCE_EVENT_NOT_FOUND);
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  }, [operationId, onOpenChange]);
  useEffect(() => { if (open) void charger(); }, [open, charger]);
  useEffect(() => {
    if (!open) return;
    const h = () => { void charger(); };
    window.addEventListener(BUSINESS_PERIODS_MUTATED, h);
    return () => window.removeEventListener(BUSINESS_PERIODS_MUTATED, h);
  }, [open, charger]);

  const ouvrirDocument = (fileId: number) => openDrawer({ kind: "document", id: fileId });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col gap-0 p-0" data-testid="reference-event-sheet">
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
          <SheetTitle>{REFERENCE_EVENT_TITLE}</SheetTitle>
          <SheetDescription data-testid="reference-event-label">{view?.label ?? (loading ? "…" : "")}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {view && (
            <>
              {view.coverages.length
                ? <CoverageHistoryList coverages={view.coverages} onOpenDocument={ouvrirDocument} onSaved={() => { void charger(); }} />
                : view.typeCode === "CONTRACT" && (
                  <div className="space-y-1" data-testid="coverage-history-empty">
                    <p className="text-xs font-semibold text-muted-foreground">{COVERAGE_HISTORY_TITLE}</p>
                    <p className="text-sm text-muted-foreground">{COVERAGE_HISTORY_EMPTY}</p>
                  </div>
                )}
              {view.documents.length > 0 && (
                <div className="space-y-2" data-testid="reference-event-documents">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><FileText className="w-3.5 h-3.5" />{REFERENCE_EVENT_DOCUMENTS_TITLE}</p>
                  <ul className="space-y-1">
                    {view.documents.map((d) => (
                      <li key={d.fileId}>
                        <button
                          type="button"
                          onClick={() => ouvrirDocument(d.fileId)}
                          className="inline-flex min-h-[44px] md:min-h-[32px] max-w-full items-center gap-1.5 text-sm text-[color:var(--accent)] hover:underline text-left"
                          aria-label={`Ouvrir le document : ${d.title}`}
                        >
                          <span className="truncate">{d.title}</span>
                          {jj(d.date) && <span className="shrink-0 text-xs text-muted-foreground">· {jj(d.date)}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {view.agendaItemId != null && (
                <button
                  type="button"
                  onClick={() => { onOpenChange(false); openDrawer({ kind: "echeance", id: view.agendaItemId! }); }}
                  className="inline-flex min-h-[44px] md:min-h-[32px] items-center gap-1.5 text-sm text-[color:var(--accent)] hover:underline"
                  data-testid="reference-event-agenda"
                >
                  <CalendarDays className="w-3.5 h-3.5" />{REFERENCE_EVENT_AGENDA_LINK}
                </button>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Lien qui ouvre la fiche d'un événement de référence (ligne de dépense, tiroir du document). */
export function ReferenceEventLink({ operationId, label }: { operationId: number; label?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[32px] md:min-h-0 min-w-0 items-center gap-1 text-xs text-primary hover:underline text-left"
        data-reference-event-open={operationId}
      >
        <Layers className="w-3 h-3 shrink-0" aria-hidden />
        <span className="truncate">{label ? `${REFERENCE_EVENT_OPEN_LABEL} : ${label}` : REFERENCE_EVENT_OPEN_LABEL}</span>
      </button>
      {open && <ReferenceEventSheet operationId={operationId} open={open} onOpenChange={setOpen} />}
    </>
  );
}

/**
 * Tiroir d'un document : liens vers ses événements de référence SANS élément
 * d'agenda (ceux qui en ont un s'ouvrent déjà depuis l'agenda) — c'est ce qui
 * rend l'historique de couverture consultable sans Agenda.
 */
export function DocumentReferenceEvents({ documentId }: { documentId: number }) {
  const [refs, setRefs] = useState<Array<{ id: number; label: string; hasAgenda: boolean; coverageCount: number }>>([]);
  useEffect(() => {
    let actif = true;
    apiClient.get<{ references: typeof refs }>(`/api/documents/${documentId}/evenements-reference`)
      .then((r) => { if (actif) setRefs(r?.references ?? []); })
      .catch(() => { if (actif) setRefs([]); });
    return () => { actif = false; };
  }, [documentId]);
  const sansAgenda = refs.filter((r) => !r.hasAgenda);
  if (!sansAgenda.length) return null;
  return (
    <div className="flex flex-col items-start gap-1" data-testid="document-reference-events">
      {sansAgenda.map((r) => <ReferenceEventLink key={r.id} operationId={r.id} label={r.label} />)}
    </div>
  );
}
