/**
 * Registre des intentions — CDC §9.2.
 *
 * Table des définitions (traitement, éligibilité Gemini, sources attendues).
 * FERMÉ et versionné (§9.10). Toute évolution => mise à jour tests + règles d'offre
 * + catalogue d'actions + métriques + validation PO.
 */
import { INTENT_CATALOG_VERSION, type IntentDefinition, type VerebonaIntent } from '../types/intents';

const D = (
  intent: VerebonaIntent,
  label: string,
  treatment: IntentDefinition['treatment'],
  geminiEligible: boolean,
  requiresRetrieval: boolean,
  expectedSourceTypes: string[],
): IntentDefinition => ({ intent, label, treatment, geminiEligible, requiresRetrieval, expectedSourceTypes });

export const INTENT_DEFINITIONS: Record<VerebonaIntent, IntentDefinition> = {
  GREETING: D('GREETING', 'Salutation', 'template', false, false, []),
  THANKS: D('THANKS', 'Remerciement', 'template', false, false, []),
  GOODBYE: D('GOODBYE', "Fin d'échange", 'template', false, false, []),

  PRODUCT_HELP_HOW_TO: D('PRODUCT_HELP_HOW_TO', 'Comment réaliser une action', 'help+action', true, false, ['help_entry']),
  PRODUCT_HELP_EXPLAIN: D('PRODUCT_HELP_EXPLAIN', 'À quoi sert une fonction', 'help', false, false, ['help_entry']),
  PRODUCT_HELP_STATUS: D('PRODUCT_HELP_STATUS', "Signification d'un statut", 'help', false, false, ['help_entry', 'product_rule']),
  PRODUCT_PLAN_LIMIT: D('PRODUCT_PLAN_LIMIT', "Limite d'offre / indisponibilité", 'plan_rule', false, false, ['product_rule']),

  NAVIGATION_OPEN: D('NAVIGATION_OPEN', 'Ouvrir un écran/objet', 'action_catalog', false, false, []),
  NAVIGATION_FIND: D('NAVIGATION_FIND', 'Où trouver une fonction', 'help+action', false, false, ['help_entry']),

  ACCOUNT_SEARCH_ASSET: D('ACCOUNT_SEARCH_ASSET', 'Retrouver un bien', 'sql', false, true, ['asset_field']),
  ACCOUNT_SEARCH_DOCUMENT: D('ACCOUNT_SEARCH_DOCUMENT', 'Retrouver un document', 'sql', false, true, ['document']),
  ACCOUNT_SEARCH_AGENDA: D('ACCOUNT_SEARCH_AGENDA', 'Retrouver une échéance', 'sql', false, true, ['agenda_item']),
  ACCOUNT_SEARCH_SUPPLIER: D('ACCOUNT_SEARCH_SUPPLIER', 'Retrouver un fournisseur', 'sql', false, true, ['supplier']),

  ACCOUNT_FACT_ASSET: D('ACCOUNT_FACT_ASSET', "Lire une donnée d'un bien", 'sql+template', false, true, ['asset_field', 'document']),
  ACCOUNT_FACT_DOCUMENT: D('ACCOUNT_FACT_DOCUMENT', "Lire une donnée d'un document", 'sql+template', false, true, ['document', 'document_extraction']),
  ACCOUNT_FACT_AGENDA: D('ACCOUNT_FACT_AGENDA', "Lire une date/statut d'agenda", 'sql+template', false, true, ['agenda_item']),
  ACCOUNT_TO_PROCESS: D('ACCOUNT_TO_PROCESS', 'Compter/lister À traiter', 'sql', false, true, ['to_process_item']),
  ACCOUNT_MISSING_INFORMATION: D('ACCOUNT_MISSING_INFORMATION', 'Données manquantes', 'business_rules', false, true, ['asset_field', 'document', 'product_rule']),

  ACCOUNT_SUMMARY: D('ACCOUNT_SUMMARY', 'Synthèse multi-sources', 'retrieval+synthesis', true, true, ['document', 'document_extraction', 'asset_field']),
  ACCOUNT_COMPARISON: D('ACCOUNT_COMPARISON', 'Comparaison', 'retrieval+comparison', true, true, ['document', 'document_extraction']),
  ACCOUNT_TIMELINE: D('ACCOUNT_TIMELINE', 'Chronologie', 'retrieval+timeline', true, true, ['document', 'agenda_item', 'asset_field']),

  EXPORT_HELP: D('EXPORT_HELP', 'Expliquer/ouvrir un export', 'help+action', false, false, ['help_entry']),

  CLARIFICATION_ANSWER: D('CLARIFICATION_ANSWER', 'Réponse à une clarification', 'clarification', false, false, []),

  TECHNICAL_ISSUE: D('TECHNICAL_ISSUE', 'Problème/erreur/blocage', 'diagnostic', false, false, ['help_entry']),

  UNSUPPORTED_ACTION: D('UNSUPPORTED_ACTION', 'Action non exécutable en V1', 'limit', false, false, []),
  OUT_OF_SCOPE: D('OUT_OF_SCOPE', 'Hors périmètre', 'scope', false, false, []),
  SENSITIVE_ADVICE: D('SENSITIVE_ADVICE', 'Conseil réglementé', 'sensitive', false, false, ['product_rule']),
  UNSAFE_OR_MALICIOUS: D('UNSAFE_OR_MALICIOUS', 'Tentative malveillante', 'block', false, false, []),

  UNKNOWN: D('UNKNOWN', 'Intention indéterminée', 'classification', true, false, []),
};

export function getIntentDefinition(intent: VerebonaIntent): IntentDefinition {
  return INTENT_DEFINITIONS[intent];
}

export { INTENT_CATALOG_VERSION };
