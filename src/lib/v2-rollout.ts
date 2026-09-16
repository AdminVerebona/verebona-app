/**
 * Bascule V1 → V2 — CDC V2.0 §15.
 *
 * NOTE : « À traiter » ne figure plus ici. Sa bascule est FAITE — la page sert
 * directement la file V2 et le code V1 a été retiré. Un drapeau qui ne peut
 * plus être rebasculé n'est pas un filet de sécurité, seulement une option
 * morte que quelqu'un finira par activer en croyant revenir en arrière.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN DRAPEAU, PARCE QUE LA BASCULE EST LA SEULE ÉTAPE NON RÉVERSIBLE
 *
 * Les lots 1 à 3 s'ajoutaient : un défaut se corrigeait en ignorant le
 * nouveau code. Le lot 4 remplace des écrans en service, et une page V2 qui
 * se révélerait incomplète sur un compte réel laisserait l'utilisateur sans
 * l'ancienne.
 *
 * Le drapeau rend la bascule réversible sans redéploiement : une variable
 * d'environnement suffit à revenir en arrière, le temps de corriger. C'est ce
 * qui permet de basculer un compte de test, puis dix, plutôt que tout le parc
 * d'un coup.
 *
 * ── POURQUOI `NEXT_PUBLIC_` ───────────────────────────────────────────────
 *
 * Les pages concernées sont des composants client. Un drapeau lu uniquement
 * côté serveur obligerait à le transmettre en propriété depuis chaque page —
 * et il suffirait d'en oublier une pour qu'un écran bascule seul.
 *
 * Il n'y a rien de sensible ici : savoir quelle version d'un écran est active
 * n'ouvre aucun accès.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Pages documentaires : regroupement par Rubrique.
 *
 * Activable depuis le lot 5 : la page V2 porte désormais le téléversement (par
 * le dialogue commun, non réécrit), la suppression, le tri, les filtres et la
 * pagination par Rubrique.
 *
 * Elle n'a volontairement PAS de champ de recherche local — le §4.2 et le
 * critère UX-01 l'interdisent, la recherche restant centralisée au niveau
 * général de Verebona. Son absence est une exigence, pas un manque.
 */
export function isDocumentsV2Enabled(): boolean {
  return process.env.NEXT_PUBLIC_VEREBONA_V2_DOCUMENTS === 'on';
}
