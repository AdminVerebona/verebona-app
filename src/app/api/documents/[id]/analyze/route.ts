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
 * Échec de l'analyse : `error` / `ANALYSIS_FAILED` sur le flux avec le
 * statut fonctionnel (lot 34C : jamais le motif technique, conservé sur le
 * document pour BO › Exécutions IA), le document repart en file durable
 * (nouvelle tentative avec backoff). Un job T1 vivant pour ce document
 * → `ALREADY_ANALYZING` (pas de double appel au master).
 *
 * Lot 113U (carte #720 « Analyse T1 ko ») :
 *   · le relais du flux du pipeline ne transmet JAMAIS un `error` : l'échec
 *     publié par `failSources` (sans code, lu AVANT la remise en file) était
 *     le premier événement d'erreur lu par le tiroir → « Impossible de
 *     lancer l'analyse », puis « en file d'attente » à la relecture. Seule
 *     la route émet le verdict final, après la remise en file ;
 *   · une erreur de session levée par la garde (CGUV à accepter, double
 *     authentification, session révoquée, vérification impossible) est
 *     transmise avec SON code, et non plus `INTERNAL_ERROR` ;
 *   · un job T1 vivant est signalé (`ALREADY_ANALYZING`, statut fonctionnel
 *     et prochaine tentative) AVANT les contrôles d'offre : la file
 *     traitera le document, aucun refus trompeur ;
 *   · chaque refus porte une référence d'incident (`incidentRef`) et est
 *     journalisé (`document_analysis_launch_refusals`, BO › File d'attente IA).
 */

import { NextRequest } from 'next/server';
import type { RunSourceAnalysisOutput } from '@/services/ai/source-analysis/pipeline';

// Indication de segment Next.js ; sans effet sur Scalingo (`next start`), où
// seule la coupure du routeur HTTP de l'hébergeur borne la requête.
export const maxDuration = 300;
import { getSession } from '@/lib/auth-guards';
import { isKnownSessionError } from '@/lib/auth/session-errors';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { canConsumeAnalysis } from '@/services/commercial-model.service';
import { refuserSiPasDIA } from '@/lib/write-access-guard';
import { appVersionFromUserAgent, launchOriginOf, newIncidentRef } from '@/lib/ai/analysis-launch';
import { readClientContext } from '@/lib/mobile/client-context';

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Contexte de journalisation d'un refus (lot 113U), complété au fil des contrôles. */
interface RefusalContext {
  accountId: number | null;
  userId: number | null;
  assetFileId: number | null;
  client: ReturnType<typeof launchOriginOf>;
  appVersion: string | null;
}

/**
 * Lot 113U : verdict d'erreur de la route — référence d'incident, journal
 * (jamais bloquant), puis événement. Le texte affiché vient du référentiel
 * fermé du tiroir ; seuls les codes FONCTIONNELS gardent leur `message`.
 */
async function refuse(
  write: (data: Record<string, unknown>) => Promise<void>,
  ctx: RefusalContext,
  data: Record<string, unknown> & { code: string },
): Promise<void> {
  const incidentRef = newIncidentRef();
  try {
    const { recordLaunchRefusal } = await import('@/services/ai/source-analysis/launch-refusals');
    await recordLaunchRefusal({
      incidentRef, source: 'server', code: data.code, httpStatus: 200,
      assetFileId: ctx.assetFileId, accountId: ctx.accountId, userId: ctx.userId,
      client: ctx.client, appVersion: ctx.appVersion,
      processingStatus: typeof data.processingStatus === 'string' ? data.processingStatus : null,
      nextAttemptAt: typeof data.nextAttemptAt === 'string' ? data.nextAttemptAt : null,
      detail: { userMessageCode: data.userMessageCode, retryScheduled: data.retryScheduled },
    });
  } catch { /* le journal n'empêche jamais la réponse */ }
  await write({ type: 'error', ...data, incidentRef });
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
  const write = (data: Record<string, unknown>) => writer.write(sseEvent(data));

  const response = new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });

  const ua = request.headers.get('user-agent');
  const clientCtx = readClientContext(request);
  const ctx: RefusalContext = {
    accountId: null, userId: null, assetFileId: null,
    client: launchOriginOf(clientCtx.declared ? clientCtx.client : null, ua),
    appVersion: clientCtx.appVersion ?? appVersionFromUserAgent(ua),
  };

  // Run analysis in background, stream progress
  (async () => {
    try {
      // Lot 113U : la garde de session LÈVE ses refus (`AUTH_REQUIRED`,
      // `INVALID_TOKEN`, `MFA_REQUIRED`, `CGUV_REACCEPTANCE_REQUIRED`,
      // `SESSION_UNAVAILABLE`…) — ils devenaient `INTERNAL_ERROR`.
      let session: Awaited<ReturnType<typeof getSession>> | null;
      try {
        session = await getSession(request);
      } catch (e) {
        if (isKnownSessionError(e)) {
          const code = (e as Error).message === 'FORBIDDEN' ? 'ACCESS_DENIED' : (e as Error).message;
          await refuse(write, ctx, { code });
          return;
        }
        throw e;
      }

      if (!session) {
        await refuse(write, ctx, { code: 'UNAUTHORIZED' });
        return;
      }
      ctx.userId = session.userId ?? null;

      const { id: rawId } = await params;
      const accountId = session.currentAccountId;


      if (!accountId) {
        await refuse(write, ctx, { code: 'NO_ACCOUNT' });
        return;
      }
      ctx.accountId = accountId;

      const assetFileId = parseInt(rawId);
      if (isNaN(assetFileId)) {
        await refuse(write, ctx, { code: 'INVALID_ID' });
        return;
      }

      // Propriété du document (anti-énumération : un document d'un autre
      // compte est « introuvable », sans rien révéler de son état).
      const [owned] = await db
        .select({ id: assetFiles.id })
        .from(assetFiles)
        .where(and(eq(assetFiles.id, assetFileId), eq(assetFiles.accountId, accountId)))
        .limit(1);

      if (!owned) {
        await refuse(write, ctx, { code: 'NOT_FOUND' });
        return;
      }
      ctx.assetFileId = assetFileId;

      // Lot 113U : un job T1 vivant traitera ce document — signalé AVANT les
      // contrôles d'offre et de droits (la file applique les siens) : plus de
      // refus trompeur alors que le tiroir affiche « en file d'attente ».
      if (await signalLiveJob(assetFileId, accountId, ctx, write)) return;

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
        await refuse(write, ctx, { code: String(code), message });
        return;
      }

      const quotaGate = await canConsumeAnalysis(accountId, 1);
      if (!quotaGate.allowed) {
        await refuse(write, ctx, { code: quotaGate.reason || 'ANALYSIS_QUOTA_REACHED' });
        return;
      }

      await streamUnifiedAnalysis({
        assetFileId,
        accountId,
        userId: session.userId,
        write,
        ctx,
      });
    } catch (error) {
      if (error instanceof Response) {
        await refuse(write, ctx, { code: 'AUTH_ERROR' }).catch(() => undefined);
      } else {
        // Le pipeline ne lève pas (échecs écrits sur le fichier) : seule une
        // panne de transport ou d'authentification arrive ici.
        // Lot 34C : l'exception reste dans les journaux, jamais dans le flux.
        console.error('POST /api/documents/[id]/analyze error:', error);
        await refuse(write, ctx, { code: 'INTERNAL_ERROR' }).catch(() => undefined);
      }
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  return response;
}

/**
 * Job T1 vivant (en attente, en cours, en attente technique, reporté au
 * plafond de coût) : verdict d'information avec le statut FONCTIONNEL
 * (prochaine tentative, attente technique) ; vrai si un verdict a été émis.
 * File illisible : faux (l'analyse directe reste possible, comportement antérieur).
 */
async function signalLiveJob(
  assetFileId: number,
  accountId: number,
  ctx: RefusalContext,
  write: (data: Record<string, unknown>) => Promise<void>,
): Promise<boolean> {
  let vivant = false;
  try {
    const { listLiveTargets } = await import('@/services/ai/queue/job-queue.repository');
    vivant = (await listLiveTargets('T1', 'asset_file', [assetFileId])).size > 0;
  } catch { return false; }
  if (!vivant) return false;

  const { getFileProcessingView, processingFields } =
    await import('@/services/ai/processing-status/processing-status.service');
  const vue = await getFileProcessingView(assetFileId, accountId).catch(() => null);
  const etat = vue ? processingFields(vue) : {};

  // Lot 22 : plafond IA du mois du compte atteint — rien n'est lancé ; le
  // document (déjà reporté) sera analysé automatiquement au début du mois suivant.
  try {
    const { costCapReachedFor, costCapAnalysisReason } = await import('@/services/ai/gateway/account-cost-cap');
    const cap = await costCapReachedFor(accountId);
    if (cap) {
      await refuse(write, ctx, { code: 'ANALYSIS_COST_CAP_REACHED', message: costCapAnalysisReason(cap.resumeAt), ...etat });
      return true;
    }
  } catch { /* plafond illisible : le job vivant suffit au verdict ci-dessous */ }

  // Revue 3a : un job T1 vivant (en attente ou en cours, par exemple remis en
  // file après un échec) traitera ce document — une analyse directe en
  // parallèle doublerait l'appel au master. Refus explicite, motif affiché.
  await refuse(write, ctx, {
    code: 'ALREADY_ANALYZING',
    message: 'Ce document est déjà en file d’analyse : il sera analysé automatiquement dans quelques instants.',
    ...etat,
  });
  return true;
}

/**
 * Analyse : authentification, propriété et file déjà contrôlées, transport SSE uniquement.
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
  ctx: RefusalContext;
}): Promise<void> {
  const { assetFileId, accountId, userId, write, ctx } = args;

  const { analyzeFileSources, registerAnalysisStreamWriter } =
    await import('@/services/ai/source-analysis/entrypoint');

  // Relais de la progression émise par le pipeline vers ce flux — lot 34C :
  // sans texte technique, avec le statut fonctionnel (`userStreamEvent`).
  // Lot 113U : un `error` du pipeline n'est JAMAIS relayé comme verdict —
  // il est publié avant la remise en file durable (`analyzeFileSources`) et
  // n'a pas de code ; il devient un `state_update`. Le verdict final est
  // émis ci-dessous, après la remise en file.
  const { userStreamEvent, getFileProcessingView, processingFields } =
    await import('@/services/ai/processing-status/processing-status.service');
  const unregister = await registerAnalysisStreamWriter(assetFileId, (data) => {
    void userStreamEvent(assetFileId, accountId, data)
      .then((evt) => write(evt.type === 'error' ? { ...evt, type: 'state_update' } : evt))
      .catch(() => undefined);
  });

  const keepAlive = setInterval(() => { void write({ type: 'ping' }); }, 20_000);

  try {
    const outcome = await analyzeFileSources([assetFileId], accountId, {
      userId,
      origin: 'documents/analyze',
      processingVisibility: 'USER',
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
      const vue = await getFileProcessingView(assetFileId, accountId).catch(() => null);
      await refuse(write, ctx, { code: SKIP_CODES[outcome.skippedReason], message, ...(vue ? processingFields(vue) : {}) });
      return;
    }

    // Panne inattendue du pipeline (`null`, déjà journalisée) : rien n'a été
    // remis en file — la reprise serveur (`analysis-recovery`) retrouvera le
    // document bloqué après une dizaine de minutes. Jamais un `done` trompeur.
    if (!outcome) {
      await refuse(write, ctx, { code: 'ANALYSIS_INTERRUPTED' });
      return;
    }

    // Échec de l'analyse (master T1, persistance) : le document garde son
    // motif (ANALYSIS_FAILED) et repart en file durable (`analyzeFileSources`),
    // sauf échec définitif déjà repris (voir `failure-policy`).
    //
    // Lot 34C : jamais le motif technique. Le statut FONCTIONNEL relu après
    // la remise en file (job réellement en attente → « En file d'attente »,
    // aucun job → échec définitif générique ou action utilisateur ciblée) ;
    // le tiroir en tire son texte (référentiel fermé).
    if (outcome.failedSourceIds.includes(assetFileId)) {
      const vue = await getFileProcessingView(assetFileId, accountId).catch(() => null);
      await refuse(write, ctx, { code: 'ANALYSIS_FAILED', ...(vue ? processingFields(vue) : {}) });
      return;
    }

    await write({ type: 'done' });
  } finally {
    clearInterval(keepAlive);
    unregister();
  }
}
