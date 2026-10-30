/**
 * PATCH /api/admin/communications/fin-essai/settings — lot 100G : réglages de
 * la séquence de fin d'essai (notifications de service, campagne commerciale,
 * base légale et déclaration « client existant », jours des relances,
 * fenêtres de rattrapage, heures d'envoi, lien « offres »).
 *
 * Activer la campagne commerciale exige `confirmed: true` (confirmation
 * explicite de l'écran). Chaque changement, refus compris, est journalisé
 * (journal d'administration + journal de la séquence). Le J+80 n'a AUCUN
 * réglage : son verrou est côté serveur (politique de conservation).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { pgClient } from '@/db';
import { saveTrialLifecycleSettings } from '@/services/trial-lifecycle/settings.service';

export async function PATCH(request: NextRequest) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || !body.settings || typeof body.settings !== 'object') {
    return NextResponse.json({ code: 'INVALID_BODY', message: 'Corps attendu : { settings: { … }, confirmed? }.' }, { status: 400 });
  }
  const patch = body.settings as Record<string, unknown>;
  const [admin] = await pgClient<{ email: string }[]>`SELECT email FROM users WHERE id = ${adminId}`;
  const adminEmail = admin?.email ?? `user:${adminId}`;

  if ((patch.commercialEnabled === true || patch.softOptInDeclared === true) && body.confirmed !== true) {
    await logAdminAction({ adminId, adminEmail, action: 'TRIAL_LIFECYCLE_SETTINGS_UPDATE', targetType: 'TRIAL_LIFECYCLE', targetId: null, result: 'DENIED', after: patch, details: { reason: 'CONFIRMATION_REQUIRED' } });
    return NextResponse.json({ code: 'CONFIRMATION_REQUIRED', message: 'Confirmation explicite requise pour activer la campagne commerciale ou déclarer la base « client existant ».' }, { status: 409 });
  }
  try {
    const r = await saveTrialLifecycleSettings({ patch, admin: { id: adminId, email: adminEmail } });
    if (!r.ok) {
      await logAdminAction({ adminId, adminEmail, action: 'TRIAL_LIFECYCLE_SETTINGS_UPDATE', targetType: 'TRIAL_LIFECYCLE', targetId: null, result: 'FAILURE', after: patch, details: { issues: r.issues.map((i) => i.field) } });
      return NextResponse.json({ code: 'INVALID_SETTINGS', message: r.issues.map((i) => i.message).join(' '), issues: r.issues }, { status: 400 });
    }
    if (r.changed) {
      await logAdminAction({ adminId, adminEmail, action: 'TRIAL_LIFECYCLE_SETTINGS_UPDATE', targetType: 'TRIAL_LIFECYCLE', targetId: null, result: 'SUCCESS', before: r.before as never, after: r.settings as never });
    }
    return NextResponse.json({ settings: r.settings, changed: r.changed });
  } catch (error) {
    console.error('[admin/communications/fin-essai/settings] PATCH :', error);
    await logAdminAction({ adminId, adminEmail, action: 'TRIAL_LIFECYCLE_SETTINGS_UPDATE', targetType: 'TRIAL_LIFECYCLE', targetId: null, result: 'FAILURE', after: patch, details: { reason: 'ERROR' } });
    return NextResponse.json({ code: 'SAVE_FAILED', message: 'Enregistrement impossible.' }, { status: 500 });
  }
}
