/**
 * Feature flags de l'assistant — CDC §39, CA-30.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES FLAGS DU §39 ÉTAIENT DÉCLARÉS, JAMAIS LUS
 *
 * Seuls `VEREBONA_ASSISTANT_ENABLED` et `AI_INTELLIGENT_ASSISTANT` (retiré au
 * lot 16b-2) agissaient ;
 * `product_help`, `account_ai`, `fallback_model`, `sources` et
 * `semantic_retrieval` n'étaient lus nulle part. Chacun est désormais lu À
 * CHAQUE DEMANDE (aucun cache) et produit l'effet de rollback du §39 :
 *
 *   flag (§39)                          variable                                 défaut  effet quand coupé
 *   verebona_assistant_enabled          VEREBONA_ASSISTANT_ENABLED               on      assistant indisponible (503)
 *   verebona_assistant_product_help     VEREBONA_ASSISTANT_PRODUCT_HELP          on      pas de réponse d'aide ; renvoi au Centre d'aide
 *   verebona_assistant_account_ai       VEREBONA_ASSISTANT_ACCOUNT_AI            on      aucun appel modèle (classification, revalidation,
 *                                       (+ VEREBONA_ASSISTANT_AI_ENABLED)                 génération) ; recherche classique et aide conservées
 *   verebona_assistant_fallback_model   VEREBONA_ASSISTANT_FALLBACK_MODEL        on      aucune escalade vers le modèle de repli
 *                                       (+ VEREBONA_ASSISTANT_AI_FALLBACK_ENABLED)
 *   verebona_assistant_sources          VEREBONA_ASSISTANT_SOURCES               on      sources non exposées (panneau, « Voir les sources »)
 *   verebona_assistant_semantic_retrieval VEREBONA_ASSISTANT_SEMANTIC_RETRIEVAL  off     adaptateurs `semantic` exclus (§13.6)
 *
 * Hors §39 — commandes d'écriture depuis le chat (écart acté au §4.8 /
 * §22.5, décision produit : conservées) : `VEREBONA_ASSISTANT_WRITE_COMMANDS`,
 * ACTIVÉ par défaut (seuls off/false/0/no le coupent — `areWriteCommandsEnabled`
 * dans `assistant-config.ts`). Pour une V1 strictement conforme au CDC,
 * positionner `VEREBONA_ASSISTANT_WRITE_COMMANDS=off` en production. En
 * lecture seule (fin d'essai, §6.5), aucune commande n'est préparée.
 *
 * Modification : dans le BO (Configuration IA › Assistant — D-J1, lot 21),
 * sans redémarrage, toutes instances ; la variable d'environnement reste la
 * valeur initiale et le repli (`assistant-settings.ts`). Historiquement : Le §39 n'impose pas de
 * modification sans redéploiement pour les flags ; il l'impose pour
 * « désactiver un modèle », ce que font l'arrêt d'urgence par traitement
 * (`ai_treatment_state`) et les versions de configuration du BO IA.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Surcharge serveur des interrupteurs (valeurs administrées dans le BO,
 * D-J1). Posée UNIQUEMENT par `assistant-flags.server.ts`.
 */
let surcharge: ((flag: AssistantFlag) => boolean | undefined) | null = null;

export function setAssistantFlagOverrideProvider(fn: ((flag: AssistantFlag) => boolean | undefined) | null): void {
  surcharge = fn;
}

export type AssistantFlag =
  | 'enabled'
  | 'product_help'
  | 'account_ai'
  | 'fallback_model'
  | 'sources'
  | 'semantic_retrieval';

/** Nom du flag au sens du §39. */
export const FLAG_NAMES: Record<AssistantFlag, string> = {
  enabled: 'verebona_assistant_enabled',
  product_help: 'verebona_assistant_product_help',
  account_ai: 'verebona_assistant_account_ai',
  fallback_model: 'verebona_assistant_fallback_model',
  sources: 'verebona_assistant_sources',
  semantic_retrieval: 'verebona_assistant_semantic_retrieval',
};

const VARIABLES: Record<AssistantFlag, { env: string[]; def: boolean }> = {
  enabled: { env: ['VEREBONA_ASSISTANT_ENABLED'], def: true },
  product_help: { env: ['VEREBONA_ASSISTANT_PRODUCT_HELP'], def: true },
  account_ai: { env: ['VEREBONA_ASSISTANT_ACCOUNT_AI', 'VEREBONA_ASSISTANT_AI_ENABLED'], def: true },
  fallback_model: { env: ['VEREBONA_ASSISTANT_FALLBACK_MODEL', 'VEREBONA_ASSISTANT_AI_FALLBACK_ENABLED'], def: true },
  sources: { env: ['VEREBONA_ASSISTANT_SOURCES'], def: true },
  semantic_retrieval: { env: ['VEREBONA_ASSISTANT_SEMANTIC_RETRIEVAL'], def: false },
};

function lire(raw: string | undefined, def: boolean): boolean {
  if (raw == null || raw.trim() === '') return def;
  const v = raw.trim().toLowerCase();
  if (['off', 'false', '0', 'no', 'disabled'].includes(v)) return false;
  if (['on', 'true', '1', 'yes', 'enabled'].includes(v)) return true;
  // Valeur inconnue : défaut du CDC (une faute de frappe ne bascule rien).
  return def;
}

/**
 * Flag actif ? Toutes les variables associées doivent l'autoriser (une
 * variable historique à `false` coupe aussi). Lu à chaque appel.
 */
export function isAssistantFlagOn(flag: AssistantFlag, env: NodeJS.ProcessEnv = process.env): boolean {
  // D-J1 (lot 21) : interrupteur administré dans le BO — prime sur
  // l'environnement, pour l'environnement réel du processus. Fournisseur
  // posé par `assistant-flags.server.ts` (serveur seulement) : ce module reste
  // PUR, importable côté client, qui garde les défauts et l'environnement.
  if (env === process.env && surcharge) {
    const o = surcharge(flag);
    if (typeof o === 'boolean') return o;
  }
  const { env: noms, def } = VARIABLES[flag];
  return noms.every((n) => lire(env[n], def));
}

/** Instantané de tous les flags (trace, administration, tests). */
export function assistantFlagsSnapshot(env: NodeJS.ProcessEnv = process.env): Record<string, boolean> {
  return Object.fromEntries(
    (Object.keys(FLAG_NAMES) as AssistantFlag[]).map((f) => [FLAG_NAMES[f], isAssistantFlagOn(f, env)]),
  );
}
