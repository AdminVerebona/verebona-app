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
}
