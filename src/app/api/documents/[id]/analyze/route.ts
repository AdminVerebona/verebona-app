/**
 * POST /api/documents/[id]/analyze
 * [id] = asset_files.id
 * Déclenche un run d'analyse IA sur un document.
 * Utilise un stream SSE pour garder la connexion ouverte (évite le timeout HTTP de 120s en dev).
 */

import { NextRequest } from 'next/server';

export const maxDuration = 300; // 5 minutes — Vercel only
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { assetFiles, assets } from '@/db/schema';
import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { analyzeDocument } from '@/services/document-ai/analyze-document';
import { PROMPT_VERSIONS } from '@/services/document-ai/gemini-client';
import { agendaFileLinks, agendaItemSources, agendaItems, rooms, equipments } from '@/db/schema';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from '@/lib/s3-client';
import { applyAiSuggestionsToAsset } from '@/services/document-ai/apply-ai-suggestions';
import { canConsumeAnalysis, consumeAnalysisCredits } from '@/services/commercial-model.service';
import { AiUsageTracker } from '@/services/document-ai/ai-usage-tracker';

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Consommer le body avant le début du streaming (il ne peut être lu qu'une fois).
  // Lot 0 : l'ancien flag `skipNotification` est retiré — cette route ne crée plus
  // de notification par fichier (cf. CDC §7.2).
  await request.json().catch(() => ({}));

  const encoder = new TextEncoder();

  const stream = new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(encoder.encode(chunk));
    },
  });
  const writer = stream.writable.getWriter();

  const response = new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });

  // Run analysis in background, stream progress
  (async () => {
    try {
      const session = await getSession(request);

      if (!session) {
        await writer.write(sseEvent({ type: 'error', code: 'UNAUTHORIZED' }));
        return;
      }
      
      const { id: rawId } = await params;
      const accountId = session.currentAccountId;

      if (!accountId) {
        await writer.write(sseEvent({ type: 'error', code: 'NO_ACCOUNT' }));
        return;
      }

      const quotaGate = await canConsumeAnalysis(accountId, 1);
      if (!quotaGate.allowed) {
        await writer.write(sseEvent({ type: 'error', code: quotaGate.reason || 'ANALYSIS_QUOTA_REACHED' }));
        return;
      }

      const assetFileId = parseInt(rawId);
      if (isNaN(assetFileId)) {
        await writer.write(sseEvent({ type: 'error', code: 'INVALID_ID' }));
        return;
      }

      const [file] = await db.select().from(assetFiles).where(
        and(eq(assetFiles.id, assetFileId), eq(assetFiles.accountId, accountId))
      ).limit(1);

      if (!file) {
        await writer.write(sseEvent({ type: 'error', code: 'NOT_FOUND' }));
        return;
      }

      // Déduplication : si déjà en cours d'analyse, ne pas relancer
      if (file.analysisState === 'ANALYZING') {
        await writer.write(sseEvent({ type: 'error', code: 'ALREADY_ANALYZING', message: 'Analyse déjà en cours' }));
        return;
      }

      // Marquer immédiatement en ANALYZING en base — permet à la recovery et au polling
      // de détecter un timeout Vercel si la fonction est coupée avant d'écrire l'état final.
      await db.update(assetFiles)
        .set({ analysisState: 'ANALYZING', updatedAt: new Date() })
        .where(eq(assetFiles.id, assetFileId));

      await writer.write(sseEvent({ type: 'progress', stage: 'preparing' }));

      let signedUrl: string;
      let mimeType: string;

      if (file.mimeType === 'application/x-web-link') {
        if (!file.webLinkUrl) {
          await writer.write(sseEvent({ type: 'error', code: 'WEB_LINK_URL_MISSING' }));
          return;
        }
        signedUrl = file.webLinkUrl;
        mimeType = 'text/html';
      } else {
        if (!file.s3Key || !file.s3Bucket) {
          await writer.write(sseEvent({ type: 'error', code: 'FILE_NOT_IN_STORAGE' }));
          return;
        }
        const command = new GetObjectCommand({ Bucket: file.s3Bucket, Key: file.s3Key });
        signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        mimeType = file.mimeType ?? 'application/pdf';
      }

      const linkedAssetId = file.assetId ?? null;

      const [userAssets, existingTitlesRows, existingAgendaViaLinks, existingAgendaViaSources, linkedAssetRooms, linkedAssetEquipments] = await Promise.all([
        db
          .select({ id: assets.id, name: assets.name, category: assets.category, registrationNumber: assets.registrationNumber, subtype: assets.subtype, engineInfo: assets.engineInfo })
          .from(assets)
          .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt)))
          .limit(50),
        db
          .select({ retainedTitle: assetFiles.retainedTitle })
          .from(assetFiles)
          .where(and(
            eq(assetFiles.accountId, accountId),
            isNotNull(assetFiles.retainedTitle),
            isNull(assetFiles.deletedAt),
          ))
          .limit(100),
        // Agenda items linked via agenda_file_links (user-created from suggestions)
        db
          .select({ title: agendaItems.title, startDate: agendaItems.startDate })
          .from(agendaFileLinks)
          .innerJoin(agendaItems, eq(agendaFileLinks.agendaItemId, agendaItems.id))
          .where(eq(agendaFileLinks.assetFileId, assetFileId)),
        // Agenda items created by a previous analysis run on this file (via agendaItemSources)
        db
          .select({ title: agendaItems.title, startDate: agendaItems.startDate })
          .from(agendaItemSources)
          .innerJoin(agendaItems, eq(agendaItemSources.agendaItemId, agendaItems.id))
          .where(eq(agendaItemSources.assetFileId, assetFileId)),
        // Rooms of the already-linked asset (if any) to help AI identify rooms more precisely
        linkedAssetId
          ? db.select({ id: rooms.id, name: rooms.name, roomType: rooms.roomType }).from(rooms).where(eq(rooms.assetId, linkedAssetId))
          : Promise.resolve([]),
        // Equipments of the already-linked asset (if any) to help AI identify equipment more precisely
        linkedAssetId
          ? db.select({ id: equipments.id, name: equipments.name, type: equipments.type, category: equipments.category }).from(equipments).where(eq(equipments.assetId, linkedAssetId))
          : Promise.resolve([]),
      ]);
      const existingTitles = existingTitlesRows
        .map(r => r.retainedTitle!)
        .filter(t => t.trim().length > 0);

      // Deduplicated list of existing agenda items linked to this document
      const existingAgendaItems = [
        ...existingAgendaViaLinks,
        ...existingAgendaViaSources,
      ].reduce<{ title: string; startDate: string | null }[]>((acc, item) => {
        if (!acc.some(a => a.title === item.title)) {
          acc.push({ title: item.title, startDate: item.startDate ?? null });
        }
        return acc;
      }, []);

      // Build linked asset context (only when asset was manually set before re-analysis)
      let linkedAssetContext: { assetId: number; assetName: string; assetCategory: string; rooms: { id: number; name: string; roomType: string }[]; equipments: { id: number; name: string; type: string | null; category: string | null }[] } | undefined;
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

      await writer.write(sseEvent({ type: 'progress', stage: 'analyzing' }));

      // Démarrer le tracking IA avant l'analyse
      const isReanalysis = file.analysisState === 'ANALYZED' || file.analysisState === 'VALIDATION_REQUIRED';
      const operationId = await AiUsageTracker.startOperation({
        accountId,
        userId: session.userId,
        assetFileId,
        operationCategory: 'document_analysis',
        origin: isReanalysis ? 'reanalyse' : 'upload',
        isBillable: true,
        isReanalysis,
      }).catch(() => null);

      // Keep-alive ping every 20s while Gemini works
      const keepAlive = setInterval(async () => {
        try { await writer.write(sseEvent({ type: 'ping' })); } catch { /* closed */ }
      }, 20_000);

      try {
        // Suivi des étapes pipeline
        const STEP_ORDER = ['lecture', 'extraction', 'analyse', 'alimentation'];
        let currentStepId: number | null = null;
        let currentStepOrder = 0;

        const startStep = async (stage: string) => {
          if (!operationId) return;
          // Compléter l'étape précédente
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
          assetFileId,
          signedUrl,
          mimeType,
          promptVersion: PROMPT_VERSIONS.extract_agenda,
          accountId,
          userAssets,
          existingTitles,
          existingAgendaItems,
          linkedAssetContext,
          onProgress: async (stage: string) => {
            await writer.write(sseEvent({ type: 'progress', stage }));
            await startStep(stage);
          },
        });
        clearInterval(keepAlive);

        // Déterminer l'état final et l'écrire en base
        // (la route single-doc n'appelle pas runUnifiedAnalysisPipeline, donc elle doit le faire elle-même)
        {
          const HIGH_CONF = 0.7;
          const proposals = result.proposals ?? [];
          const hasRoomSuggestions = proposals.some((p: any) => p.targetKey === 'linkedRoomId' && p.status === 'pending');
          const hasEquipmentSuggestions = proposals.some((p: any) => p.targetKey === 'equipmentId' && p.status === 'pending');
          const hasPending = proposals.some((p: any) => p.status === 'pending');
          const allHighConf = proposals
            .filter((p: any) => p.proposalType === 'field' && p.status === 'pending')
            .every((p: any) => p.confidence ? parseFloat(p.confidence) >= HIGH_CONF : false);

          let finalState: string;
          if (hasRoomSuggestions || hasEquipmentSuggestions) {
            finalState = 'VALIDATION_REQUIRED';
          } else if (!hasPending || allHighConf) {
            finalState = 'ANALYZED';
          } else {
            finalState = 'VALIDATION_REQUIRED';
          }
          await db.update(assetFiles)
            .set({ analysisState: finalState, updatedAt: new Date() })
            .where(eq(assetFiles.id, assetFileId));
        }

        // Compléter la dernière étape
        if (currentStepId) {
          AiUsageTracker.completeStep({ stepId: currentStepId, status: 'done' }).catch(() => {});
        }

        // Finaliser le tracking avec les métriques de coût
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

        // Vérifications sécurité (fire-and-forget, ne bloque pas la réponse)
        AiUsageTracker.checkSecurityRules({
          accountId,
          assetFileId,
          totalCostMicros: result.totalCostMicros ?? 0,
          checkReanalysis: isReanalysis,
          checkCost: true,
        }).catch(() => {});

        // Enrichir le bien lié — await pour que l'onglet Informations soit à jour
        // avant l'envoi du SSE done et la création de la notification.
        if (file.assetId) {
          await applyAiSuggestionsToAsset({
            assetId: file.assetId,
            accountId,
            assetFileId,
          }).catch(err => {
            console.error('[analyze] applyAiSuggestionsToAsset failed:', err);
          });
        }

        // Lot 0 — plus de notification cloche par fichier ici (cf. CDC §7.2 :
        // « la clôture du lot devient l'unique source métier »). Cette route est
        // une ré-analyse d'un document unique effectuée pendant que l'utilisateur
        // le consulte : il reçoit déjà l'événement SSE `done` ci-dessous. Les
        // imports multi-documents passent par runUnifiedAnalysisPipeline, qui émet
        // une seule notification de lot.

        await consumeAnalysisCredits(accountId, 1);

        await writer.write(sseEvent({ type: 'done', runId: result.runId }));
      } catch (err) {
        clearInterval(keepAlive);
        // Tracker l'échec
        if (operationId) {
          AiUsageTracker.completeOperation({
            operationId,
            businessResult: 'error',
            errorMessage: (err as Error)?.message ?? 'Erreur inconnue',
          }).catch(() => {});
        }
        throw err;
      }
    } catch (error) {
      if (error instanceof Response) {
        await writer.write(sseEvent({ type: 'error', code: 'AUTH_ERROR' }));
      } else {
        const failReason = (error as Error).message ?? 'Erreur inconnue';
        console.error('POST /api/documents/[id]/analyze error:', error);
        // Persister la raison d'échec en base pour affichage dans le drawer
        try {
          const { id: rawId } = await params;
          const assetFileId = parseInt(rawId);
          if (!isNaN(assetFileId)) {
            await db.update(assetFiles).set({ analysisState: 'ANALYSIS_FAILED', analysisFailReason: failReason, updatedAt: new Date() }).where(eq(assetFiles.id, assetFileId));
          }
        } catch { /* non-blocking */ }
        await writer.write(sseEvent({ type: 'error', code: 'INTERNAL_ERROR', message: failReason }));
      }
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  return response;
}
