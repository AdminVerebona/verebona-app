/**
 * GET /api/auth/oauth/providers — lot 93 : fournisseurs actifs (boutons
 * « Continuer avec Google / Apple »). Public, sans donnée de compte ; les deux
 * à `false` tant que les variables Scalingo ne sont pas posées.
 *
 * Lot 111W : `passkey` = service WebAuthn du SERVEUR utilisable (RP ID et
 * origines valides, `webAuthnStatus()`). Statut GLOBAL de cet environnement,
 * identique pour tous : aucune information sur un compte, un facteur enrôlé
 * ou l'appareil (anti-énumération). L'écran de connexion n'affiche le bouton
 * « Se connecter avec une clé d'accès » que si ce statut ET la prise en
 * charge WebAuthn de la vue sont réunis. Ne prouve PAS qu'une clé existe sur
 * l'appareil.
 */
import { NextResponse } from 'next/server';
import { enabledProviders } from '@/lib/auth/oauth/config';
import { webAuthnStatus } from '@/lib/auth/mfa/passkeys';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ...enabledProviders(), passkey: webAuthnStatus().available }, { headers: { 'Cache-Control': 'no-store' } });
}
