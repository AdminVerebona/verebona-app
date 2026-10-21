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

import { T2_MASTER_VARIABLES, listMasterTasks } from '../../registry/operations';
import { inspectMasterTemplate, isOptionalMasterTask, isOptionalMasterVariable } from '../../prompts/prompt-loader';

export interface T2PromptCheck {
  code: 'BUSINESS_CANDIDATES' | 'RULE_A7' | 'RULE_A8' | 'RULE_A9' | 'INTERACTION_MODE' | 'SUPPLIED_FACTS' | 'SEMANTIC_DECISION' | 'SELECTED_CANDIDATE_REF';
  label: string;
  present: boolean;
}

/**
 * Lot 75J (#419 §3) — COMPATIBILITÉ du texte avec ce que le serveur injecte
 * réellement et attend en sortie : emplacements des variables injectées
 * (`T2_MASTER_VARIABLES`, hors facultatives), aucun emplacement inconnu
 * (jamais rempli : rendu refusé), branches UNDERSTAND / ANSWER / REVALIDATE.
 * Incompatible : les appels T2 échouent (rendu refusé) — l'assistant répond
 * sans IA ; aucun arbitrage n'est tenté. Présence d'un texte ≠ preuve de
 * fonctionnement : la recette réelle reste obligatoire (procédure BO).
 */
export interface T2PromptCompatibility {
  compatible: boolean;
  /** Variables injectées par le serveur sans emplacement dans le texte (rendu refusé). */
  missingVariables: string[];
  /** Emplacements du texte qu'aucune variable serveur ne remplit (rendu refusé). */
  unknownPlaceholders: string[];
  /** Branches attendues absentes du texte. */
  missingBranches: string[];
}

export interface T2PromptCapabilities {
  checks: T2PromptCheck[];
  /** Arbitrage T2 entre candidats possible avec ce texte. */
  arbitration: boolean;
  /** Informations apportées (proposition / contexte) comprises avec ce texte. */
  interaction: boolean;
  /** Lot 75J : compatibilité avec les variables injectées et le contrat de sortie. */
  compatibility: T2PromptCompatibility;
  /** Message explicite (BO) ; `null` : tout est présent. */
  message: string | null;
}

/** Compatibilité d'un texte T2 avec les variables injectées et les branches (pure, testée). */
export function t2PromptCompatibility(text: string): T2PromptCompatibility {
  const info = inspectMasterTemplate(text ?? '');
  const cle = info.discriminant ?? 'TASK';
  const injectees = new Set<string>(T2_MASTER_VARIABLES);
  const missingVariables = T2_MASTER_VARIABLES.filter((v) => !info.placeholders.includes(v) && !isOptionalMasterVariable('t2_master_v1', v));
  const unknownPlaceholders = info.placeholders.filter((p) => p !== cle && p !== 'TASK' && p !== 'MODE' && !injectees.has(p));
  const missingBranches = listMasterTasks('t2_master_v1').filter((t) => !info.branches.includes(t) && !isOptionalMasterTask('t2_master_v1', t));
  return {
    compatible: missingVariables.length === 0 && unknownPlaceholders.length === 0 && missingBranches.length === 0 && info.hasTaskPlaceholder,
    missingVariables, unknownPlaceholders, missingBranches,
  };
}

const CHECKS: ReadonlyArray<{ code: T2PromptCheck['code']; label: string; test: (t: string) => boolean }> = [
  { code: 'BUSINESS_CANDIDATES', label: 'Emplacement {{BUSINESS_CANDIDATES}} (candidats métier)', test: (t) => t.includes('{{BUSINESS_CANDIDATES}}') },
  { code: 'RULE_A7', label: 'Règle A7 (nature du message)', test: (t) => /(^|\n)\s*A7\s*[—-]/.test(t) },
  { code: 'RULE_A8', label: 'Règle A8 (informations apportées)', test: (t) => /(^|\n)\s*A8\s*[—-]/.test(t) },
  { code: 'RULE_A9', label: 'Règle A9 (arbitrage entre candidats)', test: (t) => /(^|\n)\s*A9\s*[—-]/.test(t) },
  { code: 'INTERACTION_MODE', label: 'Sortie interactionMode', test: (t) => t.includes('interactionMode') },
  { code: 'SUPPLIED_FACTS', label: 'Sortie suppliedFacts', test: (t) => t.includes('suppliedFacts') },
  { code: 'SEMANTIC_DECISION', label: 'Sortie semanticDecision', test: (t) => t.includes('semanticDecision') },
  // Lot 75J : champ du contrat de sortie revalidé par le serveur (référence de candidat).
  { code: 'SELECTED_CANDIDATE_REF', label: 'Sortie selectedCandidateRef', test: (t) => t.includes('selectedCandidateRef') },
];

/** Contrôle d'un texte de prompt maître T2 (pure, testée). */
export function t2PromptCapabilities(text: string): T2PromptCapabilities {
  const checks = CHECKS.map((c) => ({ code: c.code, label: c.label, present: c.test(text ?? '') }));
  const has = (code: T2PromptCheck['code']) => checks.find((c) => c.code === code)!.present;
  const compatibility = t2PromptCompatibility(text ?? '');
  const arbitration = has('BUSINESS_CANDIDATES') && has('RULE_A9') && has('SEMANTIC_DECISION') && has('SELECTED_CANDIDATE_REF') && compatibility.compatible;
  const interaction = has('RULE_A7') && has('RULE_A8') && has('INTERACTION_MODE') && has('SUPPLIED_FACTS') && compatibility.compatible;
  const manquants = checks.filter((c) => !c.present).map((c) => c.label);
  const incompat = [
    compatibility.missingVariables.length ? `variables injectées sans emplacement : ${compatibility.missingVariables.map((v) => `{{${v}}}`).join(', ')}` : null,
    compatibility.unknownPlaceholders.length ? `emplacements inconnus du serveur : ${compatibility.unknownPlaceholders.map((v) => `{{${v}}}`).join(', ')}` : null,
    compatibility.missingBranches.length ? `branches absentes : ${compatibility.missingBranches.join(', ')}` : null,
  ].filter(Boolean);
  const message = manquants.length === 0 && compatibility.compatible ? null
    : `${!compatibility.compatible ? `Version INCOMPATIBLE avec le serveur (${incompat.join(' ; ')}) : les appels T2 sont refusés, l’assistant répond sans IA. ` : ''}`
      + `${!arbitration ? 'Arbitrage sémantique IMPOSSIBLE avec cette version : les demandes à plusieurs lectures se terminent par une clarification. ' : ''}`
      + `${!interaction ? 'Informations apportées non comprises : aucune proposition de modification ni information de contexte. ' : ''}`
      + `${manquants.length ? `Éléments absents : ${manquants.join(', ')}. ` : ''}`
      + 'Action : activer une version du prompt maître T2 basée sur le texte livré (brouillon → « Repartir du texte livré avec l’application »), puis la tester et l’activer.';
  return { checks, arbitration, interaction, compatibility, message };
}
