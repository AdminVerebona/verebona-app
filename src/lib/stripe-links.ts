/**
 * Liens « Ouvrir dans Stripe » — CDC Back-Office V1 SUB-011, SUB-012, UX-008.
 *
 * Le BO n'affiche plus les identifiants Stripe (SUB-012) : il propose un lien
 * qui ouvre l'objet exact dans le tableau de bord Stripe, dans le bon mode.
 *
 * Le mode (test / live) est celui de la clé serveur `STRIPE_SECRET_KEY` : un
 * objet créé en mode test est introuvable depuis le tableau de bord live, et
 * réciproquement. Le lien est donc construit CÔTÉ SERVEUR — la clé n'est pas
 * connue du navigateur — et transmis tout fait à l'interface.
 */
import { getStripeKeyMode, type StripeMode } from '@/lib/stripe';

/** Objets Stripe pour lesquels le BO propose un lien. */
export type StripeObjectKind =
  | 'customers'
  | 'subscriptions'
  | 'invoices'
  | 'payments'
  | 'promotion_codes';

const DASHBOARD_BASE = 'https://dashboard.stripe.com';

/**
 * Identifiant Stripe plausible (`cus_…`, `sub_…`, `in_…`, `pi_…`, `promo_…`).
 * Tout autre contenu est refusé : l'identifiant vient de la base et finit dans
 * un `href`, il ne doit pas pouvoir y injecter un chemin ou un schéma.
 */
const STRIPE_ID = /^[A-Za-z0-9_]{3,255}$/;

/** Mode de la clé serveur courante, `null` si absente ou illisible. */
export function currentStripeMode(env: NodeJS.ProcessEnv = process.env): StripeMode | null {
  return getStripeKeyMode(env.STRIPE_SECRET_KEY);
}

/**
 * URL du tableau de bord Stripe pour un objet donné, ou `null` si
 * l'identifiant est absent ou invalide.
 *
 * @param mode mode Stripe ; par défaut, celui de `STRIPE_SECRET_KEY`. Une clé
 *   absente ou illisible est traitée comme live : un lien live vers un objet
 *   test affiche « introuvable » dans Stripe, sans autre effet.
 */
export function stripeDashboardUrl(
  kind: StripeObjectKind,
  id: string | null | undefined,
  mode: StripeMode | null = currentStripeMode(),
): string | null {
  if (!id || !STRIPE_ID.test(id)) return null;
  const prefix = mode === 'test' ? '/test' : '';
  return `${DASHBOARD_BASE}${prefix}/${kind}/${encodeURIComponent(id)}`;
}
