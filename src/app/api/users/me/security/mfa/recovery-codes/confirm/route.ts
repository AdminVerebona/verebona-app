/** POST /api/users/me/security/mfa/recovery-codes/confirm — conservation des codes confirmée (lot 110B). */
import type { NextRequest } from 'next/server';
import { mfaJson, withSession } from '@/lib/auth/mfa/http';
import { markRecoveryConfirmed } from '@/lib/auth/mfa/db';

export async function POST(request: NextRequest) {
  return withSession(request, async (session) => {
    await markRecoveryConfirmed(session.userId);
    return mfaJson({ success: true });
  });
}
