/**
 * unified-analysis-pipeline.ts
 * Pipeline d'analyse unifié — gère 1 ou N fichiers avec :
 *   - Passe 0 : regroupement multi-pages via Gemini (si N > 1)
 *   - Analyse en parallèle par groupe
 *   - Auto-commit si toutes les proposals field ont confiance ≥ 0.7
 *     et aucune suggestion room/equipment
 *   - Soft-delete des fichiers secondaires fusionnés
 *   - Journal dans document_lots / document_lot_items
 *
 * Fire-and-forget : appelé sans await depuis /api/files/confirm.
 */

import { db } from '@/db';
import {
  assetFiles,
  assets,
  documentLots,
  documentLotItems,
  documentAnalysisProposals,
  agendaItems,
  rooms,
  equipments,
} from '@/db/schema';
import { eq, and, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import { emit } from '@/lib/notifications';
import { analyzeDocument } from './analyze-document';
import { commitDocument } from './commit-engine';
import { PROMPT_VERSIONS, callGeminiWithFallback } from './gemini-client';
import { AiUsageTracker } from './ai-usage-tracker';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '@/lib/s3-client';
import { linkDocumentToEquipments } from '@/services/equipment/equipment-auto-link.service';
import { triggerAssetEnrichment } from './asset-enrichment-trigger';
import { canConsumeAnalysis, consumeAnalysisCredits } from '@/services/commercial-model.service';

const HIGH_CONFIDENCE_THRESHOLD = 0.7;

// ── SSE broadcast (partagé avec l'ancien pipeline) ───────────────────────────
type SSEWriter = (data: Record<string, unknown>) => void;
const streamWriters = new Map<number, Set<SSEWriter>>();

export function registerStreamWriter(assetFileId: number, writer: SSEWriter): () => void {
  if (!streamWriters.has(assetFileId)) {
    streamWriters.set(assetFileId, new Set());
  }
  streamWriters.get(assetFileId)!.add(writer);
  return () => {
    const set = streamWriters.get(assetFileId);
    if (set) {
      set.delete(writer);
      if (set.size === 0) streamWriters.delete(assetFileId);
    }
  };
}

function broadcast(assetFileId: number, data: Record<string, unknown>) {
  const writers = streamWriters.get(assetFileId);
  if (!writers) return;
  for (const write of writers) {
    try { write(data); } catch { /* connexion fermée */ }
  }
}

// ── Helpers état ─────────────────────────────────────────────────────────────

async function setAnalysisState(
  assetFileId: number,
  state: string,
  failReason?: string,
): Promise<number> {
  const patch: Record<string, unknown> = { analysisState: state, updatedAt: new Date() };
  if (failReason !== undefined) patch.analysisFailReason = failReason;

  if (state === 'ANALYSIS_FAILED') {
    const [updated] = await db.update(assetFiles)
      .set({ ...patch, analysisRetryCount: sql`${assetFiles.analysisRetryCount} + 1` })
      .where(eq(assetFiles.id, assetFileId))
      .returning({ retryCount: assetFiles.analysisRetryCount });
    broadcast(assetFileId, { type: 'state_update', analysisState: state });
    return updated?.retryCount ?? 1;
  }

  const successStates = ['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED', 'FUSION_SUGGESTED'];
  if (successStates.includes(state)) patch.analysisRetryCount = 0;

  await db.update(assetFiles).set(patch as any).where(eq(assetFiles.id, assetFileId));
  broadcast(assetFileId, { type: 'state_update', analysisState: state });
  return 0;
}

// ── Résolution URL S3 ────────────────────────────────────────────────────────

async function resolveFileUrl(fileId: number): Promise<{ id: number; url: string; mimeType: string; assetId: number | null } | null> {
  const [file] = await db.select({
    id: assetFiles.id,
    mimeType: assetFiles.mimeType,
    s3Key: assetFiles.s3Key,
    s3Bucket: assetFiles.s3Bucket,
    webLinkUrl: assetFiles.webLinkUrl,
    assetId: assetFiles.assetId,
  }).from(assetFiles).where(eq(assetFiles.id, fileId)).limit(1);

  if (!file) return null;

  if (file.mimeType === 'application/x-web-link') {
    if (!file.webLinkUrl) return null;
    return { id: fileId, url: file.webLinkUrl, mimeType: 'text/html', assetId: file.assetId ?? null };
  }
  if (!file.s3Key || !file.s3Bucket) return null;
  const command = new GetObjectCommand({ Bucket: file.s3Bucket, Key: file.s3Key });
  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  return { id: fileId, url, mimeType: file.mimeType ?? 'application/pdf', assetId: file.assetId ?? null };
}

// ── Chargement contexte IA pour un compte ────────────────────────────────────

async function loadAnalysisContext(accountId: number, linkedAssetId: number | null) {
  const [userAssets, existingTitlesRows, allAccountAgendaItems, linkedAssetRooms, linkedAssetEquipments] = await Promise.all([
    db.select({ id: assets.id, name: assets.name, category: assets.category, registrationNumber: assets.registrationNumber, subtype: assets.subtype, engineInfo: assets.engineInfo })
      .from(assets)
      .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt)))
      .limit(50),
    db.select({ retainedTitle: assetFiles.retainedTitle, documentType: assetFiles.documentType, supplier: assetFiles.supplier })
      .from(assetFiles)
      .where(and(eq(assetFiles.accountId, accountId), isNotNull(assetFiles.retainedTitle), isNull(assetFiles.deletedAt)))
      .limit(200),
    db.select({ id: agendaItems.id, title: agendaItems.title, startDate: agendaItems.startDate, manualStatus: agendaItems.manualStatus })
      .from(agendaItems)
      .where(eq(agendaItems.accountId, accountId))
      .limit(200),
    linkedAssetId
      ? db.select({ id: rooms.id, name: rooms.name, roomType: rooms.roomType }).from(rooms).where(eq(rooms.assetId, linkedAssetId))
      : Promise.resolve([]),
    linkedAssetId
      ? db.select({ id: equipments.id, name: equipments.name, type: equipments.type, category: equipments.category }).from(equipments).where(eq(equipments.assetId, linkedAssetId))
      : Promise.resolve([]),
  ]);

  // Build enriched title list: include supplier + documentType for better harmonisation context
  const existingTitles = existingTitlesRows
    .filter(r => r.retainedTitle && r.retainedTitle.trim().length > 0)
    .map(r => {
      const parts: string[] = [r.retainedTitle!];
      if (r.supplier) parts.push(`[fournisseur:${r.supplier}]`);
      if (r.documentType) parts.push(`[type:${r.documentType}]`);
      return parts.join(' ');
    });
  const existingAgendaItems = allAccountAgendaItems.map(i => ({
    id: i.id,
    title: i.title,
    startDate: i.startDate ?? null,
    manualStatus: i.manualStatus ?? null,
  }));

  let linkedAssetContext: {
    assetId: number;
    assetName: string;
    assetCategory: string;
    rooms: Array<{ id: number; name: string; roomType: string }>;
    equipments: Array<{ id: number; name: string; type: string | null; category: string | null }>;
  } | undefined;

  if (linkedAssetId) {
    const linkedAsset = userAssets.find(a => a.id === linkedAssetId);
    if (linkedAsset) {
      linkedAssetContext = {
        assetId: linkedAsset.id,
        assetName: linkedAsset.name,
        assetCategory: linkedAsset.category,
        rooms: linkedAssetRooms,
        equipments: linkedAssetEquipments,
      };
    }
  }

  return { userAssets, existingTitles, existingAgendaItems, linkedAssetContext };
}

// ── Auto-commit d'un groupe ───────────────────────────────────────────────────

async function autoCommitGroup(
  leadFileId: number,
  accountId: number,
  agendaEffects: import('@/types/document-ai').AgendaEffect[],
): Promise<'ANALYZED' | 'VALIDATION_REQUIRED' | 'CONFLICT_DETECTED'> {
  const proposals = await db.select()
    .from(documentAnalysisProposals)
    .where(eq(documentAnalysisProposals.assetFileId, leadFileId));

  const hasRoomSuggestions = proposals.some(p => p.targetKey === 'linkedRoomId' && p.status === 'pending');
  const hasEquipmentSuggestions = proposals.some(p => p.targetKey === 'equipmentId' && p.status === 'pending');
  const hasLowConfidenceAssetLink = proposals
    .filter(p => p.targetKey === 'matchedAssetId' && p.status === 'pending')
    .some(p => !p.confidence || parseFloat(p.confidence) < HIGH_CONFIDENCE_THRESHOLD);
  const allHighConfidence = proposals
    .filter(p => p.proposalType === 'field' && p.status === 'pending')
    .every(p => p.confidence ? parseFloat(p.confidence) >= HIGH_CONFIDENCE_THRESHOLD : false);
  const hasPending = proposals.some(p => p.status === 'pending');

  // Propositions field à haute confiance (à auto-commiter dans tous les cas VALIDATION_REQUIRED)
  const highConfFieldProposals = proposals.filter(p =>
    p.proposalType === 'field'
    && p.status === 'pending'
    && p.confidence
    && parseFloat(p.confidence) >= HIGH_CONFIDENCE_THRESHOLD
  );

  if (hasRoomSuggestions || hasEquipmentSuggestions || hasLowConfidenceAssetLink) {
    // Le commit complet est bloqué par des suggestions room/equipment/lien basse confiance
    // Mais on auto-commit quand même les champs à haute confiance (fournisseur, titre, date…)
    if (highConfFieldProposals.length > 0) {
      await autoCommitHighConfFields(leadFileId, highConfFieldProposals);
    }
    await setAnalysisState(leadFileId, 'VALIDATION_REQUIRED');
    return 'VALIDATION_REQUIRED';
  }

  if (!hasPending) {
    await setAnalysisState(leadFileId, 'ANALYZED');
    return 'ANALYZED';
  }

  if (allHighConfidence) {
    try {
      await commitDocument(leadFileId, accountId, agendaEffects);
      await setAnalysisState(leadFileId, 'ANALYZED');
      return 'ANALYZED';
    } catch {
      await setAnalysisState(leadFileId, 'CONFLICT_DETECTED');
      return 'CONFLICT_DETECTED';
    }
  }

  // Certaines propositions field ont une confiance faible
  // → on auto-commit uniquement les champs à haute confiance
  if (highConfFieldProposals.length > 0) {
    await autoCommitHighConfFields(leadFileId, highConfFieldProposals);
  }
  await setAnalysisState(leadFileId, 'VALIDATION_REQUIRED');
  return 'VALIDATION_REQUIRED';
}

// ── Auto-commit partiel des champs haute confiance ────────────────────────────

const HIGH_CONF_COLUMN_MAP: Record<string, string> = {
  retainedTitle: 'retainedTitle',
  retainedFunctionCode: 'retainedFunctionCode',
  supplier: 'supplier',
  documentDate: 'documentDate',
  amountCents: 'amountCents',
  description: 'description',
  notes: 'notes',
};

async function autoCommitHighConfFields(
  leadFileId: number,
  highConfProposals: typeof documentAnalysisProposals.$inferSelect[],
): Promise<void> {
  const fileUpdate: Record<string, unknown> = {};
  const keptIds: number[] = [];

  for (const p of highConfProposals) {
    const col = HIGH_CONF_COLUMN_MAP[p.targetKey];
    if (!col) continue;
    try {
      fileUpdate[col] = JSON.parse(p.proposedValueJson!);
    } catch {
      fileUpdate[col] = p.proposedValueJson;
    }
    keptIds.push(p.id);
  }

  if (Object.keys(fileUpdate).length === 0) return;

  await db.update(assetFiles)
    .set({ ...fileUpdate, updatedAt: new Date() })
    .where(eq(assetFiles.id, leadFileId));

  // Marquer comme "kept" pour ne pas les proposer à nouveau
  if (keptIds.length > 0) {
    await db.update(documentAnalysisProposals)
      .set({ status: 'kept', finalValueJson: documentAnalysisProposals.proposedValueJson })
      .where(inArray(documentAnalysisProposals.id, keptIds));
  }
}

// ── Broadcast final + notification ───────────────────────────────────────────

// Diffuse l'état final d'un groupe vers les onglets ouverts (SSE).
// NB (Lot 0) : ne crée plus de notification par fichier. La notification
// document est désormais émise une seule fois à la clôture du lot, dans
// `runUnifiedAnalysisPipeline` (cf. CDC §7.2 « une seule notification par lot »).
async function broadcastFinal(leadFileId: number, finalState: string) {
  const finalProposals = await db
    .select().from(documentAnalysisProposals)
    .where(eq(documentAnalysisProposals.assetFileId, leadFileId));

  broadcast(leadFileId, {
    type: 'done',
    analysisState: finalState,
    proposals: finalProposals.map(p => ({
      id: p.id,
      proposalType: p.proposalType,
      targetKey: p.targetKey,
      displayLabel: p.displayLabel,
      proposedValueJson: p.proposedValueJson,
      confidence: p.confidence,
      status: p.status,
    })),
  });
}

// ── Point d'entrée principal ──────────────────────────────────────────────────

export async function runUnifiedAnalysisPipeline(
  fileIds: number[],
  accountId: number,
): Promise<void> {
  if (fileIds.length === 0) return;

  // Récupérer userId depuis le premier fichier
  const [firstFile] = await db.select({ userId: assetFiles.userId })
    .from(assetFiles).where(eq(assetFiles.id, fileIds[0])).limit(1);
  const userId = firstFile?.userId;
  if (!userId) return;

  // ── Vérification que tous les fichiers appartiennent bien à ce compte ────
  // CRITIQUE : sécurité inter-compte — empêche la contamination entre comptes
  // même si un appelant transmet des fileIds d'un autre compte.
  const ownedFiles = await db
    .select({ id: assetFiles.id })
    .from(assetFiles)
    .where(and(inArray(assetFiles.id, fileIds), eq(assetFiles.accountId, accountId)));
  const ownedSet = new Set(ownedFiles.map(f => f.id));
  const filteredIds = fileIds.filter(fid => ownedSet.has(fid));
  if (filteredIds.length === 0) {
    console.warn(`[pipeline] Aucun fichier valide pour le compte ${accountId} — abandon`);
    return;
  }
  fileIds = filteredIds;

  // ── Déduplication : ignorer les fichiers déjà en cours d'analyse ──────────
  // Évite qu'un même document ne soit analysé deux fois en parallèle
  // (ex: double-clic, confirm + check-pending simultanés).
  const currentStates = await db
    .select({ id: assetFiles.id, analysisState: assetFiles.analysisState })
    .from(assetFiles)
    .where(inArray(assetFiles.id, fileIds));

  const inProgressIds = new Set(
    currentStates.filter(f => f.analysisState === 'ANALYZING').map(f => f.id)
  );
  const deduplicatedIds = fileIds.filter(fid => !inProgressIds.has(fid));
  if (deduplicatedIds.length === 0) {
    console.info(`[pipeline] Tous les fichiers (${fileIds.length}) sont déjà en cours d'analyse pour le compte ${accountId} — abandon`);
    return;
  }
  if (deduplicatedIds.length < fileIds.length) {
    console.info(`[pipeline] ${fileIds.length - deduplicatedIds.length} fichier(s) déjà en cours d'analyse, ignoré(s).`);
  }
  fileIds = deduplicatedIds;

  // ── Vérification quota ─────────────────────────────────────────────────────
  const quotaGate = await canConsumeAnalysis(accountId, fileIds.length);
  if (!quotaGate.allowed) {
    // Laisser analysisState à null — le recovery les reprendra dès que du crédit est disponible
    // (ne pas écrire d'état fictif qui compliquerait la détection)
    console.info(`[pipeline] Quota insuffisant pour account ${accountId} — ${fileIds.length} doc(s) en attente de crédit.`);
    return;
  }

  // ── Créer le lot journal ───────────────────────────────────────────────────
  const [lot] = await db.insert(documentLots).values({
    accountId,
    status: 'analyzing',
  }).returning({ id: documentLots.id });

  const lotId = lot.id;

  await db.insert(documentLotItems).values(
    fileIds.map((fid, i) => ({
      lotId,
      assetFileId: fid,
      position: i,
      analysisStatus: 'analyzing' as const,
    }))
  );

  // Passer tous les fichiers en ANALYZING
  await db.update(assetFiles)
    .set({ analysisState: 'ANALYZING', updatedAt: new Date() })
    .where(inArray(assetFiles.id, fileIds));

  // ── Résoudre les URLs S3 ───────────────────────────────────────────────────
  const fileInfos = (await Promise.all(fileIds.map(resolveFileUrl))).filter(
    (f): f is NonNullable<typeof f> => f !== null
  );

  if (fileInfos.length === 0) {
    await db.update(documentLots).set({ status: 'partially_failed' }).where(eq(documentLots.id, lotId));
    return;
  }

  // ── Passe 0 : regroupement Gemini (si N > 1) ──────────────────────────────
  let groups: number[][] = fileInfos.map((_, i) => [i]);

  if (fileInfos.length > 1) {
    try {
      const groupingResult = await callGeminiWithFallback({
        promptVersion: PROMPT_VERSIONS.detect_groups,
        fileUrls: fileInfos.map(f => f.url),
        mimeType: 'application/pdf',
        fileMimeTypes: fileInfos.map(f => f.mimeType),
        promptSubstitutions: { COUNT: fileInfos.length.toString() },
      });
      const detected = groupingResult.parsed as number[][];
      if (Array.isArray(detected) && detected.length > 0) {
        groups = detected;
      }
    } catch (err) {
      console.warn('[unified-pipeline] Passe 0 échouée, on continue sans regroupement:', (err as Error).message);
    }
  }

  // ── Analyse en parallèle par groupe ───────────────────────────────────────
  let analysedCount = 0;

  await Promise.all(groups.map(async (groupIndices) => {
    const groupFiles = groupIndices.map(i => fileInfos[i]).filter(Boolean);
    if (groupFiles.length === 0) return;

    const leadFile = groupFiles[0];
    const allFileIds = groupFiles.map(f => f.id);
    const allUrls = groupFiles.map(f => f.url);
    const linkedAssetId = leadFile.assetId;

    broadcast(leadFile.id, { type: 'state_update', analysisState: 'ANALYZING', stage: 'analyzing' });

    // Démarrer le tracking IA pour ce groupe
    const operationId = await AiUsageTracker.startOperation({
      accountId,
      userId,
      assetFileId: leadFile.id,
      operationCategory: 'document_analysis',
      origin: 'upload',
      isBillable: true,
    }).catch(() => null);

    try {
      const { userAssets, existingTitles, existingAgendaItems, linkedAssetContext } =
        await loadAnalysisContext(accountId, linkedAssetId);

      // Suivi des étapes pipeline
      const STEP_ORDER = ['lecture', 'extraction', 'analyse', 'alimentation'];
      let currentStepId: number | null = null;
      let currentStepOrder = 0;

      const startStep = async (stage: string) => {
        if (!operationId) return;
        if (currentStepId) {
          AiUsageTracker.completeStep({ stepId: currentStepId, status: 'done' }).catch(() => {});
        }
        const order = STEP_ORDER.indexOf(stage);
        currentStepOrder = order >= 0 ? order + 1 : currentStepOrder + 1;
        currentStepId = await AiUsageTracker.startStep({
          operationId,
          stepName: stage,
          stepOrder: currentStepOrder,
          provider: 'gemini',
          model: 'gemini-2.5-flash',
        }).catch(() => null);
      };

      const result = await analyzeDocument({
        assetFileId: leadFile.id,
        assetFileIds: allFileIds,
        lotId,
        signedUrl: leadFile.url,
        signedUrls: allUrls,
        mimeType: leadFile.mimeType,
        promptVersion: PROMPT_VERSIONS.extract_full,
        accountId,
        userAssets,
        existingTitles,
        existingAgendaItems,
        linkedAssetContext,
        onProgress: async (stage: string) => {
          broadcast(leadFile.id, { type: 'progress', analysisState: 'ANALYZING', stage });
          await startStep(stage);
        },
      });

      // Compléter la dernière étape
      if (currentStepId) {
        AiUsageTracker.completeStep({ stepId: currentStepId, status: 'done' }).catch(() => {});
      }

      // Mettre à jour les lot items
      await db.update(documentLotItems)
        .set({ analysisStatus: 'completed', currentAnalysisRunId: result.runId })
        .where(and(
          eq(documentLotItems.lotId, lotId),
          inArray(documentLotItems.assetFileId, allFileIds),
        ));

      // Auto-commit
      const finalState = await autoCommitGroup(leadFile.id, accountId, result.agendaEffects);
      let isDuplicate = false;

      // Détection de doublons post-analyse (AVANT completeOperation pour ne pas compter le doublon dans le quota)
      try {
        const { detectFusionCandidates } = await import('./fusion-detector');
        const fusionResult = await detectFusionCandidates(leadFile.id, accountId);
        if (fusionResult.hasCandidates) {
          // Ne PAS override VALIDATION_REQUIRED → les propositions (fournisseur, date…)
          // n'ont pas été commitées et doivent pouvoir être validées par l'utilisateur.
          if (finalState === 'ANALYZED') {
            await db.update(assetFiles)
              .set({ analysisState: 'FUSION_SUGGESTED', updatedAt: new Date() })
              .where(eq(assetFiles.id, leadFile.id));
          }
          isDuplicate = true;
        }
      } catch { /* non-bloquant */ }

      if (isDuplicate && finalState === 'ANALYZED') {
        // Document doublon : ne pas compter dans analysedCount, ni dans le quota AI
        if (operationId) {
          AiUsageTracker.completeOperation({
            operationId,
            businessResult: 'duplicate', // ne sera pas compté dans incrementAnalysisCounter
            totalCostMicros: result.totalCostMicros ?? 0,
            totalInputTokens: result.totalInputTokens ?? 0,
            totalOutputTokens: result.totalOutputTokens ?? 0,
            usedFallback: result.usedFallback,
            providerFallback: result.usedFallback ? result.modelUsed : undefined,
          }).catch(() => {});
        }
        // Broadcast final avec FUSION_SUGGESTED
        await broadcastFinal(leadFile.id, 'FUSION_SUGGESTED');
        return; // Pas de post-processing pour un doublon
      }

      // Si un doublon a été détecté mais que le doc est en VALIDATION_REQUIRED,
      // on ne change pas l'état — l'utilisateur valide d'abord ses champs
      // On compte quand même comme analyse réussie pour le suivi de quota

      analysedCount++;

      // Compléter le tracking IA (document normal, pas doublon)
      if (operationId) {
        AiUsageTracker.completeOperation({
          operationId,
          businessResult: 'success',
          totalCostMicros: result.totalCostMicros ?? 0,
          totalInputTokens: result.totalInputTokens ?? 0,
          totalOutputTokens: result.totalOutputTokens ?? 0,
          usedFallback: result.usedFallback,
          providerFallback: result.usedFallback ? result.modelUsed : undefined,
        }).catch(() => {});
      }

      // Vérifications sécurité (fire-and-forget)
      AiUsageTracker.checkSecurityRules({
        accountId,
        assetFileId: leadFile.id,
        totalCostMicros: result.totalCostMicros ?? 0,
        checkCost: true,
      }).catch(() => {});

      // Soft-delete des fichiers secondaires si commit réussi
      if (finalState === 'ANALYZED' && allFileIds.length > 1) {
        const secondaryIds = allFileIds.slice(1);
        await db.update(assetFiles)
          .set({ deletedAt: new Date() })
          .where(inArray(assetFiles.id, secondaryIds));
        await db.update(documentLotItems)
          .set({ commitStatus: 'committed' })
          .where(and(
            eq(documentLotItems.lotId, lotId),
            inArray(documentLotItems.assetFileId, secondaryIds),
          ));
      }

      // Broadcast final + notification
      await broadcastFinal(leadFile.id, finalState);

      // Post-commit non-bloquant
      if (finalState === 'ANALYZED') {
        const [refreshed] = await db.select({ assetId: assetFiles.assetId })
          .from(assetFiles).where(eq(assetFiles.id, leadFile.id)).limit(1);
        const resolvedAssetId = refreshed?.assetId ?? linkedAssetId;
        if (resolvedAssetId) {
          // ⚠️ L'ÉCHEC ÉTAIT AVALÉ. `.catch(() => {})` faisait disparaître
          // sans trace une clé Gemini absente, un quota atteint ou une
          // réponse illisible : le traitement d'alimentation « ne tournait
          // pas » sans qu'aucune ligne de journal ne l'indique.
          void triggerAssetEnrichment({
            assetId: resolvedAssetId,
            accountId,
            assetFileId: leadFile.id,
            reason: 'document_analyzed',
          });
          linkDocumentToEquipments(leadFile.id, accountId, result.equipmentCandidates).catch(() => {});
        }
      }

    } catch (err) {
      const failReason = (err as Error).message ?? 'Erreur inconnue';
      console.error(`[unified-pipeline] Groupe leadFile=${leadFile.id} FAILED:`, err);

      if (operationId) {
        AiUsageTracker.completeOperation({
          operationId,
          businessResult: 'error',
          errorMessage: failReason,
        }).catch(() => {});
      }

      await db.update(documentLotItems)
        .set({ analysisStatus: 'failed' })
        .where(and(
          eq(documentLotItems.lotId, lotId),
          inArray(documentLotItems.assetFileId, allFileIds),
        ));

      for (const fid of allFileIds) {
        const retryCount = await setAnalysisState(fid, 'ANALYSIS_FAILED', failReason);
        broadcast(fid, { type: 'error', analysisState: 'ANALYSIS_FAILED', message: failReason });

        if (retryCount >= 10) {
          const [fileRow] = await db.select({ userId: assetFiles.userId, retainedTitle: assetFiles.retainedTitle, originalFilename: assetFiles.originalFilename, analysisState: assetFiles.analysisState })
            .from(assetFiles).where(eq(assetFiles.id, fid)).limit(1);
          if (fileRow?.userId && fileRow.analysisState === 'ANALYSIS_FAILED') {
            const documentTitle = fileRow.retainedTitle || fileRow.originalFilename || undefined;
            await emit({
              type: 'ANALYSIS_FAILED_PERSISTENT',
              recipientUserIds: [fileRow.userId],
              accountId,
              entityType: 'asset_file',
              entityId: fid,
              payload: { assetFileId: fid, documentTitle, errorReason: failReason },
              dedupeKey: `document:analysis-failed-persistent:${fid}`,
            });
          }
        }
      }
    }
  }));

  // ── Consommer les crédits quota ────────────────────────────────────────────
  if (analysedCount > 0) {
    await consumeAnalysisCredits(accountId, analysedCount).catch(() => {});
  }

  // ── Mettre à jour le statut du lot ────────────────────────────────────────
  const lotItemStatuses = await db.select({ status: documentLotItems.analysisStatus })
    .from(documentLotItems)
    .where(eq(documentLotItems.lotId, lotId));

  const failedCount = lotItemStatuses.filter(i => i.status === 'failed').length;
  const completedCount = lotItemStatuses.filter(i => i.status === 'completed').length;

  const lotFinalStatus = failedCount > 0 ? 'partially_failed' : 'committed';
  await db.update(documentLots)
    .set({ status: lotFinalStatus, committedAt: new Date() })
    .where(eq(documentLots.id, lotId));

  // ── Notification unique par lot (cf. CDC §7.2) ─────────────────────────────
  // Émise via le service central : un seul enregistrement, quel que soit le
  // nombre de fichiers/groupes ; canaux et préférences appliqués par le moteur.
  try {
    const batchType =
      completedCount === 0 ? 'DOCUMENT_BATCH_FAILED'
      : failedCount > 0 ? 'DOCUMENT_BATCH_PARTIALLY_FAILED'
      : 'DOCUMENT_BATCH_COMPLETED';

    await emit({
      type: batchType,
      recipientUserIds: [userId],
      accountId,
      entityType: 'document_lot',
      entityId: lotId,
      payload: { lotId, analysedCount: completedCount, failedCount },
      // Clé stable par lot (le moteur ajoute l'utilisateur).
      dedupeKey: `document:batch-complete:${lotId}`,
    });
  } catch (err) {
    console.error('[unified-pipeline] notification de lot échouée (non-bloquant):', err);
  }
}
