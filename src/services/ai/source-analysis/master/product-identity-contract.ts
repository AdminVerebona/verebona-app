/**
 * Lot 101A — contrat de prompt T1 `t1-product-identity-v1` (étape 10 du guide
 * du PO) : identité du produit (série, modèle, référence commerciale,
 * désignation, numéro de série) et produit PRINCIPAL d'une page fournisseur.
 *
 * Le code ne dépend PAS de ce contrat pour être sûr : le garde-fou serveur
 * `guardProductIdentity` s'applique avant et après le collage. Le marqueur
 * sert à la conformité automatique (registre 99B) et au diagnostic.
 */
export const T1_PRODUCT_IDENTITY_CONTRACT = 't1-product-identity-v1';

/** Le prompt T1 porte-t-il le contrat (détection de production) ? */
export function promptCarriesProductIdentity(text: string): boolean {
  return String(text ?? '').includes(T1_PRODUCT_IDENTITY_CONTRACT);
}
