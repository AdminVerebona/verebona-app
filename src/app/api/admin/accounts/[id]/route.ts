import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accounts, accountSubscriptions, users, accountMemberships, assets, assetFiles, accountAuditLog, duoAccounts, duoMemberships, invoices, planLimits, subscriptionHistory } from '@/db/schema';
import { and, eq, sql, desc, asc, isNull } from 'drizzle-orm';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';
import { logAdminAction } from '@/lib/admin-audit';
import { stripeDashboardUrl } from '@/lib/stripe-links';
import { getAccountStorageUsage } from '@/lib/storage-quota';
import {
  changePlanAsAdmin,
  isAdminAssignablePlan,
  ADMIN_ASSIGNABLE_PLANS,
  ADMIN_PLAN_CHANGE_HTTP_STATUS,
} from '@/services/billing/admin-plan-change.service';
import { deleteAccountAsAdmin } from '@/services/account/admin-account-deletion.service';
import { planAtDate } from '@/lib/admin/plan-at-date';


export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(request);
    const { id } = await params;
    const accountId = parseInt(id);

    if (isNaN(accountId)) {
      return NextResponse.json({ error: 'Invalid account ID' }, { status: 400 });
    }

    // Fetch account with owner info
    const [account] = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        ownerUserId: accounts.ownerUserId,
        planType: accounts.planType,
        subscriptionTier: accounts.subscriptionTier,
        subscriptionStatus: accounts.subscriptionStatus,
        stripeCustomerId: accounts.stripeCustomerId,
        stripeSubscriptionId: accounts.stripeSubscriptionId,
        premiumUntil: accounts.premiumUntil,
        proUntil: accounts.proUntil,
        subscriptionStartedAt: accounts.subscriptionStartedAt,
        planRenewalDate: accounts.planRenewalDate,
        maxMembers: accounts.maxMembers,
        isActive: accounts.isActive,
        createdAt: accounts.createdAt,
        updatedAt: accounts.updatedAt,
        ownerEmail: users.email,
        ownerName: sql<string>`COALESCE(${users.firstName} || ' ' || ${users.lastName}, ${users.email})`,
      })
      .from(accounts)
      .leftJoin(users, eq(accounts.ownerUserId, users.id))
      .where(eq(accounts.id, accountId));

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Abonnement tel que le lisent les droits (entitlements) : offre,
    // périodicité, dates de période et de conclusion du contrat.
    const [subscription] = await db
      .select({
        planCode: accountSubscriptions.planCode,
        status: accountSubscriptions.status,
        billingPeriod: accountSubscriptions.billingPeriod,
        currentPeriodStartAt: accountSubscriptions.currentPeriodStartAt,
        currentPeriodEndAt: accountSubscriptions.currentPeriodEndAt,
        contractConcludedAt: accountSubscriptions.contractConcludedAt,
        firstBilledAt: accountSubscriptions.firstBilledAt,
        cancelAtPeriodEnd: accountSubscriptions.cancelAtPeriodEnd,
        trialEndsAt: accountSubscriptions.trialEndsAt,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, accountId))
      .limit(1);

    // Identifiants Stripe : lus pour construire les liens, jamais renvoyés.
    const [subscriptionIds] = await db
      .select({
        stripeCustomerId: accountSubscriptions.stripeCustomerId,
        stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, accountId))
      .limit(1);

    // Fetch members
    const members = await db
      .select({
        id: accountMemberships.id,
        userId: accountMemberships.userId,
        email: sql<string>`COALESCE(${users.email}, ${accountMemberships.invitedEmail})`,
        name: sql<string>`COALESCE(${users.firstName} || ' ' || ${users.lastName}, '')`,
        role: accountMemberships.role,
        status: accountMemberships.status,
        joinedAt: accountMemberships.joinedAt,
        invitedAt: accountMemberships.invitedAt,
      })
      .from(accountMemberships)
      .leftJoin(users, eq(accountMemberships.userId, users.id))
      .where(eq(accountMemberships.accountId, accountId));

    // Fetch assets
    const accountAssets = await db
      .select({
        id: assets.id,
        name: assets.name,
        category: assets.category,
        status: assets.status,
        createdAt: assets.createdAt,
      })
      .from(assets)
      .where(eq(assets.accountId, accountId))
      .orderBy(desc(assets.createdAt));

    // Fetch audit logs
    const auditLogs = await db
      .select()
      .from(accountAuditLog)
      .where(eq(accountAuditLog.accountId, accountId))
      .orderBy(desc(accountAuditLog.timestamp))
      .limit(50);

    // Fetch duo account for the owner of this account
    const [duoAccount] = await db
      .select({
        id: duoAccounts.id,
        subscriptionStatus: duoAccounts.subscriptionStatus,
        activatedAt: duoAccounts.activatedAt,
        createdAt: duoAccounts.createdAt,
      })
      .from(duoAccounts)
      .where(eq(duoAccounts.billingOwnerUserId, account.ownerUserId))
      .limit(1);

    let duoAccountData = null;
    if (duoAccount) {
      const members = await db
        .select({
          id: duoMemberships.id,
          userId: duoMemberships.userId,
          status: duoMemberships.status,
          slot: duoMemberships.slot,
          email: users.email,
          name: sql<string>`COALESCE(${users.firstName} || ' ' || ${users.lastName}, ${users.email})`,
        })
        .from(duoMemberships)
        .leftJoin(users, eq(duoMemberships.userId, users.id))
        .where(eq(duoMemberships.duoId, duoAccount.id));

      duoAccountData = { ...duoAccount, members };
    }

    // ── Synthèse §5.2.1 : dernière connexion de n'importe quel membre ────
    const [lastLogin] = await db
      .select({ at: sql<Date | null>`max(${users.lastLoginAt})` })
      .from(accountMemberships)
      .innerJoin(users, eq(users.id, accountMemberships.userId))
      .where(eq(accountMemberships.accountId, accountId));

    // ── Consommations et quotas §5.2.3 (ACC-D04 : lecture seule) ─────────
    const storage = await getAccountStorageUsage(accountId);
    const [limits] = await db
      .select({ maxAssets: planLimits.maxAssets, maxDocuments: planLimits.maxDocuments, maxUsers: planLimits.maxUsers })
      .from(planLimits)
      .where(eq(planLimits.planCode, storage.planCode))
      .limit(1);
    const [assetCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(assets)
      .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt)));
    const [documentCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(assetFiles)
      .where(and(eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)));
    const activeMembers = members.filter((m) => m.status === 'active' || m.status === 'ACTIVE').length;
    const quotas = {
      assets: { used: Number(assetCount?.n ?? 0), limit: limits?.maxAssets ?? null },
      documents: { used: Number(documentCount?.n ?? 0), limit: limits?.maxDocuments ?? null },
      users: { used: activeMembers, limit: limits?.maxUsers ?? null },
      storage: { usedBytes: storage.usedBytes, limitBytes: storage.limitBytes },
    };

    // ── Paiements §7.3 (SUB-009, SUB-010, SUB-011, SUB-013) ──────────────
    // Date, montant, statut, offre ; lien Stripe par paiement ; jamais de
    // lien vers la facture elle-même (hosted_invoice_url / invoice_pdf).
    const history = await db
      .select({ createdAt: subscriptionHistory.createdAt, oldTier: subscriptionHistory.oldTier, newTier: subscriptionHistory.newTier })
      .from(subscriptionHistory)
      .where(eq(subscriptionHistory.accountId, accountId))
      .orderBy(asc(subscriptionHistory.createdAt));
    const invoiceRows = await db
      .select({
        id: invoices.id,
        stripeInvoiceId: invoices.stripeInvoiceId,
        amount: invoices.amount,
        currency: invoices.currency,
        status: invoices.status,
        paidAt: invoices.paidAt,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .where(eq(invoices.accountId, accountId))
      .orderBy(desc(invoices.createdAt))
      .limit(100);
    const payments = invoiceRows.map((inv) => {
      const date = inv.paidAt ?? inv.createdAt;
      return {
        id: inv.id,
        date,
        amountCents: inv.amount,
        currency: inv.currency,
        status: inv.status,
        plan: planAtDate(history, date, account.planType),
        stripeUrl: stripeDashboardUrl('invoices', inv.stripeInvoiceId),
      };
    });

    // SUB-012 : les identifiants Stripe ne sont pas exposés ; seuls les liens
    // « Ouvrir dans Stripe », construits côté serveur (mode test/live), le sont.
    const { stripeCustomerId, stripeSubscriptionId, ...accountPublic } = account;
    const stripeLinks = {
      customer: stripeDashboardUrl('customers', subscriptionIds?.stripeCustomerId ?? stripeCustomerId),
      subscription: stripeDashboardUrl('subscriptions', subscriptionIds?.stripeSubscriptionId ?? stripeSubscriptionId),
    };

    return NextResponse.json({
      account: { ...accountPublic, lastLoginAt: lastLogin?.at ?? null },
      subscription: subscription ?? null,
      stripeLinks,
      quotas,
      payments,
      assignablePlans: ADMIN_ASSIGNABLE_PLANS,
      members,
      assets: accountAssets,
      auditLogs,
      duoAccount: duoAccountData,
    });
  } catch (error) {
    const errMsg = (error as Error).message;
    if (['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED', 'INSUFFICIENT_PERMISSIONS'].includes(errMsg)) {
      return SessionService.handleSessionError(error);
    }
    console.error('Failed to fetch account detail:', error);
    return NextResponse.json({ error: 'Failed to fetch account detail' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/accounts/[id] — changement exceptionnel d'offre UNIQUEMENT.
 *
 * CDC Back-Office V1 GEN-001 / SUB-014 / ACC-D04 : le BO n'est pas un canal de
 * modification métier. Ont été retirés : périodicité (`billingPeriod`),
 * identifiants Stripe, `premiumUntil`, `maxMembers`, `subscriptionStatus`,
 * retrait d'un membre (`removeMembershipId`). La suspension/réactivation passe
 * par `POST …/suspend` et `POST …/reactivate`.
 *
 * Corps accepté : `{ "planType": "STANDARD" | "PREMIUM" | "PREMIUM_DUO" }`.
 * Stripe est mis à jour AVANT l'application locale ; un refus Stripe renvoie
 * 502 STRIPE_UPDATE_FAILED sans aucun changement local (ACC-A08, ERR-005).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const { id } = await params;
  const accountId = Number(id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return NextResponse.json({ error: 'Invalid account ID' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const extraFields = body ? Object.keys(body).filter((k) => k !== 'planType') : [];
  if (!body || extraFields.length > 0 || !isAdminAssignablePlan(body.planType)) {
    return NextResponse.json(
      {
        error: 'READ_ONLY_FIELDS',
        code: 'READ_ONLY_FIELDS',
        message:
          "Seul le changement exceptionnel d'offre est possible ici (corps attendu : { planType: 'STANDARD' | 'PREMIUM' | 'PREMIUM_DUO' }).",
        rejectedFields: extraFields,
      },
      { status: 400 },
    );
  }
  const newPlan = body.planType;

  try {
    const result = await changePlanAsAdmin({ accountId, newPlan });
    if (!result.ok) {
      await logAdminAction({
        adminId,
        action: 'ACCOUNT_PLAN_CHANGE',
        targetType: 'ACCOUNT',
        targetId: accountId,
        result: result.code === 'SAME_PLAN' || result.code === 'SCHEDULED_CHANGE_PENDING' ? 'DENIED' : 'FAILURE',
        before: result.oldPlan ? { planType: result.oldPlan } : null,
        after: { planType: newPlan },
        details: { code: result.code, message: result.message },
      });
      return NextResponse.json(
        { error: result.code, code: result.code, message: result.message },
        { status: ADMIN_PLAN_CHANGE_HTTP_STATUS[result.code] },
      );
    }
    await logAdminAction({
      adminId,
      action: 'ACCOUNT_PLAN_CHANGE',
      targetType: 'ACCOUNT',
      targetId: accountId,
      result: 'SUCCESS',
      before: { planType: result.oldPlan },
      after: { planType: result.newPlan },
      details: { stripeUpdated: result.stripeUpdated, billingPeriod: result.billingPeriod },
    });
    return NextResponse.json({
      success: true,
      planType: result.newPlan,
      stripeUpdated: result.stripeUpdated,
      message: result.stripeUpdated
        ? "Offre modifiée. Stripe facturera le prix de la nouvelle offre à la prochaine échéance, sans prorata."
        : "Offre modifiée dans Verebona. Aucun abonnement Stripe actif : rien n'a été modifié côté Stripe.",
    });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('Failed to update account:', error);
    return NextResponse.json({ error: 'Failed to update account' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/accounts/[id] — suppression définitive via le workflow
 * unique (CDC Back-Office V1 ACC-A14 à ACC-A17).
 *
 * Confirmation renforcée (ACC-A15) : le corps doit porter le nom exact du
 * compte, `{ "confirmName": "…" }` — vérifié côté serveur, pas seulement dans
 * l'interface.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const { id } = await params;
  const accountId = Number(id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return NextResponse.json({ error: 'Invalid account ID' }, { status: 400 });
  }

  try {
    const [account] = await db
      .select({ id: accounts.id, name: accounts.name, ownerUserId: accounts.ownerUserId, planType: accounts.planType })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as { confirmName?: unknown } | null;
    if (typeof body?.confirmName !== 'string' || body.confirmName.trim() !== account.name.trim()) {
      return NextResponse.json(
        { error: 'CONFIRMATION_MISMATCH', code: 'CONFIRMATION_MISMATCH', message: 'Le nom saisi ne correspond pas au nom du compte.' },
        { status: 400 },
      );
    }

    const before = { name: account.name, ownerUserId: account.ownerUserId, planType: account.planType };
    const outcome = await deleteAccountAsAdmin(accountId);

    if (!outcome.ok) {
      const stripeBlocked = outcome.code === 'STRIPE_SUBSCRIPTION_ACTIVE';
      await logAdminAction({
        adminId,
        action: 'ACCOUNT_DELETE',
        targetType: 'ACCOUNT',
        targetId: accountId,
        result: stripeBlocked ? 'DENIED' : 'FAILURE',
        before,
        details: {
          code: outcome.code,
          ...(outcome.code === 'EXECUTION_FAILED'
            ? { scheduleId: outcome.scheduleId, reason: outcome.execution.reason }
            : {}),
        },
      });
      if (stripeBlocked) {
        return NextResponse.json(
          {
            error: outcome.code,
            code: outcome.code,
            message:
              "Un abonnement Stripe est encore actif. Résiliez-le d'abord dans Stripe, puis relancez la suppression.",
            stripeUrl: stripeDashboardUrl('subscriptions', outcome.stripeSubscriptionId),
          },
          { status: 409 },
        );
      }
      if (outcome.code === 'ACCOUNT_NOT_FOUND') {
        return NextResponse.json({ error: 'Account not found' }, { status: 404 });
      }
      return NextResponse.json(
        {
          error: 'DELETION_FAILED',
          code: 'DELETION_FAILED',
          message: `La suppression n'a pas abouti et rien n'a été supprimé : ${outcome.execution.reason ?? 'erreur inconnue'}.`,
        },
        { status: 500 },
      );
    }

    await logAdminAction({
      adminId,
      action: 'ACCOUNT_DELETE',
      targetType: 'ACCOUNT',
      targetId: accountId,
      result: 'SUCCESS',
      before,
      after: { deleted: true },
      details: {
        scheduleId: outcome.scheduleId,
        supersededScheduleId: outcome.supersededScheduleId,
        deleted: outcome.execution.deleted,
        preserved: outcome.execution.preserved,
      },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('Failed to delete account:', error);
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}
