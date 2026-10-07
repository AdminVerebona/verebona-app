/**
 * Validation d'un document par l'utilisateur (« Sauvegarder = valider », tiroir
 * du document) — remplace `document-ai/commit-engine` (lot 16b-3).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI LE MOTEUR DE COMMIT HISTORIQUE A DISPARU
 *
 * `commitDocument` appliquait les propositions du run de référence
 * DIRECTEMENT dans `asset_files` (titre, date, fournisseur, liens bien /
 * pièce / équipement) et dans l'agenda (élément existant marqué « réalisé »
 * par simple ressemblance de libellé, traces `agenda_item_sources`). Ces
 * écritures contournaient les primitives canoniques :
 *   · les métadonnées du document sont écrites par l'analyse T1
 *     (`analysis-result.repository#updateSourceMetadata`, valeurs saisies par
 *     l'utilisateur protégées) puis par la route `PUT /api/documents/[id]`
 *     qu'appelle le tiroir juste avant la validation ;
 *   · le rattachement à un bien passe par cette même route (relation N-N et
 *     cycle de vie des preuves, `document-evidence-lifecycle`) ;
 *   · la fiche du bien est alimentée par les preuves et la réconciliation T3 ;
 *   · l'agenda (création, réalisation) relève de T4 et de sa primitive
 *     `writeAgendaItem` — jamais d'un rapprochement de libellés.
 * Les propositions du master T1 ne portaient d'ailleurs plus les clés que le
 * moteur historique savait appliquer (`matchedAssetId`, `retainedTitle`…).
 *
 * CE QUI RESTE : la décision de l'utilisateur. Les propositions en attente du
 * run de référence sont marquées « conservées » (`kept`, valeur finale =
 * valeur proposée), le document quitte l'état `VALIDATION_REQUIRED`, et le
 * rattachement déterministe à un équipement du bien est tenté comme avant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { documentAnalysisProposals, documentAnalysisRuns, assetFiles } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { CommitResult } from '@/types/document-ai';

/**
 * Valide un document : propositions en attente → `kept`, état
 * `VALIDATION_REQUIRED` → `ANALYZED`. Aucune écriture sur le bien ni sur
 * l'agenda (voir l'en-tête). Lève si le document n'a pas de run de référence.
 */
export async function validateDocumentProposals(assetFileId: number, accountId: number): Promise<CommitResult> {
  const [run] = await db
    .select({ id: documentAnalysisRuns.id })
    .from(documentAnalysisRuns)
    .where(and(
      eq(documentAnalysisRuns.assetFileId, assetFileId),
      eq(documentAnalysisRuns.accountId, accountId),
      eq(documentAnalysisRuns.isCurrentReference, true),
    ))
    .limit(1);
  if (!run) throw new Error(`No current reference run for asset file ${assetFileId}`);

  let kept = 0;
  await db.transaction(async (tx) => {
    const pending = await tx
      .select({ id: documentAnalysisProposals.id, proposedValueJson: documentAnalysisProposals.proposedValueJson })
      .from(documentAnalysisProposals)
      .where(and(
        eq(documentAnalysisProposals.runId, run.id),
        eq(documentAnalysisProposals.assetFileId, assetFileId),
        eq(documentAnalysisProposals.status, 'pending'),
      ));
    for (const p of pending) {
      await tx.update(documentAnalysisProposals)
        .set({ status: 'kept', finalValueJson: p.proposedValueJson })
        .where(eq(documentAnalysisProposals.id, p.id));
    }
    kept = pending.length;

    // NOTE : last_analysis_at n'est PAS mis à jour (une validation n'est pas une analyse).
    await tx.update(assetFiles)
      .set({ analysisState: 'ANALYZED' })
      .where(and(eq(assetFiles.id, assetFileId), eq(assetFiles.analysisState, 'VALIDATION_REQUIRED')));
  });

  // Lot 28 : « Sauvegarder = valider ». Une donnée documentaire du catalogue
  // « À traiter » (fin de contrat, fin de garantie…) validée ici avec UNE
  // seule valeur devient une valeur utilisateur ; deux valeurs différentes
  // restent à arbitrer. Puis « À traiter » est réévalué. Ne lève jamais.
  await recordValidatedDocumentValues(assetFileId, accountId, run.id);

  // Rattachement déterministe à un équipement du bien (non bloquant), comme
  // après l'ancien commit.
  void import('@/services/equipment/equipment-auto-link.service')
    .then(({ linkDocumentToEquipments }) => linkDocumentToEquipments(assetFileId, accountId))
    .catch(() => { /* non bloquant */ });

  console.info(`[documents] validation du document ${assetFileId} : ${kept} proposition(s) conservée(s).`);
  return { committed: true, appliedFields: [], agendaEffectsProcessed: 0 };
}

/** Données documentaires du pont « À traiter » validées au commit (lot 28). */
async function recordValidatedDocumentValues(assetFileId: number, accountId: number, runId: number): Promise<void> {
  try {
    const { documentBridgeFieldKey, recordUserDocumentValue, onDocumentEditedByUser } =
      await import('@/services/to-process/document-rule-bridge');
    const rows = await db
      .select({ targetKey: documentAnalysisProposals.targetKey, finalValueJson: documentAnalysisProposals.finalValueJson })
      .from(documentAnalysisProposals)
      .where(and(
        eq(documentAnalysisProposals.runId, runId),
        eq(documentAnalysisProposals.assetFileId, assetFileId),
        eq(documentAnalysisProposals.proposalType, 'field'),
        inArray(documentAnalysisProposals.status, ['kept', 'modified']),
      ));
    const parCle = new Map<string, Set<string>>();
    for (const r of rows) {
      const cle = documentBridgeFieldKey(r.targetKey);
      if (!cle || !r.finalValueJson) continue;
      let v: unknown;
      try { v = JSON.parse(r.finalValueJson); } catch { continue; }
      if (v !== null && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) v = (v as Record<string, unknown>).value;
      if (v === null || v === undefined || v === '') continue;
      parCle.set(cle, (parCle.get(cle) ?? new Set()).add(String(v)));
    }
    let ecrit = false;
    for (const [cle, valeurs] of parCle) {
      if (valeurs.size !== 1) continue; // contradiction : l'arbitrage reste ouvert
      ecrit = (await recordUserDocumentValue(accountId, assetFileId, cle, [...valeurs][0])) || ecrit;
    }
    if (ecrit) await onDocumentEditedByUser(accountId, assetFileId);
  } catch (e) {
    console.error(`[documents] validation « À traiter » du document ${assetFileId} :`, (e as Error).message);
  }
}
