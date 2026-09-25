/**
 * Types de la configuration IA versionnée — CDC BO IA §2.1, §4.1, §7.
 *
 * Miroir des tables de la migration 0131. Les champs administrables sont ceux
 * arrêtés dans « BO IA — champs administrables par traitement » ; tout ce qui
 * n'y figure pas reste dans le code, et le §2.1 dit pourquoi pour chacun.
 */
import { isPromptAdministrable, type Treatment } from './treatments';
import type { AiEnvironment } from './environment';
import type { ConfigVersionStatus } from './version-state-machine';

/**
 * Niveau de raisonnement demandé au modèle.
 *
 * Énumération fermée : c'est un réglage fonctionnel, pas un nombre libre. Une
 * valeur hors liste serait transmise telle quelle au fournisseur, qui la
 * refuserait au moment de l'appel — donc en production, et pas à la validation.
 */
export const REASONING_LEVELS = ['minimal', 'standard', 'étendu'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Réaction d'un garde-fou lorsque son seuil est franchi (SCR-02). */
export const GUARDRAIL_REACTIONS = ['alerte', 'suspension'] as const;
export type GuardrailReaction = (typeof GUARDRAIL_REACTIONS)[number];

export interface GuardrailSetting {
  /** Code du catalogue fermé. L'administrateur choisit, il n'invente pas. */
  code: string;
  threshold: number;
  reaction: GuardrailReaction;
}

/** Déclencheur d'un traitement batch (§15.1). */
export interface TriggerSetting {
  /** Événement du catalogue *code-defined* (T3-005), ou planification. */
  kind: 'event' | 'schedule';
  code: string;
  active: boolean;
}

/**
 * Seuils de la cascade coût/qualité — T2 uniquement (§11.2).
 *
 * Chaque seuil est la confiance À PARTIR DE LAQUELLE le niveau est jugé
 * suffisant : en deçà, on monte d'un cran. Les deux extrêmes sont significatifs
 * et légitimes, c'est pourquoi ils ne sont pas interdits :
 *   · 0 — ce niveau suffit toujours, on n'escalade jamais au-delà ;
 *   · 1 — ce niveau ne suffit jamais, on escalade systématiquement.
 *
 * Un seuil de 1 sur les trois niveaux revient à envoyer chaque question au
 * modèle : c'est coûteux, ce n'est pas une erreur, et la validation le signale
 * sans le refuser.
 */
export interface CascadeThresholds {
  /** Niveau 1 — base structurée, filtres, agrégations. Coût nul. */
  database: number;
  /** Niveau 2 — recherche textuelle, plein texte, métadonnées. Coût nul. */
  text: number;
  /** Niveau 3 — recherche sémantique. Coût faible. */
  semantic: number;
  /**
   * Le niveau sémantique est-il disponible ?
   *
   * Il est aujourd'hui désactivé dans le code. Le drapeau permet de l'ouvrir
   * sans redéploiement le jour où il l'est — et de le refermer aussitôt s'il
   * déçoit, ce qu'un déploiement rendrait bien plus lent.
   */
  semanticEnabled: boolean;
}

/** Configuration d'un traitement au sein d'une version. */
export interface TreatmentConfig {
  treatment: Treatment;
  /**
   * Prompt administrable unique (T1-013, T3-007, T4-010).
   * Toujours vide pour T5, dont le comportement est dans le code (T5-003).
   */
  prompt: string;
  primaryModel: string | null;
  fallback1: string | null;
  fallback2: string | null;
  reasoningPrimary: ReasoningLevel | null;
  reasoningFallback1: ReasoningLevel | null;
  reasoningFallback2: ReasoningLevel | null;
  /** §2.1 — modèle principal uniquement ; les fallbacks héritent. */
  maxOutputTokens: number | null;
  guardrails: GuardrailSetting[];
  /** Vide pour T2 et T5, hors file globale (GEN-004). */
  triggers: TriggerSetting[];
  /** T2 uniquement. `null` = non configuré, le code décide (§11.2). */
  cascade: CascadeThresholds | null;
}

/** Version globale : un instantané des cinq traitements (GEN-002). */
export interface ConfigVersion {
  id: number;
  uid: string;
  environment: AiEnvironment;
  status: ConfigVersionStatus;
  /** vN, attribué à la validation seulement (VER-006). */
  visibleNumber: number | null;
  label: string | null;
  baseVersionId: number | null;
  /** Attribut, pas statut (§4.1) : un Brouillon obsolète reste un Brouillon. */
  isStale: boolean;
  createdBy: number | null;
  createdAt: Date;
  validatedAt: Date | null;
  activatedAt: Date | null;
  archivedAt: Date | null;
}

export interface ConfigVersionWithEntries extends ConfigVersion {
  entries: TreatmentConfig[];
}

/** Champ de configuration, pour le diff et les erreurs de validation. */
export type ConfigFieldKey =
  | 'prompt'
  | 'primaryModel'
  | 'fallback1'
  | 'fallback2'
  | 'reasoningPrimary'
  | 'reasoningFallback1'
  | 'reasoningFallback2'
  | 'maxOutputTokens'
  | 'guardrails'
  | 'triggers'
  | 'cascade';

/** Libellés lisibles, pour les écrans et les messages d'erreur. */
export const FIELD_LABELS: Readonly<Record<ConfigFieldKey, string>> = {
  prompt: 'Prompt',
  primaryModel: 'Modèle principal',
  fallback1: 'Fallback 1',
  fallback2: 'Fallback 2',
  reasoningPrimary: 'Niveau de raisonnement — principal',
  reasoningFallback1: 'Niveau de raisonnement — fallback 1',
  reasoningFallback2: 'Niveau de raisonnement — fallback 2',
  maxOutputTokens: 'Max output tokens',
  guardrails: 'Garde-fous',
  triggers: 'Déclencheurs',
  cascade: 'Cascade coût/qualité',
};

/** Configuration vide d'un traitement — base d'un premier Brouillon. */
/**
 * Retire d'une configuration ce que le BO n'a pas le droit de porter.
 *
 * Aujourd'hui : le prompt de T5, qui n'est pas administrable (T5-003, E-02).
 * Appliquée à toute écriture en base et à la préparation d'un package, pour
 * qu'un prompt T5 hérité d'une ancienne version ne se propage pas.
 */
export function normalizeTreatmentConfig<C extends Pick<TreatmentConfig, 'treatment' | 'prompt'>>(c: C): C {
  return isPromptAdministrable(c.treatment) ? c : { ...c, prompt: '' };
}

export function emptyTreatmentConfig(treatment: Treatment): TreatmentConfig {
  return {
    treatment,
    prompt: '',
    primaryModel: null,
    fallback1: null,
    fallback2: null,
    reasoningPrimary: null,
    reasoningFallback1: null,
    reasoningFallback2: null,
    maxOutputTokens: null,
    guardrails: [],
    triggers: [],
    cascade: null,
  };
}
