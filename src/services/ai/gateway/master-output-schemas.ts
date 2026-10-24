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
  T3DocumentNamingOutput, T3LinkAmbiguityOutput, T3MasterOutput, T3OperationMatchOutput, T3ValueConflictOutput,
} from '../reconciliation/master/t3-contract';
import { T3KnowledgeQueryOutput } from '../reconciliation/knowledge-query/contract';
import {
  T4ClassifyEventOutput, T4ClassifyEventV2Output, T4ClassifyEventV3Output, T4MasterOutput, T4TemporalAmbiguityOutput, T4VerifyCompletionOutput,
} from '../agenda/master/t4-contract';
import {
  T2AnswerOutput, T2MasterOutput, T2RevalidateOutput, T2UnderstandOutput,
} from '../assistant/master/t2-contract';
import { T6EvaluateOutput, T6FormulateOutput } from '@/services/home/mascot/t6-contract';

export const MASTER_OUTPUT_SCHEMAS: Readonly<Record<string, ZodType>> = {
  T1GroupUploadOutput,
  T1AnalyzeDocumentOutput,
  T1MasterOutput,
  T3ValueConflictOutput,
  T3LinkAmbiguityOutput,
  T3OperationMatchOutput,
  // Lot 61 : harmonisation du nommage documentaire (branche facultative).
  T3DocumentNamingOutput,
  // Lot 85F : compréhension de la connaissance T1 persistée (branche facultative, texte attendu de l'équipe IA).
  T3KnowledgeQueryOutput,
  T3MasterOutput,
  T4ClassifyEventOutput,
  // Lot 54 : contrat de sortie `t4_output_v2` de CLASSIFY_EVENT (décision Agenda + récurrence).
  T4ClassifyEventV2Output,
  // Lot 61 : contrat `t4_output_v3` (v2 + évaluation d'une intervention « À traiter »).
  T4ClassifyEventV3Output,
  T4VerifyCompletionOutput,
  T4TemporalAmbiguityOutput,
  T4MasterOutput,
  T2UnderstandOutput,
  T2AnswerOutput,
  T2RevalidateOutput,
  T2MasterOutput,
  // T6 (§28) : pas de discriminant de sortie, `schemaVersion` strict (t6-output-v2).
  T6FormulateOutput,
  // Lot 61 (MODE=EVALUATE) : `schemaVersion` t6-evaluation-v1 strict.
  T6EvaluateOutput,
};

export function masterOutputSchemaFor(name: string): ZodType | null {
  return MASTER_OUTPUT_SCHEMAS[name] ?? null;
}
