import { redirect } from 'next/navigation';

/**
 * Lot 74B (point 5) — ancien lien `/mon-compte/partage`.
 *
 * Cette page n'a jamais existé : l'e-mail et les notifications d'invitation
 * à un compte partagé y menaient (404). Plus aucun lien n'y pointe ; un
 * ancien e-mail ou une ancienne notification ouvre désormais « Mon compte »
 * (aucun parcours d'acceptation hors Premium Duo tant que l'offre Pro n'est
 * pas vendue ; l'invitation Duo a sa propre page, `/duo/join/[token]`).
 */
export default function AncienLienPartage(): never {
  redirect('/mon-compte');
}
