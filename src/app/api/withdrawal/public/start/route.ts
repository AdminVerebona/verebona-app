/**
 * POST /api/withdrawal/public/start — CDC 6 §6.3 et §12.2 (public).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RÉPONSE EST TOUJOURS LA MÊME
 *
 * « La réponse ne doit pas révéler l'existence d'un compte à un tiers » (§12.2).
 * Cette route est ouverte à n'importe qui : distinguer « adresse connue » de
 * « adresse inconnue » en ferait un outil d'énumération de la clientèle.
 *
 * Le corps renvoyé et le code HTTP sont donc invariables. Seul le contenu de
 * la boîte mail diffère — et lui seul est légitime à le faire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { startPublicVerification } from '@/services/withdrawal/public-verification.service';
import { sendVerificationLink } from '@/services/withdrawal/receipt.service';

const GENERIC_RESPONSE = {
  status: 'sent',
  message:
    'Si un compte Verebona est associé à cette adresse, vous allez recevoir un ' +
    'lien vous permettant de poursuivre votre demande. Ce lien est valable 30 minutes.',
};

export async function POST(req: NextRequest) {
  await ensureMigrations();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // Seule exception à la réponse générique : une adresse syntaxiquement
    // invalide ne renseigne sur aucun compte.
    return NextResponse.json(
      { error: 'Adresse électronique invalide.', code: 'INVALID_EMAIL' },
      { status: 400 },
    );
  }

  try {
    const result = await startPublicVerification({
      email,
      firstName: typeof body.firstName === 'string' ? body.firstName.trim() : undefined,
      lastName: typeof body.lastName === 'string' ? body.lastName.trim() : undefined,
      contractReference:
        typeof body.contractReference === 'string' ? body.contractReference.trim() : undefined,
    });

    if (result.token && result.email && result.userId) {
      await sendVerificationLink({
        to: result.email,
        userId: result.userId,
        firstName: result.firstName,
        token: result.token,
      });
    }
  } catch (e) {
    // Même une panne ne modifie pas la réponse : elle révélerait, par sa
    // seule différence, que le traitement est allé plus loin pour certaines
    // adresses que pour d'autres.
    console.error('[withdrawal] démarrage public impossible :', (e as Error).message);
  }

  return NextResponse.json(GENERIC_RESPONSE, { status: 202 });
}
