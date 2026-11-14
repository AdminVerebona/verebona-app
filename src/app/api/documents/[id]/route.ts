import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { hasProjectableKnowledge, projectDocumentKnowledgeToAsset } from '@/services/ai/knowledge/document-knowledge.service';
import { db } from '@/db';
import { assetFiles, adminAuditLog, documentTypes } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth-guards';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { isKnownStorageDocumentCode } from '@/lib/referential/document-codes';
import { analyzeFileSources } from '@/services/ai/source-analysis/entrypoint';
import { onDocumentEditedByUser } from '@/services/to-process/document-rule-bridge';
import { displayDocumentTitle, isValidBusinessTitle } from '@/lib/documents/document-title-rules';
import {
  assertTargetInAccount, isCrossAccountReferenceError, logCrossAccountRefusal, ownedSql, TargetCoherenceError,
} from '@/services/security/account-ownership';
import { documentTargetsErrorResponse, prepareTargetLists } from '@/services/documents/document-targets/route-support';
import { NOTES_MAX_LENGTH, notesWriteFromEdit, resolveNotesDescription } from '@/lib/documents/notes-description';
import { markNotesUserOwned, readNotesDescriptionMeta, NotesIntentUnavailableError, NOTES_INTENT_UNAVAILABLE_MESSAGE } from '@/services/documents/notes-description/store';

/** Identifiant de cible envoyé : `undefined` (absent), `null` (retiré) ou entier. */
function cible(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === 0 || v === '' || v === '0') return null;
  const n = parseInt(String(v));
  return isNaN(n) ? NaN : n;
}

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
    // Lot 85D : écriture refusée en lecture seule (essai échu, impayé, résilié, rétractation).
    const refus = await refuserSiLectureSeule(session.currentAccountId);
    if (refus) return refus;
    const { id: rawId } = await params;
    const documentId = parseInt(rawId);

    if (isNaN(documentId)) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'ID de document invalide' },
        { status: 400 }
      );
    }

    const body = await request.json();
    // Lot 113Z (#723) : `description` n'est plus lue ici — c'est la description
    // T1 (interne), jamais écrite par l'édition utilisateur ; un client
    // antérieur qui l'envoie encore (vide compris) ne l'efface plus.
    const { fileName, documentType, webLinkUrl, documentDate, retainedTitle, retainedFunctionCode, supplier, notes, notesDescription, amountCents, userEditedFields } = body;
    if (body.description !== undefined) {
      console.info('[documents/PUT] champ « description » ignoré (lot 113Z : écrit par T1 seulement).');
    }
    let { assetId, substructureId, equipmentId } = body;

    // Lot 86E : le code V1 historique (`document_type`) est FACULTATIF. Le
    // tiroir ne l'envoie plus : il le « normalisait » en « AUTRE » quand la
    // nature reconnue n'avait pas d'équivalent V1 (« BON_COMMANDE »). Absent ou
    // inchangé, il est conservé tel quel ; seule une MODIFICATION est validée.
    if (!fileName) {
      return NextResponse.json(
        { error: 'MISSING_FIELD', message: 'Le nom du document est requis' },
        { status: 400 }
      );
    }

    const existingDoc = await db
      .select()
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.id, documentId),
          // Lot 72D : tout membre du compte (plus seulement celui qui l'a déposé).
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

    // ══════════════════════════════════════════════════════════════════════
    // LOT 113Z — CHAMP UNIQUE « NOTES / DESCRIPTION »
    //
    // `notesDescription` : texte enregistré par le tiroir dans le champ unique.
    // Il est comparé au texte AFFICHÉ (notes utilisateur > description T1 >
    // vide) : inchangé → aucune écriture (ni valeur, ni provenance) ; modifié
    // → `notes` (null si effacé) + reprise en main explicite
    // (`notes_user_owned`), que T1 ne défait jamais. `notes` seul (client
    // antérieur) : écrit seulement s'il diffère de la note enregistrée.
    // ══════════════════════════════════════════════════════════════════════
    let notesEcrites: { notes: string | null; cleared: boolean } | null = null;
    if (notesDescription !== undefined || notes !== undefined) {
      const saisie = notesDescription !== undefined ? notesDescription : notes;
      if (saisie !== null && typeof saisie !== 'string') {
        return NextResponse.json({ error: 'INVALID_INPUT', message: 'Notes / Description invalide' }, { status: 400 });
      }
      if (typeof saisie === 'string' && saisie.length > NOTES_MAX_LENGTH) {
        return NextResponse.json({ error: 'INVALID_INPUT', message: `Notes / Description : ${NOTES_MAX_LENGTH} caractères au plus` }, { status: 400 });
      }
      const meta = await readNotesDescriptionMeta(session.currentAccountId, documentId);
      const affiche = notesDescription !== undefined
        ? resolveNotesDescription({ notes: oldDoc.notes, description: oldDoc.description, notesUserOwned: meta.notesUserOwned, descriptionSource: meta.descriptionSource }).text
        : (oldDoc.notes ?? '');
      const w = notesWriteFromEdit(affiche, saisie);
      if (w.write) notesEcrites = { notes: w.notes, cleared: w.cleared };
    }

    // ══════════════════════════════════════════════════════════════════════
    // LOT 111I — RATTACHEMENT MULTIPLE (listes `assetIds`, `substructureIds`,
    // `equipmentIds`). La sélection est validée pour le compte AVANT toute
    // écriture ; ses colonnes « principal » (triplet cohérent sur un bien)
    // remplacent les anciens champs à valeur unique, qui suivent ensuite le
    // chemin historique (contrôle SEC-05, marques, projection, réanalyse).
    // Les autres cibles deviennent des liens USER dans la MÊME transaction.
    // Anciens appelants (valeur unique, sans liste) : comportement inchangé.
    // ══════════════════════════════════════════════════════════════════════
    let listes: Awaited<ReturnType<typeof prepareTargetLists>> = null;
    try {
      listes = await prepareTargetLists(session.currentAccountId, documentId, body);
    } catch (e) {
      const r = documentTargetsErrorResponse(e, session.currentAccountId, 'PUT /api/documents/[id]');
      if (r) return r;
      throw e;
    }
    if (listes) {
      assetId = listes.columns.assetId;
      substructureId = listes.columns.substructureId;
      equipmentId = listes.columns.equipmentId;
    }

    const typeModifie = documentType !== undefined && documentType !== null && documentType !== oldDoc.documentType;
    if (typeModifie) {
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
    }

    // ══════════════════════════════════════════════════════════════════════
    // LOT 49 (SEC-05) — CIBLES DU COMPTE, AVANT TOUTE ÉCRITURE
    //
    // Bien, pièce et équipement demandés : du compte actif ; pièce et
    // équipement portés par le bien attendu (celui envoyé, sinon l'actuel) et
    // par le même bien. Un refus arrête TOUT : aucune écriture partielle,
    // aucune projection, réanalyse ni réconciliation. La mise à jour porte en
    // plus la condition de compte dans son SQL (document ET cibles).
    // ══════════════════════════════════════════════════════════════════════
    const assetDemande = cible(assetId);
    const pieceDemandee = cible(substructureId);
    const equipementDemande = cible(equipmentId);
    if ([assetDemande, pieceDemandee, equipementDemande].some((v) => Number.isNaN(v))) {
      return NextResponse.json({ error: 'INVALID_INPUT', message: 'Identifiant de bien, pièce ou équipement invalide' }, { status: 400 });
    }
    if (assetDemande || pieceDemandee || equipementDemande) {
      try {
        await assertTargetInAccount(session.currentAccountId, {
          assetId: assetDemande !== undefined ? assetDemande : (pieceDemandee || equipementDemande ? oldDoc.assetId : null),
          substructureId: pieceDemandee ?? null,
          equipmentId: equipementDemande ?? null,
        });
      } catch (e) {
        if (isCrossAccountReferenceError(e)) {
          logCrossAccountRefusal('PUT /api/documents/[id]', e);
          return NextResponse.json({ error: 'NOT_FOUND', message: 'Bien, pièce ou équipement introuvable' }, { status: 404 });
        }
        if (e instanceof TargetCoherenceError) {
          return NextResponse.json({ error: 'INVALID_INPUT', message: e.message }, { status: 400 });
        }
        throw e;
      }
    }

    const now = new Date();
    const updateData: any = {
      ...(typeModifie ? { documentType } : {}),
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
    if (notesEcrites) {
      updateData.notes = notesEcrites.notes;
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
    // Lot 103F : une date du document MODIFIÉE ici est une correction
    // utilisateur, prioritaire : aucune analyse ultérieure ne la remplace
    // (`updateSourceMetadata` respecte `userEditedFields.documentDate`) —
    // même posée avant la première analyse, quand le tiroir ne la marque pas.
    {
      const avant = (oldDoc.userEditedFields ?? {}) as Record<string, boolean>;
      const dateModifiee = documentDate !== undefined && (documentDate || null) !== (oldDoc.documentDate ?? null);
      if (dateModifiee || avant.documentDate === true) {
        updateData.userEditedFields = {
          ...((updateData.userEditedFields ?? avant) as Record<string, boolean>),
          documentDate: true,
        };
      }
    }
    if (substructureId !== undefined) {
      updateData.substructureId = substructureId === null || substructureId === 0 ? null : parseInt(substructureId);
    }
    if (equipmentId !== undefined) {
      updateData.equipmentId = equipmentId === null || equipmentId === 0 ? null : parseInt(equipmentId);
    }
    // Lot 71A (point B) : équipement choisi — ou retiré — par l'utilisateur :
    // décision utilisateur, jamais défaite par le rapprochement automatique
    // (`document-equipment-link.service`). Marque conservée d'un
    // enregistrement à l'autre, comme pour le bien.
    {
      const avant = (oldDoc.userEditedFields ?? {}) as Record<string, boolean>;
      const equipementModifie = equipmentId !== undefined && (updateData.equipmentId ?? null) !== (oldDoc.equipmentId ?? null);
      if (equipementModifie || avant.equipmentId === true) {
        updateData.userEditedFields = {
          ...((updateData.userEditedFields ?? avant) as Record<string, boolean>),
          equipmentId: true,
        };
      }
    }

    if (listes) {
      // Lot 111I : colonnes secondaires historiques réalignées sur la sélection ; marques par niveau modifié.
      updateData.linkedAssetId = listes.columns.linkedAssetId;
      updateData.linkedRoomId = listes.columns.linkedRoomId;
      const marques = { ...((updateData.userEditedFields ?? oldDoc.userEditedFields ?? {}) as Record<string, boolean>) };
      if (listes.changed.assets) marques.assetId = true;
      if (listes.changed.rooms) marques.substructureId = true;
      if (listes.changed.equipments) marques.equipmentId = true;
      updateData.userEditedFields = marques;
    }

    if (oldDoc.isWebLink && webLinkUrl !== undefined) {
      updateData.webLinkUrl = webLinkUrl.trim();
      updateData.webLinkTitle = fileName.trim();
    }

    const cibles = [
      ...(updateData.assetId ? [ownedSql('asset', updateData.assetId, session.currentAccountId)] : []),
      ...(updateData.substructureId ? [ownedSql('substructure', updateData.substructureId, session.currentAccountId)] : []),
      ...(updateData.equipmentId ? [ownedSql('equipment', updateData.equipmentId, session.currentAccountId)] : []),
    ];
    const accountIdEcriture = session.currentAccountId;
    const ecrit = await db.transaction(async (tx) => {
      const lignes = await tx
        .update(assetFiles)
        .set(updateData)
        .where(and(eq(assetFiles.id, documentId), eq(assetFiles.accountId, accountIdEcriture), ...cibles))
        .returning({ id: assetFiles.id });
      // Lot 113Z : reprise en main de « Notes / Description », même transaction que la note.
      if (lignes.length > 0 && notesEcrites) await markNotesUserOwned(tx, accountIdEcriture, documentId);
      // Lot 111I : liens des autres cibles (colonnes déjà écrites ci-dessus, même transaction).
      if (lignes.length > 0 && listes) {
        const { applyDocumentTargets } = await import('@/services/documents/document-targets/service');
        await applyDocumentTargets(tx, {
          accountId: accountIdEcriture, fileId: documentId, selection: listes.selection, mode: 'replace',
          columnsManagedByCaller: true,
          previousColumns: {
            assetId: oldDoc.assetId, linkedAssetId: oldDoc.linkedAssetId, substructureId: oldDoc.substructureId ?? null,
            equipmentId: oldDoc.equipmentId ?? null, linkedRoomId: oldDoc.linkedRoomId,
          },
        });
      }
      return lignes;
    });
    if (ecrit.length === 0) {
      // Cible devenue étrangère ou supprimée entre le contrôle et l'écriture.
      return NextResponse.json({ error: 'NOT_FOUND', message: 'Document non trouvé' }, { status: 404 });
    }

    const changes = [];
    if (updateData.originalFilename !== undefined && oldDoc.originalFilename !== fileName.trim()) {
      changes.push(`Nom: "${oldDoc.originalFilename}" → "${fileName.trim()}"`);
    }
    if (titreUtilisateur) {
      changes.push(`Titre: "${oldDoc.retainedTitle ?? ''}" → "${updateData.retainedTitle ?? ''}"`);
    }
    if (typeModifie) {
      changes.push(`Type: "${oldDoc.documentType}" → "${documentType}"`);
    }
    if (oldDoc.documentDate !== (documentDate || null)) {
      changes.push(`Date du document: "${oldDoc.documentDate || 'non définie'}" → "${documentDate || 'non définie'}"`);
    }
    if (assetId !== undefined && oldDoc.assetId !== (assetId === null || assetId === 0 ? null : parseInt(assetId))) {
      const newAssetId = assetId === null || assetId === 0 ? 'aucun' : assetId;
      changes.push(`Bien: ${oldDoc.assetId || 'aucun'} → ${newAssetId}`);
    }

    if (notesEcrites) {
      // Contenu jamais journalisé (donnée personnelle) : seulement le fait.
      changes.push(notesEcrites.cleared ? 'Notes / Description : effacées par l’utilisateur' : 'Notes / Description : modifiées par l’utilisateur');
    }
    if (listes && (listes.changed.assets || listes.changed.rooms || listes.changed.equipments)) {
      changes.push(`Rattachements: biens [${listes.selection.assetIds.join(', ')}], pièces [${listes.selection.roomIds.join(', ')}], équipements [${listes.selection.equipmentIds.join(', ')}]`);
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
      // Lot 113Z : `notes` non plus — T1 ne lit pas la note de l'utilisateur
      // (aucun contexte nouveau pour l'analyse).
      .filter((k) => k !== 'updatedAt' && k !== 'assetId' && k !== 'userEditedFields' && k !== 'titleSource' && k !== 'notes')
      .some((k) => !memeValeur(updateData[k], (oldDoc as Record<string, unknown>)[k]));
    const seulLeBienChange =
      assetCible !== undefined && assetCible !== oldDoc.assetId && !autresChampsModifies;
    // Lot 113Z (#723, recette 3 et 7) : rien de ce que lit T1 n'a changé (notes
    // seules, ou enregistrement sans modification) → aucune réanalyse, aucune
    // projection ; « À traiter » et les caches de l'Assistant suivent quand même.
    const ciblesModifiees = (assetCible !== undefined && assetCible !== oldDoc.assetId)
      || !!(listes && (listes.changed.assets || listes.changed.rooms || listes.changed.equipments));
    const rienPourT1 = !autresChampsModifies && !ciblesModifiees;
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
      !rienPourT1 && hasBeenAnalysed && !!accountId && seulLeBienChange && !!assetCible
      && await hasProjectableKnowledge(documentId).catch(() => false);

    const reanalyser = () => {
      if (!accountId) return;
      // Réanalyse consécutive à une correction manuelle : pas de crédit
      // consommé, l'utilisateur n'a pas déposé de nouveau document.
      analyzeFileSources([documentId], accountId, {
        userId: session.userId,
        billable: false,
        origin: 'documents/PUT',
        // Lot 50 : réanalyse après correction / rattachement — jamais un sujet de la mascotte.
        processingVisibility: 'TECHNICAL',
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
    } else if (hasBeenAnalysed && accountId && !rienPourT1) {
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

    // Lot 113Z : texte affiché après l'écriture (le tiroir le reprend tel quel).
    const metaApres = await readNotesDescriptionMeta(session.currentAccountId, documentId).catch(() => null);
    const notesApres = notesEcrites ? notesEcrites.notes : oldDoc.notes;
    const notesDescriptionVue = resolveNotesDescription({
      notes: notesApres, description: oldDoc.description,
      notesUserOwned: metaApres?.notesUserOwned ?? false, descriptionSource: metaApres?.descriptionSource ?? null,
    });

    return NextResponse.json(
      { message: 'Document mis à jour avec succès', documentId, notesDescription: notesDescriptionVue, reanalysis: !rienPourT1 && hasBeenAnalysed },
      { status: 200 }
    );

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    // Carte #767 (E05) : intention « Notes / Description » non persistable → transaction annulée, erreur explicite.
    if (error instanceof NotesIntentUnavailableError) {
      return NextResponse.json({ error: error.code, reason: error.reason, message: NOTES_INTENT_UNAVAILABLE_MESSAGE }, { status: 503 });
    }
    console.error('PUT /api/documents/[id] error:', error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}
