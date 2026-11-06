/**
 * Contrat de la REVUE DU RATTACHEMENT d'un document — `t3-document-attachment-review-v1`
 * (lot 113L, ticket #711 « Rattachement documentaire — Confier à l'IA
 * l'arbitrage des indices et supprimer les faux conflits automatiques »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TRAITEMENT RESPONSABLE : T3, prompt maître `t3_master_v1`, branche
 * LINK_AMBIGUITY, opération `t3_link_ambiguity`, relation DOCUMENT_ASSET
 * (« revue du rattachement »). Aucun moteur parallèle : même passerelle,
 * même schéma de sortie, mêmes traces d'exécution que T3 DOCUMENT_ASSET.
 *
 *   · ENTRÉE : aucun emplacement nouveau. `SUBJECT_CONTEXT` porte en plus
 *     `attachmentReview` (rattachement actuel, indices du serveur avec leurs
 *     unités sources contextualisées — valeurs d'identifiant MASQUÉES —,
 *     cibles des faits) ; `RELATION_TYPE` nomme la revue.
 *   · SORTIE : section FACULTATIVE `attachmentReview` (`t3-contract.ts`) —
 *     KEEP_CURRENT / ARBITRATE / MULTIPLE, biens concernés, indices et unités
 *     cités, justification. Quand la version ACTIVE du prompt porte le
 *     marqueur, la section est OBLIGATOIRE (absente = réponse invalide :
 *     aucune carte) ; sans le marqueur, la décision est lue dans `matches` /
 *     `documentScope` (contrat historique de la branche).
 *   · Le SERVEUR reste garant : monde fermé (biens, indices, unités fournis),
 *     appartenance au compte, état actuel du document, choix utilisateur,
 *     doublons, persistance. Jamais de déplacement automatique.
 *
 * Activation : le PO colle le bloc 22 du guide
 * docs/exploitation/prompts-a-appliquer-par-le-po.md (étape 22). Le code ne
 * modifie jamais le prompt actif du BO. Coupure d'urgence :
 * `T3_ATTACHMENT_REVIEW_ENABLED=0` (aucune revue, aucune carte nouvelle ;
 * les cartes ouvertes restent telles quelles).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Marqueur exact attendu dans le prompt T3 actif. */
export const T3_ATTACHMENT_REVIEW_CONTRACT = 't3-document-attachment-review-v1';

/** Opération IA de la revue (celle de la relation DOCUMENT_ASSET). */
export const ATTACHMENT_REVIEW_OPERATION = 't3_link_ambiguity';

/** Le texte d'un prompt T3 porte-t-il le contrat de revue ? (pure, recherche du marqueur) */
export function promptCarriesAttachmentReview(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(T3_ATTACHMENT_REVIEW_CONTRACT);
}

/** Coupure d'urgence (variable Scalingo) : `0` → aucune revue (aucun appel, aucune carte nouvelle). */
export function attachmentReviewEnabled(): boolean {
  return process.env.T3_ATTACHMENT_REVIEW_ENABLED?.trim() !== '0';
}

let memo: { at: number; carried: boolean } | null = null;
const MEMO_MS = 60_000;

/**
 * La version EFFECTIVE du prompt maître T3 porte-t-elle le contrat de revue ?
 * Même résolution que la passerelle (version BO active, sinon fichier du
 * dépôt). Mémorisée une minute. Ne lève jamais (illisible : faux).
 */
export async function attachmentReviewContractActive(): Promise<boolean> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.carried;
  let carried = false;
  try {
    const [{ resolveOperationConfig }, loader, { getOperation }] = await Promise.all([
      import('@/services/ai/config/config-resolver'),
      import('@/services/ai/prompts/prompt-loader'),
      import('@/services/ai/registry/operations'),
    ]);
    const op = getOperation(ATTACHMENT_REVIEW_OPERATION);
    const cfg = await resolveOperationConfig(ATTACHMENT_REVIEW_OPERATION);
    const configured = cfg.promptArchitecture === 'master' && cfg.masterPromptText?.trim() ? cfg.masterPromptText : null;
    const text = configured ?? await loader.loadMasterTemplate(op.masterPromptCode!, op.useCaseCode);
    carried = promptCarriesAttachmentReview(text);
  } catch (e) {
    console.error('[t3-attachment-review] version du prompt T3 illisible (contrat de revue) :', (e as Error).message);
    carried = false;
  }
  memo = { at: Date.now(), carried };
  return carried;
}

/** Tests seulement. */
export function __resetAttachmentReviewContractMemo(): void { memo = null; }
