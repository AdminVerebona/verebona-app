/**
 * POST /api/documents/[id]/analyze
 * [id] = asset_files.id
 * Déclenche l'analyse IA d'un document (réanalyse depuis le tiroir).
 * Utilise un stream SSE pour garder la connexion ouverte (évite le timeout HTTP de 120s en dev).
 *
 * Délégation intégrale au pipeline (`analyzeFileSources`, prompt maître T1) :
 * quota, déduplication, état du fichier, contexte du compte, preuves, crédits
 * et déclenchement des moteurs aval sont assurés par `runSourceAnalysis`. La
 * route ne fait que l'authentification et le transport SSE.
 *
 * Lot 16b-3 : le chemin historique (`analyzeDocument`, complétion des champs
 * vides, seuil de confiance 0,7, ancien suivi d'usage, coût codé en dur) est supprimé —
 * le coût est mesuré par la seule passerelle, aux tarifs de `ai_model_pricing`.
 * Échec de l'analyse : `error` / `ANALYSIS_FAILED` sur le flux avec le motif
 * (affiché par le tiroir), le document garde son motif et repart en file
 * durable (nouvelle tentative avec backoff). Un job T1 vivant pour ce document
 * → `ALREADY_ANALYZING` (pas de double appel au master).
 */

import { NextRequest } from 'next/server';
import type { RunSourceAnalysisOutput } from '@/services/ai/source-analysis/pipeline';

// Indication de segment Next.js ; sans effet sur Scalingo (`next start`), où
// seule la coupure du routeur HTTP de l'hébergeur borne la requête.
export const maxDuration = 300;
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { canConsumeAnalysis } from '@/services/commercial-model.service';
import { refuserSiPasDIA } from '@/lib/write-access-guard';

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

      // ══════════════════════════════════════════════════════════════════
      // REFUS TRANSMIS PAR LE FLUX, NON PAR LE STATUT HTTP
      //
      // Cette route rend un flux SSE : les en-têtes sont déjà partis quand
      // ce contrôle s'exécute. Renvoyer un 403 ici n'atteindrait personne.
      // Le client lit `type: 'error'` et son `code`.
      // ══════════════════════════════════════════════════════════════════
      const refus = await refuserSiPasDIA(accountId);
      if (refus) {
        const { code, message } = await refus.json();
        await writer.write(sseEvent({ type: 'error', code, message }));
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

      await streamUnifiedAnalysis({
        assetFileId,
        accountId,
        userId: session.userId,
        write: (data) => writer.write(sseEvent(data)),
      });
    } catch (error) {
      if (error instanceof Response) {
        await writer.write(sseEvent({ type: 'error', code: 'AUTH_ERROR' }));
      } else {
        // Le pipeline ne lève pas (échecs écrits sur le fichier) : seule une
        // panne de transport ou d'authentification arrive ici.
        const failReason = (error as Error).message ?? 'Erreur inconnue';
        console.error('POST /api/documents/[id]/analyze error:', error);
        await writer.write(sseEvent({ type: 'error', code: 'INTERNAL_ERROR', message: failReason }));
      }
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  return response;
}

/**
 * Analyse : authentification déjà faite, transport SSE uniquement.
 *
 * Contrat vis-à-vis de l'interface : mêmes types d'événements et codes
 * d'erreur qu'avant la bascule. `done` ne porte pas de `runId` : l'interface
 * recharge sur `state_update`.
 */
async function streamUnifiedAnalysis(args: {
  assetFileId: number;
  accountId: number;
  userId: number;
  write: (data: Record<string, unknown>) => Promise<void>;
}): Promise<void> {
  const { assetFileId, accountId, userId, write } = args;

  const [owned] = await db
    .select({ id: assetFiles.id })
    .from(assetFiles)
    .where(and(eq(assetFiles.id, assetFileId), eq(assetFiles.accountId, accountId)))
    .limit(1);

  if (!owned) {
    await write({ type: 'error', code: 'NOT_FOUND' });
    return;
  }

  // Lot 22 : plafond IA du mois du compte atteint — rien n'est lancé ; le
  // document (déjà reporté, ou reporté par le pipeline ci-dessous) sera
  // analysé automatiquement au début du mois suivant.
  try {
    const { costCapReachedFor, costCapAnalysisReason } = await import('@/services/ai/gateway/account-cost-cap');
    const cap = await costCapReachedFor(accountId);
    if (cap) {
      const { listLiveTargets } = await import('@/services/ai/queue/job-queue.repository');
      if ((await listLiveTargets('T1', 'asset_file', [assetFileId])).size > 0) {
        await write({ type: 'error', code: 'ANALYSIS_COST_CAP_REACHED', message: costCapAnalysisReason(cap.resumeAt) });
        return;
      }
    }
  } catch { /* plafond illisible : le pipeline le contrôle de nouveau */ }

  // Revue 3a : un job T1 vivant (en attente ou en cours, par exemple remis en
  // file après un échec) traitera ce document — une analyse directe en
  // parallèle doublerait l'appel au master. Refus explicite, motif affiché.
  try {
    const { listLiveTargets } = await import('@/services/ai/queue/job-queue.repository');
    if ((await listLiveTargets('T1', 'asset_file', [assetFileId])).size > 0) {
      await write({
        type: 'error', code: 'ALREADY_ANALYZING',
        message: 'Ce document est déjà en file d’analyse : il sera analysé automatiquement dans quelques instants.',
      });
      return;
    }
  } catch { /* file illisible : l'analyse directe reste possible (comportement antérieur) */ }

  const { analyzeFileSources, registerAnalysisStreamWriter } =
    await import('@/services/ai/source-analysis/entrypoint');

  // Relais de la progression émise par le pipeline vers ce flux.
  const unregister = await registerAnalysisStreamWriter(assetFileId, (data) => {
    void write(data);
  });

  const keepAlive = setInterval(() => { void write({ type: 'ping' }); }, 20_000);

  try {
    const outcome = await analyzeFileSources([assetFileId], accountId, {
      userId,
      origin: 'documents/analyze',
    });

    // Le pipeline gère quota et déduplication : la route se contente de
    // traduire son verdict dans les codes que l'interface connaît déjà.
    //
    // Table typée sur les motifs réels de `RunSourceAnalysisOutput` : si le
    // pipeline en ajoute un, le compilateur exige sa traduction ici plutôt que
    // de laisser l'interface recevoir un `done` trompeur.
    const SKIP_CODES: Record<NonNullable<RunSourceAnalysisOutput['skippedReason']>, string> = {
      quota: 'ANALYSIS_QUOTA_REACHED',
      already_running: 'ALREADY_ANALYZING',
      no_valid_source: 'NOT_FOUND',
      cost_cap: 'ANALYSIS_COST_CAP_REACHED',
    };

    const SKIP_MESSAGES: Record<NonNullable<RunSourceAnalysisOutput['skippedReason']>, string> = {
      quota: 'Quota d’analyse atteint : le document n’a pas été analysé.',
      already_running: 'Ce document est déjà en cours d’analyse : le résultat s’affichera à la fin.',
      no_valid_source: 'Document introuvable ou non analysable.',
      cost_cap: 'Plafond IA du mois atteint : l’analyse sera lancée automatiquement le 1er du mois.',
    };

    if (outcome?.skippedReason) {
      // Lot 22 : motif daté (« reprise le 1er novembre »), comme sur le document.
      const message = outcome.skippedReason === 'cost_cap' && outcome.costCap
        ? (await import('@/services/ai/gateway/account-cost-cap')).costCapAnalysisReason(new Date(outcome.costCap.resumeAt))
        : SKIP_MESSAGES[outcome.skippedReason];
      await write({ type: 'error', code: SKIP_CODES[outcome.skippedReason], message });
      return;
    }

    // Panne inattendue du pipeline (`null`, déjà journalisée) : rien n'a été
    // remis en file — la reprise serveur (`analysis-recovery`) retrouvera le
    // document bloqué après une dizaine de minutes. Jamais un `done` trompeur.
    if (!outcome) {
      await write({
        type: 'error', code: 'ANALYSIS_FAILED',
        message: 'Analyse interrompue par une erreur technique : elle sera relancée automatiquement dans une dizaine de minutes.',
      });
      return;
    }

    // Échec de l'analyse (master T1, persistance) : le document garde son
    // motif (ANALYSIS_FAILED) et repart en file durable (`analyzeFileSources`),
    // sauf échec définitif déjà repris (voir `failure-policy`).
    if (outcome.failedSourceIds.includes(assetFileId)) {
      const [f] = await db.select({ reason: assetFiles.analysisFailReason })
        .from(assetFiles).where(eq(assetFiles.id, assetFileId)).limit(1);
      await write({ type: 'error', code: 'ANALYSIS_FAILED', message: f?.reason ?? 'Analyse impossible.' });
      return;
    }

    await write({ type: 'done' });
  } finally {
    clearInterval(keepAlive);
    unregister();
  }
}
