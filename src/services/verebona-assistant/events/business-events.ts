/**
 * Événements métier — CDC §25.7 / §31.7.
 *
 * Petit bus d'événements en mémoire permettant de déclencher l'invalidation de cache
 * et l'observabilité sans coupler les services métier à l'assistant.
 */
import { invalidateAccountRetrieval, type BusinessEntity } from '../cache/invalidation';

export interface BusinessEvent {
  type: 'created' | 'updated' | 'deleted';
  entity: BusinessEntity;
  accountId: number;
  entityId: string | number;
}

type Handler = (e: BusinessEvent) => void;
const handlers: Handler[] = [
  (e) => invalidateAccountRetrieval(e.accountId, e.entity),
];

export function onBusinessEvent(h: Handler): void { handlers.push(h); }
export function emitBusinessEvent(e: BusinessEvent): void {
  for (const h of handlers) { try { h(e); } catch (err) { console.error('[verebona] event handler', (err as Error).message); } }
}
