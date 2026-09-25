import { NextRequest, NextResponse } from 'next/server';
import { hasProjectableKnowledge, projectDocumentKnowledgeToAsset } from '@/services/ai/knowledge/document-knowledge.service';
import { db } from '@/db';
import { assetFiles, adminAuditLog, documentTypes } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { analyzeFileSources } from '@/services/ai/source-analysis/entrypoint';
import { triggerAssetEnrichment } from '@/services/document-ai/asset-enrichment-trigger';

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

    // ══════════════════════════════════════════════════════════════════════
    // RATTACHEMENT À UN BIEN : PROJECTION DEPUIS T1, SANS RELIRE LE FICHIER
    //
    // Quand seul le bien change et que T1 a déjà produit la représentation
    // durable du document (texte, faits, preuves), les projections métier
    // du bien sont produites depuis ces données persistées — plus de
    // réanalyse complète du fichier, ni de consommation de quota.
    // Les autres corrections manuelles conservent la réanalyse existante.
    // ══════════════════════════════════════════════════════════════════════
    const assetCible =
      assetId === undefined ? undefined
        : assetId === null || assetId === 0 ? null
          : parseInt(assetId);
    // « Seul le bien change » se vérifie sur TOUS les champs envoyés, pas
    // seulement sur ceux que journalise l'audit : une description, un
    // fournisseur ou un montant corrigé en même temps justifient une
    // réanalyse (contexte nouveau pour l'IA).
    const memeValeur = (a: unknown, b: unknown) => {
      const norm = (v: unknown) => (v === undefined || v === '' ? null : v instanceof Date ? v.toISOString() : v);
      const x = norm(a), y = norm(b);
      if (x !== null && typeof x === 'object') return JSON.stringify(x) === JSON.stringify(y);
      return x === y || String(x) === String(y);
    };
    const autresChampsModifies = Object.keys(updateData)
      .filter((k) => k !== 'updatedAt' && k !== 'assetId')
      .some((k) => !memeValeur(updateData[k], (oldDoc as Record<string, unknown>)[k]));
    const seulLeBienChange =
      assetCible !== undefined && assetCible !== oldDoc.assetId && !autresChampsModifies;
    const projectionPossible =
      hasBeenAnalysed && !!accountId && seulLeBienChange && !!assetCible
      && await hasProjectableKnowledge(documentId).catch(() => false);

    const reanalyser = () => {
      if (!accountId) return;
      // Réanalyse consécutive à une correction manuelle : pas de crédit
      // consommé, l'utilisateur n'a pas déposé de nouveau document.
      analyzeFileSources([documentId], accountId, {
        userId: session.userId,
        billable: false,
        origin: 'documents/PUT',
      }).catch(err => {
        console.error(`[documents/PUT] re-analyse après modification manuelle échouée (file ${documentId}):`, err);
      });
    };

    if (projectionPossible && accountId && assetCible) {
      void projectDocumentKnowledgeToAsset({
        accountId, userId: session.userId, fileId: documentId, assetId: assetCible,
      }).then((preuves) => {
        // Aucune preuve produite : repli sur la réanalyse.
        if (preuves === 0) reanalyser();
      }).catch(err => {
        console.error(`[documents/PUT] projection T1 après rattachement échouée (file ${documentId}):`, err);
        reanalyser();
      });
    } else if (hasBeenAnalysed && accountId) {
      reanalyser();
    }

    // ══════════════════════════════════════════════════════════════════════
    // ⚠️ LE RATTACHEMENT À UN BIEN N'ALIMENTAIT PAS LA FICHE
    //
    // Rattacher un document déjà analysé à un bien est le geste attendu pour
    // que ses données remontent dans l'onglet « Informations » — l'adresse
    // lue sur une facture doit renseigner l'adresse du bien.
    //
    // Or aucun des trois déclencheurs de `applyAiSuggestionsToAsset` ne
    // couvrait ce cas (cf. `asset-enrichment-trigger.ts`). Cette route se
    // contentait de relancer une analyse complète en tâche de fond, soumise
    // au quota d'analyse — qui rend la main SANS RIEN FAIRE lorsqu'il est
    // épuisé — et qui n'alimente la fiche que si elle retombe sur ANALYZED.
    //
    // L'alimentation est désormais déclenchée explicitement, sans dépendre
    // de l'issue de cette réanalyse.
    // ══════════════════════════════════════════════════════════════════════
    const nouvelAssetId =
      assetId === undefined
        ? undefined
        : assetId === null || assetId === 0
          ? null
          : parseInt(assetId);

    if (accountId && nouvelAssetId && nouvelAssetId !== oldDoc.assetId) {
      void triggerAssetEnrichment({
        assetId: nouvelAssetId,
        accountId,
        assetFileId: documentId,
        reason: 'document_attached',
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
