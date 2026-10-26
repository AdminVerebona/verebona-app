/**
 * Raisons d'indisponibilité du catalogue Stripe et action qui les corrige —
 * lot 36B (« Tarif indisponible » partout sur la vitrine après le lot 35).
 *
 * Module PUR, sans secret ni identifiant Stripe : utilisé par le diagnostic
 * BO (Exploitation › Catalogue Stripe), par le JSON public
 * `/api/billing/catalog` (codes seulement) et par les tests.
 *
 * Pour chaque code : un libellé lisible, ce que le système fait TOUT SEUL, et
 * — si une intervention est utile — l'action BO existante qui corrige
 * (`publish`, `resume`, `sync`, `backfill`) ou, à défaut, le réglage à faire
 * dans le tableau de bord Stripe / Scalingo (jamais une commande).
 */

export type CatalogBoAction = 'publish' | 'resume' | 'sync' | 'backfill';

export interface ReasonExplanation {
  label: string;
  /** Ce qui se passe sans intervention. */
  auto: string;
  /** Bouton BO existant qui corrige, s'il y en a un. */
  action: CatalogBoAction | null;
  /** Réglage hors application (tableau de bord), si aucun bouton ne suffit. */
  hint?: string;
}

const PUBLISH_FIXES = 'La première publication de la grille du code crée des prix valides sous les produits Verebona et leur transfère la clé.';

/** Raisons par clé stable (couple offre × périodicité). */
export const COUPLE_REASONS: Readonly<Record<string, ReasonExplanation>> = {
  KEY_MISSING: {
    label: 'Aucun prix Stripe ne porte cette clé (prix créés sans lookup_key, aucune variable STRIPE_PRICE_*_MONTHLY/YEARLY reconnue)',
    auto: PUBLISH_FIXES,
    action: 'publish',
  },
  KEY_CONFLICT: { label: 'Plusieurs prix portent cette clé', auto: PUBLISH_FIXES, action: 'publish' },
  KEY_ON_ARCHIVED_PRICE: {
    label: 'La clé est portée par un prix archivé dans Stripe',
    auto: `Transférée au prix configuré s'il existe ; sinon : ${PUBLISH_FIXES}`,
    action: 'publish',
  },
  KEY_ON_INVALID_PRICE: {
    label: 'La clé est portée par un prix non vendable (paiement unique, autre devise…)',
    auto: PUBLISH_FIXES,
    action: 'publish',
  },
  LEGACY_PRICE_NOT_FOUND: {
    label: 'La variable STRIPE_PRICE_* désigne un prix introuvable dans ce compte / ce mode Stripe',
    auto: PUBLISH_FIXES,
    action: 'publish',
  },
  LEGACY_PRICE_INVALID: {
    label: 'La variable STRIPE_PRICE_* désigne un prix inactif ou de mauvaise cadence / devise',
    auto: PUBLISH_FIXES,
    action: 'publish',
  },
  LEGACY_PRICE_OTHER_KEY: {
    label: 'Le prix configuré porte déjà une autre clé (non Verebona) : il n’est pas réaffecté',
    auto: PUBLISH_FIXES,
    action: 'publish',
  },
  STRIPE_PERMISSION: {
    label: 'La clé API Stripe n’a pas le droit d’écrire les prix (clé restreinte)',
    auto: 'Nouvel essai automatique toutes les 5 à 15 min.',
    action: null,
    hint: 'Stripe › Développeurs › Clés API : utiliser la clé secrète standard, ou donner à la clé restreinte l’écriture sur Prices et Products.',
  },
  KEY_INIT_FAILED: { label: 'Initialisation de la clé impossible (erreur Stripe)', auto: PUBLISH_FIXES, action: 'publish' },
  PRODUCT_NOT_APPROVED: {
    label: 'Le prix est sous un produit Stripe non reconnu comme produit Verebona (métadonnée verebona_plan absente, aucune variable de prix ne le désigne)',
    auto: PUBLISH_FIXES,
    action: 'publish',
  },
  PRODUCT_INACTIVE: { label: 'Le produit Stripe est archivé', auto: PUBLISH_FIXES, action: 'publish' },
  METADATA_CONFLICT: { label: 'Métadonnées verebona_plan / verebona_period contradictoires avec la clé', auto: PUBLISH_FIXES, action: 'publish' },
  PRICE_INACTIVE: { label: 'Prix archivé', auto: PUBLISH_FIXES, action: 'publish' },
  LOOKUP_KEY_MISMATCH: { label: 'Clé inattendue sur le prix', auto: PUBLISH_FIXES, action: 'publish' },
  WRONG_MODE: { label: 'Prix d’un autre mode Stripe (test / live)', auto: PUBLISH_FIXES, action: 'publish' },
  WRONG_CURRENCY: { label: 'Devise autre que l’euro', auto: PUBLISH_FIXES, action: 'publish' },
  NOT_RECURRING: { label: 'Prix non récurrent', auto: PUBLISH_FIXES, action: 'publish' },
  WRONG_INTERVAL: { label: 'Cadence incorrecte pour la clé', auto: PUBLISH_FIXES, action: 'publish' },
  USAGE_METERED: { label: 'Prix à l’usage', auto: PUBLISH_FIXES, action: 'publish' },
  NOT_PER_UNIT: { label: 'Prix par paliers', auto: PUBLISH_FIXES, action: 'publish' },
  INVALID_AMOUNT: { label: 'Montant invalide', auto: PUBLISH_FIXES, action: 'publish' },
  CUSTOM_AMOUNT: { label: 'Prix libre', auto: PUBLISH_FIXES, action: 'publish' },
  TRANSFORM_QUANTITY: { label: 'Quantité transformée', auto: PUBLISH_FIXES, action: 'publish' },
  TAX_EXCLUSIVE: { label: 'Prix hors taxes (une TVA pourrait s’ajouter)', auto: PUBLISH_FIXES, action: 'publish' },
  NO_ACTIVE_REVISION: { label: 'Catalogue jamais synchronisé', auto: 'Synchronisation toutes les 5 min.', action: 'sync' },
};

/** Raisons au niveau du catalogue (exposables dans le JSON public : codes non sensibles). */
export type PublicCatalogReason =
  | 'STRIPE_NOT_CONFIGURED'
  | 'NOT_INITIALIZED'
  | 'SYNC_FAILED'
  | 'PUBLICATION_PENDING'
  | 'PUBLICATION_IN_PROGRESS'
  | 'PUBLICATION_FAILED'
  | 'PRICES_UNAVAILABLE';

const CATALOG_REASONS: Readonly<Record<PublicCatalogReason | 'EXPECTED_MODE_MISSING' | 'MODE_MISMATCH' | 'BACKFILL_PENDING' | 'WAITING_INSTANCES' | 'PREVIOUS_FAILURE', ReasonExplanation>> = {
  STRIPE_NOT_CONFIGURED: {
    label: 'STRIPE_SECRET_KEY absente ou illisible',
    auto: 'Aucune (rien ne peut être lu chez Stripe).',
    action: null,
    hint: 'Scalingo › Environnement : poser STRIPE_SECRET_KEY (sk_test_… en préprod, sk_live_… en production).',
  },
  NOT_INITIALIZED: { label: 'Catalogue jamais synchronisé', auto: 'Synchronisation toutes les 5 min (3 min après le démarrage).', action: 'sync' },
  SYNC_FAILED: { label: 'Synchronisation avec Stripe en échec', auto: 'Nouvel essai toutes les 5 min.', action: 'sync' },
  PUBLICATION_PENDING: {
    label: 'Aucune grille complète vendable : première publication de la grille du code à venir',
    auto: 'Publication automatique au prochain passage de la tâche (≤ 5 min, ou 20 min si une partie de la grille est déjà vendue).',
    action: 'publish',
  },
  PUBLICATION_IN_PROGRESS: { label: 'Publication en cours', auto: 'Se termine seule (quelques secondes à quelques minutes).', action: null },
  PUBLICATION_FAILED: {
    label: 'Publication en échec',
    auto: 'Si aucune grille n’est vendue, reprise automatique toutes les 15 min ; sinon l’ancienne grille reste vendue.',
    action: 'resume',
  },
  PRICES_UNAVAILABLE: { label: 'Une partie des offres est indisponible', auto: 'Voir la raison par clé.', action: 'publish' },
  EXPECTED_MODE_MISSING: {
    label: 'Mode Stripe attendu indéterminable : écritures Stripe refusées (LK-88)',
    auto: 'Aucune.',
    action: null,
    hint: 'Scalingo › Environnement : poser STRIPE_EXPECTED_MODE=test (préprod) / live (production), ou NEXT_PUBLIC_APP_ENV.',
  },
  MODE_MISMATCH: {
    label: 'La clé Stripe n’est pas du mode attendu (test / live)',
    auto: 'Aucune.',
    action: null,
    hint: 'Scalingo › Environnement : aligner STRIPE_SECRET_KEY et STRIPE_EXPECTED_MODE / NEXT_PUBLIC_APP_ENV.',
  },
  BACKFILL_PENDING: {
    label: 'Grille du code en attente : reprise historique non terminée (une grille est déjà vendue)',
    auto: 'Reprise relancée toutes les 5 min ; publication dès qu’elle aboutit.',
    action: 'publish',
  },
  WAITING_INSTANCES: { label: 'Délai de 20 min après déploiement (instances homogènes)', auto: 'Publication automatique à l’échéance.', action: null },
  // Lot 53I : « Publier la grille du code » refusé (PREVIOUS_FAILURE) — dire pourquoi et qui reprend.
  PREVIOUS_FAILURE: {
    label: 'Grille du code non publiée : une publication précédente est en échec (« Publier » est refusé tant qu’elle n’est pas reprise)',
    auto: 'Préproduction : la reprise automatique ciblée reprend cette publication (voir « Reprise automatique de la publication »). Ailleurs, l’ancienne grille reste vendue.',
    action: 'resume',
  },
};

export function explainCoupleReason(code: string | null | undefined): ReasonExplanation | null {
  if (!code) return null;
  return COUPLE_REASONS[code] ?? { label: code, auto: PUBLISH_FIXES, action: 'publish' };
}

export function explainCatalogReason(code: string | null | undefined): ReasonExplanation | null {
  if (!code) return null;
  return (CATALOG_REASONS as Record<string, ReasonExplanation>)[code] ?? null;
}

/** Libellés des boutons BO existants (StripeCatalogPanel). */
export const BO_ACTION_LABELS: Readonly<Record<CatalogBoAction, string>> = {
  publish: 'Publier la grille du code',
  resume: 'Reprendre la publication',
  sync: 'Synchroniser',
  backfill: 'Reprise historique',
};
