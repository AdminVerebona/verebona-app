/**
 * DELETE /api/users/me/auth-identities/{google|apple} — lot 93, CDC 18 §12.3,
 * §29 : dissociation après réauthentification fraîche (< 5 min) et
 * confirmation explicite côté écran ; REFUSÉE si elle retirait la dernière
 * méthode de connexion (LAST_LOGIN_METHOD, contrôle serveur atomique).
 * Notification de sécurité (NOTIF-01) ; Apple : autorisation révoquée.
 * Preuve : réauthentification du lot 92 (`requireReauth`, action
 * `unlink-provider`) ; corps facultatif { currentPassword } (clients anciens).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isOAuthProvider } from '@/lib/auth/oauth/config';
import { unlinkIdentity } from '@/lib/auth/oauth/identities';
import { requireReauth, revokeAppleTokensLater } from '@/lib/auth/oauth/account-security';
import { notifyIdentityChange } from '@/lib/auth/oauth/flow';
import { SOCIAL_ERROR_MESSAGES } from '@/lib/auth/oauth/messages';

export async function DELETE(request: NextRequest, context: { params: Promise<{ provider: string }> }) {
  const provider = (await context.params).provider;
  if (!isOAuthProvider(provider)) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // Session ET preuve de réauthentification 92 de cette session.
  const session = await requireReauth(request, body, 'unlink-provider');
  if (!session.ok) return session.response;

  const outcome = await unlinkIdentity(session.userId, provider);
  if (!outcome.ok) {
    const message = outcome.code === 'LAST_LOGIN_METHOD' ? SOCIAL_ERROR_MESSAGES.LAST_LOGIN_METHOD : 'Ce fournisseur n’est pas associé à votre compte.';
    return NextResponse.json({ error: message, code: outcome.code, message }, { status: outcome.code === 'LAST_LOGIN_METHOD' ? 409 : 404 });
  }
  if (provider === 'apple' && outcome.refreshTokenCiphertext) {
    revokeAppleTokensLater(session.userId, [outcome.refreshTokenCiphertext], 'dissociation');
  }
  await notifyIdentityChange(request, session.userId, session.email, provider, 'unlinked', 'security');
  return NextResponse.json({ success: true, provider });
}
