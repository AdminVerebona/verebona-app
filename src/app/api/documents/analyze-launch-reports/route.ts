/**
 * POST /api/documents/analyze-launch-reports — lot 113U (carte #720).
 *
 * Rapport CLIENT d'un lancement d'analyse resté sans réponse exploitable :
 * refus HTTP sans corps lisible (proxy de l'hébergeur, 5xx, 401 avant
 * renouvellement), coupure réseau avant toute réponse, flux interrompu. Le
 * tiroir l'envoie par le client de l'application (renouvellement de session
 * compris) avec la référence d'incident qu'il a AFFICHÉE ; la ligne rejoint le
 * journal des refus (`document_analysis_launch_refusals`, source `client`).
 *
 * Corps fermé : référence, document, statut HTTP, code (forme de code
 * seulement), phase, tentative — aucun texte libre. Document d'un autre compte
 * → journalisé sans document (anti-énumération : réponse identique). Plafond
 * par utilisateur et par heure. Réponse toujours `{ ok }` : le rapport ne fait
 * jamais échouer l'écran.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { pgClient } from '@/db';
import { appVersionFromUserAgent, launchOriginOf, normalizeLaunchCode, parseIncidentRef } from '@/lib/ai/analysis-launch';
import { readClientContext } from '@/lib/mobile/client-context';
import { clientReportAllowed, recordLaunchRefusal } from '@/services/ai/source-analysis/launch-refusals';

const PHASES = new Set(['response', 'network', 'stream']);

export async function POST(request: NextRequest) {
  let session;
  try {
    session = await getSession(request);
  } catch (e) {
    if (isSessionError(e)) return sessionErrorResponse(e);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const incidentRef = parseIncidentRef(body.incidentRef);
    if (!incidentRef) return NextResponse.json({ ok: false, code: 'INVALID_REFERENCE' }, { status: 400 });
    if (!(await clientReportAllowed(session.userId))) return NextResponse.json({ ok: false, code: 'RATE_LIMITED' }, { status: 200 });

    const accountId = session.currentAccountId ?? null;
    let assetFileId: number | null = null;
    const fileId = Number(body.fileId);
    if (accountId && Number.isInteger(fileId) && fileId > 0) {
      const rows = (await pgClient.unsafe(
        `SELECT id FROM asset_files WHERE id = $1 AND account_id = $2 LIMIT 1`, [fileId, accountId] as never[],
      )) as unknown as Array<{ id: number }>;
      assetFileId = rows[0] ? Number(rows[0].id) : null;
    }
    const status = Number(body.httpStatus);
    const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const phase = typeof body.phase === 'string' && PHASES.has(body.phase) ? body.phase : 'response';
    const code = normalizeLaunchCode(body.code)
      || (phase === 'network' ? 'NETWORK_ERROR' : phase === 'stream' ? 'STREAM_INTERRUPTED' : httpStatus ? `HTTP_${httpStatus}` : 'UNKNOWN_CODE');
    const ua = request.headers.get('user-agent');
    const ctx = readClientContext(request);
    const ok = await recordLaunchRefusal({
      incidentRef, source: 'client', code, httpStatus,
      assetFileId, accountId, userId: session.userId,
      client: launchOriginOf(ctx.declared ? ctx.client : null, ua),
      appVersion: ctx.appVersion ?? appVersionFromUserAgent(ua),
      detail: { clientPhase: phase, attempt: Number.isInteger(body.attempt) ? body.attempt : undefined },
    });
    return NextResponse.json({ ok });
  } catch {
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
