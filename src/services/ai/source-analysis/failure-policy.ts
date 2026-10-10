/**
 * Échecs de l'analyse T1 : transitoire ou définitif (revue L16b-3a, points 1
 * et 2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI DISTINGUER
 *
 * Sans repli « étapes » (lot 16b-3), un document dont la sortie du master est
 * INVALIDE sur toute la chaîne de modèles (JSON tronqué d'un gros PDF, par
 * exemple) échouait à chaque essai : 4 exécutions par la file, puis jusqu'à
 * 10 relances par la reprise serveur — ≈ 36 appels facturés pour un échec qui
 * ne change pas, et 4 à 5 échecs complets consécutifs du traitement T1 qui
 * suspendaient T1 pour TOUS les comptes (disjoncteur, seuil 5).
 *
 * Un échec est DÉFINITIF quand le dernier modèle de la chaîne a répondu mais
 * que sa sortie est inexploitable (`INVALID_OUTPUT`), ou quand le prompt
 * maître est invalide (`MASTER_PROMPT_INVALID`) : le fournisseur fonctionne,
 * c'est l'entrée (ou la configuration) qui pose problème. Il a droit à UNE
 * reprise (une sortie tronquée peut ne pas se reproduire), puis :
 *   · le job est clos sans nouvelle tentative (`t1-handler`) ;
 *   · le compteur d'essais du fichier est porté à `MAX_ANALYSIS_RETRIES` : la
 *     reprise serveur ne le relance plus (`analysis-recovery`) ; l'utilisateur
 *     peut toujours relancer depuis le tiroir.
 * Un document produit donc au plus deux échecs complets T1 (sous le seuil du
 * disjoncteur) et au plus 2 × 3 appels modèle.
 *
 * Toute autre cause (panne fournisseur, délai, quota, persistance) reste
 * TRANSITOIRE : backoff de la file puis reprise serveur, comme avant.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { isInternalAiErrorCode } from '../gateway/errors';

/** Relances au-delà desquelles la reprise serveur n'insiste plus (`analysis-recovery`). */
export const MAX_ANALYSIS_RETRIES = 10;

/** Codes de passerelle d'un échec définitif du master T1. */
const DEFINITIVE_CODES = new Set(['INVALID_OUTPUT', 'MASTER_PROMPT_INVALID',
  // Lot 34D : contrat runtime incohérent (défaut interne, identique à chaque essai).
  'RUNTIME_CONTRACT_MISMATCH']);

/**
 * L'échec de la passerelle est-il définitif ? `ALL_MODELS_FAILED` : code du
 * DERNIER modèle sollicité (`lastFailureCode`) ; sinon le code lui-même.
 */
export function isDefinitiveGatewayFailure(e: unknown): boolean {
  const err = e as { code?: unknown; lastFailureCode?: unknown } | null;
  if (!err || typeof err !== 'object') return false;
  const code = err.code === 'ALL_MODELS_FAILED' ? err.lastFailureCode : err.code;
  return typeof code === 'string' && DEFINITIVE_CODES.has(code);
}

/**
 * Motif d'échec ENREGISTRÉ sur le document (lot 34D) : un défaut INTERNE du
 * moteur (contrat runtime incohérent, contrat T4 violé) n'est jamais exposé
 * tel quel à l'utilisateur final — message générique ; le détail (empreintes,
 * contrat, étape) reste dans BO › Exécutions IA. Les autres causes gardent
 * leur message historique.
 */
export function userFacingFailReason(e: unknown): string | null {
  const err = e as { code?: unknown; lastFailureCode?: unknown } | null;
  if (!err || typeof err !== 'object') return null;
  if (isInternalAiErrorCode(err.code) || isInternalAiErrorCode(err.lastFailureCode)) {
    return 'erreur technique interne du moteur d’analyse (détail transmis à l’équipe Verebona)';
  }
  return null;
}

/** Origine d'une remise en file après un échec HORS file (`entrypoint`). */
export const REQUEUE_ORIGIN_SUFFIX = ':reprise';
