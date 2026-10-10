import { NextRequest, NextResponse } from 'next/server';
import { normalizeReferralCode, resolveReferralCode } from '@/services/referral-attribution.service';
import { appBaseUrl, referralRedirectPath } from '@/services/referral/referral-invitation.service';

// Lu à chaque requête : un lien désactivé dans le BO cesse aussitôt d'être propagé.
export const dynamic = 'force-dynamic';

/**
 * GET /r/<code> — lien de parrainage partagé (lot 34I).
 *
 * Ce lien est généré par Mon compte › Parrainage et par l'e-mail
 * d'invitation (`buildReferralUrl`), mais aucune route ne le recevait : il
 * aboutissait à la page 404.
 *
 * Code connu et actif → `/signup?ref=CODE` ; le formulaire affiche « code de
 * parrainage appliqué » et le transmet à `POST /api/users`, qui mémorise
 * l'attribution (`recordSignupReferral`). Code inconnu, désactivé ou mal
 * formé → `/signup`, sans erreur. Aucune base joignable → `/signup?ref=CODE` :
 * le serveur jugera le code à l'inscription (il enregistre un code rejeté
 * avec son motif), le visiteur n'est pas bloqué.
 *
 * Pas de cookie : le CDC parrainage §4.2 interdit toute conservation
 * persistante du code (voir `referralRedirectPath`).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code: raw } = await params;
  const code = normalizeReferralCode(raw);

  let target = referralRedirectPath(null);
  if (code) {
    try {
      const resolved = await resolveReferralCode(code, null);
      if (resolved) target = referralRedirectPath(code);
      else console.info(`[referral] lien /r/ inconnu ou inactif : ${code}`);
    } catch (error) {
      console.error('[referral] vérification du lien /r/ impossible :', (error as Error).message);
      target = referralRedirectPath(code);
    }
  }

  // Origine publique de l'application (derrière le proxy Scalingo, l'URL de
  // la requête porte l'hôte interne).
  const response = NextResponse.redirect(`${appBaseUrl()}${target}`, 307);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
