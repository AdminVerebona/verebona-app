/**
 * Lot 81D — actualisation automatique du TCO de la fiche (ticket P2 « TCO :
 * écarts de calcul annuel », § « Actualiser automatiquement le TCO »).
 *
 * Le backend recalcule le TCO à chaque lecture ; l'interface ne relisait
 * qu'à l'ouverture et sur `asset-details-updated`. Elle relit désormais sur
 * les ÉVÉNEMENTS EXISTANTS de l'application, sans en inventer :
 *   · `verebona:data-mutated` — émis par `apiClient` après TOUTE écriture
 *     réussie : prix / date d'achat du bien ou d'un équipement, opération
 *     (montant, date, statut, création, suppression, rattachement),
 *     justificatif, rapprochement / fusion / séparation / consolidation T3
 *     demandés depuis l'interface, avoir, remboursement, indemnité, cession ;
 *   · `asset-details-updated` (fiche, assistant), `document-added`,
 *     `document-deleted`, `document-analysis-complete` (analyse et
 *     consolidation en arrière-plan), `agenda-mutated` (opérations depuis
 *     l'agenda), `refresh-a-traiter` (décisions « À traiter »).
 * Les événements sont REGROUPÉS (`createCoalescedRefresh` : une lecture par
 * rafale, réponses anciennes écartées) ; la relecture est un GET, qui n'émet
 * aucun événement : aucune boucle. L'écriture faite par le TCO lui-même
 * (« Ajouter / Retirer du TCO », forfaits) renvoie ou relit déjà le TCO : son
 * propre `verebona:data-mutated` est ignoré une fois (pas de double lecture).
 * Pur (aucun import serveur) : testé L81D-UI-03 / L81D-R*.
 */

/** Événements existants après lesquels le TCO ouvert est relu. */
export const TCO_REFRESH_EVENTS = [
  'verebona:data-mutated',
  'asset-details-updated',
  'document-added',
  'document-deleted',
  'document-analysis-complete',
  'agenda-mutated',
  'refresh-a-traiter',
] as const;

/** Fenêtre de regroupement (ms) : les événements d'une même action ne produisent qu'une lecture. */
export const TCO_REFRESH_WINDOW_MS = 400;

/**
 * L'événement concerne-t-il le TCO de ce bien ? `asset-details-updated`
 * porte le bien modifié (un autre bien : sans effet) ; les autres événements
 * ne disent pas quel bien est touché (un justificatif ou une opération peut
 * changer de bien) : relecture, regroupée.
 */
export function tcoEventConcernsAsset(name: string, detail: unknown, assetId: number): boolean {
  if (name !== 'asset-details-updated') return true;
  const id = detail && typeof detail === 'object' ? (detail as { assetId?: unknown }).assetId : undefined;
  return id == null || Number(id) === assetId;
}

/**
 * Année présentée après une relecture : l'année choisie si elle reste
 * disponible, sinon l'année par défaut du calcul (pure).
 */
export function tcoKeptYear(chosen: number | null, years: ReadonlyArray<{ year: number }>, defaultYear: number): number {
  return chosen != null && years.some((y) => y.year === chosen) ? chosen : defaultYear;
}

/**
 * Branche l'actualisation du TCO sur les événements de mutation (`target` :
 * `window` dans l'application, un `EventTarget` dans les tests). Rend la
 * fonction de débranchement. Section fermée : rien (elle relit à
 * l'ouverture) ; écriture propre du TCO en cours : son
 * `verebona:data-mutated` est ignoré (la réponse porte déjà le TCO recalculé).
 */
export function watchTcoMutations(o: {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  assetId: number;
  isOpen: () => boolean;
  isOwnWrite: () => boolean;
  invalidate: () => void;
}): () => void {
  const handler = (e: Event) => {
    if (!o.isOpen() || !tcoEventConcernsAsset(e.type, (e as CustomEvent).detail, o.assetId)) return;
    if (e.type === 'verebona:data-mutated' && o.isOwnWrite()) return;
    o.invalidate();
  };
  TCO_REFRESH_EVENTS.forEach((n) => o.target.addEventListener(n, handler));
  return () => TCO_REFRESH_EVENTS.forEach((n) => o.target.removeEventListener(n, handler));
}
