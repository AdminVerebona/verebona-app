import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, adminAuditLog, documentTypes } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { analyzeFileSources } from '@/services/ai/source-analysis/entrypoint';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request);
    const { userId } = session;
    if (!session.currentAccountId) {
      return NextResponse.json(
        { error: 'NO_ACCOUNT', message: 'Aucun compte sélectionné' },
        { status: 400 }
      );
    }
    const { id: rawId } = await params;
    const documentId = parseInt(rawId);

    if (isNaN(documentId)) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'ID de document invalide' },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { fileName, documentType, assetId, substructureId, equipmentId, webLinkUrl, documentDate, retainedTitle, retainedFunctionCode, supplier, description, notes, amountCents, userEditedFields } = body;

    if (!fileName || !documentType) {
      return NextResponse.json(
        { error: 'MISSING_FIELD', message: 'Le nom et le type de document sont requis' },
        { status: 400 }
      );
    }

    const validDocType = await db
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(eq(documentTypes.code, documentType))
      .limit(1);

    if (validDocType.length === 0) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'Type de document invalide ou inactif' },
        { status: 400 }
      );
    }

    const existingDoc = await db
      .select()
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.id, documentId),
          eq(assetFiles.userId, userId),
          eq(assetFiles.accountId, session.currentAccountId),
          isNull(assetFiles.deletedAt)
        )
      )
      .limit(1);

    if (existingDoc.length === 0) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Document non trouvé' },
        { status: 404 }
      );
    }

    const oldDoc = existingDoc[0];

    const now = new Date();
    const updateData: any = {
      originalFilename: fileName.trim(),
      documentType,
      documentDate: documentDate || null,
      updatedAt: now,
    };

    // V3.3 IA fields
    if (retainedTitle !== undefined) {
      updateData.retainedTitle = retainedTitle || null;
    }
    if (retainedFunctionCode !== undefined) {
      updateData.retainedFunctionCode = retainedFunctionCode || null;
    }
    if (supplier !== undefined) {
      updateData.supplier = supplier || null;
    }
    if (description !== undefined) {
      updateData.description = description || null;
    }
    if (notes !== undefined) {
      updateData.notes = notes || null;
    }
    if (amountCents !== undefined) {
      updateData.amountCents = amountCents != null ? parseInt(amountCents) : null;
    }
    if (userEditedFields !== undefined && userEditedFields !== null && typeof userEditedFields === 'object') {
      updateData.userEditedFields = userEditedFields;
    }

    if (assetId !== undefined) {
      updateData.assetId = assetId === null || assetId === 0 ? null : parseInt(assetId);
    }
    if (substructureId !== undefined) {
      updateData.substructureId = substructureId === null || substructureId === 0 ? null : parseInt(substructureId);
    }
    if (equipmentId !== undefined) {
      updateData.equipmentId = equipmentId === null || equipmentId === 0 ? null : parseInt(equipmentId);
    }

    if (oldDoc.isWebLink && webLinkUrl !== undefined) {
      updateData.webLinkUrl = webLinkUrl.trim();
      updateData.webLinkTitle = fileName.trim();
    }

    await db
      .update(assetFiles)
      .set(updateData)
      .where(eq(assetFiles.id, documentId));

    const changes = [];
    if (oldDoc.originalFilename !== fileName.trim()) {
      changes.push(`Nom: "${oldDoc.originalFilename}" → "${fileName.trim()}"`);
    }
    if (oldDoc.documentType !== documentType) {
      changes.push(`Type: "${oldDoc.documentType}" → "${documentType}"`);
    }
    if (oldDoc.documentDate !== (documentDate || null)) {
      changes.push(`Date du document: "${oldDoc.documentDate || 'non définie'}" → "${documentDate || 'non définie'}"`);
    }
    if (assetId !== undefined && oldDoc.assetId !== (assetId === null || assetId === 0 ? null : parseInt(assetId))) {
      const newAssetId = assetId === null || assetId === 0 ? 'aucun' : assetId;
      changes.push(`Bien: ${oldDoc.assetId || 'aucun'} → ${newAssetId}`);
    }

    if (changes.length > 0) {
      try {
        await db.insert(adminAuditLog).values({
          timestamp: new Date(),
          adminUserId: userId,
          adminEmail: 'user',
          actionType: 'ASSET_UPDATE',
          targetType: 'document',
          targetId: documentId,
          details: changes.join(', '),
        });
      } catch (auditError) {
        // Audit log failure must not block the save
        console.warn('PUT /api/documents/[id] audit log error:', auditError);
      }
    }

    // Toute modification manuelle fournit du contexte supplémentaire pour l'IA :
    // relancer une analyse en arrière-plan si le document a déjà été analysé.
    const hasBeenAnalysed = oldDoc.analysisState != null && oldDoc.analysisState !== 'UPLOADING' && oldDoc.analysisState !== 'UPLOADED';
    const accountId = session.currentAccountId;

    if (hasBeenAnalysed && accountId) {
      // Réanalyse consécutive à une correction manuelle : pas de crédit
      // consommé, l'utilisateur n'a pas déposé de nouveau document.
      analyzeFileSources([documentId], accountId, {
        userId: session.userId,
        billable: false,
        origin: 'documents/PUT',
      }).catch(err => {
        console.error(`[documents/PUT] re-analyse après modification manuelle échouée (file ${documentId}):`, err);
      });
    }

    return NextResponse.json(
      { message: 'Document mis à jour avec succès', documentId },
      { status: 200 }
    );

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('PUT /api/documents/[id] error:', error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}
