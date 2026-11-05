/** POST /api/auth/mfa/cancel — abandon de l'étape provisoire (aucun accès accordé). */
import { type NextRequest } from 'next/server';
import { mfaJson } from '@/lib/auth/mfa/http';
import { cancelPending, clearPendingCookie, readPending } from '@/lib/auth/mfa/pending';

export async function POST(request: NextRequest) {
  const ctx = await readPending(request).catch(() => null);
  if (ctx) await cancelPending(ctx.pid).catch(() => null);
  const res = mfaJson({ success: true });
  clearPendingCookie(res);
  return res;
}
