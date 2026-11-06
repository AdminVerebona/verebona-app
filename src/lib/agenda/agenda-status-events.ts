/**
 * Lot 111R — événements qui peuvent CHANGER le statut effectif d'un élément
 * d'agenda, donc relus par toutes les vues qui l'affichent (Agenda, onglet
 * Agenda du bien, Timeline de la fiche du bien — desktop et mobile —, tiroir
 * équipement) :
 *
 *   · `agenda-mutated` : statut manuel changé, élément modifié ou supprimé,
 *     document associé / dissocié depuis un tiroir ;
 *   · `document-deleted` : un document supprimé n'est plus une preuve de
 *     réalisation — l'élément redevient « Statut à confirmer » / « Date échue » ;
 *   · `document-analysis-complete` : l'analyse d'un document peut établir une
 *     preuve de réalisation (contrôle COH-AGENDA-HISTORICAL-STATUS, lot 103D).
 *
 * Le cache de réponses d'`apiClient` est déjà rendu périmé par ces mêmes
 * événements (`data-freshness`) : la relecture va au serveur, qui recalcule
 * le statut (aucun état obsolète). Plusieurs événements rapprochés (lot
 * d'analyses) déclenchent une seule relecture.
 */
export const AGENDA_STATUS_SOURCE_EVENTS = ['agenda-mutated', 'document-deleted', 'document-analysis-complete'] as const;

/** Délai de regroupement des événements (ms). */
export const AGENDA_STATUS_REFRESH_DEBOUNCE_MS = 250;

/** Abonne `handler` aux événements ci-dessus ; renvoie la désinscription. Sans navigateur : rien. */
export function subscribeAgendaStatusSources(handler: () => void, debounceMs = AGENDA_STATUS_REFRESH_DEBOUNCE_MS): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; handler(); }, debounceMs);
  };
  for (const name of AGENDA_STATUS_SOURCE_EVENTS) window.addEventListener(name, fire);
  return () => {
    if (timer) clearTimeout(timer);
    for (const name of AGENDA_STATUS_SOURCE_EVENTS) window.removeEventListener(name, fire);
  };
}
