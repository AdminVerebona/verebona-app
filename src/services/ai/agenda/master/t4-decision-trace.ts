/**
 * Lot 54 — observabilité BO de la décision T4 CLASSIFY_EVENT (ticket « T4
 * décisionnaire », §12).
 *
 * La décision APPLIQUÉE par le moteur (après contrôle de cohérence) est
 * rattachée à l'exécution IA de l'appel (`ai_usage_event.metadata.t4Decision`,
 * même `traceId`) : BO › Exécutions IA distingue « T4 a rejeté l'événement »,
 * « événement accepté, récurrence rejetée », « T4 s'est abstenu » et
 * « échec technique T4 » (celui-ci est en outre l'exécution en échec
 * elle-même). Aucune migration : métadonnée JSON existante. Aucun contenu
 * documentaire brut : décisions, candidat de récurrence sans extrait, raisons
 * courtes du modèle.
 */
import type { T4DecisionTrace } from '../types';

export const T4_VERDICT_LABEL: Record<T4DecisionTrace['verdict'], string> = {
  ACCEPTED: 'T4 a accepté l’événement',
  RECURRENCE_REJECTED: 'T4 a accepté l’événement mais pas la récurrence',
  EVENT_REJECTED: 'T4 a rejeté l’événement',
  ABSTAINED: 'T4 s’est abstenu',
  TECHNICAL_FAILURE: 'Échec technique T4',
};

/**
 * Écrit la décision sur l'exécution de l'appel. Jamais bloquant pour
 * l'appelant (qui capture).
 *
 * Lot 71E (§E) : l'exécution RÉUSSIE de la trace en priorité ; à défaut (tous
 * les modèles en échec), la DERNIÈRE exécution en erreur de la même trace —
 * l'échec technique complet garde ainsi une décision exploitable au BO.
 * Rend `true` si une exécution a reçu la décision.
 */
export async function attachT4DecisionToTrace(traceId: string, trace: T4DecisionTrace): Promise<boolean> {
  const { pgClient } = await import('@/db');
  const { traceId: _t, ...decision } = trace;
  const rows = await pgClient.unsafe(
    `UPDATE ai_usage_event SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('t4Decision', $2::jsonb)
      WHERE id = (SELECT id FROM ai_usage_event
                   WHERE operation_code = 't4_classify_event' AND metadata->>'traceId' = $1
                   ORDER BY (status = 'success') DESC, id DESC LIMIT 1)
      RETURNING id`,
    [traceId, JSON.stringify(decision)] as never[],
  );
  return (rows as unknown as unknown[]).length > 0;
}
