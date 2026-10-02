/**
 * Indicateurs d'usage de l'assistant — CDC Assistant §32.3 ; décision PO
 * D-J7 (lot 21) : « en base, affichés dans le BO ».
 *
 * Événements envoyés par le client (`POST /api/verebona/usage-events`) :
 *   ASSISTANT_OPEN  ouverture de Verebona ;
 *   ACTION_CLICK    clic sur une action (type d'action, principale ou non) ;
 *   SOURCE_OPEN     ouverture d'une source (type de source) ;
 *   ANSWER_COPY     copie d'une réponse ;
 *   FEEDBACK        retour utile / pas utile.
 *
 * ANONYMES : ni compte, ni utilisateur, ni message — seulement des codes
 * d'énumérations fermées (type d'événement, d'action, de source, intention,
 * offre). Une valeur hors liste est ramenée à `null`, jamais stockée telle
 * quelle. Rétention : 13 mois (purge quotidienne de l'assistant).
 */
import { VEREBONA_ACTION_TYPES } from '../types/actions';
import { SOURCE_TYPES } from '../types/sources';
import { VEREBONA_INTENTS } from '../types/intents';

export const USAGE_EVENT_TYPES = ['ASSISTANT_OPEN', 'ACTION_CLICK', 'SOURCE_OPEN', 'ANSWER_COPY', 'FEEDBACK'] as const;
export type UsageEventType = (typeof USAGE_EVENT_TYPES)[number];

export const USAGE_PLANS = ['STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO'] as const;
const VALEURS: Readonly<Partial<Record<UsageEventType, readonly string[]>>> = {
  ACTION_CLICK: ['primary', 'secondary'],
  FEEDBACK: ['helpful', 'not_helpful'],
};
export const USAGE_BATCH_MAX = 20;

export interface UsageEvent {
  type: UsageEventType;
  actionType: string | null;
  sourceType: string | null;
  intent: string | null;
  value: string | null;
}

const dans = (liste: readonly string[], v: unknown): string | null =>
  typeof v === 'string' && liste.includes(v) ? v : null;

/** Normalise un lot reçu du client (pur) : événements inconnus ignorés. */
export function normalizeUsageEvents(raw: unknown): UsageEvent[] {
  const lot = Array.isArray(raw) ? raw.slice(0, USAGE_BATCH_MAX) : [];
  const out: UsageEvent[] = [];
  for (const e of lot) {
    const o = (e ?? {}) as Record<string, unknown>;
    const type = dans(USAGE_EVENT_TYPES, o.type) as UsageEventType | null;
    if (!type) continue;
    out.push({
      type,
      actionType: type === 'ACTION_CLICK' ? dans(VEREBONA_ACTION_TYPES, o.actionType) : null,
      sourceType: type === 'SOURCE_OPEN' ? dans(SOURCE_TYPES, o.sourceType) : null,
      intent: dans(VEREBONA_INTENTS, o.intent),
      value: dans(VALEURS[type] ?? [], o.value),
    });
  }
  return out;
}

/** Offre normalisée (jamais d'identifiant). */
export function usagePlan(planType: unknown): string | null {
  const p = typeof planType === 'string' ? planType.toUpperCase() : '';
  return (USAGE_PLANS as readonly string[]).includes(p) ? p : null;
}

/** Enregistre un lot — UNE insertion. Ne lève jamais (mesure, pas service). */
export async function recordUsageEvents(events: UsageEvent[], plan: string | null): Promise<number> {
  if (events.length === 0) return 0;
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      // Horodatage arrondi à l'heure : sans compte ni utilisateur, un instant
      // précis permettrait encore de recouper un événement avec les journaux
      // d'accès. L'heure suffit aux agrégats (§32.3).
      `INSERT INTO verebona_usage_events (event_type, action_type, source_type, intent, plan, value, created_at)
       SELECT u.*, date_trunc('hour', now())
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS u`,
      [
        events.map((e) => e.type), events.map((e) => e.actionType), events.map((e) => e.sourceType),
        events.map((e) => e.intent), events.map(() => plan), events.map((e) => e.value),
      ] as never[],
    );
    return events.length;
  } catch (e) {
    console.warn('[verebona][usage] événements non enregistrés :', (e as Error).message);
    return 0;
  }
}
