/**
 * GET /api/documents/[id]/stream
 * Endpoint SSE — pousse les mises à jour d'analysisState en temps réel.
 * Le client s'y abonne quand analysisState === 'ANALYZING'.
 * Le stream se ferme automatiquement sur état terminal.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { registerAnalysisStreamWriter } from '@/services/ai/source-analysis/entrypoint';
import { isTerminalAnalysisState } from '@/types/domain';

export const maxDuration = 300;

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

  (async () => {
    try {
      const session = await getSession(request);
      const { id: rawId } = await params;
      const accountId = session.currentAccountId;

      if (!accountId) {
        await writer.write(sseEvent({ type: 'error', code: 'NO_ACCOUNT' }));
        return;
      }

      const assetFileId = parseInt(rawId);
      if (isNaN(assetFileId)) {
        await writer.write(sseEvent({ type: 'error', code: 'INVALID_ID' }));
        return;
      }

      // Verify ownership
      const [file] = await db.select({
        id: assetFiles.id,
        analysisState: assetFiles.analysisState,
      }).from(assetFiles).where(
        and(eq(assetFiles.id, assetFileId), eq(assetFiles.accountId, accountId))
      ).limit(1);

      if (!file) {
        await writer.write(sseEvent({ type: 'error', code: 'NOT_FOUND' }));
        return;
      }

      // If already terminal, send current state and close
      if (isTerminalAnalysisState(file.analysisState)) {
        await writer.write(sseEvent({ type: 'state_update', analysisState: file.analysisState }));
        await writer.write(sseEvent({ type: 'done', analysisState: file.analysisState }));
        return;
      }

      // Send current state immediately
      await writer.write(sseEvent({ type: 'state_update', analysisState: file.analysisState ?? 'ANALYZING' }));

      // Keep-alive ping every 20s
      const keepAlive = setInterval(async () => {
        try { await writer.write(sseEvent({ type: 'ping' })); } catch { clearInterval(keepAlive); }
      }, 20_000);

      // Abonnement aux deux registres de diffusion — voir
       // `registerAnalysisStreamWriter`. Sans cela, le flux se tairait dès que
       // le drapeau passe à `enabled`.
      const unregister = await registerAnalysisStreamWriter(assetFileId, async (data) => {
        try {
          await writer.write(sseEvent(data));
          // Close stream on terminal state
          if (data.type === 'done' || data.type === 'error' || isTerminalAnalysisState(data.analysisState as string | null)) {
            clearInterval(keepAlive);
            unregister();
            try { await writer.close(); } catch { /* already closed */ }
          }
        } catch { /* client disconnected */ }
      });

      // Auto-timeout after 5 minutes
      setTimeout(async () => {
        clearInterval(keepAlive);
        unregister();
        try {
          await writer.write(sseEvent({ type: 'timeout' }));
          await writer.close();
        } catch { /* already closed */ }
      }, 5 * 60 * 1000);

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        unregister();
      });

    } catch (error) {
      if (error instanceof Response) {
        try { await writer.write(sseEvent({ type: 'error', code: 'AUTH_ERROR' })); } catch { /* ignore */ }
      } else {
        console.error('GET /api/documents/[id]/stream error:', error);
        try { await writer.write(sseEvent({ type: 'error', code: 'INTERNAL_ERROR' })); } catch { /* ignore */ }
      }
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  return response;
}
