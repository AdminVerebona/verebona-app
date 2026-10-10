/**
 * Webhooks Stripe : prise en charge atomique, idempotence métier, événements
 * de catalogue — CDC lookup_key V4 §14.2, LK-25, LK-69, LK-70, TC-23, TC-24,
 * TC-65, TC-66.
 */
import type Stripe from 'stripe';
import { pgClient } from '@/db';

type Exec = { unsafe: (q: string, p?: never[]) => Promise<unknown> };
const exec = () => pgClient as unknown as Exec;

/** Délai au-delà duquel une prise en charge non terminée est reprise (processus tué). */
export const WEBHOOK_CLAIM_STALE_MINUTES = 10;

export type WebhookClaim = 'CLAIMED' | 'ALREADY_PROCESSED' | 'IN_PROGRESS';

/**
 * Prend l'événement en UNE instruction (LK-70) : l'ancien schéma « lire,
 * supprimer l'échec, réinsérer » laissait deux livraisons simultanées
 * s'exécuter ensemble. Reprise permise si l'exécution précédente a échoué
 * (message d'erreur) ou si elle est périmée (processus tué).
 */
export async function claimWebhookEvent(event: Pick<Stripe.Event, 'id' | 'type'>, payload: string, e: Exec = exec()): Promise<WebhookClaim> {
  const rows = (await e.unsafe(
    `INSERT INTO stripe_webhook_logs (event_type, event_id, payload, processed, processing_time_ms, created_at, claimed_at)
     VALUES ($1, $2, $3, false, 0, now(), now())
     ON CONFLICT (event_id) DO UPDATE SET claimed_at = now(), error_message = NULL, payload = EXCLUDED.payload
       WHERE stripe_webhook_logs.processed = false
         AND (stripe_webhook_logs.claimed_at IS NULL
              OR stripe_webhook_logs.error_message IS NOT NULL
              OR stripe_webhook_logs.claimed_at < now() - ($4 || ' minutes')::interval)
     RETURNING id`,
    [event.type, event.id, payload, String(WEBHOOK_CLAIM_STALE_MINUTES)] as never[],
  )) as Array<{ id: number }>;
  if (rows.length > 0) return 'CLAIMED';
  const [existing] = (await e.unsafe(`SELECT processed FROM stripe_webhook_logs WHERE event_id = $1`, [event.id] as never[])) as Array<{ processed: boolean }>;
  return existing?.processed ? 'ALREADY_PROCESSED' : 'IN_PROGRESS';
}

/**
 * Idempotence MÉTIER par facture et par effet (LK-70) : vrai la première
 * fois seulement, quel que soit l'événement (`invoice.paid`,
 * `invoice.payment_succeeded`) ou la livraison.
 */
export async function claimInvoiceEffect(invoiceId: string, effect: string, e: Exec = exec()): Promise<boolean> {
  try {
    const rows = (await e.unsafe(
      `INSERT INTO stripe_invoice_effects (stripe_invoice_id, effect) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING stripe_invoice_id`,
      [invoiceId, effect] as never[],
    )) as unknown[];
    return rows.length > 0;
  } catch (err) {
    // Table absente (migration 0306 non appliquée) : comportement antérieur.
    if ((err as { code?: string }).code === '42P01') return true;
    throw err;
  }
}

const CATALOG_EVENTS = new Set(['price.created', 'price.updated', 'price.deleted', 'product.updated', 'product.deleted']);

export function isCatalogEvent(type: string): boolean {
  return CATALOG_EVENTS.has(type);
}

/**
 * Événement de catalogue (LK-25, LK-69) : invalide la projection partagée
 * puis la RELIT chez Stripe au moment du traitement — jamais depuis le
 * contenu de l'événement, potentiellement ancien ou désordonné (TC-66). Ne
 * modifie aucun abonnement, droit, date d'essai ni facture. Si la relecture
 * échoue, l'invalidation persiste et la tâche planifiée resynchronise
 * (expiration = filet de sécurité, TC-65).
 */
export async function handleCatalogEvent(event: Pick<Stripe.Event, 'id' | 'type'>): Promise<void> {
  const { invalidateCatalog, refreshCatalog } = await import('./price-catalog.service');
  await invalidateCatalog(`webhook:${event.type}:${event.id}`);
  const r = await refreshCatalog({ source: `webhook:${event.type}` });
  console.info(JSON.stringify({ evt: 'billing.catalog.webhook', eventId: event.id, type: event.type, result: r.status, reason: r.reason ?? null }));
}
