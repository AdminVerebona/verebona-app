import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accounts, users, accountMemberships, assets, assetFiles, duoAccounts, scheduledAccountDeletions } from '@/db/schema';
import { and, count, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';

/**
 * GET /api/admin/accounts[?q=…] — liste des comptes, CDC Back-Office V1 §5.1.
 *
 * Colonnes (§5.1) : nom, offre, statut, utilisateurs, biens, documents,
 * stockage utilisé, date de création, dernière connexion (de n'importe quel
 * membre). En tête (ACC-L01) : total et synthèse par statut.
 *
 * ACC-L02 / REC-ACC-01 — recherche SERVEUR `q` : nom du compte, OU prénom /
 * nom / e-mail de N'IMPORTE QUEL utilisateur rattaché (et non plus du seul
 * titulaire, filtré côté navigateur). Insensible à la casse.
 *
 * SUB-012 : aucun identifiant Stripe renvoyé.
 *
 * Hors lot : filtres, tri serveur et pagination (ACC-L03 à L05, P2).
 */

/** Motif ILIKE « contient », jokers de l'utilisateur neutralisés. */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function searchCondition(q: string): SQL {
  const pattern = containsPattern(q);
  return or(
    sql`${accounts.name} ILIKE ${pattern}`,
    sql`EXISTS (
      SELECT 1
        FROM ${accountMemberships} m
        JOIN ${users} u ON u.id = m.user_id
       WHERE m.account_id = ${accounts.id}
         AND m.status IN ('active', 'ACTIVE', 'pending')
         AND (u.email ILIKE ${pattern}
           OR u.first_name ILIKE ${pattern}
           OR u.last_name ILIKE ${pattern}
           OR (u.first_name || ' ' || u.last_name) ILIKE ${pattern})
    )`,
    // Titulaire sans adhésion (données anciennes) : couvert par la jointure.
    sql`${users.email} ILIKE ${pattern}`,
    sql`(${users.firstName} || ' ' || ${users.lastName}) ILIKE ${pattern}`,
  ) as SQL;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const q = (request.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 200);

    const allAccounts = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        ownerId: accounts.ownerUserId,
        createdAt: accounts.createdAt,
        ownerEmail: users.email,
        ownerName: sql<string>`COALESCE(${users.firstName} || ' ' || ${users.lastName}, ${users.email})`,
        planType: accounts.planType,
        subscriptionStatus: accounts.subscriptionStatus,
        isActive: accounts.isActive,
        hasStripeCustomer: sql<boolean>`${accounts.stripeCustomerId} IS NOT NULL`,
        duoAccountId: accounts.duoAccountId,
        duoStatus: duoAccounts.subscriptionStatus,
      })
      .from(accounts)
      .leftJoin(users, eq(accounts.ownerUserId, users.id))
      .leftJoin(duoAccounts, eq(accounts.duoAccountId, duoAccounts.id))
      .where(q ? searchCondition(q) : undefined);

    const accountIds = allAccounts.map((a) => a.id);

    // Agrégats groupés : une requête par indicateur, jamais une par compte.
    const [memberRows, assetRows, fileRows, loginRows, deletionRows] = accountIds.length > 0
      ? await Promise.all([
          db.select({ accountId: accountMemberships.accountId, cnt: count() })
            .from(accountMemberships)
            .where(and(inArray(accountMemberships.accountId, accountIds), eq(accountMemberships.status, 'active')))
            .groupBy(accountMemberships.accountId),
          db.select({ accountId: assets.accountId, cnt: count() })
            .from(assets)
            .where(and(inArray(assets.accountId, accountIds), isNull(assets.deletedAt)))
            .groupBy(assets.accountId),
          // Documents et stockage : fichiers non supprimés au dépôt confirmé
          // (même règle que le plafond de stockage, `lib/storage-quota.ts`).
          db.select({
            accountId: assetFiles.accountId,
            cnt: count(),
            bytes: sql<string>`coalesce(sum(${assetFiles.size}), 0)`,
          })
            .from(assetFiles)
            .where(and(
              inArray(assetFiles.accountId, accountIds),
              isNull(assetFiles.deletedAt),
              or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
            ))
            .groupBy(assetFiles.accountId),
          db.select({
            accountId: accountMemberships.accountId,
            lastLoginAt: sql<Date | null>`max(${users.lastLoginAt})`,
          })
            .from(accountMemberships)
            .innerJoin(users, eq(users.id, accountMemberships.userId))
            .where(inArray(accountMemberships.accountId, accountIds))
            .groupBy(accountMemberships.accountId),
          db.select({ accountId: scheduledAccountDeletions.accountId })
            .from(scheduledAccountDeletions)
            .where(and(
              inArray(scheduledAccountDeletions.accountId, accountIds),
              eq(scheduledAccountDeletions.status, 'SCHEDULED'),
            )),
        ])
      : [[], [], [], [], []];

    const members = new Map(memberRows.map((r) => [r.accountId, Number(r.cnt)]));
    const assetCounts = new Map(assetRows.map((r) => [r.accountId, Number(r.cnt)]));
    const files = new Map(fileRows.map((r) => [r.accountId, { cnt: Number(r.cnt), bytes: Number(r.bytes) }]));
    const logins = new Map(loginRows.map((r) => [r.accountId, r.lastLoginAt]));
    const deletionPending = new Set(deletionRows.map((r) => r.accountId));

    const rows = allAccounts.map((account) => {
      const status: 'active' | 'suspended' | 'deletion_pending' =
        deletionPending.has(account.id) ? 'deletion_pending' : account.isActive ? 'active' : 'suspended';
      return {
        ...account,
        planType: (account.planType || 'STANDARD').toUpperCase(),
        status,
        memberCount: members.get(account.id) ?? 0,
        assetCount: assetCounts.get(account.id) ?? 0,
        documentCount: files.get(account.id)?.cnt ?? 0,
        storageBytes: files.get(account.id)?.bytes ?? 0,
        lastLoginAt: logins.get(account.id) ?? null,
      };
    });

    const summary = {
      total: rows.length,
      active: rows.filter((r) => r.status === 'active').length,
      suspended: rows.filter((r) => r.status === 'suspended').length,
      deletionPending: rows.filter((r) => r.status === 'deletion_pending').length,
    };

    return NextResponse.json({ accounts: rows, summary, query: q || null });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('Failed to fetch accounts:', error);
    return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 });
  }
}
