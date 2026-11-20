"use client";
/**
 * Page entière d'un événement de référence —
 * `/agenda/evenements-reference/[id]` (carte #744, travaux D ; CDC
 * « Opérations / Agenda V2.0 » §14 ; AC01, AC22, AC41, AC56).
 *
 * Adresse stable, sous l'Agenda (aucune entrée de menu nouvelle). Point
 * d'arrivée de la recherche générale, des liens « Voir l'événement de
 * référence : … » (tiroir d'un événement de l'Agenda, tiroir d'un document,
 * coût de possession) et de la Timeline du bien. Consultable sans événement
 * de l'Agenda, sans bien, sans document et sans date.
 *
 * Les droits sont appliqués côté serveur
 * (`GET /api/evenements-reference/:id/fiche`) : un événement de référence
 * d'un autre compte est introuvable (404). Un ancien identifiant regroupé
 * est remplacé dans l'adresse par l'identifiant courant. « Corriger » une
 * période passe par la garde d'écriture existante du document.
 *
 * ÉCRITURE (travaux D, décisions du PO du 15/11/2026) : les gestes de la page
 * viennent de `useReferenceEventWrite` — chacun passe par la garde d'écriture
 * (un compte en lecture seule voit la fenêtre habituelle, rien n'est envoyé)
 * et par une route gardée. Après une suppression, la page propose de l'annuler
 * TANT QU'ELLE RESTE OUVERTE, en disant que l'événement de référence revient
 * sans ses événements de l'Agenda (ils ne sont pas rattachés de nouveau).
 *
 * « Retour » : même effet que le retour du navigateur quand la page a été
 * ouverte depuis l'application ; arrivée directe (lien, favori, onglet neuf) :
 * retour à l'Agenda.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { useBreadcrumb } from "@/contexts/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { openDrawer } from "@/lib/drawers";
import { REFERENCE_EVENT_TITLE } from "@/lib/documents/business-period-surfaces";
import {
  REFERENCE_EVENT_PAGE_LABELS as L, referenceEventHref, referenceEventIdFromParam,
} from "@/lib/reference-events/reference-event-page";
import { REFERENCE_EVENT_WRITE_LABELS as W } from "@/lib/reference-events/reference-event-write";
import type { ReferenceEventPageView } from "@/services/business-operations/graph/reference-event-page";
import { BUSINESS_PERIODS_MUTATED } from "@/components/documents/BusinessPeriods";
import { ReferenceEventPageContent } from "@/components/reference-events/ReferenceEventPageContent";
import {
  restoreReferenceEvent, useReferenceEventWrite, type ReferenceEventDeleted,
} from "@/components/reference-events/ReferenceEventWrite";

const AGENDA_ROUTE = "/agenda";

export default function ReferenceEventPage() {
  const params = useParams();
  const router = useRouter();
  const { setBreadcrumbs } = useBreadcrumb();
  const [fiche, setFiche] = useState<ReferenceEventPageView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not_found" | "error">("loading");
  /** Suppression venant d'être faite depuis cette page : annulable tant qu'elle reste ouverte. */
  const [supprime, setSupprime] = useState<ReferenceEventDeleted | null>(null);
  const [annulation, setAnnulation] = useState<{ busy: boolean; erreur: string | null }>({ busy: false, erreur: null });
  const brut = String(params?.id ?? "");
  const id = referenceEventIdFromParam(brut);

  const load = useCallback(async () => {
    if (id === null) { setState("not_found"); return; }
    try {
      const res = await fetch(`/api/evenements-reference/${id}/fiche`, { credentials: "include" });
      if (res.status === 404 || res.status === 400) { setState("not_found"); return; }
      if (!res.ok) { setState("error"); return; }
      const body = (await res.json()) as { fiche?: ReferenceEventPageView };
      if (!body.fiche) { setState("error"); return; }
      // Ancien identifiant regroupé : l'adresse est corrigée, sans entrée d'historique supplémentaire.
      if (body.fiche.id !== id) { router.replace(referenceEventHref(body.fiche.id)); return; }
      setFiche(body.fiche);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [id, router]);

  useEffect(() => { setState("loading"); setFiche(null); setSupprime(null); void load(); }, [load]);

  const onChanged = useCallback(() => { void load(); }, [load]);
  const onDeleted = useCallback((d: ReferenceEventDeleted) => { setSupprime(d); setAnnulation({ busy: false, erreur: null }); }, []);
  const { actions, dialogs } = useReferenceEventWrite(fiche, { onChanged, onDeleted });

  /** Annule la suppression : l'événement de référence revient SANS ses événements de l'Agenda (décision du PO du 15/11/2026). */
  const annuler = useCallback(async () => {
    if (!supprime) return;
    setAnnulation({ busy: true, erreur: null });
    const r = await restoreReferenceEvent(supprime);
    if (r.ok) {
      toast.success(r.message);
      setSupprime(null);
      setAnnulation({ busy: false, erreur: null });
      setState("loading");
      void load();
      return;
    }
    // Refus « lecture seule » : la fenêtre habituelle de la garde s'en charge (aucune phrase ici).
    setAnnulation({ busy: false, erreur: r.message });
  }, [load, supprime]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Mon agenda", href: AGENDA_ROUTE }, { label: fiche?.title ?? REFERENCE_EVENT_TITLE }]);
  }, [fiche, setBreadcrumbs]);

  // Une période corrigée ailleurs (tiroir du document) ou un tiroir qui modifie une relation : la fiche est relue.
  useEffect(() => {
    const h = () => { void load(); };
    window.addEventListener(BUSINESS_PERIODS_MUTATED, h);
    window.addEventListener("refresh-a-traiter", h);
    return () => {
      window.removeEventListener(BUSINESS_PERIODS_MUTATED, h);
      window.removeEventListener("refresh-a-traiter", h);
    };
  }, [load]);

  const retour = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push(AGENDA_ROUTE);
  }, [router]);

  const back = (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-11 px-2 text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] md:h-9"
      onClick={retour}
      data-testid="reference-event-back"
    >
      <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
      {L.back}
    </Button>
  );

  // Suppression faite depuis cette page : elle reste annulable tant que la page est ouverte.
  if (supprime) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        {back}
        <Card>
          <CardContent className="flex flex-col items-start gap-3 pt-6" data-testid="reference-event-deleted">
            <p className="font-medium [overflow-wrap:anywhere]">{W.deletedTitle}</p>
            <p className="text-sm text-[color:var(--text-primary)] [overflow-wrap:anywhere]">{supprime.title}</p>
            <p className="text-sm text-muted-foreground">{W.deletedBody}</p>
            <p className="text-sm text-muted-foreground">{W.deletedUndoHint}</p>
            {annulation.erreur && (
              <p className="text-sm text-[color:var(--danger)]" role="alert" data-testid="reference-event-write-error">{annulation.erreur}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm" className="h-11 md:h-9" onClick={() => { void annuler(); }}
                disabled={annulation.busy} data-testid="reference-event-undo-delete"
              >
                {annulation.busy ? W.busy : W.undoDelete}
              </Button>
              <Button size="sm" variant="outline" className="h-11 md:h-9" asChild><Link href={AGENDA_ROUTE}>{L.backToAgenda}</Link></Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className="space-y-6 p-4 md:p-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-32" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (state !== "ready" || !fiche) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        {back}
        <Card>
          <CardContent className="flex flex-col items-start gap-3 pt-6" data-testid="reference-event-page-unavailable">
            <AlertTriangle className="h-5 w-5 text-muted-foreground" aria-hidden />
            <p className="font-medium">{state === "not_found" ? L.notFound : L.loadError}</p>
            <p className="text-sm text-muted-foreground">{state === "not_found" ? L.notFoundHint : L.loadErrorHint}</p>
            <div className="flex flex-wrap gap-2">
              {state === "error" && <Button size="sm" className="h-11 md:h-9" onClick={() => { setState("loading"); void load(); }}>{L.retry}</Button>}
              <Button size="sm" variant="outline" className="h-11 md:h-9" asChild><Link href={AGENDA_ROUTE}>{L.backToAgenda}</Link></Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      {back}
      <ReferenceEventPageContent
        fiche={fiche}
        actions={actions}
        openers={{
          openDocument: (fileId) => openDrawer({ kind: "document", id: fileId }),
          openAgendaItem: (itemId) => openDrawer({ kind: "echeance", id: itemId }),
          openEquipment: (equipmentId) => openDrawer({ kind: "equipement", id: equipmentId }),
          openRoom: (roomId) => openDrawer({ kind: "piece", id: roomId }),
          onPeriodsSaved: () => { void load(); },
        }}
      />
      {dialogs}
    </div>
  );
}
