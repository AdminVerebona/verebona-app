/**
 * Offre effective de l'assistant, dérivée des DROITS — CDC §6.5, §0.13, §15.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ESSAI 7 JOURS N'AVAIT PAS ACCÈS À L'IA
 *
 * Les routes calculaient `entitlements.premiumFeatures ? session.planType :
 * 'STANDARD'`. Pendant l'essai, `premiumFeatures` vaut `true` mais
 * `users.plan_type` (donc le JWT) reste `STANDARD` : `isPlanAiEligible`
 * renvoyait `false` et l'essai n'avait ni classification, ni génération, ni
 * revalidation. Le §6.5 exige l'inverse : « pendant l'essai, l'utilisateur
 * bénéficie du comportement Premium ; le modèle et les limites techniques
 * sont identiques à Premium ».
 *
 * La source de vérité est `getEntitlements(accountId)` (abonnement du
 * COMPTE), pas le JWT (offre de l'UTILISATEUR, figée à la connexion). Le JWT
 * ne sert plus qu'à distinguer une variante Premium que les droits ne
 * connaissent pas (PREMIUM_PRO).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Entitlements } from '@/services/entitlements.service';
import type { PlanCode } from '../registries/capability-registry';

export function assistantPlanFromEntitlements(
  entitlements: Pick<Entitlements, 'plan' | 'premiumFeatures'>,
  sessionPlanType?: string | null,
): PlanCode {
  // Pas de fonctions Premium (Standard, essai expiré, abonnement suspendu) :
  // comportement Standard, sans IA sur les données (§6.1).
  if (!entitlements.premiumFeatures) return 'STANDARD';
  switch (entitlements.plan) {
    // §6.5 : l'essai a le comportement Premium, modèle et limites compris.
    case 'trial': return 'PREMIUM';
    case 'premium_duo': return 'PREMIUM_DUO';
    case 'premium': return sessionPlanType === 'PREMIUM_PRO' ? 'PREMIUM_PRO' : 'PREMIUM';
    // Droits Premium sans offre reconnue : on suit les droits, pas le JWT.
    default: return 'PREMIUM';
  }
}

/**
 * Accès de l'assistant quand le compte ne peut plus écrire — CDC §6.5.
 *
 * À l'expiration de l'essai, « les nouveaux appels intelligents sont
 * désactivés » et « l'assistant explique la limite et propose d'ouvrir la
 * page des offres » — mais la recherche classique et l'aide RESTENT
 * disponibles. La route refusait tout l'assistant (403) : elle ne refuse plus
 * que si le compte n'est même plus consultable.
 *
 *   · peut écrire                      → `null` (aucune limite) ;
 *   · lecture seule (essai échu…)      → limite : assistant sans IA ;
 *   · ni lecture ni écriture           → `NO_ACCESS` (refus, comme avant).
 */
export function assistantPlanLimit(
  entitlements: Pick<Entitlements, 'canWrite' | 'status'> & { canRead?: boolean },
): 'TRIAL_EXPIRED' | 'SUBSCRIPTION_REQUIRED' | 'NO_ACCESS' | null {
  if (entitlements.canWrite) return null;
  if (entitlements.canRead === false) return 'NO_ACCESS';
  return entitlements.status === 'readonly' ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_REQUIRED';
}
