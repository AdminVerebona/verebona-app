/**
 * Schémas de sortie des opérations master, par nom — CDC 15 §22.2, §22.3.
 *
 * La gateway valide avec le schéma Zod fourni par l'appelant ; le référentiel
 * ne déclare qu'un NOM (`outputSchema`). Pour les masters, ce catalogue relie
 * le nom au schéma discriminé du contrat, afin que le contrôle de démarrage
 * (et les tests) vérifient qu'une opération master ne déclare pas un schéma
 * inexistant ou plat. Branche → schéma : `masterOutputSchemaFor`.
 */
import type { ZodType } from 'zod';
import {
  T1AnalyzeDocumentOutput, T1GroupUploadOutput, T1MasterOutput,
} from '../source-analysis/master/t1-contract';
import {
  T3LinkAmbiguityOutput, T3MasterOutput, T3ValueConflictOutput,
} from '../reconciliation/master/t3-contract';

export const MASTER_OUTPUT_SCHEMAS: Readonly<Record<string, ZodType>> = {
  T1GroupUploadOutput,
  T1AnalyzeDocumentOutput,
  T1MasterOutput,
  T3ValueConflictOutput,
  T3LinkAmbiguityOutput,
  T3MasterOutput,
};

export function masterOutputSchemaFor(name: string): ZodType | null {
  return MASTER_OUTPUT_SCHEMAS[name] ?? null;
}
