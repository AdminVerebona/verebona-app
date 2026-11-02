/**
 * Contrat de variables T3 LINK_AMBIGUITY / DOCUMENT_ASSET « preuves croisées »
 * — `t3-document-asset-cross-v1` (lot 105D, ticket « Rattachement rétroactif
 * après création d'un bien », §E).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * VERSIONNÉ ET RÉTROCOMPATIBLE
 *
 *   · ENTRÉE : aucun emplacement nouveau. `SUBJECT_CONTEXT` (JSON) gagne,
 *     SEULEMENT pour la relation DOCUMENT_ASSET et seulement quand la version
 *     ACTIVE du prompt T3 porte le marqueur, deux clés : `document.fileId` et
 *     `crossDocument` (contrat, identité documentaire, documents du groupe et
 *     leur rôle, preuves vérifiées par le serveur avec identifiants
 *     numériques, contradictions, relation groupe → bien). Sans marqueur : les
 *     variables sont EXACTEMENT celles d'avant (non-régression).
 *   · SORTIE : section FACULTATIVE `crossDocument` de la branche
 *     LINK_AMBIGUITY (`t3-contract.ts`) — absente pour les autres relations et
 *     pour un prompt sans le bloc ; présente, elle est VÉRIFIÉE par le serveur
 *     (`validateCrossDocumentOutput`) : preuves citées hors de celles fournies
 *     = monde fermé violé ; relation groupe → bien non établie, portée du
 *     document incertaine ou validation demandée = aucun rattachement.
 *   · Le SERVEUR reste garant : monde fermé, `hasEvidence`, seuil 0,8 et
 *     confiance « certain » INCHANGÉS ; aucune preuve croisée n'est un
 *     « contrôle serveur » d'un candidat.
 *
 * Activation : le PO colle le bloc `t3-document-asset-cross-v1` (guide
 * docs/exploitation/prompts-a-appliquer-par-le-po.md, étape 12) après la
 * qualification ; coupure d'urgence `T3_CROSS_DOCUMENT_CONTEXT_ENABLED=0`
 * (variables d'avant, sans toucher au prompt).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Marqueur exact attendu dans le prompt T3 actif. */
export const T3_DOCUMENT_ASSET_CROSS_CONTRACT = 't3-document-asset-cross-v1';

/** Opération IA de la relation DOCUMENT_ASSET. */
const LINK_AMBIGUITY_OPERATION = 't3_link_ambiguity';

/** Le texte d'un prompt T3 porte-t-il le contrat « preuves croisées » ? (pure, recherche du marqueur) */
export function promptCarriesCrossDocument(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(T3_DOCUMENT_ASSET_CROSS_CONTRACT);
}

/** Coupure d'urgence (variable Scalingo) : `0` → variables d'avant le lot 105D. */
export function crossDocumentContextEnabled(): boolean {
  return process.env.T3_CROSS_DOCUMENT_CONTEXT_ENABLED?.trim() !== '0';
}

/** Coupure d'urgence des groupes d'identité (cartes groupées, règles de groupe) : `0` → comportement d'avant le lot 105D. */
export function identityGroupsEnabled(): boolean {
  return process.env.T3_IDENTITY_GROUPS_ENABLED?.trim() !== '0';
}

/** Mémoire des décisions IA DOCUMENT_ASSET (lot 99A étendu) : `0` → rappel à chaque réexamen (comportement du lot 54A). */
export function documentAssetAiMemoryEnabled(): boolean {
  return process.env.T3_DOCUMENT_ASSET_AI_MEMORY_ENABLED?.trim() !== '0';
}

let memo: { at: number; carried: boolean } | null = null;
const MEMO_MS = 60_000;

/**
 * La version EFFECTIVE du prompt maître T3 (opération `t3_link_ambiguity`)
 * porte-t-elle le contrat ? Même résolution que la passerelle (version BO
 * active, texte de la version de configuration, sinon fichier du dépôt).
 * Mémorisée une minute. Ne lève jamais (illisible : faux, variables d'avant).
 */
export async function crossDocumentContractActive(): Promise<boolean> {
  if (!crossDocumentContextEnabled()) return false;
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.carried;
  let carried = false;
  try {
    const [{ resolveOperationConfig }, loader, { getOperation }] = await Promise.all([
      import('@/services/ai/config/config-resolver'),
      import('@/services/ai/prompts/prompt-loader'),
      import('@/services/ai/registry/operations'),
    ]);
    const op = getOperation(LINK_AMBIGUITY_OPERATION);
    const cfg = await resolveOperationConfig(LINK_AMBIGUITY_OPERATION);
    const configured = cfg.promptArchitecture === 'master' && cfg.masterPromptText?.trim() ? cfg.masterPromptText : null;
    const text = configured ?? await loader.loadMasterTemplate(op.masterPromptCode!, op.useCaseCode);
    carried = promptCarriesCrossDocument(text);
  } catch (e) {
    console.error('[t3-document-asset] version du prompt T3 illisible (contrat preuves croisées) :', (e as Error).message);
    carried = false;
  }
  memo = { at: Date.now(), carried };
  return carried;
}

/** Tests seulement. */
export function __resetCrossDocumentContractMemo(): void { memo = null; }

/**
 * Déclaration du contrat (registre de conformité 99B, guide du PO) — même
 * forme que `T3_NAMING_PERIOD_PROMPT_CONTRACT`.
 */
export const T3_DOCUMENT_ASSET_CROSS_PROMPT_CONTRACT = {
  id: T3_DOCUMENT_ASSET_CROSS_CONTRACT,
  treatment: 'T3',
  masterPromptCode: 't3_master_v1',
  operationCode: LINK_AMBIGUITY_OPERATION,
  task: 'LINK_AMBIGUITY',
  marker: T3_DOCUMENT_ASSET_CROSS_CONTRACT,
  guide: { file: 'docs/exploitation/prompts-a-appliquer-par-le-po.md', blockId: T3_DOCUMENT_ASSET_CROSS_CONTRACT, step: 12 },
  emergencyEnv: 'T3_CROSS_DOCUMENT_CONTEXT_ENABLED',
  carried: promptCarriesCrossDocument,
  /** Effet tant que le marqueur manque : variables d'avant (aucune preuve croisée transmise), règles serveur de groupe actives. */
  fallback: 'LEGACY_VARIABLES_SERVER_GROUP_RULES',
} as const;
