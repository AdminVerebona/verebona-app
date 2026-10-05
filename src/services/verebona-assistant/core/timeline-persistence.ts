/**
 * Chronologie persistée de l'assistant — CDC 15 T2-35, reliquat R1 (lot 19).
 *
 * `events[]` d'une réponse (une entrée par événement : date, texte, objet
 * d'origine, lien) est écrit dans `verebona_messages.timeline_events_json`
 * (migration 0228) et relu à la reprise d'un fil. Sans cela, la chronologie
 * redevenait du texte au rechargement.
 *
 *   · lecture canonique toujours active (lot 16b-2) : les `events` sont
 *     produits à chaque réponse qui en porte ;
 *   · colonne absente (migration non appliquée) : rien n'est écrit ni lu,
 *     comportement antérieur, signalé une fois par processus ;
 *   · à la relecture (§19.10), chaque lien est REVÉRIFIÉ : un objet supprimé
 *     ou passé hors du compte perd son lien (`href: null`, `unavailable`) —
 *     la ligne reste, l'historique n'est pas réécrit.
 */
import type { AssistantTimelineEvent } from '../types/contracts';
import { identifiantsIndisponibles, type Requeteur } from './source-availability.service';

const RECONTROLE_MS = 5 * 60_000;
let etat: { ready: boolean; checkedAt: number } | null = null;
let signale = false;

/** Colonne 0228 présente ? (cache 5 min ; ne lève jamais) */
export async function timelineColumnReady(): Promise<boolean> {
  if (etat && (etat.ready || Date.now() - etat.checkedAt < RECONTROLE_MS)) return etat.ready;
  let ready = false;
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'verebona_messages' AND column_name = 'timeline_events_json'`,
    )) as unknown as Array<{ n: number }>;
    ready = Number(rows[0]?.n ?? 0) === 1;
  } catch {
    ready = false;
  }
  etat = { ready, checkedAt: Date.now() };
  if (!ready && !signale) {
    signale = true;
    console.error('[verebona] ⚠️ MIGRATION 0228 NON APPLIQUÉE : chronologie des réponses non conservée (relue en texte). Voir /api/health.');
  }
  return ready;
}

/** Réservé aux tests. */
export function __resetTimelineColumnForTests(ready: boolean | null = null): void {
  etat = ready === null ? null : { ready, checkedAt: Date.now() };
  signale = false;
}

/** Au plus autant d'entrées que la planification en produit (borne de sécurité). */
const MAX_EVENTS = 50;

/**
 * Valeur à écrire (pure, testée) : entrées valides seulement (texte non vide,
 * lien interne), bornées ; `null` sans chronologie.
 */
export function timelineForStorage(events: AssistantTimelineEvent[] | null | undefined): AssistantTimelineEvent[] | null {
  if (!Array.isArray(events)) return null;
  const out = events
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
    .slice(0, MAX_EVENTS)
    .map((e) => ({
      date: typeof e.date === 'string' ? e.date : null,
      text: e.text.trim().slice(0, 500),
      ref: typeof e.ref === 'string' ? e.ref : null,
      href: typeof e.href === 'string' && e.href.startsWith('/') && !e.href.startsWith('//') ? e.href : null,
    }));
  return out.length ? out : null;
}

/** Entrée relue : `unavailable` quand l'objet a disparu ou est passé hors compte. */
export type StoredTimelineEvent = AssistantTimelineEvent & { unavailable?: boolean };

/**
 * Revérifie les liens des chronologies d'un historique (§19.10). Une seule
 * vérification pour toute la page. Ne lève jamais : une vérification
 * impossible laisse les liens tels quels (comme pour les cartes).
 */
export async function reverifierChronologiesDesMessages<T extends { timeline_events_json?: unknown }>(
  messages: T[],
  accountId: number,
  requeteur?: Requeteur,
): Promise<T[]> {
  const avec = messages.filter((m) => Array.isArray(m.timeline_events_json) && (m.timeline_events_json as unknown[]).length > 0);
  if (avec.length === 0) return messages;
  const refs = avec.flatMap((m) => (m.timeline_events_json as StoredTimelineEvent[]).filter((e) => e?.ref && e.href).map((e) => e.ref!));
  const morts = await identifiantsIndisponibles(refs, accountId, requeteur).catch(() => new Set<string>());
  if (morts.size === 0) return messages;
  return messages.map((m) => (Array.isArray(m.timeline_events_json)
    ? {
        ...m,
        timeline_events_json: (m.timeline_events_json as StoredTimelineEvent[]).map((e) =>
          (e?.ref && morts.has(e.ref) ? { ...e, href: null, unavailable: true } : e)),
      }
    : m));
}
