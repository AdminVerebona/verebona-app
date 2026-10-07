/**
 * Registre déclaratif des modèles — CDC Assistant §15.12, §15.13, §15.14,
 * §32.6 (« visualiser les dates de dépréciation des modèles ») ; lot 23.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI MANQUAIT
 *
 * Le registre de l'assistant ne portait que l'alias et le modèle attendu ;
 * le statut « preview » était DEVINÉ par une expression régulière sur le nom
 * (`preview`, `-exp`). Un modèle nouvellement listé par le fournisseur, au
 * nom anodin, passait pour stable ; et rien ne disait vers quel modèle
 * revenir, ni avec quels prompts maîtres un modèle avait été validé.
 *
 * Ce fichier DÉCLARE chaque modèle connu de Verebona :
 *   · statut stable / preview / déprécié (déclaré, plus déduit) ;
 *   · date d'activation dans Verebona (`null` : jamais activé) et date de fin
 *     annoncée par le fournisseur ;
 *   · capacités (sorties structurées, multimodal, raisonnement) ;
 *   · limites de contexte et de sortie, limites de débit (`null` : non
 *     déclarées ici — palier du projet fournisseur ; la liste du fournisseur,
 *     `ai_model_catalog`, complète à l'affichage) ;
 *   · prompts maîtres compatibles (les schémas suivent : ceux des opérations
 *     de ces masters) ;
 *   · modèle de rollback (stable, déclaré ici — vérifié par les tests et au
 *     démarrage).
 * Les PRIX ne sont pas ici : catalogue central versionné (§15.9,
 * `pricing/gemini-public-catalog.ts`, `ai_model_pricing`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REPLI PRUDENT : MODÈLE INCONNU = PREVIEW
 *
 * Un modèle absent de ce registre n'a été ni qualifié ni évalué : il est
 * traité comme un modèle preview (§15.12 : pas en production sans feature
 * flag et double validation, lot 21). Le recetter hors production reste
 * possible ; le déclarer ici est la seule façon d'en faire un modèle stable.
 *
 * Module PUR (aucun accès base) : lu par le BO, la passerelle, les contrôles
 * de démarrage et d'activation.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Version du registre déclaratif (tracée avec les contrôles de démarrage). */
export const DECLARED_MODELS_VERSION = 'declared-models-v1.0' as const;

export type ModelLifecycleStatus = 'stable' | 'preview' | 'deprecated';

export const MODEL_STATUS_LABELS: Readonly<Record<ModelLifecycleStatus | 'unknown', string>> = {
  stable: 'Stable',
  preview: 'Preview',
  deprecated: 'Déprécié',
  unknown: 'Inconnu (traité comme preview)',
};

export type ModelCapability = 'structured_output' | 'multimodal' | 'thinking';

export interface DeclaredModel {
  provider: 'gemini';
  model: string;
  status: ModelLifecycleStatus;
  /** Date d'activation dans Verebona (AAAA-MM-JJ) ; `null` : jamais activé. */
  activatedOn: string | null;
  /** Date de fin annoncée par le fournisseur (AAAA-MM-JJ). */
  retiresOn: string | null;
  capabilities: readonly ModelCapability[];
  /** Fenêtre de contexte (tokens d'entrée) ; `null` : liste du fournisseur. */
  contextWindowTokens: number | null;
  /** Sortie maximale du modèle (tokens) ; `null` : liste du fournisseur. */
  maxOutputTokens: number | null;
  /** Limites de débit du palier contractuel ; `null` : non déclarées. */
  rateLimits: { requestsPerMinute: number | null; tokensPerMinute: number | null };
  /** Prompts maîtres validés avec ce modèle (§15.12 « prompts et schémas compatibles »). */
  compatiblePrompts: readonly string[];
  /** Modèle de retour arrière (stable, déclaré ici). */
  rollbackModel: string | null;
  note?: string;
}

// Prompts maîtres (CDC 15 §22). Lot 32B : la compatibilité est DÉCLARÉE
// MODÈLE PAR MODÈLE, jamais déduite de la catégorie commerciale (« Flash »,
// « Pro ») — l'ancienne exclusion générale des Pro sur l'assistant (CDC
// Assistant V1, §15.6 / §31.2) n'est plus une règle active. Un modèle n'est
// sélectionnable pour un traitement que s'il déclare le prompt maître de ce
// traitement ET satisfait les autres règles (`usable-models.ts`).
const T1 = 't1_master_v1';
const T2 = 't2_master_v1';
const T3 = 't3_master_v1';
const T4 = 't4_master_v1';
const T5 = 't5_master_v1';
const T6 = 't6_master_v1';
const TOUS = [T1, T2, T3, T4, T5, T6] as const;
/**
 * Modèles à latence de raisonnement longue : non validés pour la mascotte
 * (T6, délai de 8 s, `t6_formulate`) — raison technique propre à ces
 * modèles, pas à leur nom.
 */
const SANS_MASCOTTE = [T1, T2, T3, T4, T5] as const;

const NON_DECLARE = { requestsPerMinute: null, tokensPerMinute: null } as const;
const STRUCT_MULTI = ['structured_output', 'multimodal'] as const;
const STRUCT_MULTI_THINK = ['structured_output', 'multimodal', 'thinking'] as const;

export const DECLARED_MODELS: readonly DeclaredModel[] = [
  {
    provider: 'gemini', model: 'gemini-3.5-flash-lite', status: 'stable',
    // Alias assistant-default depuis le constat de préproduction du 18/09/2026.
    activatedOn: '2026-09-18', retiresOn: null, capabilities: STRUCT_MULTI,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    compatiblePrompts: TOUS, rollbackModel: 'gemini-3.1-flash-lite',
  },
  {
    provider: 'gemini', model: 'gemini-3.1-flash-lite', status: 'stable',
    // Alias assistant-escalation (CDC Assistant du 16/07/2026) et principal T1/T3/T4.
    activatedOn: '2026-07-16', retiresOn: null, capabilities: STRUCT_MULTI,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    compatiblePrompts: TOUS, rollbackModel: 'gemini-3.5-flash-lite',
  },
  {
    provider: 'gemini', model: 'gemini-3.5-flash', status: 'stable',
    // Premier repli de l'analyse documentaire (référentiel des opérations).
    // Date d'activation non documentée : à renseigner (point ouvert lot 23).
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    compatiblePrompts: TOUS, rollbackModel: 'gemini-3.1-flash-lite',
    note: 'Remplacé par gemini-3.6-flash au catalogue tarifaire.',
  },
  {
    provider: 'gemini', model: 'gemini-3.6-flash', status: 'stable',
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    compatiblePrompts: TOUS, rollbackModel: 'gemini-3.5-flash',
  },
  {
    provider: 'gemini', model: 'gemini-2.5-flash', status: 'stable',
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: 1_048_576, maxOutputTokens: 65_536, rateLimits: NON_DECLARE,
    compatiblePrompts: TOUS, rollbackModel: 'gemini-3.1-flash-lite',
  },
  {
    provider: 'gemini', model: 'gemini-2.5-pro', status: 'deprecated',
    // Principal du code de la gouvernance (T5) et second repli documentaire. Date
    // d'activation non documentée : à renseigner (point ouvert lot 23).
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: 1_048_576, maxOutputTokens: 65_536, rateLimits: NON_DECLARE,
    // Lot 32B : compatible T2 (sorties structurées, multimodal) — mais
    // DÉPRÉCIÉ, donc jamais proposé pour une nouvelle configuration, sur
    // aucun traitement : refusé parce qu'il est déprécié, pas parce que Pro.
    compatiblePrompts: SANS_MASCOTTE, rollbackModel: 'gemini-3.5-flash',
    note: 'Déprécié : non sélectionnable pour une nouvelle configuration. Accès limité aux comptes existants (à vérifier sur la clé) ; '
      + 'aucune date d’arrêt annoncée par la page officielle des dépréciations.',
  },
  {
    provider: 'gemini', model: 'gemini-2.5-flash-lite', status: 'deprecated',
    activatedOn: '2026-07-16', retiresOn: '2026-10-16', capabilities: STRUCT_MULTI,
    contextWindowTokens: 1_048_576, maxOutputTokens: 65_536, rateLimits: NON_DECLARE,
    compatiblePrompts: TOUS, rollbackModel: 'gemini-3.5-flash-lite',
    note: 'Indisponible aux comptes récents depuis le 18/09/2026.',
  },
  {
    provider: 'gemini', model: 'gemini-3-flash-preview', status: 'preview',
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    compatiblePrompts: TOUS, rollbackModel: 'gemini-3.5-flash',
  },
  {
    provider: 'gemini', model: 'gemini-3.1-pro-preview', status: 'preview',
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    // Lot 32B : compatible T2 ; preview, donc admis seulement si la
    // politique preview effective l'autorise.
    compatiblePrompts: SANS_MASCOTTE, rollbackModel: 'gemini-3.6-flash',
    note: 'Preview : sélectionnable seulement si la politique preview l’autorise.',
  },
];

const PAR_MODELE = new Map(DECLARED_MODELS.map((m) => [m.model, m]));

export function findDeclaredModel(model: string | null | undefined): DeclaredModel | undefined {
  return typeof model === 'string' ? PAR_MODELE.get(model) : undefined;
}

/** Statut déclaré ; `unknown` pour un modèle absent du registre. */
export function declaredModelStatus(model: string | null | undefined): ModelLifecycleStatus | 'unknown' {
  return findDeclaredModel(model)?.status ?? 'unknown';
}

/**
 * Modèle à traiter comme preview (§15.12) : déclaré preview, ou INCONNU du
 * registre (repli prudent). `null`/vide : aucun modèle, donc rien à garder.
 */
export function isPreviewModel(model: string | null | undefined): boolean {
  if (typeof model !== 'string' || model.trim() === '') return false;
  const s = declaredModelStatus(model);
  return s === 'preview' || s === 'unknown';
}

// ── Cohérence (§15.14) ──────────────────────────────────────────────────────

export interface ModelUse {
  /** Traitement ou opération (libellé des messages). */
  where: string;
  model: string;
  /** Prompt maître de l'usage (absent : pas de contrôle de compatibilité). */
  promptCode?: string | null;
}

export interface CoherenceIssue {
  /** `error` : bloquant ; `warning` : signalé. */
  level: 'error' | 'warning';
  code: 'UNKNOWN_MODEL' | 'PREVIEW_NOT_ALLOWED' | 'PROMPT_INCOMPATIBLE' | 'ROLLBACK_MISSING' | 'ROLLBACK_UNKNOWN' | 'ROLLBACK_NOT_STABLE' | 'MODEL_DEPRECATED';
  where: string;
  model: string;
  message: string;
}

/**
 * Contrôle de cohérence d'un ensemble d'usages (pur) :
 *   · modèle inconnu du registre → avertissement (traité comme preview :
 *     la garde preview décide) ;
 *   · prompt maître non déclaré compatible → erreur ;
 *   · modèle de rollback absent, inconnu, ou non stable (preview, déprécié)
 *     → erreur ;
 *   · modèle déprécié → avertissement (date de fin dans le message).
 */
export function checkModelUses(uses: readonly ModelUse[], today: string = new Date().toISOString().slice(0, 10)): CoherenceIssue[] {
  const out: CoherenceIssue[] = [];
  const vus = new Set<string>();
  for (const u of uses) {
    const cle = `${u.where}|${u.model}|${u.promptCode ?? ''}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    const d = findDeclaredModel(u.model);
    if (!d) {
      out.push({ level: 'warning', code: 'UNKNOWN_MODEL', where: u.where, model: u.model,
        message: `${u.where} : modèle « ${u.model} » absent du registre des modèles — traité comme preview (§15.12).` });
      continue;
    }
    if (u.promptCode && !d.compatiblePrompts.includes(u.promptCode)) {
      out.push({ level: 'error', code: 'PROMPT_INCOMPATIBLE', where: u.where, model: u.model,
        message: `${u.where} : le modèle « ${u.model} » n’est pas déclaré compatible avec le prompt « ${u.promptCode} » `
          + `(prompts compatibles : ${d.compatiblePrompts.join(', ') || 'aucun'}).` });
    }
    if (!d.rollbackModel) {
      out.push({ level: 'error', code: 'ROLLBACK_MISSING', where: u.where, model: u.model,
        message: `${u.where} : aucun modèle de rollback déclaré pour « ${u.model} ».` });
    } else {
      const r = findDeclaredModel(d.rollbackModel);
      if (!r) {
        out.push({ level: 'error', code: 'ROLLBACK_UNKNOWN', where: u.where, model: u.model,
          message: `${u.where} : le modèle de rollback « ${d.rollbackModel} » de « ${u.model} » est absent du registre.` });
      } else if (r.status !== 'stable') {
        out.push({ level: 'error', code: 'ROLLBACK_NOT_STABLE', where: u.where, model: u.model,
          message: `${u.where} : le modèle de rollback « ${d.rollbackModel} » de « ${u.model} » n’est pas stable (${MODEL_STATUS_LABELS[r.status].toLowerCase()}).` });
      }
    }
    if (d.status === 'deprecated') {
      const passe = d.retiresOn != null && d.retiresOn <= today;
      out.push({ level: 'warning', code: 'MODEL_DEPRECATED', where: u.where, model: u.model,
        message: `${u.where} : modèle « ${u.model} » déprécié${d.retiresOn ? ` (fin ${passe ? 'atteinte le' : 'prévue le'} ${d.retiresOn})` : ''} — remplacement à tester (§15.13).` });
    }
  }
  return out;
}

/** Message unique et lisible des erreurs bloquantes. */
export function coherenceMessage(issues: readonly CoherenceIssue[]): string {
  return issues.filter((i) => i.level === 'error').map((i) => i.message).join(' ');
}
