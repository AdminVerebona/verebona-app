/**
 * GET /api/dashboard/a-traiter
 * V3.3 — Structure 3 onglets : Documents / Agenda / Équipements
 *
 * Documents :
 *   - missing_function : retainedFunctionCode IS NULL ou vide ET le fichier n'est pas une image
 *                        (les images ont la fonction implicite "Photo")
 *   - missing_useful_link : aucune liaison parmi assetId, linkedAssetId, linkedRoomId, equipmentId
 *   Note : missing_title supprimé — un document a toujours originalFilename comme titre de repli.
 *
 * Agenda :
 *   - Consomme le calcul AttentionFlag existant (computeAttentionFlags via AgendaQueryService)
 *   - sans_bien, en_retard, date_incoherente, donnee_distincte_a_qualifier
 *
 * Équipements :
 *   - equipement_sans_bien uniquement (equipement_incomplet supprimé — plan §5.4)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, equipments, documentLotItems, assets } from '@/db/schema';
import { eq, and, isNull, isNotNull, or, desc, notInArray } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { getAgendaAttentionItems } from '@/services/agenda/AgendaQueryService';
import { serverCacheGet, serverCacheSet } from '@/lib/server-cache';

export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    const accountId = session.currentAccountId;
    if (!accountId) {
      return NextResponse.json({ error: 'No account selected' }, { status: 400 });
    }

    // Cache serveur 15s : le badge "À traiter" est affiché sur toutes les pages
    // via DashboardLayout. Sans cache, chaque navigation déclenche 3 queries DB.
    const cacheKey = `a-traiter:${accountId}`;
    const cached = serverCacheGet<object>(cacheKey);
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' },
      });
    }

    const [documentsRaw, agendaAttentionItems, equipementsSansBien] = await Promise.all([

      // ─── Documents à traiter ──────────────────────────────────────────────
      // Un document entre dans À traiter si au moins un motif est vrai.
      // missing_function : retainedFunctionCode IS NULL ou vide
      // missing_useful_link : aucune liaison parmi assetId, linkedAssetId, linkedRoomId, equipmentId
      db.select({
        id: assetFiles.id,
        publicId: assetFiles.publicId,
        filename: assetFiles.filename,
        originalFilename: assetFiles.originalFilename,
        mimeType: assetFiles.mimeType,
        retainedTitle: assetFiles.retainedTitle,
        retainedFunctionCode: assetFiles.retainedFunctionCode,
        assetId: assetFiles.assetId,
        linkedAssetId: assetFiles.linkedAssetId,
        linkedRoomId: assetFiles.linkedRoomId,
        equipmentId: assetFiles.equipmentId,
        documentType: assetFiles.documentType,
        documentDate: assetFiles.documentDate,
        supplier: assetFiles.supplier,
        description: assetFiles.description,
        uploadedAt: assetFiles.uploadedAt,
        lastAnalysisAt: assetFiles.lastAnalysisAt,
        analysisState: assetFiles.analysisState,
      })
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.accountId, accountId),
            or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
            isNull(assetFiles.deletedAt),
            eq(assetFiles.isWebLink, false),
            eq(assetFiles.isIgnored, false),
            // Exclure les documents dont l'analyse IA est encore en cours
            or(
              isNull(assetFiles.analysisState),
              notInArray(assetFiles.analysisState, ['UPLOADING', 'UPLOADED', 'ANALYZING'])
            ),
            or(
              // missing_function : ni retainedFunctionCode ni documentType ne sont définis
              and(
                isNull(assetFiles.retainedFunctionCode),
                isNull(assetFiles.documentType)
              ),
              // missing_useful_link
              and(
                isNull(assetFiles.assetId),
                isNull(assetFiles.linkedAssetId),
                isNull(assetFiles.linkedRoomId),
                isNull(assetFiles.equipmentId)
              ),
              // missing_analysis : document jamais analysé par l'IA
              isNull(assetFiles.lastAnalysisAt),
              // ai_conflict
              eq(assetFiles.analysisState, 'CONFLICT_DETECTED'),
              // fusion_suggested : plusieurs fichiers du même lot reconnus comme un seul document
              eq(assetFiles.analysisState, 'FUSION_SUGGESTED'),
            )
          )
        )
        .orderBy(desc(assetFiles.uploadedAt)),

      // ─── Agenda à traiter ─────────────────────────────────────────────────
      // Consomme la logique canonique computeAttentionFlags (sans_bien, en_retard, etc.)
      getAgendaAttentionItems(accountId),

      // ─── Équipements à traiter ────────────────────────────────────────────
      // CDC V3.3 §5.4 : equipement_sans_bien uniquement (equipement_incomplet supprimé)
      // equipement_sans_bien = équipement actif dont le bien associé est supprimé (soft-delete).
      // En schema V1, assetId est NOT NULL (FK), donc on cherche les équipements dont
      // le bien attaché a été soft-deleted (assets.deletedAt IS NOT NULL).
      db.select({
        id: equipments.id,
        name: equipments.name,
        type: equipments.type,
        category: equipments.category,
        assetId: equipments.assetId,
        status: equipments.status,
      })
        .from(equipments)
        .innerJoin(assets, eq(equipments.assetId, assets.id))
        .where(
          and(
            eq(assets.accountId, accountId),
            isNull(equipments.archivedAt),
            isNotNull(assets.deletedAt),
          )
        ),
    ]);

    // ── Récupérer les runIds des fichiers FUSION_SUGGESTED pour construire les groupes ──
    const fusionFileIds = documentsRaw
      .filter(d => d.analysisState === 'FUSION_SUGGESTED')
      .map(d => d.id);

    // Pour chaque fichier fusion, trouver son runId courant via documentLotItems
    const fusionRunIdByFileId: Record<number, number> = {};
    if (fusionFileIds.length > 0) {
      try {
        const rows = await db
          .select({
            assetFileId: documentLotItems.assetFileId,
            runId: documentLotItems.currentAnalysisRunId,
          })
          .from(documentLotItems)
          .where(
            or(...fusionFileIds.map(id => eq(documentLotItems.assetFileId, id)))
          );
        for (const r of rows) {
          if (r.runId) fusionRunIdByFileId[r.assetFileId] = r.runId;
        }
      } catch { /* non-bloquant */ }
    }

    // Compute attention motifs for each document
    const isImage = (mimeType: string | null) => !!mimeType?.startsWith('image/');

    const documents = documentsRaw
      .map(doc => {
        const motifs: string[] = [];

        // fusion_suggested : prioritaire — ces fichiers ne nécessitent pas d'autres motifs
        if (doc.analysisState === 'FUSION_SUGGESTED') {
          motifs.push('fusion_suggested');
          return {
            ...doc,
            motifs,
            fusionRunId: fusionRunIdByFileId[doc.id] ?? null,
          };
        }

        // missing_function : ni retainedFunctionCode ni documentType définis, ET pas une image
        const hasFunction = doc.retainedFunctionCode?.trim() || doc.documentType?.trim();
        if (!hasFunction && !isImage(doc.mimeType)) motifs.push('missing_function');

        // missing_useful_link
        if (!doc.assetId && !doc.linkedAssetId && !doc.linkedRoomId && !doc.equipmentId) {
          motifs.push('missing_useful_link');
        }

        // missing_analysis : jamais analysé
        if (!doc.lastAnalysisAt) motifs.push('missing_analysis');

        // ai_conflict
        if (doc.analysisState === 'CONFLICT_DETECTED') motifs.push('ai_conflict');

        return { ...doc, motifs, fusionRunId: null as number | null };
      })
      // Exclure les documents qui n'ont finalement aucun motif
      .filter(doc => doc.motifs.length > 0);

    const responseData = {
      documents,
      agendaItems: agendaAttentionItems,
      equipements: equipementsSansBien,
    };

    serverCacheSet(cacheKey, responseData, 15_000);

    return NextResponse.json(responseData, {
      headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' },
    });

  } catch (error) {
    console.error('API a-traiter error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
