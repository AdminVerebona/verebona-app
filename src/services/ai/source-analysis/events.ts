/**
 * Étapes 13 et 14 — déclenchement des moteurs aval (CDC §4.1.4).
 *
 * L'analyse ÉMET un événement ; elle n'appelle jamais directement la
 * réconciliation ni l'agenda. Trois raisons :
 *
 * Lot 16b-3 (retrait de l'ancien moteur) : plus aucun drapeau de bascule.
 * Les abonnés (réconciliation T3, agenda T4) s'exécutent toujours ; le pont
 * vers l'ancien moteur de cohérence (`emitAssetUpdated`, quand
 * `AI_RECONCILIATION_ENGINE` n'était pas `enabled`) est supprimé.
 */
import type { SourceAnalysisResult } from './types';

export interface SourceAnalyzedEvent {
  accountId: number;
  userId: number;
  assetId: number | null;
  leadSourceId: number;
  result: SourceAnalysisResult;
}

type Handler = (e: SourceAnalyzedEvent) => Promise<void>;

interface Subscription {
  /** Nom de l'abonné, pour le journal. */
  label: string;
  handler: Handler;
}

const subscriptions: Subscription[] = [];

/** Enregistré par les usages T3 (réconciliation) et T4 (agenda) au démarrage. */
export function onSourceAnalyzed(label: string, handler: Handler): void {
  subscriptions.push({ label, handler });
}

export function clearSourceAnalyzedHandlers(): void {
  subscriptions.length = 0;
}

export async function emitSourceAnalyzed(e: SourceAnalyzedEvent): Promise<void> {
  for (const { label, handler } of subscriptions) {
    // Un abonné défaillant ne doit jamais faire échouer l'analyse (§11.4).
    await handler(e).catch((err) =>
      console.error(`[source-analyzed] abonné ${label} en échec (non bloquant) :`, (err as Error).message));
  }
}
