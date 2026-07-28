/**
 * Contrat d'adaptateur de source — CDC §4.1.5.
 *
 * « Les responsabilités spécifiques doivent rester dans des adaptateurs. »
 * Un adaptateur convertit une source brute en `SourceInput` normalisé. Il ne
 * contient AUCUNE logique d'appel modèle : c'est précisément ce qui distingue
 * la cible de l'existant, où `/web-links/[id]/analyze` portait son propre
 * pipeline Gemini (défaut n°4 du CDC §2.2).
 */
import type { SourceInput, SourceType } from '../types';

export interface AdapterPrepareInput {
  sourceIds: number[];
  accountId: number;
  userId: number;
  linkedAssetId?: number | null;
}

export interface SourceAdapter {
  readonly sourceType: SourceType;
  /** Récupère et prépare le contenu, sans jamais appeler un modèle. */
  prepare(input: AdapterPrepareInput): Promise<SourceInput>;
  /** Libère les ressources temporaires créées pendant la préparation. */
  cleanup?(input: SourceInput): Promise<void>;
}
