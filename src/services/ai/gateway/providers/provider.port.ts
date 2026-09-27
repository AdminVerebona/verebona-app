/**
 * Contrat fournisseur — CDC §5.2 (« future substitution du fournisseur »).
 *
 * Toute la connaissance d'un fournisseur donné est confinée derrière ce port.
 * Changer de fournisseur ne doit impliquer aucune modification métier.
 */
import type { AiAttachment } from '../types';
import type { ReasoningLevel } from '../../config/config-types';

export interface ProviderCallInput {
  model: string;
  /** Prompt déjà résolu (variables substituées et masquées). */
  prompt: string;
  attachments: AiAttachment[];
  timeoutMs: number;
  /**
   * Plafond de jetons de sortie (CDC BO IA §2.1), administrable par version.
   *
   * `undefined` laisse le fournisseur appliquer son propre défaut. Ne jamais
   * traduire une absence par un plafond arbitraire : une réponse tronquée est
   * invalide, et le §5.3 interdit de persister une sortie qui ne respecte pas
   * son schéma — une troncature transformerait donc un réglage en panne.
   */
  maxOutputTokens?: number;
  /**
   * Niveau de raisonnement administré pour le rang sollicité (T1-UI-06,
   * T2-UI-03, T3-UI-03, T4-UI-03). `null`/absent = défaut du modèle. Chaque
   * adaptateur le projette sur le réglage de son fournisseur.
   */
  reasoning?: ReasoningLevel | null;
  /**
   * Réponse contrainte au JSON par le fournisseur (mode JSON natif). Absent ou
   * false : texte libre, le JSON éventuel est extrait par le validateur.
   */
  jsonResponse?: boolean;
  /**
   * Pièces jointes préparées UNE fois pour toute la chaîne de modèles d'une
   * exécution (`openAttachmentSession`). Absent : l'adaptateur prépare et
   * nettoie lui-même, à chaque appel.
   */
  attachmentSession?: AttachmentSession;
}

/**
 * Préparation des pièces jointes partagée par les tentatives d'une même
 * exécution de la passerelle (principal puis replis). Sans elle, chaque repli
 * retéléchargeait et renvoyait chaque fichier à la Files API — jusqu'à quatre
 * fois pour l'analyse documentaire, attente de l'état ACTIVE comprise, ce qui
 * pouvait consommer à lui seul le délai global de 15 min d'un job T1.
 */
export interface AttachmentSession {
  /** Libère les ressources temporaires (fichiers Files API). Idempotent. */
  release(): Promise<void>;
}

export interface ProviderCallOutput {
  rawText: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  readonly name: string;
  /**
   * true si les identifiants d'accès sont configurés.
   *
   * Peut être asynchrone : la clé administrée depuis le BO est lue en base
   * (PROV-UI-05, WF-21). Les appelants l'attendent (`await`).
   */
  isConfigured(): boolean | Promise<boolean>;
  call(input: ProviderCallInput): Promise<ProviderCallOutput>;
  /**
   * Ouvre une préparation partagée pour `attachments` (facultatif). La
   * passerelle la transmet à chaque tentative puis la libère en fin de chaîne.
   */
  openAttachmentSession?(attachments: AiAttachment[]): AttachmentSession;
}
