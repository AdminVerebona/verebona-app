/**
 * GET /api/public/marketing/signup-notice — lot 102C (ticket conformité,
 * P2 « Prospection post-essai »). Bloc d'information / de choix sur les
 * relances commerciales à afficher sous le formulaire d'inscription (locale
 * et Google / Apple), selon la base légale et le mécanisme choisis au BO.
 * `notice: null` tant que le PO n'a rien activé (défaut).
 *
 * Public (formulaire sans session) ; aucune donnée personnelle ; jamais mis
 * en cache (un changement du BO s'applique au parcours suivant).
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [{ loadTrialLifecycleSettings }, { signupNoticeFor, currentPrivacyPolicyUrl }] = await Promise.all([
      import('@/services/trial-lifecycle/settings.service'),
      import('@/services/trial-lifecycle/signup-collection'),
    ]);
    const { settings } = await loadTrialLifecycleSettings();
    return NextResponse.json({ notice: signupNoticeFor(settings, await currentPrivacyPolicyUrl()) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[public/marketing/signup-notice] :', (e as Error).message);
    // Prudence : sans réglage lisible, aucun bloc (aucune relance ne sera possible faute de preuve).
    return NextResponse.json({ notice: null }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
