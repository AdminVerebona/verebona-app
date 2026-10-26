/**
 * Moteur de notifications Verebona (CDC §11).
 * Point d'entrée public : `emit()` pour les producteurs, `processPending()`
 * pour le cron de dispatch.
 */
export { emit } from './event-service';
export { processPending, processOutboxIds } from './dispatcher';
export { getCatalogEntry } from './catalog';
export { resolveChannels } from './policy-resolver';
