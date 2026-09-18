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
 *
 * ── CORRECTION §10.4 : CHAQUE ABONNÉ PORTE SON DRAPEAU ───────────────────
 * La version précédente déclenchait TOUS les abonnés dès que l'UN des deux
 * drapeaux était actif :
 *
 *     if (shouldRunNewEngine('AI_RECONCILIATION_ENGINE') ||
 *         shouldRunNewEngine('AI_AGENDA_ENGINE')) { … tous les handlers … }
 *
 * Les abonnés étant anonymes, aucun aiguillage n'était possible. Conséquences
 * mesurées :
 *   · `AI_AGENDA_ENGINE=enabled` + `AI_RECONCILIATION_ENGINE=legacy` exécutait
 *     quand même la réconciliation — en shadow, donc sans écriture, mais avec
 *     des appels modèle facturés que personne n'avait demandés, pendant que le
 *     pont vers l'ancien moteur tournait lui aussi ;
 *   · le cas symétrique était pire : l'abonné agenda n'avait AUCUNE garde
 *     d'écriture et persistait ses décisions alors que son propre drapeau
 *     valait `legacy`, tandis que l'ancien classifieur restait en service.
 *     Deux moteurs écrivaient sur le même objet.
 *
 * Un abonnement déclare donc désormais le drapeau qui le gouverne, et l'émission
 * n'exécute que les abonnés dont le drapeau propre l'autorise. C'est la seule
 * forme qui tienne quand les cinq drapeaux basculent indépendamment.
 */
import { shouldRunNewEngine, shouldRunLegacy, type AiFlag } from '../flags/ai-feature-flags';
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
  /** Drapeau qui gouverne CET abonné, et lui seul (§10.1). */
  flag: AiFlag;
  handler: Handler;
}

const subscriptions: Subscription[] = [];

/**
 * Enregistré par les usages 2 et 4 au démarrage.
 *
 * Le drapeau est obligatoire : un abonné sans drapeau ne pourrait pas être
 * exclu d'une bascule partielle, ce qui est précisément le défaut corrigé ici.
 */
export function onSourceAnalyzed(flag: AiFlag, handler: Handler): void {
  subscriptions.push({ flag, handler });
}

export function clearSourceAnalyzedHandlers(): void {
  subscriptions.length = 0;
}

export async function emitSourceAnalyzed(e: SourceAnalyzedEvent): Promise<void> {
  // Aiguillage de bascule : un seul moteur agit sur un objet donné (§10.4).
  // La décision est prise abonné par abonné, jamais globalement.
  for (const { flag, handler } of subscriptions) {
    if (!shouldRunNewEngine(flag)) continue;
    // Un abonné défaillant ne doit jamais faire échouer l'analyse (§11.4).
    await handler(e).catch((err) =>
      console.error(`[source-analyzed] abonné ${flag} en échec (non bloquant) :`, (err as Error).message));
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
