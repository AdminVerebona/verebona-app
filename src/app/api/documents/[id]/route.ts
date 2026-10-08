import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { hasProjectableKnowledge, projectDocumentKnowledgeToAsset } from '@/services/ai/knowledge/document-knowledge.service';
import { db } from '@/db';
import { assetFiles, adminAuditLog, documentTypes } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { isKnownStorageDocumentCode } from '@/lib/referential/document-codes';
import { analyzeFileSources } from '@/services/ai/source-analysis/entrypoint';
import { onDocumentEditedByUser } from '@/services/to-process/document-rule-bridge';
import { displayDocumentTitle, isValidBusinessTitle } from '@/lib/documents/document-title-rules';

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

    // Lot 30 : le référentiel V1 (résolveur documentaire unique) valide ; la
    // table `document_types` reste consultée pour un type ajouté en back-office.
    const validDocType = isKnownStorageDocumentCode(documentType)
      ? [{ id: 0 }]
      : await db
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
      documentType,
      documentDate: documentDate || null,
      updatedAt: now,
    };
    // Lot 33C : quand le titre est envoyé à part (tiroir), le nom ORIGINAL du
    // fichier est conservé — il sert de repli d'affichage (« nom original
    // exploitable ») et n'est pas le titre. Lien web et anciens appelants
    // (sans `retainedTitle`) : comportement historique.
    if (retainedTitle === undefined || oldDoc.isWebLink) {
      updateData.originalFilename = fileName.trim();
    }

    // ══════════════════════════════════════════════════════════════════════
    // TITRE UTILISATEUR (lot 33C, ticket T1/T3) — `title_source = USER`
    //
    // Un titre MODIFIÉ ici n'est plus jamais réécrit automatiquement. « Modifié »
    // s'entend par rapport au titre AFFICHÉ : un tiroir qui renvoie le titre
    // tel qu'il l'a montré ne fait pas d'un titre système un titre
    // utilisateur. Client antérieur au lot 33C : il renvoyait le NOM DE
    // FICHIER (« <uuid>.pdf ») à la place d'un titre métier — ignoré.
    // ══════════════════════════════════════════════════════════════════════
    let titreUtilisateur: 'USER' | 'SYSTEM' | null = null;
    let titreIgnore = false;
    if (retainedTitle !== undefined) {
      const nouveau = typeof retainedTitle === 'string' ? retainedTitle.trim() : '';
      const ancien = oldDoc.retainedTitle?.trim() ?? '';
      const ids = { s3Key: oldDoc.s3Key, publicId: oldDoc.publicId };
      const affiche = displayDocumentTitle(oldDoc, '');
      const renvoiNomFichier = nouveau === (oldDoc.originalFilename?.trim() ?? '')
        && isValidBusinessTitle(ancien, ids) && !isValidBusinessTitle(nouveau, ids);
      if (nouveau === ancien) {
        // Inchangé.
      } else if (nouveau === affiche || renvoiNomFichier) {
        titreIgnore = true;
      } else {
        updateData.retainedTitle = nouveau || null;
        titreUtilisateur = nouveau ? 'USER' : 'SYSTEM';
        updateData.titleSource = titreUtilisateur;
      }
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
    // La marque `retainedTitle` suit la source du titre (lot 33C).
    if (titreUtilisateur || titreIgnore) {
      const marques = { ...((updateData.userEditedFields ?? oldDoc.userEditedFields ?? {}) as Record<string, boolean>) };
      if (titreUtilisateur === 'USER') marques.retainedTitle = true;
      else {
        // Titre vidé, ou titre non modifié (la marque envoyée par le client
        // n'est pas crue : un ancien tiroir la posait à tort) — la marque
        // antérieure n'est conservée que sur un titre courant conforme.
        const avantMarque = (oldDoc.userEditedFields as Record<string, boolean> | null)?.retainedTitle === true;
        const conforme = isValidBusinessTitle(oldDoc.retainedTitle, { s3Key: oldDoc.s3Key, publicId: oldDoc.publicId });
        if (titreUtilisateur === null && avantMarque && conforme) marques.retainedTitle = true;
        else delete marques.retainedTitle;
      }
      updateData.userEditedFields = marques;
    }

    if (assetId !== undefined) {
      updateData.assetId = assetId === null || assetId === 0 ? null : parseInt(assetId);
    }

    // Lot 28 (« À traiter », LINK-ASSET) : un rattachement choisi — ou RETIRÉ
    // — par l'utilisateur est une décision utilisateur, qu'aucune analyse
    // ultérieure ne défait automatiquement. Le tiroir renvoie
    // `userEditedFields` en entier : la marque est conservée d'un
    // enregistrement à l'autre.
    {
      const avant = (oldDoc.userEditedFields ?? {}) as Record<string, boolean>;
      const rattachementModifie = assetId !== undefined && updateData.assetId !== oldDoc.assetId;
      if (rattachementModifie || avant.assetId === true) {
        updateData.userEditedFields = {
          ...((updateData.userEditedFields ?? avant) as Record<string, boolean>),
          assetId: true,
        };
      }
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
    if (updateData.originalFilename !== undefined && oldDoc.originalFilename !== fileName.trim()) {
      changes.push(`Nom: "${oldDoc.originalFilename}" → "${fileName.trim()}"`);
    }
    if (titreUtilisateur) {
      changes.push(`Titre: "${oldDoc.retainedTitle ?? ''}" → "${updateData.retainedTitle ?? ''}"`);
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
      // `userEditedFields` ne fait que marquer les champs ci-dessus (et, lot 28,
      // le rattachement) : il ne constitue pas une correction à lui seul.
      .filter((k) => k !== 'updatedAt' && k !== 'assetId' && k !== 'userEditedFields' && k !== 'titleSource')
      .some((k) => !memeValeur(updateData[k], (oldDoc as Record<string, unknown>)[k]));
    const seulLeBienChange =
      assetCible !== undefined && assetCible !== oldDoc.assetId && !autresChampsModifies;
    // CDC 15 T3-03 : détachement ou déplacement A → B — les preuves portées
    // par A sont retirées et A réconcilié AVANT la reprojection sur B
    // (ne lève jamais).
    if (accountId && assetCible !== undefined && oldDoc.assetId && assetCible !== oldDoc.assetId) {
      const { onDocumentAssetChanged } = await import('@/services/ai/evidence/document-evidence-lifecycle');
      await onDocumentAssetChanged({
        accountId, userId: session.userId, fileId: documentId, fromAssetId: oldDoc.assetId, toAssetId: assetCible,
      });
    }

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

    // Lot 16b-3 (D-H1) : plus d'enrichissement silencieux du bien au
    // rattachement (`asset-enrichment-trigger`, moteur historique supprimé).
    // La fiche du bien est alimentée par la projection des faits T1 puis la
    // réconciliation T3 (ci-dessus), ou par la réanalyse en repli.

    // Lot 28 : « À traiter » suit la correction — rattachement, fournisseur…
    // L'action résolue se ferme, un problème réapparu (document détaché) se
    // rouvre. Ne lève jamais.
    if (accountId) await onDocumentEditedByUser(accountId, documentId);

    // CDC Assistant §25.7 : événement métier (caches de l'assistant).
    if (accountId) await emitBusinessEvent({ type: 'DOCUMENT_UPDATED', accountId, entityId: documentId });

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
