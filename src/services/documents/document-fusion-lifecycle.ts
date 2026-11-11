/**
 * Fusion de deux documents (`POST /api/documents/[id]/fusion`, actions
 * « merge » / « replace ») — cycle de vie des preuves du document écarté.
 */
/**
 * Lot 113AK (Trello #736) — CAUSE DÉMONTRÉE de preuves actives orphelines : la
 * fusion supprimait le document (corbeille) sans le cycle de vie des preuves ;
 * ses `field_evidence` restaient ACTIVE, puis visaient un document purgé
 * après 30 jours. Même point d'entrée que la suppression (`onDocumentsDeleted` :
 * retrait des preuves, agenda automatique, T3), puis qualification
 * « fusionné » au journal de provenance. Ne lève jamais.
 */
export async function retireMergedDocumentEvidence(p: { accountId: number; userId: number; fileId: number; keptFileId: number }): Promise<void> {
  try {
    const { onDocumentsDeleted } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    const r = await onDocumentsDeleted({ accountId: p.accountId, userId: p.userId, fileIds: [p.fileId] });
    const { provenanceJournalReady, recordProvenanceEvents } = await import('@/services/ai/source-analysis/source-units/provenance-repair');
    const { pgClient } = await import('@/db');
    if (await provenanceJournalReady(pgClient)) {
      await recordProvenanceEvents(pgClient, [{
        accountId: p.accountId, fileId: p.fileId, subject: 'EVIDENCE', status: 'DOCUMENT_MERGED', cause: 'DOCUMENT_MERGED_INTO_OTHER', phase: 'LIFECYCLE',
        detail: { keptFileId: p.keptFileId, withdrawn: r.withdrawn, assetIds: r.assetIds },
      }]);
    }
  } catch (e) {
    console.error(`[documents/fusion] preuves du document ${p.fileId} non retirées :`, (e as Error).message);
  }
}
