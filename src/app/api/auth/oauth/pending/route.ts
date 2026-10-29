/**
 * Étape d'inscription / de rattachement après le retour Google / Apple — lot
 * 93, CDC 18 §7.2, §8.1, §8.2, §37. Liée au navigateur (cookie `vb_oauth`).
 *
 *   GET  → état affiché par /connexion-sociale (410 si expirée ou inconnue) ;
 *   POST { action: 'link-password', email, password }  « J'ai déjà un compte » ;
 *        { action: 'signup', firstName, lastName, email, acceptedTerms, termsVersion, referralCode } ;
 *        { action: 'verify-code', code } ; { action: 'resend-code' } ; { action: 'cancel' }.
 *
 * Aucun fournisseur actif : 404.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { enabledProviders } from '@/lib/auth/oauth/config';
import { notFound } from '@/lib/auth/oauth/flow';
import {
  cancelPending, linkWithPassword, loadPending, pendingState, resendEmailCode, signup, verifyEmailCode,
} from '@/lib/auth/oauth/pending';

function anyProvider(): boolean {
  const e = enabledProviders();
  return e.google || e.apple;
}

export async function GET(request: NextRequest) {
  if (!anyProvider()) return notFound();
  const tx = await loadPending(request);
  if (tx instanceof NextResponse) return tx;
  return NextResponse.json(await pendingState(tx), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: NextRequest) {
  if (!anyProvider()) return notFound();
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const tx = await loadPending(request);
  if (tx instanceof NextResponse) return tx;
  try {
    switch (body.action) {
      case 'link-password': return await linkWithPassword(request, tx, body);
      case 'signup': return await signup(request, tx, body);
      case 'verify-code': return await verifyEmailCode(request, tx, body);
      case 'resend-code': return await resendEmailCode(request, tx);
      case 'cancel': return await cancelPending(tx);
      default: return NextResponse.json({ error: 'Action inconnue', code: 'INVALID_ACTION' }, { status: 400 });
    }
  } catch (e) {
    console.error('[oauth] étape en attente :', (e as Error)?.message ?? e);
    return NextResponse.json({ error: 'Une erreur est survenue. Réessayez.', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
