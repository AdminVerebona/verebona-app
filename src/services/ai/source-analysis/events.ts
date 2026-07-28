/**
 * Étapes 13 et 14 — déclenchement des moteurs aval (CDC §4.1.4).
 *
 * L'analyse ÉMET un événement ; elle n'appelle jamais directement la
 * réconciliation ni l'agenda. Trois raisons :
 *
 *  1. Le CDC §10.2 exige un mode shadow où la réconciliation décide sans
 *     écrire : impossible si l'analyse l'appelle en dur.
 *  2. Le CDC §10.4 interdit qu'un même événement métier déclenche l'ancien ET
 *     le nouveau moteur ; l'aiguillage se fait ici, en un seul endroit.
 *  3. Les tests du pipeline n'ont pas à démarrer la réconciliation.
 */
import { shouldRunNewEngine, shouldRunLegacy } from '../flags/ai-feature-flags';
import type { SourceAnalysisResult } from './types';

export interface SourceAnalyzedEvent {
  accountId: number;
  userId: number;
  assetId: number | null;
  leadSourceId: number;
  result: SourceAnalysisResult;
}

type Handler = (e: SourceAnalyzedEvent) => Promise<void>;

const handlers: Handler[] = [];

/** Enregistré par les usages 2 et 4 au démarrage. */
export function onSourceAnalyzed(handler: Handler): void {
  handlers.push(handler);
}

export function clearSourceAnalyzedHandlers(): void {
  handlers.length = 0;
}

export async function emitSourceAnalyzed(e: SourceAnalyzedEvent): Promise<void> {
  // Aiguillage de bascule : un seul moteur agit sur un objet donné (§10.4).
  if (shouldRunNewEngine('AI_RECONCILIATION_ENGINE') || shouldRunNewEngine('AI_AGENDA_ENGINE')) {
    for (const handler of handlers) {
      // Un abonné défaillant ne doit jamais faire échouer l'analyse (§11.4).
      await handler(e).catch((err) =>
        console.error('[source-analyzed] abonné en échec (non bloquant) :', (err as Error).message));
    }
  }

  if (shouldRunLegacy('AI_RECONCILIATION_ENGINE')) {
    // Pont temporaire vers l'ancien moteur, retiré au lot 7.
    const { emitAssetUpdated } = await import('@/services/coherence/impact-propagation.service');
    if (e.assetId) {
      await emitAssetUpdated(e.accountId, e.assetId, {
        _trigger: 'document_analyzed',
        _documentId: e.leadSourceId,
      }).catch(() => {});
    }
  }
}
