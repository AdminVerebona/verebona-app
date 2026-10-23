/**
 * Déclencheurs des contrôles CIBLÉS — lot 82B (arbitrage C-Q1 : « contrôle
 * ciblé après extraction, modification, nouveau rapprochement, évolution de
 * règle ou changement d'une dépendance pertinente »).
 *
 * Aucun nouveau bus : abonnement aux deux bus existants —
 *   · fin d'analyse T1 (`onSourceAnalyzed`, même bus que T3 / T4) ;
 *   · événements métier internes (`onBusinessEvent`, §25.7) : document
 *     modifié / supprimé / déposé, bien modifié / supprimé (dépendance : ses
 *     équipements, ses documents), élément d'agenda créé / modifié ;
 *   · lot 83B : bus des Opérations (`subscribeBusinessOperationEvents`,
 *     publié après commit) — toute écriture d'une Opération (création,
 *     regroupement, fusion, invalidation…) relayée sous le type unique
 *     `BUSINESS_OPERATION_CHANGED` (invariants O-1, identité économique).
 * L'abonné ne contrôle RIEN lui-même : il marque en base les objets
 * dépendants « à contrôler » (`requestTargetedChecks`, durable, sans
 * doublon : une ligne par objet × contrôle) ; la tâche `coherence-control`
 * les contrôle au passage suivant, après temporisation (rafales regroupées).
 * Jamais bloquant pour l'opération qui émet ; compte non éligible : rien.
 */
import { requestTargetedChecks } from './orchestrator';

let abonne = false;
let desabonnerOperations: (() => void) | null = null;

const numerique = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Types d'événements métier relayés (les autres ne concernent aucun contrôle). */
export const COHERENCE_BUSINESS_EVENTS: ReadonlySet<string> = new Set([
  'DOCUMENT_UPDATED', 'DOCUMENT_DELETED', 'DOCUMENT_UPLOADED', 'ASSET_UPDATED', 'ASSET_DELETED', 'AGENDA_ITEM_CREATED', 'AGENDA_ITEM_UPDATED',
  // Lot 83E : évolution de l'abonnement, des droits / relations Duo, résolution d'une carte « À traiter » (CDC §6.1).
  'PLAN_CHANGED', 'ACCOUNT_PERMISSION_CHANGED', 'TO_PROCESS_ITEM_UPDATED',
]);

/** Lot 83B : type relayé pour toute écriture d'une Opération (bus des Opérations). */
export const BUSINESS_OPERATION_CHANGED = 'BUSINESS_OPERATION_CHANGED';

function relayer(accountId: number, event: { type: string; entityId: number | null; assetId?: number | null }): void {
  void requestTargetedChecks({ accountId, event })
    .catch((e) => console.error(`[coherence] demande de contrôle ciblé (${event.type}) non enregistrée :`, (e as Error).message));
}

/** Abonnements (démarrage, `instrumentation-node.ts`) ; idempotent. */
export async function registerCoherenceTriggers(): Promise<void> {
  if (abonne) return;
  abonne = true;
  const [{ onBusinessEvent }, { onSourceAnalyzed }, { subscribeBusinessOperationEvents }] = await Promise.all([
    import('@/services/verebona-assistant/events/business-events'),
    import('@/services/ai/source-analysis/events'),
    import('@/services/business-operations/events'),
  ]);
  desabonnerOperations = subscribeBusinessOperationEvents('coherence-targeted', (e) => {
    relayer(e.accountId, { type: BUSINESS_OPERATION_CHANGED, entityId: e.canonicalOperationId ?? e.operationId });
    // Opération fusionnée : la source fusionnée aussi (ses éléments d'agenda suivent la canonique).
    if (e.canonicalOperationId && e.canonicalOperationId !== e.operationId) relayer(e.accountId, { type: BUSINESS_OPERATION_CHANGED, entityId: e.operationId });
  });
  onBusinessEvent('coherence-targeted', (e) => {
    if (e.accountId == null || !COHERENCE_BUSINESS_EVENTS.has(e.type)) return;
    relayer(e.accountId, { type: e.type, entityId: numerique(e.entityId) });
  });
  onSourceAnalyzed('coherence-targeted', async (e) => {
    relayer(e.accountId, { type: 'SOURCE_ANALYZED', entityId: e.leadSourceId, assetId: e.assetId });
  });
}

/** Réservé aux tests. */
export function __resetCoherenceTriggersForTests(): void {
  abonne = false;
  desabonnerOperations?.();
  desabonnerOperations = null;
}
