/**
 * POST /api/public/marketing/unsubscribe — lot 100G : désinscription des
 * communications commerciales (relances après l'essai), SANS connexion.
 *
 *   · page `/desinscription?t=…` (bouton de confirmation) : corps JSON `{ t }` ;
 *   · « en un clic » (RFC 8058, en-têtes List-Unsubscribe de l'e-mail) : jeton
 *     dans l'adresse (`?t=…`), corps `List-Unsubscribe=One-Click`.
 *
 * Jeton SIGNÉ (HMAC) : il ne permet que l'opposition de son titulaire.
 * IDEMPOTENT : un second appel répond la même chose et ne change rien.
 * Jamais d'action en GET (un lecteur de liens ne désinscrit personne).
 * Réponse identique quel que soit l'utilisateur (aucune donnée renvoyée).
 */
import { NextRequest, NextResponse } from 'next/server';
import { unsubscribeWithToken } from '@/services/trial-lifecycle/opposition.service';

const DONE = 'C’est fait : vous ne recevrez plus de communications commerciales de Verebona. Les messages liés à votre compte (sécurité, facturation, service) continuent.';

export async function POST(request: NextRequest) {
  let token: unknown = request.nextUrl.searchParams.get('t');
  const oneClick = !!token;
  if (!token) {
    const body = (await request.json().catch(() => null)) as { t?: unknown } | null;
    token = body?.t;
  }
  try {
    const r = await unsubscribeWithToken(token, oneClick ? 'one_click' : 'email_link');
    if (!r.ok) {
      return NextResponse.json(
        { code: r.code, message: r.code === 'INVALID_LINK' ? 'Ce lien de désinscription n’est pas valide. Utilisez le lien reçu dans l’e-mail.' : 'Désinscription momentanément indisponible. Réessayez plus tard.' },
        { status: r.code === 'INVALID_LINK' ? 400 : 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json({ ok: true, message: DONE }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[public/marketing/unsubscribe] POST :', (error as Error).message);
    return NextResponse.json({ code: 'ERROR', message: 'Désinscription momentanément indisponible. Réessayez plus tard.' }, { status: 503 });
  }
}
