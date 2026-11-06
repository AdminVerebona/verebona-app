/**
 * Classes d'un bouton de proposition (lot 60A, point 7) : 36 px de haut AU
 * MOINS (zone tactile, §16.1) mais hauteur libre, libellé sur plusieurs
 * lignes (jamais `whitespace-nowrap` ni troncature), largeur bornée à la
 * carte, coupure des mots trop longs. Coins adoucis plutôt qu'en pilule pour
 * un libellé sur deux lignes.
 *
 * Lot 113A : module autonome, partagé par `ActionCard` (qui le réexporte) et
 * `AssetLinkChoices` sans import circulaire.
 */
export const PROPOSAL_BUTTON_CLASS = 'h-auto min-h-9 max-w-full whitespace-normal rounded-2xl py-1.5 text-left leading-snug';
