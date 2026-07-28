/**
 * Champs exclus de tout traitement par un modèle — CDC Assistant §16.2 et §29.4.
 *
 * « Ne jamais transmettre à Gemini les coordonnées bancaires. »
 * « Données sensibles masquées ou exclues par défaut. »
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ARTICULATION AVEC LA DÉCISION MÉTIER DU 28/07/2026
 *
 * Le responsable métier a demandé que l'IBAN lu dans un document soit stocké,
 * porté sur la fiche, mis à jour lorsqu'un document plus récent en indique un
 * autre, et envoyé en arbitrage en cas de doute.
 *
 * Ces deux exigences sont conciliables, à condition de distinguer deux moments :
 *
 *   • EXTRACTION (usage 1) — le document est transmis au modèle et l'IBAN
 *     figure dans la sortie. C'est le fonctionnement actuel, et c'est ce que
 *     la décision métier demande de conserver.
 *
 *   • RÉUTILISATION (usages 2 et 3) — la valeur, une fois stockée, n'est plus
 *     JAMAIS renvoyée à un modèle : ni dans un arbitrage ciblé, ni dans le
 *     contexte de l'assistant. Un doute sur un IBAN produit donc toujours un
 *     arbitrage utilisateur, jamais un appel modèle.
 *
 * C'est le seul montage qui satisfasse la demande métier sans contrevenir à
 * l'interdiction du CDC Assistant.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Champs dont la valeur ne doit jamais être renvoyée à un modèle. */
export const AI_EXCLUDED_FIELDS = new Set<string>([
  'iban', 'bic', 'accountNumber', 'bankAccount', 'cardNumber',
  'socialSecurityNumber', 'nir', 'idDocumentNumber',
]);

export function isAiExcludedField(fieldKey: string): boolean {
  if (AI_EXCLUDED_FIELDS.has(fieldKey)) return true;
  // Filet de sécurité sur les variantes de nommage : mieux vaut exclure un
  // champ anodin que laisser passer une coordonnée bancaire.
  return /iban|bic|bank|rib|card_?number|social_?security/i.test(fieldKey);
}

/**
 * Un champ exclu peut-il faire l'objet d'un arbitrage par modèle ?
 * Réponse invariablement non : la contradiction part en arbitrage utilisateur.
 */
export function canRequestAiReview(fieldKey: string): boolean {
  return !isAiExcludedField(fieldKey);
}
