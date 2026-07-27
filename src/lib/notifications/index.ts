/**
 * Moteur de notifications Verebona (CDC §11).
 * Point d'entrée public : `emit()` pour les producteurs, `processPending()`
 * pour le cron de dispatch.
 */
export { emit, type EmitInput } from './event-service';
export { processPending, processOutboxIds, type DispatchSummary } from './dispatcher';
export {
  NOTIFICATION_CATALOG, getCatalogEntry, CATEGORY_LABELS, CONFIGURABLE_CATEGORIES,
  type NotificationCategory, type NotificationChannel, type DeliveryMode, type CatalogEntry,
} from './catalog';
export { resolveChannels, type ResolvedChannels } from './policy-resolver';
export { getPreference } from './preferences';
