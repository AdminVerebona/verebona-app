import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accountMemberships } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { scheduleChange, cancelScheduledChange } from '@/services/plan-change.service';
import { CATALOG_ERROR_HTTP, CATALOG_ERROR_MESSAGES, type BillingCatalogErrorCode } from '@/services/billing/catalog-types';

/**
 * POST   /api/billing/schedule-change  — programme un changement (CDC §10)
 * DELETE /api/billing/schedule-change  — annule un changement programme (§10.3)
 *
 * Body POST : { plan_code, billing_period, displayed_price_revision }.
 * Le client transmet uniquement une offre, une periodicite et la révision du
 * prix affiché ; le serveur résout lui-même le prix exact (révision active,
 * relue chez Stripe) et la date de prise d'effet (CDC lookup_key LK-34, LK-55).
 * Réservé au titulaire de l'abonnement (FORBIDDEN_BILLING_ACTION).
 */

async function resolveOwnerAccount(request: NextRequest): Promise<{ accountId: number; userId: number; owner: boolean } | null> {
  const session = await SessionService.getSession(request);
  const memberships = await db
    .select({ accountId: accountMemberships.accountId, role: accountMemberships.role })
    .from(accountMemberships)
    .where(eq(accountMemberships.userId, session.userId));
  const membership = memberships.find((m) => m.accountId === session.currentAccountId) ?? memberships[0];
  return membership ? { accountId: membership.accountId, userId: session.userId, owner: membership.role === 'owner' } : null;
}

const MESSAGES: Record<string, string> = {
  NO_SUBSCRIPTION: "Aucun abonnement n'est associe a ce compte.",
  NO_ACTIVE_PLAN: 'Un abonnement actif est necessaire pour programmer un changement.',
  INVALID_TARGET: "L'offre ou la periodicite demandee est invalide.",
  SAME_AS_CURRENT: 'Cette offre et cette periodicite sont deja actives.',
  UPGRADE_IS_IMMEDIATE: 'Une montee en gamme prend effet immediatement : utilisez « Passer à » depuis les offres.',
  STRIPE_SCHEDULE_FAILED: "Le changement n'a pas pu être programmé auprès de notre prestataire de paiement. Réessayez dans quelques instants.",
  FOREIGN_SCHEDULE: "Votre abonnement comporte déjà une évolution planifiée qui ne peut pas être modifiée ici. Contactez le support.",
};

function isSessionError(error: unknown): boolean {
  return error instanceof Error && ['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED'].includes(error.message);
}

export async function POST(request: NextRequest) {
  try {
    const who = await resolveOwnerAccount(request);
    if (!who) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 404 });
    if (!who.owner) {
      return NextResponse.json({ code: 'FORBIDDEN_BILLING_ACTION', error: 'FORBIDDEN_BILLING_ACTION', message: CATALOG_ERROR_MESSAGES.FORBIDDEN_BILLING_ACTION }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const result = await scheduleChange({
      accountId: who.accountId,
      userId: who.userId,
      planCode: typeof body.plan_code === 'string' ? body.plan_code.toLowerCase() : '',
      billingPeriod: typeof body.billing_period === 'string' ? body.billing_period : '',
      displayedPriceRevision: body.displayed_price_revision,
    });

    if (!result.ok) {
      const catalogCode = result.reason in CATALOG_ERROR_HTTP ? (result.reason as BillingCatalogErrorCode) : null;
      return NextResponse.json(
        {
          code: result.reason,
          error: result.reason,
          message: catalogCode ? CATALOG_ERROR_MESSAGES[catalogCode] : MESSAGES[result.reason],
          ...(result.offer ? { offer: result.offer, details: { offer: result.offer } } : {}),
        },
        { status: catalogCode ? CATALOG_ERROR_HTTP[catalogCode] : result.reason === 'STRIPE_SCHEDULE_FAILED' ? 502 : 400 },
      );
    }

    // Notification « Changement d'offre programmé. Nouvelle offre : … »
    // Une notification ne doit jamais faire échouer la programmation.
    try {
      const { emit } = await import('@/lib/notifications');
      const effectiveAt = result.effectiveAt?.toISOString() ?? null;
      await emit({
        type: 'SUBSCRIPTION_CHANGE_SCHEDULED',
        payload: {
          planCode: String(body.plan_code ?? '').toUpperCase(),
          billingPeriod: body.billing_period === 'yearly' || body.billing_period === 'monthly' ? body.billing_period : null,
          effectiveAt,
        },
        accountId: who.accountId,
        entityType: 'subscription',
        entityId: String(who.accountId),
        dedupeKey: `subscription:${who.accountId}:scheduled:${body.plan_code}:${body.billing_period}:${effectiveAt ?? 'next'}`,
      });
    } catch (e) {
      console.error('[schedule-change] notification non émise :', (e as Error).message);
    }

    return NextResponse.json({
      ok: true,
      effectiveAt: result.effectiveAt?.toISOString() ?? null,
      unit_amount_cents: result.unitAmountCents ?? null,
    });
  } catch (error) {
    if (isSessionError(error)) return SessionService.handleSessionError(error);
    console.error('[schedule-change] erreur:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const who = await resolveOwnerAccount(request);
    if (!who) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 404 });
    if (!who.owner) {
      return NextResponse.json({ code: 'FORBIDDEN_BILLING_ACTION', error: 'FORBIDDEN_BILLING_ACTION', message: CATALOG_ERROR_MESSAGES.FORBIDDEN_BILLING_ACTION }, { status: 403 });
    }

    const r = await cancelScheduledChange(who.accountId);
    if (!r.ok) {
      // LK-59 : l'intention est conservée ; jamais d'annulation annoncée à tort.
      return NextResponse.json(
        { code: 'RELEASE_FAILED', error: 'RELEASE_FAILED', message: "L'annulation n'a pas pu être confirmée auprès de notre prestataire de paiement : votre changement reste programmé. Réessayez dans quelques instants." },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isSessionError(error)) return SessionService.handleSessionError(error);
    console.error('[schedule-change] erreur:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
