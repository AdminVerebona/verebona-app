/**
 * Lot 109F — RÈGLES de la détection des e-mails jetables (un seul endroit à
 * changer). Voir docs/exploitation/emails-jetables.md.
 */

/**
 * Liste d'autorisation LOCALE, versionnée, PRIORITAIRE sur toutes les listes
 * de blocage (le domaine ou l'un de ses domaines parents y figure → accepté).
 *   · relais Apple « Masquer mon adresse e-mail » (toujours autorisé) ;
 *   · grands fournisseurs et relais de confidentialité : jamais jetables, même
 *     si une version future de la liste publique les ajoutait par erreur
 *     (le script de mise à jour refuse d'ailleurs une telle version) ;
 *   · faux positifs confirmés (à ajouter ici, avec la date et le motif).
 * Garder ce tableau aligné avec `SENTINELS` de scripts/update-disposable-domains.mjs
 * (vérifié par le test l109f).
 */
export const LOCAL_ALLOWLIST: readonly string[] = [
  'privaterelay.appleid.com', 'icloud.com', 'me.com', 'mac.com',
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com',
  'yahoo.com', 'yahoo.fr', 'aol.com', 'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'neuf.fr', 'bbox.fr', 'laposte.net',
  'gmx.fr', 'gmx.com', 'gmx.de', 'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.io', 'mailo.com', 'fastmail.com',
  // Relais de confidentialité (adresses durables qui redirigent vers une vraie boîte).
  'mozmail.com', 'duck.com', 'simplelogin.com', 'aleeas.com', 'slmail.me', 'anonaddy.me', 'addy.io', 'passmail.net',
  // Faux positifs confirmés : « 'domaine.tld', // AAAA-MM-JJ motif » .
];

/**
 * Variables d'environnement (Scalingo) lues à CHAQUE contrôle — un
 * changement s'applique dès le redémarrage du conteneur, sans livraison :
 *   · DISPOSABLE_EMAIL_ALLOWLIST : faux positifs à débloquer TOUT DE SUITE
 *     (domaines séparés par des virgules ou des espaces) ;
 *   · DISPOSABLE_EMAIL_EXTRA_BLOCKLIST : domaines jetables à bloquer en
 *     urgence, avant la prochaine mise à jour du référentiel.
 * Aucune variable ne désactive globalement le contrôle (choix du ticket).
 */
export const DISPOSABLE_ENV = {
  allowlist: 'DISPOSABLE_EMAIL_ALLOWLIST',
  extraBlocklist: 'DISPOSABLE_EMAIL_EXTRA_BLOCKLIST',
} as const;

/**
 * Règle des SOUS-DOMAINES (explicite, non agressive) : l'adresse est jetable
 * si son domaine OU l'un de ses domaines parents d'au moins
 * `MIN_MATCH_LABELS` niveaux figure TEL QUEL dans une liste de blocage
 * (`a.b.yopmail.com` → `a.b.yopmail.com`, `b.yopmail.com`, `yopmail.com`).
 * On ne remonte jamais à un suffixe d'un seul niveau (`com`, `fr`) et on ne
 * déduit jamais un domaine « voisin » : seule une entrée exacte compte.
 */
export const MIN_MATCH_LABELS = 2;

/** En deçà, le référentiel embarqué est considéré comme indisponible (fichier tronqué). */
export const MIN_VALID_LIST_SIZE = 1000;

/**
 * SEUIL D'ALERTE : au-delà, le référentiel est « périmé » et une anomalie est
 * ouverte dans BO › Supervision (lot 113H). Distinct de la cible ci-dessous.
 */
export const DISPOSABLE_LIST_MAX_AGE_DAYS = 90;

/**
 * Lot 113H — CIBLE de mise à jour (action opérationnelle MENSUELLE, docs/
 * exploitation/emails-jetables.md) : au-delà, BO › Exploitation affiche
 * « mise à jour à prévoir », sans anomalie (l'alerte reste à 90 jours).
 */
export const DISPOSABLE_LIST_UPDATE_TARGET_DAYS = 31;

/** Où le contrôle a refusé une adresse (métriques agrégées). */
export type DisposableChannel =
  | 'signup'
  | 'social_signup'
  | 'social_email_code'
  | 'social_final'
  | 'email_change_request'
  | 'email_change_confirm';

/** Conservation des compteurs agrégés de refus. */
export const DISPOSABLE_REFUSAL_RETENTION_DAYS = 365;
