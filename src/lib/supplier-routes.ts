/**
 * Routes des fournisseurs — liste `/fournisseurs` et fiche `/fournisseurs/[id]`.
 *
 * Source unique : l'assistant (cartes, actions OPEN_SUPPLIER / OPEN_SUPPLIERS),
 * les cartes d'entité, les tiroirs et les pages s'y réfèrent (lot 109B : la fiche
 * est l'unique interface fournisseur, plus de tiroir), pour qu'aucun lien ne soit
 * reconstruit à la main ailleurs.
 */
export const SUPPLIERS_ROUTE = '/fournisseurs';

/** Fiche d'un fournisseur (identifiant numérique du compte). */
export function supplierHref(id: number): string {
  return `${SUPPLIERS_ROUTE}/${id}`;
}
