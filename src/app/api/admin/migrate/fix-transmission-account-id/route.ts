import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { accountMemberships, assets, assetTransmissions } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

/**
 * GET /api/admin/migrate/fix-transmission-account-id
 * Repairs accepted transmissions where the duplicated asset has accountId=null.
 * This was caused by a bug where the recipient's accountId was not resolved
 * during asset duplication.
 */
export async function GET(request: NextRequest) {
  await requireAdmin(request);

  // Find all accepted transmissions with a duplicated asset
  const transmissions = await db
    .select({
      transmissionId: assetTransmissions.id,
      duplicatedAssetId: assetTransmissions.duplicatedAssetId,
    })
    .from(assetTransmissions)
    .where(
      and(
        eq(assetTransmissions.status, 'accepted'),
      )
    );

  let fixed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const tx of transmissions) {
    if (!tx.duplicatedAssetId) { skipped++; continue; }

    const [asset] = await db
      .select({ id: assets.id, userId: assets.userId, accountId: assets.accountId })
      .from(assets)
      .where(eq(assets.id, tx.duplicatedAssetId))
      .limit(1);

    if (!asset) { skipped++; continue; }
    if (asset.accountId !== null) { skipped++; continue; }

    // Resolve accountId from accountMemberships
    const [membership] = await db
      .select({ accountId: accountMemberships.accountId })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, asset.userId))
      .limit(1);

    if (!membership?.accountId) {
      errors.push(`No membership found for asset ${asset.id} (userId ${asset.userId})`);
      continue;
    }

    await db
      .update(assets)
      .set({ accountId: membership.accountId })
      .where(and(eq(assets.id, asset.id), isNull(assets.accountId)));

    fixed++;
  }

  return NextResponse.json({ fixed, skipped, errors });
}
