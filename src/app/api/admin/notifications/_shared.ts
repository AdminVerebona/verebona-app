/**
 * Garde commune des routes de notifications du BO (CDC 3 §20 ; D-L, lot 21).
 *
 * Contrôle d'accès administrateur unique (CDC BO GEN-002 : relit le rôle en
 * base si le jeton est antérieur à une promotion) et journal des actions
 * (`logAdminAction`) : recherche, réémission, renvoi.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { logAdminAction, type AdminActionEntry } from '@/lib/admin-audit';
import { reemettreNotification, ReemissionError } from '@/services/notifications/notification-reemission.service';

export async function requireAdminContext(
  req: NextRequest,
): Promise<{ ok: true; adminId: number; adminEmail?: string } | { ok: false; response: NextResponse }> {
  try {
    const adminId = await SessionService.requireAdmin(req);
    const session = await SessionService.getSession(req).catch(() => null);
    await ensureMigrations();
    return { ok: true, adminId, adminEmail: session?.email ?? undefined };
  } catch (e) {
    return { ok: false, response: SessionService.handleSessionError(e) };
  }
}

/** Journalise une action de notifications (ne lève jamais). */
export async function logNotificationAction(
  admin: { adminId: number; adminEmail?: string },
  action: Extract<AdminActionEntry['action'], 'NOTIFICATION_SEARCH' | 'NOTIFICATION_REEMIT' | 'NOTIFICATION_RESEND'>,
  result: AdminActionEntry['result'],
  details: Record<string, unknown>,
): Promise<void> {
  await logAdminAction({ adminId: admin.adminId, adminEmail: admin.adminEmail, action, targetType: 'NOTIFICATION', targetId: null, result, details });
}

/** Réémission (§20.3), partagée avec `[outboxId]/resend`. */
export async function reemettre(
  req: NextRequest,
  admin: { adminId: number; adminEmail?: string },
  action: 'NOTIFICATION_REEMIT' | 'NOTIFICATION_RESEND',
  outboxIdParam?: string,
): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps invalide.' }, { status: 400 });
  }

  const outboxId = outboxIdParam ?? body.outboxId;
  if (typeof outboxId !== 'string') {
    return NextResponse.json({ error: '`outboxId` requis.' }, { status: 400 });
  }

  try {
    const resultat = await reemettreNotification({
      outboxId,
      actorUserId: admin.adminId,
      actorEmail: admin.adminEmail ?? `user:${admin.adminId}`,
      // §20.3 condition 4 : la confirmation vient du client, explicitement.
      // Elle n'est jamais déduite de la présence de la requête.
      confirme: body.confirme === true,
      motif: typeof body.motif === 'string' ? body.motif : undefined,
    });
    // Le service journalise la réémission réussie ; un renvoi par l'ancienne
    // route est tracé en plus sous son propre nom.
    if (action === 'NOTIFICATION_RESEND') {
      await logNotificationAction(admin, action, 'SUCCESS', { origine: outboxId, nouvelle: resultat.nouvelleId });
    }
    return NextResponse.json(resultat);
  } catch (e) {
    if (e instanceof ReemissionError) {
      await logNotificationAction(admin, action, 'DENIED', { origine: outboxId, code: e.code });
      const status = e.code === 'INTROUVABLE' ? 404 : 409;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    await logNotificationAction(admin, action, 'FAILURE', { origine: outboxId, error: (e as Error).message.slice(0, 200) });
    console.error('[reemission] échec :', (e as Error).message);
    return NextResponse.json({ error: 'Erreur interne.', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
