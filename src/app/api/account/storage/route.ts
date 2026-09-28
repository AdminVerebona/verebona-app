/**
 * GET /api/account/storage — consommation de stockage du compte courant.
 *
 * CDC Back-Office V1 STO-002 : le stockage est un garde-fou secondaire, mais
 * visible dans Mon compte (et dans le BO). Même calcul que le contrôle de
 * dépôt (`lib/storage-quota.ts`) : ce qui est affiché est ce qui bloque.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { getAccountStorageUsage } from '@/lib/storage-quota';

export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    if (!session.currentAccountId) {
      return NextResponse.json({ error: 'NO_ACCOUNT', message: 'Aucun compte actif.' }, { status: 404 });
    }
    const usage = await getAccountStorageUsage(session.currentAccountId);
    const ratio = usage.limitBytes > 0 ? usage.usedBytes / usage.limitBytes : 0;
    return NextResponse.json({
      usedBytes: usage.usedBytes,
      limitBytes: usage.limitBytes,
      ratio,
      isFull: usage.limitBytes > 0 && usage.usedBytes >= usage.limitBytes,
    });
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
