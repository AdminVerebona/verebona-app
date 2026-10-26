/**
 * GET /api/purge-pending-uploads — chemin historique de la purge planifiée,
 * strictement identique à `/api/cron/purge-pending-uploads` (même garde
 * CRON_SECRET, même verrou partagé, même réponse).
 */
export { GET } from '../cron/purge-pending-uploads/route';
