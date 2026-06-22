import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accounts, users, accountMemberships, assets, accountAuditLog, duoAccounts, duoMemberships, assetTransmissions, suppliers, supplierReviewItems, documentSuppliers, equipmentSuppliers, assetSuppliers } from '@/db/schema';
import { eq, sql, desc, inArray } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';
import { SessionService } from '@/lib/session-service';
import { applyPlanChange, type KnownPlan } from '@/lib/plan-enforcement';

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
        stripeSubscriptionId: duoAccounts.stripeSubscriptionId,
        stripeCustomerId: duoAccounts.stripeCustomerId,
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

    return NextResponse.json({
      account,
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

export async function PATCH(
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

    const body = await request.json();
    const {
      planType,
      duoAction,
      stripeCustomerId,
      stripeSubscriptionId,
      subscriptionStatus,
      premiumUntil,
      maxMembers,
    } = body as {
      planType?: string;
      duoAction?: 'activate' | 'deactivate';
      stripeCustomerId?: string | null;
      stripeSubscriptionId?: string | null;
      subscriptionStatus?: string;
      premiumUntil?: number | null;
      maxMembers?: number;
    };

    // Fetch the account
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // ── Plan change: route through shared applyPlanChange so all tables stay in sync ──
    if (planType !== undefined) {
      const resolvedPlan = planType as KnownPlan;
      const resolvedStatus =
        resolvedPlan === 'STANDARD' ? 'NONE'
        : (subscriptionStatus ?? account.subscriptionStatus ?? 'ACTIVE');
      const resolvedPremiumUntil =
        resolvedPlan === 'STANDARD' ? null
        : (premiumUntil !== undefined ? premiumUntil : account.premiumUntil);
      const resolvedMaxMembers =
        resolvedPlan === 'STANDARD' ? 1
        : resolvedPlan === 'PREMIUM_DUO' ? 2
        : 1; // PREMIUM

      await applyPlanChange({
        accountId,
        ownerUserId: account.ownerUserId,
        oldPlanType: account.planType,
        newPlanType: resolvedPlan,
        newSubStatus: resolvedStatus,
        newPremiumUntil: resolvedPremiumUntil,
        newMaxMembers: resolvedMaxMembers,
        source: 'admin:override',
        sendEmails: false, // admin overrides are silent — no user-facing emails
      });
    }

    // ── Stripe ID updates (independent of plan change) ──
    const stripeUpdate: Record<string, unknown> = { updatedAt: new Date() };
    let hasStripeUpdate = false;
    if (stripeCustomerId !== undefined) { stripeUpdate.stripeCustomerId = stripeCustomerId || null; hasStripeUpdate = true; }
    if (stripeSubscriptionId !== undefined) { stripeUpdate.stripeSubscriptionId = stripeSubscriptionId || null; hasStripeUpdate = true; }
    if (hasStripeUpdate) {
      await db.update(accounts).set(stripeUpdate).where(eq(accounts.id, accountId));
    }

    // ── Toggle account active status ──
    if (body.isActive !== undefined) {
      await db.update(accounts).set({ isActive: body.isActive, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    }

    // ── Remove a specific member ──
    if (body.removeMembershipId !== undefined) {
      const membershipId = parseInt(body.removeMembershipId);
      const [membership] = await db.select().from(accountMemberships).where(eq(accountMemberships.id, membershipId)).limit(1);
      if (!membership || membership.accountId !== accountId) {
        return NextResponse.json({ error: 'Membership not found' }, { status: 404 });
      }
      if (membership.role === 'owner') {
        return NextResponse.json({ error: 'Cannot remove the account owner' }, { status: 400 });
      }
      await db.update(accountMemberships)
        .set({ status: 'removed', removedAt: new Date() })
        .where(eq(accountMemberships.id, membershipId));
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const errMsg = (error as Error).message;
    if (['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED', 'INSUFFICIENT_PERMISSIONS'].includes(errMsg)) {
      return SessionService.handleSessionError(error);
    }
    console.error('Failed to update account:', error);
    return NextResponse.json({ error: 'Failed to update account' }, { status: 500 });
  }
}

export async function DELETE(
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

    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Nullify duplicatedAssetId FK before cascade-deleting assets (no ON DELETE on this FK)
    const accountAssets = await db.select({ id: assets.id })
      .from(assets).where(eq(assets.accountId, accountId));
    if (accountAssets.length > 0) {
      const assetIds = accountAssets.map(a => a.id);
      await db.update(assetTransmissions)
        .set({ duplicatedAssetId: null })
        .where(inArray(assetTransmissions.duplicatedAssetId, assetIds));
    }

    // Delete duo_accounts linked to the owner
    const duoList = await db.select({ id: duoAccounts.id })
      .from(duoAccounts)
      .where(eq(duoAccounts.billingOwnerUserId, account.ownerUserId));
    for (const duo of duoList) {
      await db.delete(duoMemberships).where(eq(duoMemberships.duoId, duo.id));
      await db.delete(duoAccounts).where(eq(duoAccounts.id, duo.id));
    }

    // Delete supplier junction tables and review items before suppliers (FKs reference suppliers.id with NO ACTION)
    const supplierIds = (await db.select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.accountId, accountId))).map(s => s.id);
    if (supplierIds.length > 0) {
      await db.delete(documentSuppliers).where(inArray(documentSuppliers.supplierId, supplierIds));
      await db.delete(equipmentSuppliers).where(inArray(equipmentSuppliers.supplierId, supplierIds));
      await db.delete(assetSuppliers).where(inArray(assetSuppliers.supplierId, supplierIds));
    }
    // supplierContactObservations cascade-deletes on supplier delete — OK
    await db.delete(supplierReviewItems).where(eq(supplierReviewItems.accountId, accountId));
    await db.delete(suppliers).where(eq(suppliers.accountId, accountId));

    // Nullify/delete assetTransmissions where the owner user is initiator (no FK cascade)
    await db.delete(assetTransmissions).where(eq(assetTransmissions.initiatorUserId, account.ownerUserId));
    await db.delete(assetTransmissions).where(eq(assetTransmissions.recipientUserId, account.ownerUserId));

    // Delete the account — DB cascade handles: accountMemberships, assets, accountAuditLog, subscriptionHistory
    await db.delete(accounts).where(eq(accounts.id, accountId));

    // Nullify cross-account FK references before deleting the owner user
    await db.update(suppliers)
      .set({ createdByUserId: undefined })
      .where(eq(suppliers.createdByUserId, account.ownerUserId));
    await db.update(supplierReviewItems)
      .set({ resolvedByUserId: null })
      .where(eq(supplierReviewItems.resolvedByUserId, account.ownerUserId));

    // Delete the owner user (cascade handles remaining user-linked rows)
    await db.delete(users).where(eq(users.id, account.ownerUserId));

    return NextResponse.json({ success: true });
  } catch (error) {
    const errMsg = (error as Error).message;
    if (['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED', 'INSUFFICIENT_PERMISSIONS'].includes(errMsg)) {
      return SessionService.handleSessionError(error);
    }
    console.error('Failed to delete account:', error);
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
  }
}
