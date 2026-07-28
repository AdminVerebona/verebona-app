/**
 * Contrat fournisseur — CDC §5.2 (« future substitution du fournisseur »).
 *
 * Toute la connaissance d'un fournisseur donné est confinée derrière ce port.
 * Changer de fournisseur ne doit impliquer aucune modification métier.
 */
import type { AiAttachment } from '../types';

export interface ProviderCallInput {
  model: string;
  /** Prompt déjà résolu (variables substituées et masquées). */
  prompt: string;
  attachments: AiAttachment[];
  timeoutMs: number;
}

export interface ProviderCallOutput {
  rawText: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  readonly name: string;
  /** true si les identifiants d'accès sont configurés. */
  isConfigured(): boolean;
  call(input: ProviderCallInput): Promise<ProviderCallOutput>;
}
