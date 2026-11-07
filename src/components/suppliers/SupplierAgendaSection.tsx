"use client";
/**
 * Lot 103E — événements d'Agenda rattachés à un fournisseur (fiche
 * `/fournisseurs/[id]`), relation BIDIRECTIONNELLE avec le tiroir Agenda.
 *
 *   · passés, à venir et sans date, avec intitulé et date (lot 113P : plus de statut) ; chaque
 *     ligne ouvre la fiche de l'événement (tiroir) ;
 *   · « Associer un événement » (recherche Agenda du compte) et « Dissocier »
 *     (aucune entité supprimée ; retrait mémorisé : aucun traitement
 *     automatique ne recrée le lien) ;
 *   · écritures gardées (compte en lecture seule : fenêtre habituelle).
 * Desktop et mobile (cartes empilées).
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, ChevronRight, Link2, Loader2, Search, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api-client";
import { openDrawer } from "@/lib/drawers";
import { useWriteGuard } from "@/contexts/WriteGuardContext";
import { AGENDA_SUPPLIER_BUCKET_LABELS, type AgendaSupplierTimeBucket } from "@/lib/agenda/agenda-suppliers-rules";
import { AGENDA_EVENT_LABELS } from "@/lib/agenda/grouping-view";

interface SupplierAgendaItem {
  id: number; title: string; startDate: string | null; bucket: AgendaSupplierTimeBucket;
}

const ORDRE: AgendaSupplierTimeBucket[] = ["future", "past", "undated"];
const fmt = (d: string | null) =>
  d ? new Date(`${d}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "Sans date";

export function SupplierAgendaSection({ supplierId, supplierName }: { supplierId: number; supplierName: string }) {
  const [items, setItems] = useState<SupplierAgendaItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<SupplierAgendaItem[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const { garder } = useWriteGuard();
  const autorise = () => { let ok = false; garder(() => { ok = true; }); return ok; };

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get<{ items: SupplierAgendaItem[] }>(`/api/suppliers/${supplierId}/agenda`);
      setItems(Array.isArray(r?.items) ? r.items : []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [supplierId]);

  useEffect(() => { void load(); }, [load]);
  // Modification depuis un tiroir d'événement : relecture.
  useEffect(() => {
    const h = () => { void load(); };
    window.addEventListener("agenda-mutated", h);
    return () => window.removeEventListener("agenda-mutated", h);
  }, [load]);

  useEffect(() => {
    if (!adding) return;
    let actif = true;
    const t = setTimeout(() => {
      apiClient.get<{ candidates: SupplierAgendaItem[] }>(`/api/suppliers/${supplierId}/agenda?candidats=1&q=${encodeURIComponent(q.trim())}`)
        .then((r) => { if (actif) setCandidates(r?.candidates ?? []); })
        .catch(() => { if (actif) setCandidates([]); });
    }, 200);
    return () => { actif = false; clearTimeout(t); };
  }, [adding, q, supplierId]);

  const geste = async (action: "link" | "unlink", agendaItemId: number) => {
    if (!autorise()) return;
    setBusy(agendaItemId);
    try {
      await apiClient.post(`/api/suppliers/${supplierId}/agenda`, { action, agendaItemId });
      toast.success(action === "link" ? "Événement associé" : "Événement dissocié");
      if (action === "link") { setQ(""); setAdding(false); }
      window.dispatchEvent(new CustomEvent("agenda-mutated"));
      await load();
    } catch (e: unknown) {
      if ((e as { status?: number } | null)?.status !== 403) toast.error("Ce geste n’a pas pu être appliqué.");
    } finally {
      setBusy(null);
    }
  };

  const total = items?.length ?? 0;
  return (
    <Card data-testid="supplier-agenda-section">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <CalendarDays className="w-4 h-4 text-muted-foreground" aria-hidden />
          {AGENDA_EVENT_LABELS.linkedEvents}
          <span className="text-sm font-normal text-muted-foreground">({total})</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => { if (autorise()) setAdding((v) => !v); }}>
            <Link2 className="mr-1.5 h-4 w-4" aria-hidden />Associer un événement
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {adding && (
          <div className="space-y-2 rounded-md border border-[color:var(--border-subtle)] p-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={AGENDA_EVENT_LABELS.searchEvent} className="pl-9" aria-label={AGENDA_EVENT_LABELS.searchEvent} />
            </div>
            {candidates.length === 0
              ? <p className="text-xs text-muted-foreground">Aucun événement à associer.</p>
              : (
                <ul className="divide-y">
                  {candidates.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{c.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{fmt(c.startDate)}</p>
                      </div>
                      <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => { void geste("link", c.id); }} aria-label={`Associer ${c.title} à ${supplierName}`}>
                        {busy === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Associer"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        )}
        {failed && <p className="text-sm text-muted-foreground">Les événements n’ont pas pu être chargés.</p>}
        {!failed && items && total === 0 && <p className="text-sm text-muted-foreground">{AGENDA_EVENT_LABELS.supplierNoLinkedEvent}</p>}
        {!failed && items && ORDRE.map((b) => {
          const groupe = items.filter((i) => i.bucket === b);
          if (!groupe.length) return null;
          return (
            <div key={b}>
              <p className="vb-app-label mb-1">{AGENDA_SUPPLIER_BUCKET_LABELS[b]}</p>
              <ul className="divide-y">
                {groupe.map((i) => (
                  <li key={i.id} className="flex items-center gap-2">
                    <button type="button" onClick={() => openDrawer({ kind: "echeance", id: i.id })}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-2.5 text-left hover:bg-muted/40">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{i.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{fmt(i.startDate)}</p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                    </button>
                    <Button size="icon" variant="ghost" disabled={busy === i.id} onClick={() => { void geste("unlink", i.id); }}
                      aria-label={`Dissocier ${i.title}`} title="Dissocier (l’événement et le fournisseur sont conservés)">
                      {busy === i.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
