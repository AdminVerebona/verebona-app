"use client";

/**
 * Carte Trello #806, volet B §7 — OPÉRATIONS D'UN DOCUMENT, dans le tiroir du
 * document (ordinateur et mobile : même composant, cibles tactiles de 44 px
 * sur mobile, charte Sérénité — jetons de couleur seulement).
 *
 * Le tiroir montrait seulement des liens vers les opérations du document (au
 * plus dix). Il les montre désormais TOUTES et permet de les GÉRER :
 *   · ouvrir la fiche de chaque opération (vrai lien : clavier, nouvel onglet) ;
 *   · « Retirer » le document d'UNE opération — seul ce lien part ; le document,
 *     ses autres opérations et ses liens directs avec l'agenda ne changent pas ;
 *     le refus est mémorisé par le serveur (façade d'écriture existante) ;
 *   · « Rattacher à une opération » — choix parmi les opérations du compte
 *     auxquelles le document n'appartient pas encore.
 * Les événements de l'Agenda liés au document restent listés et gérés par la
 * rubrique « Événements associés » du tiroir (existante), qui signale ceux qui
 * sont liés DIRECTEMENT, hors de toute opération du document.
 *
 * Aucune règle métier ici : `DocumentOperationsPanel` est une présentation
 * pure ; `DocumentOperations` lit `GET /api/documents/:id/evenements-reference`
 * et écrit par `POST` / `DELETE /api/evenements-reference/:id/documents` (le
 * serveur fait foi : compte, droits, lecture seule). La garde d'écriture
 * partagée s'applique avant tout envoi.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Layers, Link2, Loader2, Unlink } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ASSOCIATION_BTN, GroupingPicker } from "@/components/agenda/AgendaGroupingPanel";
import { useWriteGuard } from "@/contexts/WriteGuardContext";
import { apiClient } from "@/lib/api-client";
import { CLOSE_ALL_DRAWERS_EVENT } from "@/lib/drawers";
import { OPERATION_LINK_LABELS as L, type DocumentOperationRef } from "@/lib/reference-events/operation-links";
import { referenceEventHref } from "@/lib/reference-events/reference-event-page";
import { isWriteBlockedCode } from "@/lib/write-blocked";

/** Événement relu par les tiroirs ouverts après un geste (même signal que les gestes du tiroir de l'Agenda). */
const MUTATED_EVENT = "agenda-mutated";

interface PanelProps {
  operations: readonly DocumentOperationRef[];
  /** Identifiant de l'opération dont le retrait est en cours (bouton occupé). */
  removingId?: number | null;
  /** Absents : consultation seule (aucun bouton d'écriture). */
  onRemove?: (operation: DocumentOperationRef) => void;
  onAttach?: () => void;
}

/** Présentation pure (rendue côté serveur dans les tests, montée telle quelle dans le navigateur de test). */
export function DocumentOperationsPanel({ operations, removingId = null, onRemove, onAttach }: PanelProps) {
  if (!operations.length && !onAttach) return null;
  return (
    <section className="space-y-2 pt-2 border-t" aria-label={L.drawerTitle} data-testid="document-operations">
      <p className="vb-app-label flex items-center gap-1">
        <Layers className="w-3 h-3" aria-hidden />{L.drawerTitle}{operations.length ? ` (${operations.length})` : ""}
      </p>
      {operations.length ? (
        <ul className="space-y-1.5" role="list">
          {operations.map((o) => (
            <li key={o.id} className="flex items-center gap-1 rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-subtle)] pl-3 pr-1"
              data-testid={`document-operation-${o.id}`}>
              <Link
                href={referenceEventHref(o.id)} aria-label={L.open(o.label)} data-reference-event-open={o.id}
                onClick={(e) => {
                  // Nouvel onglet : l'écran courant ne change pas. Sinon la page ne doit pas rester recouverte par le tiroir.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  window.dispatchEvent(new CustomEvent(CLOSE_ALL_DRAWERS_EVENT));
                  // Lien vers la page déjà affichée (tiroir ouvert depuis cette fiche) : aucune navigation.
                  if (window.location.pathname === referenceEventHref(o.id)) e.preventDefault();
                }}
                className="flex min-h-11 min-w-0 flex-1 items-center py-2 text-sm font-medium text-[color:var(--text-primary)] hover:underline sm:min-h-9"
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">{o.label}</span>
              </Link>
              {onRemove && (
                <button type="button" disabled={removingId !== null} onClick={() => onRemove(o)}
                  aria-label={L.removeAria(o.label)} title={L.remove} data-testid={`document-operation-retirer-${o.id}`}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-[color:var(--text-muted)] hover:bg-[color:var(--danger-soft)] hover:text-[color:var(--danger)] disabled:opacity-40 sm:size-8">
                  {removingId === o.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Unlink className="w-3.5 h-3.5" aria-hidden />}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="text-xs text-[color:var(--text-muted)]" data-testid="document-operations-empty">{L.drawerEmpty}</p>}
      {onAttach && (
        <Button type="button" variant="secondary" size="sm" className={`min-h-11 sm:min-h-8 ${ASSOCIATION_BTN}`} data-focus-ring="off"
          onClick={onAttach} data-testid="document-operation-rattacher">
          <Link2 className="w-3.5 h-3.5" aria-hidden />{L.attach}
        </Button>
      )}
    </section>
  );
}

/** Fenêtre de confirmation du retrait (présentation pure) : dit ce qui part et ce qui reste. */
export function DocumentOperationRemoveDialog({ operation, onCancel, onConfirm }: {
  operation: DocumentOperationRef | null; onCancel: () => void; onConfirm: (operation: DocumentOperationRef) => void;
}) {
  // La fenêtre se ferme aussi après « Retirer » : cette fermeture-là n'est pas une annulation.
  const confirme = useRef(false);
  return (
    <AlertDialog open={operation !== null} onOpenChange={(o) => { if (!o) { if (!confirme.current) onCancel(); confirme.current = false; } }}>
      <AlertDialogContent data-testid="document-operation-retrait">
        <AlertDialogHeader>
          <AlertDialogTitle>{L.removeTitle}</AlertDialogTitle>
          <AlertDialogDescription>{operation ? `« ${operation.label} » — ${L.removeBody}` : ""}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{L.cancel}</AlertDialogCancel>
          <AlertDialogAction onClick={() => { confirme.current = true; if (operation) onConfirm(operation); }}>{L.removeConfirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface ListeReponse { references?: Array<{ id: number; label: string; directAgendaItemIds?: number[] }> }
interface EcritureReponse { message?: string }
interface CandidatsReponse { candidates?: Array<{ id: number; title: string; meta: string | null }>; more?: boolean }

/** Phrase d'un échec : celle du serveur ; refus « lecture seule » : la fenêtre habituelle s'en charge (null). */
function phraseEchec(err: unknown): string | null {
  const e = err as { status?: number; code?: string; serverMessage?: string } | null;
  if (e?.status === 403 && isWriteBlockedCode(e.code)) return null;
  return e?.serverMessage && e.status ? e.serverMessage : L.failed;
}

/** Tiroir d'un document : ses opérations, avec leurs gestes. `onChanged` : l'écran relit ses propres listes. */
export function DocumentOperations({ documentId, onChanged }: { documentId: number; onChanged?: () => void }) {
  const [operations, setOperations] = useState<DocumentOperationRef[] | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [aRetirer, setARetirer] = useState<DocumentOperationRef | null>(null);
  const [choix, setChoix] = useState(false);
  const [plus, setPlus] = useState(false);
  const { garder } = useWriteGuard();

  const charger = useCallback(async () => {
    try {
      const r = await apiClient.get<ListeReponse>(`/api/documents/${documentId}/evenements-reference`);
      setOperations((r?.references ?? []).map((o) => ({ id: o.id, label: o.label, directAgendaItemIds: o.directAgendaItemIds ?? [] })));
    } catch {
      setOperations([]);
    }
  }, [documentId]);

  useEffect(() => { setOperations(null); void charger(); }, [charger]);
  useEffect(() => {
    const h = () => { void charger(); };
    window.addEventListener(MUTATED_EVENT, h);
    return () => window.removeEventListener(MUTATED_EVENT, h);
  }, [charger]);

  const apres = useCallback(async (message: string | undefined) => {
    if (message) toast.success(message);
    await charger();
    window.dispatchEvent(new CustomEvent(MUTATED_EVENT));
    onChanged?.();
  }, [charger, onChanged]);

  const retirer = useCallback(async (o: DocumentOperationRef) => {
    setARetirer(null);
    setRemoving(o.id);
    try {
      const r = await apiClient.delete<EcritureReponse>(`/api/evenements-reference/${o.id}/documents?fileId=${documentId}`);
      await apres(r?.message);
    } catch (err) {
      const phrase = phraseEchec(err);
      if (phrase) toast.error(phrase);
    } finally {
      setRemoving(null);
    }
  }, [documentId, apres]);

  const rattacher = useCallback(async (operationId: number) => {
    setChoix(false);
    try {
      const r = await apiClient.post<EcritureReponse>(`/api/evenements-reference/${operationId}/documents`, { fileId: documentId });
      await apres(r?.message);
    } catch (err) {
      const phrase = phraseEchec(err);
      if (phrase) toast.error(phrase);
    }
  }, [documentId, apres]);

  const candidats = useCallback(async (q: string) => {
    const r = await apiClient.get<CandidatsReponse>(`/api/documents/${documentId}/evenements-reference?candidats=1&q=${encodeURIComponent(q)}`);
    setPlus(r?.more === true);
    return r?.candidates ?? [];
  }, [documentId]);

  if (operations === null) return null;
  return (
    <>
      <DocumentOperationsPanel
        operations={operations}
        removingId={removing}
        onRemove={(o) => garder(() => setARetirer(o))}
        onAttach={() => garder(() => { setPlus(false); setChoix(true); })}
      />
      <DocumentOperationRemoveDialog operation={aRetirer} onCancel={() => setARetirer(null)} onConfirm={(o) => { void retirer(o); }} />
      <GroupingPicker
        open={choix}
        title={L.pickerTitle}
        searchLabel={L.pickerSearch}
        description={L.pickerHint}
        note={plus ? `${L.pickerHint} ${L.pickerMore}` : L.pickerHint}
        load={candidats}
        onClose={() => setChoix(false)}
        onPick={(c) => { void rattacher(c.id); }}
      />
    </>
  );
}
