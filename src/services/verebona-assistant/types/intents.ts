/**
 * Catalogue FERMÉ et VERSIONNÉ des intentions — CDC §9.2 / §9.10.
 *
 * Règle absolue (§9.1) : une intention inconnue n'est JAMAIS créée dynamiquement
 * par Gemini. Le classifieur ne peut retourner qu'une valeur de cette énumération.
 */

export const INTENT_CATALOG_VERSION = 'intent-catalog-v1.0' as const;

export const VEREBONA_INTENTS = [
  // Conversation
  'GREETING',
  'THANKS',
  'GOODBYE',
  // Produit
  'PRODUCT_HELP_HOW_TO',
  'PRODUCT_HELP_EXPLAIN',
  'PRODUCT_HELP_STATUS',
  'PRODUCT_PLAN_LIMIT',
  // Navigation
  'NAVIGATION_OPEN',
  'NAVIGATION_FIND',
  // Recherche
  'ACCOUNT_SEARCH_ASSET',
  'ACCOUNT_SEARCH_DOCUMENT',
  'ACCOUNT_SEARCH_AGENDA',
  'ACCOUNT_SEARCH_SUPPLIER',
  // Donnée
  'ACCOUNT_FACT_ASSET',
  'ACCOUNT_FACT_DOCUMENT',
  'ACCOUNT_FACT_AGENDA',
  'ACCOUNT_TO_PROCESS',
  'ACCOUNT_MISSING_INFORMATION',
  // Synthèse (Gemini si offre éligible)
  'ACCOUNT_SUMMARY',
  'ACCOUNT_COMPARISON',
  'ACCOUNT_TIMELINE',
  // Export
  'EXPORT_HELP',
  // Clarification
  'CLARIFICATION_ANSWER',
  // Incident
  'TECHNICAL_ISSUE',
  // Limites
  'UNSUPPORTED_ACTION',
  'OUT_OF_SCOPE',
  // Sensible
  'SENSITIVE_ADVICE',
  // Sécurité
  'UNSAFE_OR_MALICIOUS',
  // Inconnu
  'UNKNOWN',
] as const;

export type VerebonaIntent = (typeof VEREBONA_INTENTS)[number];

/** Traitement attendu par intention (§9.2). */
export type IntentTreatment =
  | 'template'
  | 'help'
  | 'help+action'
  | 'plan_rule'
  | 'action_catalog'
  | 'sql'
  | 'sql+template'
  | 'business_rules'
  | 'retrieval+synthesis'
  | 'retrieval+comparison'
  | 'retrieval+timeline'
  | 'clarification'
  | 'diagnostic'
  | 'limit'
  | 'scope'
  | 'sensitive'
  | 'block'
  | 'classification';

/**
 * Métadonnées d'une intention. `geminiEligible` n'autorise PAS l'appel à lui seul :
 * l'orchestrateur vérifie aussi l'offre, le budget et la présence de sources (§15.1).
 */
export interface IntentDefinition {
  intent: VerebonaIntent;
  label: string;
  treatment: IntentTreatment;
  /** L'intention PEUT nécessiter Gemini (jamais en Standard sur données compte). */
  geminiEligible: boolean;
  requiresRetrieval: boolean;
  /** Types de sources attendus (référence les valeurs de sources.ts). */
  expectedSourceTypes: ReadonlyArray<string>;
}

export function isVerebonaIntent(value: string): value is VerebonaIntent {
  return (VEREBONA_INTENTS as readonly string[]).includes(value);
}
