/**
 * Événements d'authentification présentés dans BO › Utilisateurs › fiche ›
 * « Connexions et tentatives » — contrat PARTAGÉ (carte #799).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX ÉVÉNEMENTS DE SENS OPPOSÉ, UN SEUL LIBELLÉ
 *
 * `AUTH_TOKEN_REUSE_DETECTED` (un ancien jeton de renouvellement a été
 * représenté : révocation de SÉCURITÉ) et `AUTH_LOGOUT` avec
 * `trigger=auth-failure` (l'application a fermé la session après un refus
 * d'authentification) étaient tous deux rendus par `result:
 * 'session_revoked'`, donc par le libellé « Déconnexion par précaution ».
 * L'incident iOS du 16/11 était ainsi présenté au BO comme une mesure de
 * sécurité, avec le risque de qualifier abusivement un incident de sécurité.
 *
 * Ce module porte la correspondance EXPLICITE
 * « événement → résultat → catégorie → texte » et il est lu des DEUX côtés :
 * le service (qui construit les lignes depuis le journal d'activité) et la
 * page du BO (qui les affiche). Module PUR : aucune dépendance base ni
 * navigateur, donc aucun client PostgreSQL embarqué dans le paquet du BO.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Résultats possibles d'une ligne (liste FERMÉE). */
export type LoginResult = 'success' | 'failure' | 'throttled' | 'session_revoked' | 'app_signed_out' | 'signed_out';

/**
 * Catégorie typée de l'événement, indépendante du libellé affiché.
 * `security` est réservé à un incident de sécurité QUALIFIÉ par la source.
 */
export type LoginCategory = 'success' | 'failure' | 'anti_abuse' | 'session_incident' | 'security' | 'signed_out';

/** Correspondance résultat → catégorie (exhaustive). */
export const LOGIN_RESULT_CATEGORY: Readonly<Record<LoginResult, LoginCategory>> = Object.freeze({
  success: 'success',
  failure: 'failure',
  throttled: 'anti_abuse',
  session_revoked: 'security',
  app_signed_out: 'session_incident',
  signed_out: 'signed_out',
});

/**
 * Libellé visible. « Déconnexion par précaution » est CONSERVÉ pour la
 * révocation de sécurité (lot 79C) ; « Déconnexion après refus
 * d'authentification » est le libellé demandé par la carte #799, repris à
 * l'identique. « Déconnexion demandée » est un texte NOUVEAU, à valider par
 * le PO.
 */
export const LOGIN_RESULT_LABEL: Readonly<Record<LoginResult, string>> = Object.freeze({
  success: 'Réussie',
  failure: 'Échec',
  throttled: 'Pause',
  session_revoked: 'Déconnexion par précaution',
  app_signed_out: 'Déconnexion après refus d’authentification',
  signed_out: 'Déconnexion demandée',
});

/** Ligne telle que le BO la consomme (anciennes données : champs absents). */
export interface LoginActivityRow {
  result?: LoginResult;
  detail?: string | null;
  category?: LoginCategory;
  attemptId?: string | null;
  refusalCode?: string | null;
}

/**
 * Catégorie d'une ligne, y compris pour une ligne servie par un code
 * antérieur à la carte (champ absent) : on la déduit alors du résultat, sans
 * jamais inventer de sévérité de sécurité.
 */
export function loginCategoryOf(row: LoginActivityRow): LoginCategory {
  if (row.category) return row.category;
  return LOGIN_RESULT_CATEGORY[row.result ?? 'success'];
}

/**
 * Seuls un incident de SÉCURITÉ et un ÉCHEC portent le ton d'alerte : la
 * couleur ne qualifie pas un incident à la place du contrat de données.
 */
export function loginRowTone(row: LoginActivityRow): string {
  const category = loginCategoryOf(row);
  return category === 'security' || category === 'failure' ? 'text-destructive' : '';
}

/**
 * Carte #799 (CA04) — retrouver une tentative depuis son code de diagnostic,
 * depuis la fiche du compte et sans accès SQL ni journaux techniques.
 *
 * La recherche porte sur l'identifiant de tentative tracé ET sur le détail
 * affiché (qui le reprend, y compris pour les lignes antérieures à la carte,
 * où le champ structuré n'existait pas) : elle filtre ce qui est là, elle
 * n'invente rien. Saisie vide : la liste complète, inchangée.
 */
export function filterLoginEntries<T extends LoginActivityRow>(entries: readonly T[], recherche: string): T[] {
  const q = recherche.trim().toUpperCase();
  if (!q) return [...entries];
  return entries.filter((e) => (e.attemptId ?? '').includes(q) || (e.detail ?? '').toUpperCase().includes(q));
}
