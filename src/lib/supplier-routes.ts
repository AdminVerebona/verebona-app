/**
 * Routes des fournisseurs — liste `/fournisseurs` et fiche `/fournisseurs/[id]`.
 *
 * Source unique : l'assistant (cartes, actions OPEN_SUPPLIER / OPEN_SUPPLIERS),
 * le tiroir fournisseur et les pages s'y réfèrent, pour qu'aucun lien ne soit
 * reconstruit à la main ailleurs.
 */
export const SUPPLIERS_ROUTE = '/fournisseurs';

/** Fiche d'un fournisseur (identifiant numérique du compte). */
export function supplierHref(id: number): string {
  return `${SUPPLIERS_ROUTE}/${id}`;
}
