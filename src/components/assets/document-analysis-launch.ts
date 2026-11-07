/**
 * Lancement d'une analyse depuis le tiroir du document — transport client,
 * lot 113U (carte Trello #720 « Analyse T1 ko »).
 *
 * `POST /api/documents/[id]/analyze` rend un flux SSE : il est lu par
 * `fetch` (le client de l'application ne lit pas de flux). Ce module lui
 * rend ce que le client de l'application faisait déjà ailleurs :
 *   · en-têtes déclaratifs du client (origine Web / iOS / Android, version) ;
 *   · UN renouvellement de session sur 401 (jeton d'accès expiré pendant que
 *     le tiroir était ouvert), puis une seule nouvelle demande ;
 *   · refus HTTP lu par son `code` (jamais le libellé `error`), événements
 *     dédiés (mise à jour d'application, conditions d'utilisation) ;
 *   · rapport d'un échec sans réponse exploitable (référence d'incident) au
 *     journal du BO, par le client de l'application.
 */
import { apiClient } from '@/lib/api-client';
import { clientPlatformHeaders } from '@/lib/client-platform';
import { newIncidentRef, parseIncidentRef } from '@/lib/ai/analysis-launch';
import { notifyAppUpdateRequired } from '@/lib/mobile/native-shell';
import { CGUV_REACCEPTANCE_EVENT } from '@/lib/legal/reacceptance-gate';
import { analyzeHttpFeedback, LAUNCH_MESSAGES, type AnalyzeFeedback } from './document-analysis-feedback';

export type LaunchStart =
  | { kind: 'stream'; response: Response }
  | { kind: 'refused'; feedback: AnalyzeFeedback; status: number }
  | { kind: 'network'; feedback: AnalyzeFeedback };

/** Délais des nouveaux essais automatiques sur indisponibilité momentanée (borné). */
export const AUTO_RETRY_DELAYS_MS = [20_000, 60_000] as const;

/** Rapport d'un échec côté appareil (jamais bloquant, jamais de redirection). */
export function reportLaunchFailure(r: { incidentRef: string; fileId: number; httpStatus?: number | null; code?: string | null; phase: 'response' | 'network' | 'stream'; attempt?: number }): void {
  void apiClient.post('/api/documents/analyze-launch-reports', r, { onAuthFailure: 'silent', skipRetry: false }).catch(() => undefined);
}

function postAnalyze(fileId: number): Promise<Response> {
  return fetch(`/api/documents/${fileId}/analyze`, {
    credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...clientPlatformHeaders() },
    // skipNotification=true : tiroir ouvert, pas de cloche (champ ignoré par le serveur, lot 0).
    body: JSON.stringify({ skipNotification: true }),
  });
}

/**
 * Demande de lancement. Rend le flux, ou le retour d'un refus HTTP / réseau
 * (déjà journalisé côté appareil, avec sa référence).
 */
export async function startAnalyzeRequest(fileId: number, attempt = 0): Promise<LaunchStart> {
  let res: Response;
  try {
    res = await postAnalyze(fileId);
    if (res.status === 401) {
      // Jeton d'accès expiré pendant que le tiroir était ouvert : un
      // renouvellement (promesse partagée du client), puis une seule reprise.
      const renouvele = await apiClient.refreshToken().catch(() => false);
      if (renouvele === true) res = await postAnalyze(fileId);
    }
  } catch {
    const incidentRef = newIncidentRef();
    reportLaunchFailure({ incidentRef, fileId, phase: 'network', code: 'NETWORK_ERROR', attempt });
    return { kind: 'network', feedback: { level: 'error', category: 'NETWORK', message: LAUNCH_MESSAGES.NETWORK, incidentRef } };
  }
  if (res.ok && res.body) return { kind: 'stream', response: res };

  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  const incidentRef = parseIncidentRef(body?.incidentRef) ?? newIncidentRef();
  const feedback = analyzeHttpFeedback(res.status, body, incidentRef);
  const code = typeof body?.code === 'string' ? body.code : null;
  reportLaunchFailure({ incidentRef, fileId, httpStatus: res.status, code, phase: 'response', attempt });
  if (feedback.category === 'APP_UPDATE') notifyAppUpdateRequired(body?.details);
  if (feedback.category === 'CGUV' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CGUV_REACCEPTANCE_EVENT));
  return { kind: 'refused', feedback, status: res.status };
}

/** Effets d'un refus reçu par le FLUX (même traitement que par HTTP). */
export function applyLaunchSideEffects(feedback: AnalyzeFeedback): void {
  if (feedback.category === 'CGUV' && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CGUV_REACCEPTANCE_EVENT));
}
