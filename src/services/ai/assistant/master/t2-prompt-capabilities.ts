/**
 * Capacités #419 d'un texte de prompt maître T2 — lot 59 (ticket « Finaliser
 * le #419 », § Configuration T2 et observabilité).
 *
 * Le prompt RÉELLEMENT actif est celui du BO (version active), pas celui du
 * dépôt. Ce contrôle PUR lit un texte de prompt et dit ce qu'il permet :
 *
 *   · arbitrage sémantique : emplacement {{BUSINESS_CANDIDATES}} ET règle A9
 *     (sortie `semanticDecision`) — sans eux, aucun appel d'arbitrage n'est
 *     dépensé, la demande se termine par une clarification ;
 *   · informations apportées : règles A7 (`interactionMode`) et A8
 *     (`suppliedFacts`) — sans elles, T2 ne signale jamais une information
 *     à enregistrer ni une information de contexte (sortie par défaut QUERY,
 *     compatible) : aucune proposition de modification.
 *
 * Utilisé à l'exécution (trace de chaque demande, `t2PromptCapabilities`)
 * et par le BO (configuration IA → prompt maître T2 : bandeau de contrôle).
 * Aucune donnée utilisateur, aucun contenu du prompt dans la trace.
 */

export interface T2PromptCheck {
  code: 'BUSINESS_CANDIDATES' | 'RULE_A7' | 'RULE_A8' | 'RULE_A9' | 'INTERACTION_MODE' | 'SUPPLIED_FACTS' | 'SEMANTIC_DECISION';
  label: string;
  present: boolean;
}

export interface T2PromptCapabilities {
  checks: T2PromptCheck[];
  /** Arbitrage T2 entre candidats possible avec ce texte. */
  arbitration: boolean;
  /** Informations apportées (proposition / contexte) comprises avec ce texte. */
  interaction: boolean;
  /** Message explicite (BO) ; `null` : tout est présent. */
  message: string | null;
}

const CHECKS: ReadonlyArray<{ code: T2PromptCheck['code']; label: string; test: (t: string) => boolean }> = [
  { code: 'BUSINESS_CANDIDATES', label: 'Emplacement {{BUSINESS_CANDIDATES}} (candidats métier)', test: (t) => t.includes('{{BUSINESS_CANDIDATES}}') },
  { code: 'RULE_A7', label: 'Règle A7 (nature du message)', test: (t) => /(^|\n)\s*A7\s*[—-]/.test(t) },
  { code: 'RULE_A8', label: 'Règle A8 (informations apportées)', test: (t) => /(^|\n)\s*A8\s*[—-]/.test(t) },
  { code: 'RULE_A9', label: 'Règle A9 (arbitrage entre candidats)', test: (t) => /(^|\n)\s*A9\s*[—-]/.test(t) },
  { code: 'INTERACTION_MODE', label: 'Sortie interactionMode', test: (t) => t.includes('interactionMode') },
  { code: 'SUPPLIED_FACTS', label: 'Sortie suppliedFacts', test: (t) => t.includes('suppliedFacts') },
  { code: 'SEMANTIC_DECISION', label: 'Sortie semanticDecision', test: (t) => t.includes('semanticDecision') },
];

/** Contrôle d'un texte de prompt maître T2 (pure, testée). */
export function t2PromptCapabilities(text: string): T2PromptCapabilities {
  const checks = CHECKS.map((c) => ({ code: c.code, label: c.label, present: c.test(text ?? '') }));
  const has = (code: T2PromptCheck['code']) => checks.find((c) => c.code === code)!.present;
  const arbitration = has('BUSINESS_CANDIDATES') && has('RULE_A9') && has('SEMANTIC_DECISION');
  const interaction = has('RULE_A7') && has('RULE_A8') && has('INTERACTION_MODE') && has('SUPPLIED_FACTS');
  const manquants = checks.filter((c) => !c.present).map((c) => c.label);
  const message = manquants.length === 0 ? null
    : `${!arbitration ? 'Arbitrage sémantique IMPOSSIBLE avec cette version : les demandes à plusieurs lectures se terminent par une clarification. ' : ''}`
      + `${!interaction ? 'Informations apportées non comprises : aucune proposition de modification ni information de contexte. ' : ''}`
      + `Éléments absents : ${manquants.join(', ')}. Action : activer une version du prompt maître T2 basée sur le texte livré (brouillon → « Repartir du texte livré avec l’application »), puis la tester et l’activer.`;
  return { checks, arbitration, interaction, message };
}
