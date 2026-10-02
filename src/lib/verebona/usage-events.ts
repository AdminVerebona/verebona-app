/**
 * Envoi des indicateurs d'usage de l'assistant (CDC Assistant §32.3, D-J7).
 *
 * Côté client : les événements sont regroupés (2 s, 20 au plus) puis envoyés
 * à `POST /api/verebona/usage-events` — `sendBeacon` à la fermeture de la
 * page, `fetch keepalive` sinon. Aucun contenu : des codes seulement. Une
 * mesure ne gêne jamais l'utilisateur : toute erreur est ignorée.
 */
export type AssistantUsageEvent =
  | { type: 'ASSISTANT_OPEN' }
  | { type: 'ACTION_CLICK'; actionType: string; value: 'primary' | 'secondary'; intent?: string | null }
  | { type: 'SOURCE_OPEN'; sourceType: string; intent?: string | null }
  | { type: 'ANSWER_COPY'; intent?: string | null }
  | { type: 'FEEDBACK'; value: 'helpful' | 'not_helpful'; intent?: string | null };

const URL_USAGE = '/api/verebona/usage-events';
const DELAI_MS = 2_000;
let file: AssistantUsageEvent[] = [];
let minuteur: ReturnType<typeof setTimeout> | null = null;

export function flushAssistantUsage(): void {
  if (minuteur) { clearTimeout(minuteur); minuteur = null; }
  if (file.length === 0 || typeof window === 'undefined') return;
  const corps = JSON.stringify({ events: file.splice(0, 20) });
  try {
    if (document.visibilityState === 'hidden' && navigator.sendBeacon) {
      navigator.sendBeacon(URL_USAGE, new Blob([corps], { type: 'application/json' }));
    } else {
      void fetch(URL_USAGE, { method: 'POST', body: corps, headers: { 'Content-Type': 'application/json' }, keepalive: true, credentials: 'same-origin' })
        .catch(() => undefined);
    }
  } catch {
    /* mesure seulement */
  }
  if (file.length) flushAssistantUsage();
}

export function trackAssistantUsage(e: AssistantUsageEvent): void {
  if (typeof window === 'undefined') return;
  file.push(e);
  if (file.length >= 20) { flushAssistantUsage(); return; }
  if (!minuteur) minuteur = setTimeout(flushAssistantUsage, DELAI_MS);
}

if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAssistantUsage(); });
}
