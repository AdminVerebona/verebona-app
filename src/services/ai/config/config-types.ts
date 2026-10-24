/**
 * Types de la configuration IA versionnée — CDC BO IA §2.1, §4.1, §7.
 *
 * Miroir des tables de la migration 0131. Les champs administrables sont ceux
 * arrêtés dans « BO IA — champs administrables par traitement » ; tout ce qui
 * n'y figure pas reste dans le code, et le §2.1 dit pourquoi pour chacun.
 */
import type { Treatment } from './treatments';
import type { AiEnvironment } from './environment';
import type { ConfigVersionStatus } from './version-state-machine';
import type { OperationProfiles } from './operation-profiles';

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

/**
 * Architecture des prompts d'un traitement — CDC 15 §29 étape 14, §29.1, D-04.
 *
 *   · `master` : prompt maître unique, branches TASK imposées par le serveur,
 *     texte dans `masterPrompt` (D-03) ; vide, le fichier `tN_master_vK.txt`
 *     du dépôt s'applique (valeur initiale) ;
 *   · `steps` : étapes historiques — RETIRÉES pour tous les traitements au
 *     lot 16b (migrations 0231 à 0234). La valeur n'existe plus que comme
 *     donnée héritée (colonne `prompt_architecture`, package ancien, client
 *     ancien) : elle est refusée à l'enregistrement et à la promotion,
 *     ramenée à `master` à l'import, et AUCUNE lecture n'en dépend
 *     (`promptArchitectureOf` rend toujours `master`).
 */
export const PROMPT_ARCHITECTURES = ['steps', 'master'] as const;
export type PromptArchitecture = (typeof PROMPT_ARCHITECTURES)[number];
export const DEFAULT_PROMPT_ARCHITECTURE: PromptArchitecture = 'master';

export function isPromptArchitecture(v: unknown): v is PromptArchitecture {
  return typeof v === 'string' && (PROMPT_ARCHITECTURES as readonly string[]).includes(v);
}

/** Architecture par défaut d'un traitement : `master` pour tous (lot 16b). */
export function defaultPromptArchitectureFor(_treatment: Treatment): PromptArchitecture {
  return DEFAULT_PROMPT_ARCHITECTURE;
}

/**
 * Architecture effective d'une entrée : TOUJOURS `master`, quelle que soit la
 * valeur stockée — l'architecture `steps` est retirée pour tous les
 * traitements (lot 16b). Signature conservée pour les appelants.
 */
export function promptArchitectureOf(
  _c?: (Pick<TreatmentConfig, 'promptArchitecture'> & { treatment?: Treatment }) | null,
): PromptArchitecture {
  return 'master';
}

/** Configuration d'un traitement au sein d'une version. */
export interface TreatmentConfig {
  treatment: Treatment;
  /**
   * Prompt administrable unique (T1-013, T3-007, T4-010).
   */
  prompt: string;
  primaryModel: string | null;
  fallback1: string | null;
  fallback2: string | null;
  reasoningPrimary: ReasoningLevel | null;
  reasoningFallback1: ReasoningLevel | null;
  reasoningFallback2: ReasoningLevel | null;
  /**
   * Plafond de sortie de RÉFÉRENCE du traitement (§2.1). Lot 85C (décision
   * 08) : un rang de repli en hérite SAUF profil d'opération propre au rang,
   * et la valeur héritée est ADAPTÉE à la limite du modèle sollicité.
   */
  maxOutputTokens: number | null;
  /**
   * Lot 85C (CDC Pilotage IA V2 P4, CFG-01, OP-03) : profils par opération et
   * par rang (raisonnement, plafond de sortie, délai) — vide : la référence du
   * traitement s'applique à toutes ses opérations. Absent (client antérieur) :
   * valeur en place conservée à l'enregistrement.
   */
  operationProfiles?: OperationProfiles;
  guardrails: GuardrailSetting[];
  /** Vide pour T2 et T6, hors file globale (GEN-004). */
  triggers: TriggerSetting[];
  /** T2 uniquement. `null` = non configuré, le code décide (§11.2). */
  cascade: CascadeThresholds | null;
  /**
   * CDC 15 D-04 : architecture des prompts du traitement — valeur DEMANDÉE ou
   * stockée (héritage). Toujours lue par `promptArchitectureOf` (= `master`).
   */
  promptArchitecture?: PromptArchitecture;
  /**
   * CDC 15 D-03 : texte COMPLET du prompt maître du traitement (colonne
   * `master_prompt`, 0220). `null`/vide : fichier du dépôt. Lu par les
   * opérations master. Toujours `null`
   * pour un traitement sans master.
   */
  masterPrompt?: string | null;
}

/** Texte master renseigné d'une entrée, sinon `null`. */
export function masterPromptOf(c: Pick<TreatmentConfig, 'masterPrompt'> | null | undefined): string | null {
  const t = c?.masterPrompt;
  return typeof t === 'string' && t.trim() !== '' ? t : null;
}

/**
 * Version globale : un instantané des traitements (GEN-002). Lot 54 : active
 * ou non active, numérotée dès sa création, modifiable, historisée par
 * révisions (`ai_config_revisions`).
 */
export interface ConfigVersion {
  id: number;
  uid: string;
  environment: AiEnvironment;
  /** `ACTIVE` ou non active (anciennes valeurs lues comme non active). */
  status: ConfigVersionStatus;
  /** Lot 54 : `status === 'ACTIVE'`. */
  active: boolean;
  /** vN, attribué à la création depuis le lot 54 (avant : à la validation). */
  visibleNumber: number | null;
  label: string | null;
  description: string | null;
  baseVersionId: number | null;
  /** Hérité (lot 54 : toujours faux, plus de brouillon obsolète). */
  isStale: boolean;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date | null;
  updatedBy: number | null;
  validatedAt: Date | null;
  activatedAt: Date | null;
  archivedAt: Date | null;
  /** Suppression logique (lot 54). */
  deletedAt: Date | null;
  /** Révision courante (dernier état enregistré). `null` : pas encore reprise. */
  currentRevisionId: number | null;
  currentRevisionNumber: number | null;
  /** Statut d'origine avant le lot 54 (information). */
  legacyStatus: string | null;
}

export interface ConfigVersionWithEntries extends ConfigVersion {
  /** Lignes des traitements OPÉRATIONNELS (T1, T2, T3, T4, T6). */
  entries: TreatmentConfig[];
  /**
   * Lot 54 : prompts maîtres figés dans la révision courante (référence et
   * texte), par traitement. Absent : la version ne pilote pas ce prompt.
   */
  masterPrompts?: import('./config-snapshot').ConfigSnapshot['masterPrompts'];
  /**
   * Lot 49 (ticket 12) : traitements RETIRÉS encore présents dans cette
   * version historique (ex. `['T5']`). Conservés en base pour l'audit,
   * jamais appliqués, jamais recopiés, jamais restaurés.
   */
  retiredTreatments?: string[];
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
  | 'cascade'
  | 'promptArchitecture'
  | 'masterPrompt'
  | 'operationProfiles';

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
  promptArchitecture: 'Architecture des prompts',
  masterPrompt: 'Prompt maître',
  operationProfiles: 'Profil d’opération',
};

/** Configuration vide d'un traitement — base d'une première version. */
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
    promptArchitecture: defaultPromptArchitectureFor(treatment),
    masterPrompt: null,
    operationProfiles: {},
  };
}
