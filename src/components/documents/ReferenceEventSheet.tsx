"use client";

/**
 * LIENS VERS L'ÉVÉNEMENT DE RÉFÉRENCE (lot 113AB, Trello #725 ; carte #744,
 * travaux D).
 *
 * Règle remplacée (carte #744, travaux D — CDC « Opérations / Agenda V2.0 »
 * §14, AC41 : « page entière, pas un tiroir ») : la fiche de l'événement de
 * référence n'est plus un panneau latéral. Elle est la PAGE ENTIÈRE
 * `/agenda/evenements-reference/[id]`
 * (`components/reference-events/ReferenceEventPageContent.tsx`), qui reprend
 * tout ce que montrait le panneau (périodes de couverture corrigeables,
 * justificatifs, événements à leur date) et y ajoute dates propres, biens,
 * équipements, fournisseurs, déclarations et événements de référence
 * associés. Ce fichier ne garde que les LIENS qui y mènent (le nom du fichier
 * est conservé pour ne pas déplacer les imports existants).
 *
 * `ReferenceEventLink` : lien « Voir l'événement de référence : … » (ligne de
 * dépense, tiroir d'un document, tiroir d'un événement de l'Agenda) — un vrai
 * lien (clic milieu, nouvel onglet, clavier) vers la page. Les tiroirs ouverts
 * sont fermés au départ : la page n'est jamais recouverte.
 * `DocumentReferenceEvents` : liens du tiroir d'un document vers TOUS ses
 * événements de référence (avant #744 : seulement ceux sans événement de
 * l'Agenda ; la page est désormais le point d'arrivée unique).
 * Le mot « Opération » n'apparaît jamais.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Layers } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { CLOSE_ALL_DRAWERS_EVENT } from "@/lib/drawers";
import { referenceEventHref } from "@/lib/reference-events/reference-event-page";

/** Texte du lien d'ouverture (repris du lot 113X, « Voir l'événement de référence »). */
export const REFERENCE_EVENT_OPEN_LABEL = "Voir l’événement de référence";

/** Lien vers la PAGE ENTIÈRE d'un événement de référence (ligne de dépense, tiroirs du document et de l'Agenda). */
export function ReferenceEventLink({ operationId, label }: { operationId: number; label?: string | null }) {
  const href = referenceEventHref(operationId);
  return (
    <Link
      href={href}
      onClick={(e) => {
        // Nouvel onglet / nouvelle fenêtre : l'écran courant ne change pas.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        // La page ne doit pas rester recouverte par le tiroir d'où part le lien.
        window.dispatchEvent(new CustomEvent(CLOSE_ALL_DRAWERS_EVENT));
        // Lien vers la page déjà affichée (tiroir ouvert depuis cette page) : aucune navigation.
        if (window.location.pathname === href) e.preventDefault();
      }}
      className="inline-flex min-h-[44px] md:min-h-0 min-w-0 items-center gap-1 text-xs text-primary hover:underline text-left"
      data-reference-event-open={operationId}
    >
      <Layers className="w-3 h-3 shrink-0" aria-hidden />
      <span className="truncate">{label ? `${REFERENCE_EVENT_OPEN_LABEL} : ${label}` : REFERENCE_EVENT_OPEN_LABEL}</span>
    </Link>
  );
}

/**
 * Tiroir d'un document : liens vers TOUS ses événements de référence (règle
 * remplacée, carte #744 : avant, seulement ceux sans événement de l'Agenda).
 * `hasAgenda` reste servi par la route, il ne filtre plus rien ici.
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
  if (!refs.length) return null;
  return (
    <div className="flex flex-col items-start gap-1" data-testid="document-reference-events">
      {refs.map((r) => <ReferenceEventLink key={r.id} operationId={r.id} label={r.label} />)}
    </div>
  );
}
