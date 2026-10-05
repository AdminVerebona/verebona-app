import { useState } from 'react';

/**
 * Vrai dès que `open` l'a été une fois, et le reste ensuite (APP-PERF-05).
 *
 * Sert à ne monter un panneau ou une fenêtre — et donc à ne demander son
 * code — qu'à sa première ouverture, tout en le gardant monté après la
 * fermeture : l'animation de sortie et l'état interne (formulaire ouvert
 * depuis le panneau) restent intacts.
 */
export function useMountedOnce(open: boolean): boolean {
  const [ouvertUneFois, setOuvertUneFois] = useState(open);
  // Mise à jour pendant le rendu (motif « état dérivé » de React) : pas
  // d'effet, donc pas de rendu supplémentaire avec un panneau absent.
  if (open && !ouvertUneFois) setOuvertUneFois(true);
  return ouvertUneFois || open;
}
