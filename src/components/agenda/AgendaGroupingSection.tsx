"use client";

/**
 * Regroupement d'un élément d'agenda dans son tiroir — lot 84B (CDC « Opérations,
 * Agenda, Timeline, Sinistres v5 », lot O-3 : §8, §11.9, §14 ; AC01, AC02,
 * AC07, AC27, AC28, AC32).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS AFFICHAGES, UN SEUL COMPOSANT (desktop ET mobile)
 *
 *   · ÉVÉNEMENT DE RÉFÉRENCE (principal, §14.2, AC27) : « Tout ce qui se
 *     rattache à cet événement » en cinq catégories — étapes et rendez-vous,
 *     documents, biens, Pièces, équipements — avec relier / créer (étape) /
 *     retirer, et « Ne plus en faire l'événement de référence » (retrait
 *     MÉMORISÉ côté serveur, jamais rétabli par Verebona) ;
 *   · ÉLÉMENT RATTACHÉ (secondaire, §14.3, AC28) : tiroir LÉGER — « Fait
 *     partie de « … » », un résumé chiffré et l'accès à l'événement de
 *     référence (tiroir empilé), jamais tout l'ensemble ;
 *   · ÉLÉMENT SEUL : relier à un autre élément de l'agenda (AC02) ou à un
 *     document (AC01).
 *
 * Le mot « Opération » et le terme « principal » n'apparaissent jamais
 * (libellés : `lib/agenda/grouping-view.ts`). Les gestes passent par
 * `POST /api/agenda/:id/liens` (service unique de regroupement) ; la garde
 * d'écriture partagée s'applique (compte en lecture seule : fenêtre
 * habituelle, et le serveur refuse de toute façon).
 *
 * Accessibilité : chaque geste est un vrai bouton nommé (« Retirer « Devis » »),
 * cibles ≥ 44 px sur mobile ; le choix d'un objet s'ouvre dans un tiroir
 * EMPILÉ (composant de base 81F : zones sûres, bouton « Fermer », retour
 * Android qui ne ferme que lui, focus rendu au bouton d'origine).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiClient } from "@/lib/api-client";
import { openDrawer } from "@/lib/drawers";
import { useWriteGuard } from "@/contexts/WriteGuardContext";
import {
  GROUPING_LABELS as L, LINK_ACTION,
  type AgendaGroupingView, type GroupingAction, type GroupingCandidate, type GroupingCandidateKind,
} from "@/lib/agenda/grouping-view";
import { AgendaGroupingPanel, GroupingPicker } from "@/components/agenda/AgendaGroupingPanel";

export { AgendaGroupingPanel, GroupingPicker, MAIN_CATEGORIES, categoryRows } from "@/components/agenda/AgendaGroupingPanel";

const CreateAgendaItemDrawer = dynamic(
  () => import("@/components/agenda/CreateAgendaItemDrawer").then((m) => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false },
);

// ── Conteneur (données, gestes) ─────────────────────────────────────────────

interface SectionProps {
  itemId: number;
  /** Ouverture d'un document (tiroir local de l'écran), sinon tiroir empilé. */
  onOpenDocument?: (fileId: number) => void;
  /** Appelé après un geste réussi (l'écran relit l'élément). */
  onChanged?: () => void;
  /** Rôle courant (le tiroir masque sa liste de documents propre pour l'événement de référence). */
  onRole?: (role: AgendaGroupingView["role"]) => void;
}

export function AgendaGroupingSection({ itemId, onOpenDocument, onChanged, onRole }: SectionProps) {
  const [view, setView] = useState<AgendaGroupingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<GroupingCandidateKind | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const { garder } = useWriteGuard();

  const charger = useCallback(async () => {
    try {
      const r = await apiClient.get<{ view: AgendaGroupingView }>(`/api/agenda/${itemId}/liens`);
      setView(r.view);
    } catch {
      setView(null);
    }
  }, [itemId]);

  useEffect(() => { void charger(); }, [charger]);
  useEffect(() => {
    const h = () => { void charger(); };
    window.addEventListener("agenda-mutated", h);
    return () => window.removeEventListener("agenda-mutated", h);
  }, [charger]);
  useEffect(() => { if (view) onRole?.(view.role); }, [view?.role]); // eslint-disable-line react-hooks/exhaustive-deps

  const autorise = () => { let ok = false; garder(() => { ok = true; }); return ok; };

  const agir = useCallback(async (action: GroupingAction, targetId?: number) => {
    if (!autorise()) return;
    setBusy(true);
    try {
      const r = await apiClient.post<{ view: AgendaGroupingView | null }>(`/api/agenda/${itemId}/liens`, { action, targetId: targetId ?? null });
      if (r.view) setView(r.view);
      toast.success("C’est enregistré");
      window.dispatchEvent(new CustomEvent("agenda-mutated"));
      onChanged?.();
    } catch (err: any) {
      if (err?.status !== 403) toast.error(err?.serverMessage || err?.message || "Ce geste n’a pas abouti");
    } finally {
      setBusy(false);
    }
  }, [itemId, onChanged]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (q: string) => {
    if (!picker) return [];
    const r = await apiClient.get<{ candidates: GroupingCandidate[] }>(`/api/agenda/${itemId}/liens?candidats=${picker}&q=${encodeURIComponent(q)}`);
    return r.candidates ?? [];
  }, [itemId, picker]);

  if (!view) return null;
  return (
    <>
      <AgendaGroupingPanel
        view={view}
        busy={busy}
        onAction={(a, t) => { void agir(a, t); }}
        onPick={(k) => { if (autorise()) setPicker(k); }}
        onCreateStep={() => { if (autorise()) setCreateOpen(true); }}
        onRelease={() => { if (autorise()) setConfirmRelease(true); }}
        onOpenMain={(id) => openDrawer({ kind: "echeance", id }, { stack: true })}
        onOpenDocument={onOpenDocument ?? ((id) => openDrawer({ kind: "document", id }, { stack: true }))}
      />
      <GroupingPicker
        open={picker !== null}
        title={picker ? L.add[picker] : ""}
        load={load}
        onClose={() => setPicker(null)}
        onPick={(c) => { const k = picker; setPicker(null); if (k) void agir(LINK_ACTION[k], c.id); }}
      />
      <AlertDialog open={confirmRelease} onOpenChange={setConfirmRelease}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{L.releaseTitle}</AlertDialogTitle>
            <AlertDialogDescription>{L.releaseBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmRelease(false); void agir("retirer-reference"); }}>Confirmer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {createOpen && (
        <CreateAgendaItemDrawer
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onMutated={() => setCreateOpen(false)}
          onCreated={(id) => agir("relier-element", id)}
        />
      )}
    </>
  );
}
