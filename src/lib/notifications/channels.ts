/**
 * Canaux de livraison (CDC §11.1 §5).
 *
 *  - BellChannel   : écrit dans la table `notifications` (journal interne).
 *  - EmailChannel  : passe par `emailService` existant (Resend + templates admin).
 *  - Push          : application mobile native uniquement (`mobile-push.ts`,
 *                    lot 97). Lot 94 (décision PO M3) : le Web Push (VAPID,
 *                    navigateurs) est supprimé — envoi, abonnements, routes.
 *
 * Chaque canal renvoie un statut de livraison conforme à `notification_deliveries`
 * (§12.4) : sent | failed | skipped_preference | skipped_unavailable | expired.
 */

import { db } from '@/db';
import { notifications, users, emailTemplates } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { emailService } from '@/lib/email/email-service';
import type { CatalogEntry } from './catalog';
import type { RenderResult } from './content-renderer';
import { withSpaceParam } from '@/lib/shell/space-link';

export type DeliveryStatus = 'sent' | 'failed' | 'skipped_preference' | 'skipped_unavailable' | 'expired';

export interface DeliveryOutcome {
  status: DeliveryStatus;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface DeliveryContext {
  outboxId: string;
  userId: number;
  eventType: string;
  category: string | null;
  payload: any;
  dedupeKey: string;
  mustDeliverBell: boolean;
  /** Lot 97 : réémission — seuls ces appareils MOBILES sont visés (ceux en échec). */
  mobileInstallationIds?: string[];
  /** Lot 72D (Q7) : compte émetteur — le lien push rouvre cet espace. */
  accountId?: number | null;
}

interface BellOutcome extends DeliveryOutcome {
  notificationId?: number;
}

// ── Cloche ────────────────────────────────────────────────────────────────
export async function deliverBell(
  ctx: DeliveryContext,
  entry: CatalogEntry,
  rendered: RenderResult,
): Promise<BellOutcome> {
  try {
    const inserted = await db.insert(notifications).values({
      userId: ctx.userId,
      type: ctx.eventType,
      payloadJson: ctx.payload ? JSON.stringify(ctx.payload) : null,
      // Idempotence : même clé que l'outbox → pas de doublon de cloche en cas de relance.
      dedupeKey: ctx.dedupeKey,
      mustDeliver: ctx.mustDeliverBell,
      outboxId: ctx.outboxId,
      title: rendered.bellTitle,
      body: rendered.bellBody,
      href: rendered.href,
      category: ctx.category,
      createdAt: new Date(),
    }).onConflictDoNothing({ target: notifications.dedupeKey }).returning({ id: notifications.id });
    return { status: 'sent', notificationId: inserted[0]?.id };
  } catch (err) {
    return { status: 'failed', errorCode: 'bell_insert_error', errorMessage: (err as Error).message };
  }
}

// ── Email ────────────────────────────────────────────────────────────────
export async function deliverEmail(
  ctx: DeliveryContext,
  entry: CatalogEntry,
  rendered: RenderResult,
): Promise<DeliveryOutcome> {
  const templateCode = rendered.emailTemplateCode;
  if (!templateCode) {
    // Lot 81E : cause explicite quand l'e-mail générique est couvert par une
    // communication durable (confirmation contractuelle, fin d'offre).
    return { status: 'skipped_unavailable', errorCode: rendered.emailSkipReason ?? 'no_email_template' };
  }

  // Adresse du destinataire.
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId)).limit(1);
  if (!user?.email) {
    return { status: 'skipped_unavailable', errorCode: 'no_recipient_email' };
  }

  // Lot 1 : les templates `notif_*` sont seedés au Lot 5. Tant qu'ils n'existent
  // pas, on ignore proprement (skipped_unavailable) plutôt que de générer des
  // échecs. Dès qu'un template est seedé, l'email part sans changement de code.
  const [tpl] = await db.select({ type: emailTemplates.type }).from(emailTemplates).where(eq(emailTemplates.type, templateCode)).limit(1);
  if (!tpl) {
    return { status: 'skipped_unavailable', errorCode: 'template_not_seeded' };
  }

  const variables: Record<string, string> = {
    title: rendered.bellTitle,
    body: rendered.bellBody,
    // Lien absolu HTTPS (§15.3).
    // Lot 72D (Q7) : le lien de l'e-mail rouvre l'espace émetteur.
    actionUrl: rendered.href ? absoluteUrl(withSpaceParam(rendered.href, ctx.accountId ?? null) ?? rendered.href) : '',
  };

  // L'activation du canal a déjà été contrôlée par le dispatcher, par type
  // d'événement (CDC BO COM-011) : pas de second contrôle par gabarit.
  const res = await emailService.send({ templateCode, to: user.email, variables, userId: ctx.userId, skipChannelCheck: true });
  // `sent` = ACCEPTÉ par le prestataire ; la livraison finale se lit sur le
  // journal des envois (`email_logs.delivery_status`, même identifiant).
  if (res.success) return { status: 'sent', ...(res.providerMessageId ? { providerMessageId: res.providerMessageId } : {}) };
  return { status: 'failed', errorCode: 'email_send_error', errorMessage: res.error };
}

function absoluteUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/$/, '');
  return base ? `${base}${href.startsWith('/') ? '' : '/'}${href}` : href;
}
