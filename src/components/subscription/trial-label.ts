/**
 * Libellé de l'essai en cours — CDC 1 §9.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE PHRASE, DEUX ÉCRANS
 *
 * Le bandeau supérieur et le résumé d'abonnement affichaient la même chose,
 * écrite deux fois. Ce projet a déjà payé ce genre de duplication : deux
 * pages d'offres qui ont divergé, deux implémentations d'assistant, deux
 * mascottes.
 *
 * Une phrase modifiée à un seul endroit crée un doute chez qui la lit
 * ailleurs — « est-ce la même chose ? ».
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * « Essai gratuit en cours — 7 jours restants »
 *
 * « gratuit » plutôt que « Premium » : ce qui rassure pendant un essai, c'est
 * qu'il ne coûte rien. Le niveau de fonctionnalités se lit dans la
 * comparaison des offres, où il sert réellement à décider.
 */
export function libelleEssai(joursRestants: number): string {
  // L'accord suit le nombre. Un « 1 jours restants » se remarque, et fait
  // douter du reste de l'écran.
  const jours = joursRestants > 1 ? 'jours restants' : 'jour restant';
  return `Essai gratuit en cours — ${joursRestants} ${jours}`;
}
