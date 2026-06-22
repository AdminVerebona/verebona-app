import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { referralLinks, accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * GET /api/referral/validate/[code]
 * Route publique (pas d'auth requise).
 * Valide un code de parrainage et retourne le nom du parrain si valide.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  if (!code || code.length > 20) {
    return NextResponse.json({ valid: false, reason: 'INVALID_FORMAT' });
  }

  const [link] = await db
    .select({
      id: referralLinks.id,
      accountId: referralLinks.accountId,
      isActive: referralLinks.isActive,
    })
    .from(referralLinks)
    .where(eq(referralLinks.code, code.toUpperCase()))
    .limit(1);

  if (!link || !link.isActive) {
    return NextResponse.json({ valid: false, reason: 'CODE_NOT_FOUND' });
  }

  // Récupérer un nom d'affichage pour le parrain
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, link.accountId))
    .limit(1);

  if (!account) {
    return NextResponse.json({ valid: false, reason: 'CODE_NOT_FOUND' });
  }

  return NextResponse.json({ valid: true, code: code.toUpperCase() });
}
