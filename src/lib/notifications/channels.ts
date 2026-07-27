/**
 * Canaux de livraison (CDC §11.1 §5).
 *
 *  - BellChannel   : écrit dans la table `notifications` (journal interne).
 *  - EmailChannel  : passe par `emailService` existant (Resend + templates admin).
 *  - WebPushChannel: STUB Lot 1 — le vrai envoi signé VAPID arrive au Lot 2.
 *
 * Chaque canal renvoie un statut de livraison conforme à `notification_deliveries`
 * (§12.4) : sent | failed | skipped_preference | skipped_unavailable | expired.
 */

import { db } from '@/db';
import { notifications, users, emailTemplates, pushSubscriptions } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { emailService } from '@/lib/email/email-service';
import { sendWebPush } from './web-push-sender';
import type { CatalogEntry } from './catalog';
import type { RenderResult } from './content-renderer';

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
}

export interface BellOutcome extends DeliveryOutcome {
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
    return { status: 'skipped_unavailable', errorCode: 'no_email_template' };
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
    actionUrl: rendered.href ? absoluteUrl(rendered.href) : '',
  };

  const res = await emailService.send({ templateCode, to: user.email, variables, userId: ctx.userId });
  if (res.success) return { status: 'sent' };
  return { status: 'failed', errorCode: 'email_send_error', errorMessage: res.error };
}

// ── Web Push (envoi réel signé VAPID, multi-appareils) ─────────────────────
export interface PushDeliveryResult {
  subscriptionId: string;
  outcome: DeliveryOutcome;
}

const PUSH_MAX_FAILURES = 5;

/**
 * Envoie le push à CHAQUE abonnement actif de l'utilisateur (§10.1) et renvoie
 * un résultat par appareil (le dispatcher journalise une livraison par appareil,
 * §12.4). Le contenu reste générique (vie privée, §4.3).
 *
 * - 404/410 → abonnement `expired`, plus jamais retenté (§10.4 / §18.2) ;
 * - autre erreur → `failure_count++`, `failed` au-delà du seuil ;
 * - jamais de modification des préférences push de l'utilisateur.
 * Retourne un tableau vide si aucun appareil autorisé.
 */
export async function deliverWebPush(
  ctx: DeliveryContext,
  rendered: RenderResult,
  notificationId?: number,
): Promise<PushDeliveryResult[]> {
  const subs = await db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dhKey,
      auth: pushSubscriptions.authKey,
      failureCount: pushSubscriptions.failureCount,
    })
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, ctx.userId), eq(pushSubscriptions.status, 'active')));

  if (subs.length === 0) return [];

  // Payload minimal, sans donnée sensible ni jeton d'authentification (§14.2).
  const payload = {
    notificationId: notificationId ?? null,
    title: rendered.pushTitle,
    body: rendered.pushBody,
    href: rendered.href,
    tag: ctx.dedupeKey,
    category: ctx.category,
  };

  const results: PushDeliveryResult[] = [];
  for (const sub of subs) {
    const res = await sendWebPush({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);

    if (res.ok) {
      await db.update(pushSubscriptions)
        .set({ failureCount: 0, lastSuccessAt: new Date(), updatedAt: new Date() })
        .where(eq(pushSubscriptions.id, sub.id));
      results.push({ subscriptionId: sub.id, outcome: { status: 'sent' } });
      continue;
    }

    if (res.gone) {
      // Abonnement disparu : désactiver sans toucher aux préférences (§10.4).
      await db.update(pushSubscriptions)
        .set({ status: 'expired', lastFailureAt: new Date(), updatedAt: new Date() })
        .where(eq(pushSubscriptions.id, sub.id));
      results.push({ subscriptionId: sub.id, outcome: { status: 'expired', errorCode: `gone_${res.statusCode ?? ''}` } });
      continue;
    }

    // Erreur technique : compteur d'échecs, bascule en `failed` au-delà du seuil.
    const nextFailures = (sub.failureCount ?? 0) + 1;
    await db.update(pushSubscriptions)
      .set({
        failureCount: nextFailures,
        lastFailureAt: new Date(),
        updatedAt: new Date(),
        ...(nextFailures >= PUSH_MAX_FAILURES ? { status: 'failed' } : {}),
      })
      .where(eq(pushSubscriptions.id, sub.id));
    results.push({ subscriptionId: sub.id, outcome: { status: 'failed', errorCode: 'push_send_error', errorMessage: res.error } });
  }

  return results;
}

function absoluteUrl(href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  const base = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/$/, '');
  return base ? `${base}${href.startsWith('/') ? '' : '/'}${href}` : href;
}
