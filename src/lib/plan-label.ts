/**
 * Libelle de l'offre affiche dans les menus.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI L'ESSAI PASSE AVANT LE PLAN
 *
 * Le menu annoncait « Standard » a un compte en essai gratuit.
 *
 * Ce n'etait pas une erreur d'affichage : `subscription.plan` vient de
 * `users.plan_type`, que l'attribution d'essai NE TOUCHE PAS. L'essai vit
 * entierement dans `account_subscriptions` (`plan_code = 'premium'`,
 * `status = 'trialing'`). Un compte en essai porte donc bien `STANDARD`
 * dans la colonne lue par le menu — le libelle etait exact et le message
 * faux.
 *
 * Deux consequences pour l'utilisateur : il croit n'avoir jamais recu son
 * essai, et il ne voit nulle part combien de jours il lui reste.
 *
 * L'etat d'essai prime donc sur le plan : tant qu'il court, c'est lui qui
 * decrit la situation.
 *
 * ── CE QUE CETTE FONCTION NE FAIT PAS ────────────────────────────────────
 *
 * Elle ne change AUCUN droit. `subscription.plan` reste `STANDARD` pendant
 * l'essai, et c'est voulu : `getFeatureFlags('PREMIUM')` accorderait 10
 * biens la ou l'essai en autorise 2 (CDC §3.2), et l'interface proposerait
 * des creations que le serveur refuserait. Seul le libelle change.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type TrialLabelStatus = 'none' | 'active' | 'expired' | 'converted';

export interface PlanLabelInput {
  plan?: string | null;
  duoRole?: 'BILLING_OWNER' | 'MEMBER' | null;
  /** Etat d'essai, servi par `/api/users/me`. */
  trialStatus?: TrialLabelStatus | null;
  /** Jours restants, quand l'essai court. */
  trialDaysLeft?: number | null;
}

const PLAN_LABELS: Record<string, string> = {
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  PREMIUM_DUO: 'Premium Duo',
  PREMIUM_PRO: 'Premium Pro',
};

export function getPlanLabel(input: PlanLabelInput): string {
  const { plan, duoRole, trialStatus, trialDaysLeft } = input;

  if (trialStatus === 'active') {
    return typeof trialDaysLeft === 'number' && trialDaysLeft >= 0
      ? `Essai gratuit · J-${trialDaysLeft}`
      : 'Essai gratuit';
  }

  // Essai fini sans souscription : le dire vaut mieux qu'annoncer une offre
  // que l'utilisateur n'a jamais choisie.
  if (trialStatus === 'expired') return 'Essai terminé';

  const code = (plan ?? '').toUpperCase();
  if (code === 'PREMIUM_DUO') {
    return duoRole === 'MEMBER' ? 'Premium Duo (membre)' : 'Premium Duo';
  }
  return PLAN_LABELS[code] ?? (code ? code.toLowerCase() : 'Compte');
}
