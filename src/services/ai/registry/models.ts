/**
 * Registre Verebona des modèles — EXCEPTIONS seulement (lot 35B, ticket
 * « Catalogue IA dynamique Google ») ; historique : CDC Assistant §15.12,
 * §15.13, §15.14, §32.6, lots 23 et 32B.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE N'EST PLUS UNE ALLOWLIST
 *
 * Jusqu'au lot 34, un modèle absent de ce fichier était refusé (UNKNOWN_MODEL),
 * assimilé à un preview, et sa compatibilité T1–T6 devait être déclarée ici à
 * la main : un nouveau modèle Google exigeait un commit et une mise en
 * production. Désormais :
 *
 *   modèle listé par Google avec la clé active
 *   + qualification technique automatique réussie (`model-qualification`)
 *   + aucune exclusion explicite ci-dessous
 *   = modèle utilisable (`usable-models.ts`).
 *
 * Ce fichier ne porte plus que des EXCEPTIONS Verebona documentées :
 *   · modèle explicitement interdit (`forbidden`) ;
 *   · anomalie connue (`anomaly`, signalée) ou dépréciation constatée
 *     (`status: 'deprecated'`, `retiresOn`) ;
 *   · modèle de rollback recommandé (`rollbackModel`) ;
 *   · exception de compatibilité documentée (`excludedPrompts` : raison
 *     technique, ex. latence incompatible avec le délai de la mascotte T6).
 *
 * `capabilities` est la QUALIFICATION HISTORIQUE (manuelle) des modèles déjà
 * exploités : elle ne sert que tant qu'aucune qualification automatique
 * n'existe pour ce modèle avec la clé active (transition au déploiement —
 * aucun sélecteur ne se vide le temps de la première synchronisation). Un
 * résultat automatique la remplace toujours, y compris en échec.
 *
 * Le statut preview n'est plus deviné « inconnu = preview » : il vient du
 * fournisseur (`model-lifecycle.ts`) et n'est qu'INFORMATIF.
 *
 * Les PRIX ne sont pas ici : catalogue tarifaire synchronisé (§15.9,
 * `pricing/pricing-sync.service.ts`, `ai_model_price_status`).
 *
 * Module PUR (aucun accès base).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Version du registre (tracée avec les contrôles de démarrage). */
export const DECLARED_MODELS_VERSION = 'declared-models-v2.0-exceptions' as const;

/** Statut d'un modèle : déclaré ici (exception) ou statut fournisseur. */
export type ModelLifecycleStatus = 'stable' | 'preview' | 'experimental' | 'deprecated';

export const MODEL_STATUS_LABELS: Readonly<Record<ModelLifecycleStatus | 'unknown', string>> = {
  stable: 'Stable',
  preview: 'Preview',
  experimental: 'Expérimental (non sélectionnable)',
  deprecated: 'Déprécié',
  unknown: 'Statut non communiqué',
};

export type ModelCapability = 'structured_output' | 'multimodal' | 'thinking';

export interface DeclaredModel {
  provider: 'gemini';
  model: string;
  status: 'stable' | 'preview' | 'deprecated';
  /** Date d'activation dans Verebona (AAAA-MM-JJ) ; `null` : jamais activé. */
  activatedOn: string | null;
  /** Date de fin annoncée par le fournisseur (AAAA-MM-JJ). */
  retiresOn: string | null;
  /**
   * Qualification HISTORIQUE (manuelle, lots 23 à 32B) : utilisée seulement en
   * l'absence de qualification automatique avec la clé active.
   */
  capabilities: readonly ModelCapability[];
  /** Fenêtre de contexte (tokens d'entrée) ; `null` : liste du fournisseur. */
  contextWindowTokens: number | null;
  /** Sortie maximale du modèle (tokens) ; `null` : liste du fournisseur. */
  maxOutputTokens: number | null;
  /** Limites de débit du palier contractuel ; `null` : non déclarées. */
  rateLimits: { requestsPerMinute: number | null; tokensPerMinute: number | null };
  /** Exception de compatibilité documentée : prompts maîtres exclus et raison. */
  excludedPrompts?: { prompts: readonly string[]; reason: string };
  /** Modèle explicitement interdit par Verebona. */
  forbidden?: { reason: string };
  /** Anomalie connue (signalée, non bloquante). */
  anomaly?: string;
  /** Modèle de retour arrière recommandé (stable, déclaré ici). */
  rollbackModel: string | null;
  note?: string;
}

const T6 = 't6_master_v1';
const NON_DECLARE = { requestsPerMinute: null, tokensPerMinute: null } as const;
const STRUCT_MULTI = ['structured_output', 'multimodal'] as const;
const STRUCT_MULTI_THINK = ['structured_output', 'multimodal', 'thinking'] as const;
/**
 * Modèles à latence de raisonnement longue : non validés pour la mascotte
 * (T6, délai de 8 s, `t6_formulate`) — raison technique propre à ces
 * modèles, pas à leur nom. Seule exception de compatibilité conservée.
 */
const LATENCE_T6 = {
  prompts: [T6],
  reason: 'latence de raisonnement incompatible avec le délai de 8 s de la mascotte (T6)',
} as const;

export const DECLARED_MODELS: readonly DeclaredModel[] = [
  {
    provider: 'gemini', model: 'gemini-3.5-flash-lite', status: 'stable',
    // Alias assistant-default depuis le constat de préproduction du 18/09/2026.
    activatedOn: '2026-09-18', retiresOn: null, capabilities: STRUCT_MULTI,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    rollbackModel: 'gemini-3.1-flash-lite',
  },
  {
    provider: 'gemini', model: 'gemini-3.1-flash-lite', status: 'stable',
    // Alias assistant-escalation (CDC Assistant du 16/07/2026) et principal T1/T3/T4.
    activatedOn: '2026-07-16', retiresOn: null, capabilities: STRUCT_MULTI,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    rollbackModel: 'gemini-3.5-flash-lite',
  },
  {
    provider: 'gemini', model: 'gemini-3.5-flash', status: 'stable',
    // Premier repli de l'analyse documentaire (référentiel des opérations).
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    rollbackModel: 'gemini-3.1-flash-lite',
    note: 'Remplacé par gemini-3.6-flash au catalogue tarifaire.',
  },
  {
    provider: 'gemini', model: 'gemini-3.6-flash', status: 'stable',
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    rollbackModel: 'gemini-3.5-flash',
  },
  {
    provider: 'gemini', model: 'gemini-2.5-flash', status: 'stable',
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: 1_048_576, maxOutputTokens: 65_536, rateLimits: NON_DECLARE,
    rollbackModel: 'gemini-3.1-flash-lite',
  },
  {
    provider: 'gemini', model: 'gemini-2.5-pro', status: 'deprecated',
    // Principal du code de la gouvernance (T5) et second repli documentaire.
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: 1_048_576, maxOutputTokens: 65_536, rateLimits: NON_DECLARE,
    excludedPrompts: LATENCE_T6, rollbackModel: 'gemini-3.5-flash',
    anomaly: 'Accès limité aux comptes existants (404 « no longer available to new users » sur les clés récentes).',
    note: 'Déprécié : non sélectionnable pour une nouvelle configuration. Aucune date d’arrêt annoncée par la page officielle des dépréciations.',
  },
  {
    provider: 'gemini', model: 'gemini-2.5-flash-lite', status: 'deprecated',
    activatedOn: '2026-07-16', retiresOn: '2026-10-16', capabilities: STRUCT_MULTI,
    contextWindowTokens: 1_048_576, maxOutputTokens: 65_536, rateLimits: NON_DECLARE,
    rollbackModel: 'gemini-3.5-flash-lite',
    anomaly: 'Indisponible aux comptes récents depuis le 18/09/2026.',
  },
  {
    provider: 'gemini', model: 'gemini-3-flash-preview', status: 'preview',
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    rollbackModel: 'gemini-3.5-flash',
  },
  {
    provider: 'gemini', model: 'gemini-3.1-pro-preview', status: 'preview',
    activatedOn: null, retiresOn: null, capabilities: STRUCT_MULTI_THINK,
    contextWindowTokens: null, maxOutputTokens: null, rateLimits: NON_DECLARE,
    excludedPrompts: LATENCE_T6, rollbackModel: 'gemini-3.6-flash',
  },
];

const PAR_MODELE = new Map(DECLARED_MODELS.map((m) => [m.model, m]));

export function findDeclaredModel(model: string | null | undefined): DeclaredModel | undefined {
  return typeof model === 'string' ? PAR_MODELE.get(model) : undefined;
}

/** Statut DÉCLARÉ (exception) ; `unknown` pour un modèle sans exception. */
export function declaredModelStatus(model: string | null | undefined): DeclaredModel['status'] | 'unknown' {
  return findDeclaredModel(model)?.status ?? 'unknown';
}

/**
 * Modèle preview — INFORMATIF (lot 35B : plus aucune condition d'usage n'en
 * dépend). Statut déclaré, sinon statut fournisseur (`model-lifecycle.ts`).
 * Un modèle sans exception déclarée n'est plus « traité comme preview ».
 */
export function isPreviewModel(model: string | null | undefined, providerStatus?: ModelLifecycleStatus | null): boolean {
  if (typeof model !== 'string' || model.trim() === '') return false;
  const d = findDeclaredModel(model);
  if (d) return d.status === 'preview';
  return providerStatus === 'preview';
}

/** Raison d'exclusion documentée d'un modèle pour un prompt maître, sinon `null`. */
export function documentedExclusion(model: string, promptCode: string | null | undefined): string | null {
  const d = findDeclaredModel(model);
  if (!d?.excludedPrompts || !promptCode) return null;
  return d.excludedPrompts.prompts.includes(promptCode) ? d.excludedPrompts.reason : null;
}

// ── Cohérence (§15.14) ──────────────────────────────────────────────────────

export interface ModelUse {
  /** Traitement ou opération (libellé des messages). */
  where: string;
  model: string;
  /** Prompt maître de l'usage (absent : pas de contrôle d'exclusion). */
  promptCode?: string | null;
}

export interface CoherenceIssue {
  /** `error` : bloquant ; `warning` : signalé. */
  level: 'error' | 'warning';
  code: 'MODEL_FORBIDDEN' | 'MODEL_EXCLUDED' | 'MODEL_ANOMALY' | 'ROLLBACK_MISSING' | 'ROLLBACK_UNKNOWN' | 'ROLLBACK_NOT_STABLE' | 'MODEL_DEPRECATED';
  where: string;
  model: string;
  message: string;
}

/**
 * Contrôle de cohérence d'un ensemble d'usages avec les EXCEPTIONS Verebona
 * (pur). Un modèle sans exception déclarée n'est JAMAIS une incohérence
 * (lot 35B) : sa disponibilité et ses capacités sont établies par le
 * catalogue et la qualification automatique (`usable-models.ts`).
 *   · modèle interdit → erreur ;
 *   · exclusion documentée pour le prompt maître de l'usage → erreur ;
 *   · rollback déclaré absent du registre ou non stable → erreur ;
 *   · déprécié, anomalie connue → avertissement.
 */
export function checkModelUses(uses: readonly ModelUse[], today: string = new Date().toISOString().slice(0, 10)): CoherenceIssue[] {
  const out: CoherenceIssue[] = [];
  const vus = new Set<string>();
  for (const u of uses) {
    const cle = `${u.where}|${u.model}|${u.promptCode ?? ''}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    const d = findDeclaredModel(u.model);
    if (!d) continue;
    if (d.forbidden) {
      out.push({ level: 'error', code: 'MODEL_FORBIDDEN', where: u.where, model: u.model,
        message: `${u.where} : le modèle « ${u.model} » est interdit par Verebona (${d.forbidden.reason}).` });
    }
    const exclusion = documentedExclusion(u.model, u.promptCode);
    if (exclusion) {
      out.push({ level: 'error', code: 'MODEL_EXCLUDED', where: u.where, model: u.model,
        message: `${u.where} : le modèle « ${u.model} » est exclu pour le prompt « ${u.promptCode} » (${exclusion}).` });
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
    if (d.anomaly) {
      out.push({ level: 'warning', code: 'MODEL_ANOMALY', where: u.where, model: u.model,
        message: `${u.where} : anomalie connue sur « ${u.model} » — ${d.anomaly}` });
    }
  }
  return out;
}

/** Message unique et lisible des erreurs bloquantes. */
export function coherenceMessage(issues: readonly CoherenceIssue[]): string {
  return issues.filter((i) => i.level === 'error').map((i) => i.message).join(' ');
}
