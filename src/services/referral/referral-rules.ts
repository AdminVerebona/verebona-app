/**
 * Parrainage — RÈGLE CENTRALE UNIQUE (lot 102D, décision PO du 30/10/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE SOURCE POUR L'API, LES ÉCRANS, LES E-MAILS, LE BO ET LES TESTS
 *
 * Avant ce lot, la règle était écrite en sept endroits qui ne disaient pas la
 * même chose : l'API réservait le parrainage à Premium / Premium Duo, l'écran
 * annonçait « offres annuelles », le Centre d'aide « toutes les offres », le
 * délai de rétractation était un compte de 14 × 24 h (sans prorogation au
 * jour ouvrable suivant), le code pouvait être appliqué au paiement par un
 * compte inscrit depuis des mois, et la notification « récompense créditée »
 * partait dès le premier paiement du filleul.
 *
 * Règle PO (fait foi) :
 *   1. ATTRIBUTION valable 90 jours : le lien ou le code est utilisé, puis le
 *      filleul crée son compte dans les 90 jours. L'attribution est
 *      enregistrée à l'inscription, jamais plus tard (pas au paiement).
 *   2. Abonnement ANNUEL du filleul.
 *   3. Premier paiement (annuel) ENCAISSÉ.
 *   4. Délai de rétractation du filleul EXPIRÉ (calendrier légal, avec
 *      prorogation, `withdrawal-window.ts`).
 *   5. Récompense : 1 MOIS OFFERT AU PARRAIN (le filleul ne reçoit rien).
 *   6. AUTO-PARRAINAGE INTERDIT : même compte, même personne (adresse e-mail
 *      normalisée, membre du compte parrain), même moyen de paiement
 *      (empreinte de carte Stripe), même adresse de facturation.
 *
 * Ce module est PUR (aucune base, aucune horloge implicite, aucun import
 * serveur) : il est importé par les routes, les traitements planifiés, les
 * composants React et les tests. Les libellés sont FACTUELS — aucun texte
 * juridique : les conditions complètes sont sur la page publique
 * « Parrainage » (`referralTermsUrl`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { legalPublicUrl } from '@/lib/legal/public-legal';
import { WITHDRAWAL_PERIOD_DAYS, withdrawalWindowClosesAt, withdrawalWindowStart } from '@/services/withdrawal/withdrawal-window';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Paramètres du programme. Changer une valeur ici la change partout (API,
 * écrans, e-mail, BO, traitement planifié, tests).
 */
export const REFERRAL_RULES = Object.freeze({
  /** Délai maximal entre l'usage du lien / code et l'inscription du filleul. */
  attributionWindowDays: 90,
  /** Périodicité exigée de l'abonnement du filleul. */
  requiredBillingPeriod: 'yearly' as const,
  /** Récompense, en mois, accordée au parrain seul. */
  rewardMonths: 1,
  /**
   * Marge après la clôture légale du délai de rétractation du filleul avant
   * d'attribuer : laisse le temps à une rétractation envoyée le dernier jour
   * (formulaire, e-mail) d'être enregistrée. Choix par défaut : 1 jour.
   */
  rewardGraceDaysAfterWithdrawalClose: 1,
  /**
   * Parrain : titulaire d'un abonnement PAYANT en cours (premier paiement
   * constaté), quelle que soit l'offre et la périodicité.
   * La récompense est un report d'échéance de cet abonnement.
   */
  referrerPlans: Object.freeze(['standard', 'premium', 'premium_duo'] as const),
});

/** Chemin par défaut de l'onglet « Parrainage » de la rubrique publique « Légal ». */
export const DEFAULT_REFERRAL_TERMS_PATH = '/legal/parrainage';

type Env = Record<string, string | undefined>;

/**
 * Lien public « Parrainage » (conditions complètes, site public = source
 * juridique unique). Réglable sans livraison :
 *   · `NEXT_PUBLIC_LEGAL_REFERRAL_URL` — URL complète (prioritaire) ;
 *   · sinon `NEXT_PUBLIC_PUBLIC_SITE_URL` + `NEXT_PUBLIC_LEGAL_REFERRAL_PATH`
 *     (défaut `/legal/parrainage`).
 * Les `process.env.NEXT_PUBLIC_*` sont lus nommément (remplacés au build pour
 * les composants client).
 */
export function referralTermsUrl(env?: Env): string {
  // Raccord 102B : sans argument, configuration unique des liens légaux
  // (`NEXT_PUBLIC_LEGAL_REFERRAL_URL`, repli sur l'adresse actuelle du site).
  if (!env) return legalPublicUrl('parrainage');
  const e: Env = env;
  const full = (e.NEXT_PUBLIC_LEGAL_REFERRAL_URL ?? '').trim();
  if (/^https:\/\/[^\s]+$/i.test(full)) return full;
  const base = (e.NEXT_PUBLIC_PUBLIC_SITE_URL || 'https://www.verebona.fr').trim().replace(/\/+$/, '');
  const rawPath = (e.NEXT_PUBLIC_LEGAL_REFERRAL_PATH ?? '').trim() || DEFAULT_REFERRAL_TERMS_PATH;
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `${base}${path}`;
}

// ── 1. Attribution ──────────────────────────────────────────────────────────

/** Date limite d'inscription pour un lien / code utilisé à `codeUsedAt`. */
export function attributionDeadline(codeUsedAt: Date): Date {
  return new Date(codeUsedAt.getTime() + REFERRAL_RULES.attributionWindowDays * DAY_MS);
}

/**
 * L'inscription à `signupAt` est-elle dans la fenêtre d'attribution d'un
 * lien / code utilisé à `codeUsedAt` ? Un usage « dans le futur » (horloge
 * client faussée) est ramené à l'inscription.
 */
export function isWithinAttributionWindow(codeUsedAt: Date | null | undefined, signupAt: Date): boolean {
  if (!codeUsedAt || Number.isNaN(codeUsedAt.getTime())) return true; // code saisi à l'inscription
  const used = codeUsedAt.getTime() > signupAt.getTime() ? signupAt : codeUsedAt;
  return signupAt.getTime() <= attributionDeadline(used).getTime();
}

// ── 6. Auto-parrainage : même personne ──────────────────────────────────────

/**
 * Adresse e-mail normalisée pour comparer deux personnes : casse, espaces,
 * sous-adresse « +… » retirée ; pour Gmail, points ignorés et googlemail.com
 * ramené à gmail.com. Jamais affichée ni journalisée.
 */
export function normalizeEmailIdentity(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.trim().toLowerCase().lastIndexOf('@');
  if (at <= 0) return null;
  const e = email.trim().toLowerCase();
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local ? `${local}@${domain}` : null;
}

/** Adresse postale réduite à une clé comparable (ligne 1, code postal, pays). */
export function addressKey(a: { line1?: string | null; postal_code?: string | null; country?: string | null } | null | undefined): string | null {
  if (!a) return null;
  const line1 = (a.line1 ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const postal = (a.postal_code ?? '').replace(/\s/g, '').toUpperCase();
  if (!line1 || !postal) return null;
  return `${line1}|${postal}|${(a.country ?? '').toUpperCase()}`;
}

export type SelfReferralReason =
  | 'SELF_REFERRAL_SAME_ACCOUNT'
  | 'SELF_REFERRAL_SAME_PERSON'
  | 'SELF_REFERRAL_SAME_PAYMENT_METHOD'
  | 'SELF_REFERRAL_SAME_ADDRESS';

/**
 * Contrôle d'auto-parrainage À L'INSCRIPTION (pur) : même compte, filleul
 * déjà membre du compte parrain, ou même adresse e-mail normalisée qu'un
 * membre du compte parrain.
 */
export function signupSelfReferralReason(input: {
  referrerAccountId: number;
  referredAccountId: number | null;
  referredUserId: number;
  referredEmail: string | null;
  referrerMembers: ReadonlyArray<{ userId: number; email: string | null }>;
}): SelfReferralReason | null {
  if (input.referredAccountId !== null && input.referredAccountId === input.referrerAccountId) return 'SELF_REFERRAL_SAME_ACCOUNT';
  if (input.referrerMembers.some((m) => m.userId === input.referredUserId)) return 'SELF_REFERRAL_SAME_PERSON';
  const mine = normalizeEmailIdentity(input.referredEmail);
  if (mine && input.referrerMembers.some((m) => normalizeEmailIdentity(m.email) === mine)) return 'SELF_REFERRAL_SAME_PERSON';
  return null;
}

/**
 * Contrôle d'auto-parrainage AU PAIEMENT (pur) : la carte qui a payé
 * l'abonnement du filleul, ou son adresse de facturation, est celle du
 * parrain.
 */
export function paymentSelfReferralReason(input: {
  referredCardFingerprints: ReadonlyArray<string | null>;
  referredAddressKeys: ReadonlyArray<string | null>;
  referrerCardFingerprints: ReadonlyArray<string | null>;
  referrerAddressKeys: ReadonlyArray<string | null>;
}): SelfReferralReason | null {
  const fp = new Set(input.referrerCardFingerprints.filter((x): x is string => Boolean(x)));
  if (input.referredCardFingerprints.some((x) => x && fp.has(x))) return 'SELF_REFERRAL_SAME_PAYMENT_METHOD';
  const ad = new Set(input.referrerAddressKeys.filter((x): x is string => Boolean(x)));
  if (input.referredAddressKeys.some((x) => x && ad.has(x))) return 'SELF_REFERRAL_SAME_ADDRESS';
  return null;
}

// ── 4. Délai de rétractation du filleul ─────────────────────────────────────

/**
 * Première date à laquelle la récompense peut être attribuée : clôture
 * légale du délai de rétractation du filleul (départ = premier paiement de
 * l'abonnement annuel, prorogation comprise) + marge. `null` : aucun
 * paiement constaté.
 */
export function rewardEarliestAt(input: { firstBilledAt?: Date | string | null; contractConcludedAt?: Date | string | null }): Date | null {
  const closes = withdrawalWindowClosesAt(withdrawalWindowStart(input));
  return closes ? new Date(closes.getTime() + REFERRAL_RULES.rewardGraceDaysAfterWithdrawalClose * DAY_MS) : null;
}

/** Borne basse pour présélectionner en SQL (la vérification exacte suit). */
export function rewardPrefilterCutoff(now: Date): Date {
  return new Date(now.getTime() - WITHDRAWAL_PERIOD_DAYS * DAY_MS);
}

// ── 2. Parrain ──────────────────────────────────────────────────────────────

export type ReferrerIneligibility = 'NOT_ACCOUNT_OWNER' | 'NO_PAID_SUBSCRIPTION';

/** Le compte peut-il parrainer (pur) ? */
export function referrerEligibility(input: {
  role: string | null;
  subscription: { planCode: string | null; status: string | null; firstBilledAt: Date | string | null; stripeSubscriptionId?: string | null } | null;
}): { eligible: true } | { eligible: false; reason: ReferrerIneligibility } {
  if (input.role !== 'owner') return { eligible: false, reason: 'NOT_ACCOUNT_OWNER' };
  const s = input.subscription;
  const paid = Boolean(
    s && s.firstBilledAt
      && (REFERRAL_RULES.referrerPlans as readonly string[]).includes((s.planCode ?? '').toLowerCase())
      && ['active', 'past_due'].includes((s.status ?? '').toLowerCase()),
  );
  return paid ? { eligible: true } : { eligible: false, reason: 'NO_PAID_SUBSCRIPTION' };
}

// ── Libellés factuels (écrans, e-mail, BO) ──────────────────────────────────

const mois = (n: number) => `${n} mois offert${n > 1 ? 's' : ''}`;

export const REFERRAL_TEXT = Object.freeze({
  /** Une ligne : la récompense. */
  reward: `${mois(REFERRAL_RULES.rewardMonths)} pour vous à chaque proche qui souscrit un abonnement annuel.`,
  /** Conditions, une par ligne (Mon compte, BO). */
  conditions: Object.freeze([
    `Votre proche crée son compte avec votre lien ou votre code, au plus tard ${REFERRAL_RULES.attributionWindowDays} jours après l’avoir utilisé.`,
    'Il souscrit un abonnement annuel et son premier paiement est encaissé.',
    'Son délai de rétractation est terminé.',
    `Vous recevez alors ${mois(REFERRAL_RULES.rewardMonths)} sur votre abonnement. Votre proche ne reçoit pas d’avantage.`,
    'Le parrainage de son propre compte, ou avec le même moyen de paiement ou la même adresse, n’est pas pris en compte.',
  ]),
  /** Non éligible (Web). */
  notEligible: 'Le parrainage est disponible pour le titulaire d’un abonnement payant en cours.',
  /** Filleul : écran d'inscription et page Offres. */
  referredNotice: `Votre parrain recevra ${mois(REFERRAL_RULES.rewardMonths)} si vous souscrivez un abonnement annuel, une fois votre premier paiement encaissé et votre délai de rétractation terminé.`,
  /** Lien vers les conditions publiques. */
  termsLinkLabel: 'Conditions du parrainage',
  /**
   * Lot 108H — bloc Mon compte › Parrainage, texte court (décision PO) : une
   * accroche, le bénéfice (au parrain seul : « Recevez ») avec la condition
   * « abonnement annuel », et le lien vers les conditions complètes de la
   * page publique. Les conditions détaillées (`conditions`) restent celles
   * du BO ; elles ne sont plus reproduites dans ce bloc.
   */
  accountIntro: 'Invitez vos proches à découvrir Verebona.',
  accountReward: `Recevez ${REFERRAL_RULES.rewardMonths} mois d’abonnement offert${REFERRAL_RULES.rewardMonths > 1 ? 's' : ''} pour chaque proche qui souscrit un abonnement annuel.`,
  accountTermsLinkLabel: 'Voir les conditions du parrainage',
});

/** Motifs d'inéligibilité ou d'annulation, en clair (BO). */
export const REFERRAL_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  NOT_YEARLY: 'abonnement du filleul non annuel',
  SUBSCRIPTION_NOT_ACTIVE: 'abonnement du filleul non actif',
  SUBSCRIPTION_CANCELED: 'abonnement du filleul résilié',
  WITHDRAWAL_EXERCISED: 'rétractation du filleul',
  WITHDRAWAL_PERIOD_RUNNING: 'délai de rétractation en cours',
  PAYMENT_REFUNDED: 'paiement remboursé',
  PAYMENT_DISPUTED: 'paiement contesté',
  PAYMENT_NOT_FOUND: 'paiement introuvable',
  STRIPE_UNAVAILABLE: 'Stripe injoignable',
  SELF_REFERRAL_SAME_ACCOUNT: 'auto-parrainage : même compte',
  SELF_REFERRAL_SAME_PERSON: 'auto-parrainage : même personne',
  SELF_REFERRAL_SAME_PAYMENT_METHOD: 'auto-parrainage : même moyen de paiement',
  SELF_REFERRAL_SAME_ADDRESS: 'auto-parrainage : même adresse',
  ATTRIBUTION_WINDOW_EXPIRED: `inscription plus de ${REFERRAL_RULES.attributionWindowDays} jours après l’usage du lien`,
  CODE_NOT_FOUND_OR_INACTIVE: 'code inconnu ou désactivé',
});
