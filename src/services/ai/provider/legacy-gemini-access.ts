/**
 * Accès des modules Gemini HISTORIQUES à la clé et à l'état d'exploitation —
 * CDC BO IA PROV-UI-05, WF-21, OPS-011, OPS-008, WF-07, WF-08 ; revue
 * indépendante lot IA 2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI ÉCHAPPAIT AU BO
 *
 * Plusieurs modules antérieurs à la passerelle appellent encore Gemini
 * directement (recherche, analyse historique, enrichissement, classification
 * agenda). Ils lisaient `process.env.GEMINI_API_KEY` : la rotation de clé du
 * BO ne les atteignait pas, et surtout l'ARRÊT D'URGENCE ne les arrêtait pas —
 * « Emergency Stop arrête les appels IA courants et bloque tout nouveau
 * démarrage IA » (OPS-011) était faux pour eux.
 *
 * Aucune opération équivalente n'existe dans le référentiel de la passerelle
 * (prompts et schémas propres à chacun) : les faire passer par `AiGateway`
 * relève du plan de retrait WF-41 (E-05), pas d'un correctif. Ce module leur
 * donne le minimum exigible, en un seul endroit :
 *   · la clé ACTIVE du BO (même source et même cache que la passerelle) ;
 *   · la garde d'exploitation du traitement dont ils relèvent (même garde,
 *     même cache de 5 s, même exemption MOD-011 que la passerelle).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Treatment } from '../config/treatments';
import { assertTreatmentRunnable, isTreatmentRunnable } from '../queue/runnable-guard';
import { getProviderSecret } from './provider-secret';

export class LegacyGeminiUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  constructor(context: string) {
    super(`[${context}] Aucune clé Gemini (clé active du BO ni GEMINI_API_KEY).`);
    this.name = 'LegacyGeminiUnavailableError';
  }
}

/**
 * Clé à utiliser pour un appel Gemini historique relevant de `treatment`.
 *
 * Lève `AI_BLOCKED` (AiGatewayError, non récupérable) si l'arrêt d'urgence est
 * engagé ou si le traitement est désactivé / suspendu ; lève
 * `LegacyGeminiUnavailableError` s'il n'y a aucune clé. Chaque appelant garde
 * son propre repli (il en avait déjà un pour la clé absente).
 */
export async function requireLegacyGeminiKey(treatment: Treatment, context: string): Promise<string> {
  await assertTreatmentRunnable(treatment, context);
  const key = await getProviderSecret('gemini');
  if (!key) throw new LegacyGeminiUnavailableError(context);
  return key;
}

/**
 * Variante sans exception, pour les appelants dont le repli est déterministe
 * (classification agenda) : `null` = pas d'appel IA, appliquer le repli.
 */
export async function legacyGeminiKeyOrNull(treatment: Treatment): Promise<string | null> {
  if (!(await isTreatmentRunnable(treatment))) return null;
  return getProviderSecret('gemini');
}

/**
 * Clé seule, SANS garde : uniquement pour libérer une ressource déjà créée
 * (suppression d'un fichier temporaire chez le fournisseur). Refuser le
 * nettoyage pendant un arrêt d'urgence laisserait des documents
 * d'utilisateurs chez le fournisseur jusqu'à leur expiration (48 h).
 */
export async function legacyGeminiKeyForCleanup(): Promise<string | null> {
  return getProviderSecret('gemini');
}
