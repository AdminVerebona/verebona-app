import { NextResponse } from 'next/server';

/**
 * POST /api/billing/upgrade-apply — RETIRÉE (CDC lookup_key V4, LK-46, EC-02).
 *
 * Cette route mettait à jour l'abonnement vers `STRIPE_PRODUCTS.PREMIUM_DUO.priceId`
 * (variable historique STRIPE_PRICE_PREMIUM_DUO, modèle annuel unique) avec sa
 * propre logique de prorata : un second moteur de changement de prix, fondé
 * sur un identifiant d'environnement. Aucun écran ne l'appelait plus.
 *
 * Il n'existe plus qu'UN parcours de montée en gamme : POST /api/billing/upgrade
 * (prix résolu par lookup_key, révision affichée vérifiée, portail Stripe
 * `subscription_update_confirm`, prorata encaissé par Stripe).
 */
export async function POST() {
  return NextResponse.json(
    {
      code: 'UPGRADE_FLOW_MOVED',
      error: 'UPGRADE_FLOW_MOVED',
      message: 'Cette opération passe désormais par la page Offres (montée en gamme immédiate).',
      replacement: '/api/billing/upgrade',
    },
    { status: 410 },
  );
}
