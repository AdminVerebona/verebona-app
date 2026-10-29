/**
 * POST /api/users/me/password — lot 93, CDC 18 §10.2, §29 (PWD-02/03/04) :
 * ajoute un PREMIER mot de passe à un compte créé avec Google ou Apple
 * (« social-only »), après réauthentification fraîche par le fournisseur lié.
 * Le mot de passe est associé à l'adresse principale Verebona (vérifiée),
 * jamais à l'adresse technique du fournisseur. Il devient une méthode de
 * connexion supplémentaire ; il ne pourra pas être supprimé (V1), seulement
 * modifié (`/api/users/me/change-password`). Un compte qui a déjà un mot de
 * passe est refusé (409). Notification de sécurité « mot de passe modifié ».
 * Corps : { newPassword }. Preuve : réauthentification du lot 92 de CETTE
 * session (`requireFreshReauth`), consommée comme pour un changement.
 */
import { NextResponse, type NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { pgClient } from '@/db';
import { validatePassword, getPasswordValidationError } from '@/lib/auth/password';
import { SessionService } from '@/lib/session-service';
import { consumeReauthProof, invalidateReauthProofs, reauthRequiredResponse, requireFreshReauth } from '@/lib/auth/reauth';
import { emit } from '@/lib/notifications';
import { logUserActivity } from '@/lib/audit-logger';

function alreadySet(): NextResponse {
  const message = 'Votre compte a déjà un mot de passe : utilisez « Modifier ».';
  return NextResponse.json({ error: message, code: 'PASSWORD_ALREADY_SET', message }, { status: 409 });
}

export async function POST(request: NextRequest) {
  let userId: number;
  try {
    userId = (await SessionService.getSession(request)).userId;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
  // PWD-04 : un mot de passe existant se modifie, il ne se recrée pas (avant même la preuve).
  const [current] = await pgClient<{ has_password: boolean }[]>`
    SELECT (password_hash IS NOT NULL AND password_hash <> '') AS has_password FROM users WHERE id = ${userId}`;
  if (current?.has_password) return alreadySet();

  const reauth = await requireFreshReauth(request, { action: 'add_password' });
  if (!reauth.ok) return reauth.response;
  const { session, proof } = reauth;
  const body = (await request.json().catch(() => ({}))) as { newPassword?: unknown };
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (!validatePassword(newPassword)) return NextResponse.json(getPasswordValidationError(), { status: 400 });
  // Action à risque maximal (comme le changement) : la preuve est consommée.
  if (!(await consumeReauthProof(proof.id, 'add_password'))) return reauthRequiredResponse('REAUTH_EXPIRED');

  const hash = await bcrypt.hash(newPassword, 10);
  // Écriture CONDITIONNELLE : seulement si aucun mot de passe n'existe (deux onglets, double clic).
  const rows = await pgClient<{ email: string }[]>`
    UPDATE users SET password_hash = ${hash}, updated_at = now()
     WHERE id = ${session.userId} AND password_hash IS NULL
    RETURNING email`;
  if (rows.length === 0) return alreadySet();
  // Lot 96A (CDC 18 Q7) : nouvel identifiant — preuves de TOUTES les sessions retirées.
  await invalidateReauthProofs(session.userId, { reason: 'password_added' });
  void logUserActivity({
    activityType: 'PASSWORD_CREATED', userId: session.userId, userEmail: rows[0].email,
    details: { reauthMethod: proof.method }, request,
  });
  try {
    await emit({
      type: 'PASSWORD_CHANGED',
      recipientUserIds: [session.userId],
      entityType: 'user',
      entityId: session.userId,
      payload: {},
      dedupeKey: `security:password-created:${session.userId}:${Date.now()}`,
    });
  } catch (e) {
    console.error('[password] notification en échec :', (e as Error)?.message ?? e);
  }
  return NextResponse.json({ success: true, email: rows[0].email, message: 'Mot de passe ajouté. Vous pouvez désormais vous connecter avec votre adresse e-mail et ce mot de passe.' });
}
