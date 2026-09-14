/**
 * Écriture du classement V2 et alimentation de « À traiter ».
 * CDC V2.0 §10.2, §11.3, §12.1, §13.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE POINT DE JONCTION DU CHANTIER
 *
 * Trois modules se rencontrent ici, et aucun ne déborde sur les autres :
 *
 *   · `decide()` tranche — sans base, sans modèle (§11.3) ;
 *   · `applyClassificationChange()` applique les règles de classement — sans
 *     base non plus (§2.2, §5.1) ;
 *   · `upsertAction()` entretient la file — sans rien décider (§7.3).
 *
 * Ce service est le seul à connaître les trois et la base. C'est délibéré :
 * une écriture directe dans `asset_files` contournerait la protection des
 * valeurs utilisateur, et l'utilisateur verrait son classement manuel défait à
 * la réanalyse suivante, sans rien pour l'expliquer.
 *
 * ── ÉCRIRE ET FERMER VONT ENSEMBLE ────────────────────────────────────────
 *
 * Quand une décision écrit une valeur, l'action qui la réclamait devient sans
 * objet et doit être fermée dans la foulée (§7.3, dernier alinéa). L'oublier
 * laisserait dans « À traiter » une carte demandant une donnée déjà
 * renseignée — le défaut le plus sûr pour faire cesser de consulter la page.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { REFERENTIAL_VERSION, type AssetFamily, type RubricCode } from '@/lib/referential/v2';
import {
  applyClassificationChange,
  type DocumentClassification,
} from '@/services/documents/rubric-classification';
import type { ActionProposal, ValueOrigin } from '@/services/to-process/action-model';
import { decide, producesAction } from '@/services/to-process/decision-engine';
import {
  resolveActionsForData,
  upsertAction,
} from '@/services/to-process/to-process-action.service';
import {
  toOptimizationOutput,
  type OptimizationOutput,
} from '@/services/to-process/optimization-contract';
import { getRubric, getDocumentType } from '@/lib/referential/v2';

export interface RubricProposalInput {
  /**
   * Code brut. Volontairement typé `string` et non `RubricCode` : cette
   * proposition vient d'un modèle, et un code hors référentiel doit être
   * REJETÉ ici, pas rendu impossible par un cast en amont qui masquerait le
   * problème sans l'empêcher.
   */
  rubricCode: string;
  documentTypeCode: string | null;
  confidence: number;
  excerpt?: string;
}

export interface ApplyV2ClassificationInput {
  fileId: number;
  accountId: number;
  /** Proposition issue de l'analyse. Absente = aucune proposition crédible. */
  proposal?: RubricProposalInput | null;
  origin: ValueOrigin;
  assetFamilies?: readonly AssetFamily[];
  promptVersion?: string | null;
  pipelineVersion: string;
  /** Identifiants des preuves ayant produit la proposition (§12.1). */
  evidenceIds?: string[];
}

/**
 * Applique une proposition de classement et rend la sortie structurée du
 * §11.5, une ligne par donnée analysée.
 */
export async function applyV2Classification(
  input: ApplyV2ClassificationInput,
): Promise<OptimizationOutput[]> {
  const [row] = await db
    .select({
      id: assetFiles.id,
      rubricCode: assetFiles.rubricCode,
      documentTypeCode: assetFiles.documentTypeCode,
      rubricOrigin: assetFiles.rubricOrigin,
      typeOrigin: assetFiles.typeOrigin,
      rubricUserValidated: assetFiles.rubricUserValidated,
      typeUserValidated: assetFiles.typeUserValidated,
    })
    .from(assetFiles)
    .where(and(eq(assetFiles.id, input.fileId), eq(assetFiles.accountId, input.accountId)))
    .limit(1);

  if (!row) return [];

  const current: DocumentClassification = {
    rubricCode: (row.rubricCode as RubricCode | null) ?? null,
    documentTypeCode: row.documentTypeCode,
    rubricOrigin: (row.rubricOrigin as ValueOrigin | null) ?? null,
    typeOrigin: (row.typeOrigin as ValueOrigin | null) ?? null,
    rubricUserValidated: row.rubricUserValidated,
    typeUserValidated: row.typeUserValidated,
  };

  const outputs: OptimizationOutput[] = [];

  // Une Rubrique hors référentiel est traitée comme une absence de
  // proposition : DOC-RUB-03 s'appliquera et l'utilisateur sera sollicité,
  // plutôt que de ranger le document dans une Rubrique qui n'existe pas.
  const proposal =
    input.proposal && getRubric(input.proposal.rubricCode)
      ? { ...input.proposal, rubricCode: input.proposal.rubricCode as RubricCode }
      : null;

  // ── Rubrique (§10.2, DOC-RUB-01 à 03) ───────────────────────────────────
  const rubricProposals: ActionProposal[] = proposal
    ? [
        {
          value: proposal.rubricCode,
          label: getRubric(proposal.rubricCode)?.label ?? proposal.rubricCode,
          confidence: proposal.confidence,
          evidenceIds: input.evidenceIds,
          sourceContext: proposal.excerpt
            ? { label: proposal.excerpt.slice(0, 120) }
            : undefined,
        },
      ]
    : [];

  const rubricDecision = decide({
    targetType: 'DOCUMENT',
    key: 'rubricCode',
    currentValue: current.rubricCode,
    currentOrigin: current.rubricOrigin,
    userValidated: current.rubricUserValidated,
    proposals: rubricProposals,
  });

  outputs.push(
    toOptimizationOutput(rubricDecision, {
      objectType: 'DOCUMENT',
      objectId: input.fileId,
      fieldKey: 'rubricCode',
      currentValue: current.rubricCode,
      proposals: rubricProposals,
      promptVersion: input.promptVersion,
      pipelineVersion: input.pipelineVersion,
      referentialVersion: REFERENTIAL_VERSION,
    }),
  );

  let next = current;

  if (rubricDecision.decision === 'APPLY' || rubricDecision.decision === 'UPDATE') {
    const outcome = applyClassificationChange({
      current: next,
      nextRubric: rubricDecision.valueToWrite as RubricCode,
      origin: input.origin,
      assetFamilies: input.assetFamilies,
    });
    next = outcome.result;
  }

  // ── Type (§10.2, DOC-TYP-01 à 04) ───────────────────────────────────────
  //
  // Le Type n'est analysé qu'une fois la Rubrique connue : le §10.2 conditionne
  // toutes ses règles à « Rubrique connue ». Proposer un Type à un document
  // « Sans rubrique » créerait une action que sa résolution ne suffirait pas à
  // ranger — l'utilisateur répondrait sans rien débloquer.
  if (next.rubricCode) {
    const typeCandidate =
      proposal?.documentTypeCode &&
      getDocumentType(proposal.documentTypeCode)?.rubric === next.rubricCode
        ? proposal.documentTypeCode
        : null;

    const typeProposals: ActionProposal[] = typeCandidate
      ? [
          {
            value: typeCandidate,
            label: getDocumentType(typeCandidate)?.label ?? typeCandidate,
            confidence: proposal!.confidence,
            evidenceIds: input.evidenceIds,
          },
        ]
      : [];

    const typeDecision = decide({
      targetType: 'DOCUMENT',
      key: 'documentTypeCode',
      currentValue: next.documentTypeCode,
      currentOrigin: next.typeOrigin,
      userValidated: next.typeUserValidated,
      proposals: typeProposals,
    });

    outputs.push(
      toOptimizationOutput(typeDecision, {
        objectType: 'DOCUMENT',
        objectId: input.fileId,
        fieldKey: 'documentTypeCode',
        currentValue: next.documentTypeCode,
        proposals: typeProposals,
        promptVersion: input.promptVersion,
        pipelineVersion: input.pipelineVersion,
        referentialVersion: REFERENTIAL_VERSION,
      }),
    );

    if (typeDecision.decision === 'APPLY' || typeDecision.decision === 'UPDATE') {
      const outcome = applyClassificationChange({
        current: next,
        nextType: typeDecision.valueToWrite as string,
        origin: input.origin,
        assetFamilies: input.assetFamilies,
      });
      next = outcome.result;
    }
  }

  // ── Persistance, une seule écriture ─────────────────────────────────────
  const changed =
    next.rubricCode !== current.rubricCode ||
    next.documentTypeCode !== current.documentTypeCode;

  if (changed) {
    await db
      .update(assetFiles)
      .set({
        rubricCode: next.rubricCode,
        documentTypeCode: next.documentTypeCode,
        rubricOrigin: next.rubricOrigin,
        typeOrigin: next.typeOrigin,
        rubricUserValidated: next.rubricUserValidated,
        typeUserValidated: next.typeUserValidated,
        rubricConfidence: proposal ? String(proposal.confidence) : null,
        typeConfidenceV2: proposal ? String(proposal.confidence) : null,
        classificationReferentialVersion: REFERENTIAL_VERSION,
        classificationUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(assetFiles.id, input.fileId));
  }

  // ── Actions : créer, ou fermer ce qui n'a plus lieu d'être ──────────────
  await syncActionsForOutputs(input.accountId, input.fileId, outputs);

  return outputs;
}

/**
 * Traduit les décisions en mouvements de file.
 *
 * Une décision qui écrit ou qui n'attend rien FERME l'action correspondante ;
 * une décision qui sollicite l'utilisateur la crée ou la met à jour. Les deux
 * mouvements sont indissociables : ne faire que le premier laisse des cartes
 * orphelines, ne faire que le second empêche la file de se vider.
 */
export async function syncActionsForOutputs(
  accountId: number,
  targetId: number,
  outputs: OptimizationOutput[],
): Promise<void> {
  for (const output of outputs) {
    const dataKey = output.fieldKey ?? output.relationKey;
    if (!dataKey || !output.ruleCode) continue;

    if (!producesAction(output.recommendedDecision)) {
      await resolveActionsForData(
        accountId,
        output.objectType,
        targetId,
        dataKey,
        'OBSOLETE',
      );
      continue;
    }

    await upsertAction({
      accountId,
      targetType: output.objectType,
      targetId,
      fieldKey: output.fieldKey ?? null,
      relationKey: output.relationKey ?? null,
      actionKind: output.recommendedDecision === 'ARBITRATE' ? 'ARBITRATE' : 'COMPLETE',
      ruleCode: output.ruleCode,
      proposals: output.proposedValues,
    });
  }
}
