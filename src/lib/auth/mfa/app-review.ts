/**
 * Exemption CIBLÉE de l'obligation globale de double authentification, par
 * identité, posée par un administrateur depuis la fiche compte du BO
 * (cartes #876 et #879, complément de #672 / lot 110B). Usage prévu : comptes
 * de revue des stores (Apple / Google) — sans qualification préalable (#879).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE (module PUR : aucune lecture ici, les faits viennent de `policy.ts`,
 * lus en base dans LA MÊME requête que la décision MFA, sans cache)
 *
 * L'exemption neutralise EXCLUSIVEMENT l'obligation GLOBALE (`enforced`) :
 *   · un facteur déjà enrôlé reste exigé (`enrolled` → MFA requise, toujours) ;
 *   · aucune preuve forte n'est fabriquée : la session reste de niveau 1
 *     (AAL1), le step-up et les contrôles de session sont inchangés.
 *
 * Elle n'existe que si TOUTES les conditions sont vraies, sinon aucune
 * exemption (fail closed — état inconnu, ligne absente, valeur inattendue) :
 *   1. une autorisation ACTIVE (non révoquée) pour CETTE identité et CE
 *      compte, posée par un administrateur au BO (`app_review_mfa_exemptions`) ;
 *   2. l'identité a le rôle `USER` exactement — jamais ADMIN / SUPER_ADMIN,
 *      ni un rôle inconnu ; un changement de rôle la fait perdre aussitôt ;
 *   3. l'identité est au statut `ACTIVE` ;
 *   4. l'identité a un droit ACTIF sur ce compte (adhésion active ou
 *      titulaire — même définition que `account-access.ts`) ;
 *   5. AUCUN AUTRE compte n'est accessible par l'identité (titulaire ou
 *      adhésion active, quel qu'il soit) : l'exemption reste confinée au seul
 *      compte de l'autorisation — invitation acceptée ailleurs, ajout à un
 *      autre compte → exemption suspendue dès la requête suivante.
 *
 * #879 : la qualification « compte de revue Apple / Google »
 * (`accounts.app_review_kind`) n'est PLUS une condition ; elle reste un
 * libellé facultatif du BO (et la condition des droits de démonstration).
 * Les autorisations antérieures n'en sont pas élargies : sous #876, aucune ne
 * pouvait être active sur un compte non qualifié, et le confinement à un seul
 * compte est au moins aussi strict que l'ancienne règle « même store ».
 *
 * Identification par identifiants internes et état serveur SEULEMENT : jamais
 * par e-mail, domaine, user-agent, appareil, IP, en-tête ou secret partagé.
 * Un invité Duo n'hérite de rien : chaque identité a sa propre autorisation.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const APP_REVIEW_KINDS = ['APPLE', 'GOOGLE'] as const;
export type AppReviewKind = (typeof APP_REVIEW_KINDS)[number];

export function isAppReviewKind(v: unknown): v is AppReviewKind {
  return typeof v === 'string' && (APP_REVIEW_KINDS as readonly string[]).includes(v);
}

/** Libellés BO de la qualification technique (indépendante de l'offre). */
export const APP_REVIEW_KIND_LABELS: Readonly<Record<AppReviewKind | 'CLIENT', string>> = {
  CLIENT: 'Compte client',
  APPLE: 'Compte de revue Apple',
  GOOGLE: 'Compte de revue Google',
};

/** Faits lus en base pour une identité (aucun n'est fourni par le client). */
export interface AppReviewFacts {
  role: string | null;
  status: string | null;
  /** Autorisation active de cette identité : compte visé, `null` sinon. */
  exemptionAccountId: number | null;
  /** Qualification facultative du compte (libellé du journal, jamais une condition). */
  exemptionAccountKind: string | null;
  /** Droit actif de l'identité sur le compte de l'autorisation. */
  hasAccessToExemptionAccount: boolean;
  /** Comptes accessibles par l'identité AUTRES que celui de l'autorisation (-1 = inconnu). */
  foreignAccessibleAccounts: number;
}

export type AppReviewIneligibility =
  | 'NO_EXEMPTION'
  | 'ROLE_NOT_ELIGIBLE'
  | 'STATUS_NOT_ACTIVE'
  | 'NO_ACCESS_TO_REVIEW_ACCOUNT'
  | 'OTHER_ACCOUNT_ACCESS';

export type AppReviewEligibility =
  | { exempt: true; kind: AppReviewKind | null; accountId: number }
  | { exempt: false; reason: AppReviewIneligibility };

/** Décision pure (testée) : l'identité bénéficie-t-elle de l'exemption ? */
export function appReviewEligibility(f: AppReviewFacts | null | undefined): AppReviewEligibility {
  if (!f || !Number.isInteger(f.exemptionAccountId) || (f.exemptionAccountId as number) <= 0) return { exempt: false, reason: 'NO_EXEMPTION' };
  if (f.role !== 'USER') return { exempt: false, reason: 'ROLE_NOT_ELIGIBLE' };
  if (f.status !== 'ACTIVE') return { exempt: false, reason: 'STATUS_NOT_ACTIVE' };
  if (f.hasAccessToExemptionAccount !== true) return { exempt: false, reason: 'NO_ACCESS_TO_REVIEW_ACCOUNT' };
  if (!(Number.isInteger(f.foreignAccessibleAccounts) && f.foreignAccessibleAccounts === 0)) return { exempt: false, reason: 'OTHER_ACCOUNT_ACCESS' };
  return { exempt: true, kind: isAppReviewKind(f.exemptionAccountKind) ? f.exemptionAccountKind : null, accountId: f.exemptionAccountId as number };
}

/** Libellés BO des motifs d'inéligibilité (diagnostic, aucun secret). */
export const APP_REVIEW_INELIGIBILITY_LABELS: Readonly<Record<AppReviewIneligibility, string>> = {
  NO_EXEMPTION: 'Aucune autorisation active.',
  ROLE_NOT_ELIGIBLE: 'Rôle non éligible (administrateur ou rôle inconnu) : exemption impossible.',
  STATUS_NOT_ACTIVE: 'Identité non active (suspendue, clôturée ou non vérifiée).',
  NO_ACCESS_TO_REVIEW_ACCOUNT: 'L’identité n’a plus de droit actif sur ce compte.',
  OTHER_ACCOUNT_ACCESS: 'L’identité accède aussi à un autre compte : dispense suspendue (elle reste confinée à un seul compte).',
};

/**
 * Fragment SQL (PostgreSQL) des faits d'exemption pour l'utilisateur `u`,
 * à placer dans le SELECT de la décision MFA : une seule lecture indexée
 * (`app_review_mfa_exemptions_active_uniq`) ; les sous-requêtes d'accès ne
 * sont évaluées que si une autorisation active existe (CASE).
 */
export const APP_REVIEW_FACTS_SQL = `
  e.account_id AS review_account_id,
  ra.app_review_kind AS review_account_kind,
  CASE WHEN e.account_id IS NULL THEN false ELSE EXISTS (
    SELECT 1 FROM account_memberships am
     WHERE am.user_id = u.id AND am.account_id = e.account_id AND am.status IN ('active', 'ACTIVE')
    UNION ALL
    SELECT 1 FROM accounts ao WHERE ao.id = e.account_id AND ao.owner_user_id = u.id
  ) END AS review_has_access,
  CASE WHEN e.account_id IS NULL THEN NULL ELSE (
    SELECT COUNT(*)::int FROM accounts x
     WHERE (x.owner_user_id = u.id
            OR x.id IN (SELECT am2.account_id FROM account_memberships am2 WHERE am2.user_id = u.id AND am2.status IN ('active', 'ACTIVE')))
       AND x.id <> e.account_id
  ) END AS review_foreign_accounts`;

export const APP_REVIEW_FACTS_JOIN = `
  LEFT JOIN app_review_mfa_exemptions e ON e.user_id = u.id AND e.revoked_at IS NULL
  LEFT JOIN accounts ra ON ra.id = e.account_id`;

/** Ligne SQL → faits (types normalisés, aucune valeur devinée). */
export function appReviewFactsFromRow(r: {
  role: string | null; status: string | null;
  review_account_id: number | string | null; review_account_kind: string | null;
  review_has_access: boolean | null; review_foreign_accounts: number | string | null;
}): AppReviewFacts {
  return {
    role: r.role,
    status: r.status,
    exemptionAccountId: r.review_account_id == null ? null : Number(r.review_account_id),
    exemptionAccountKind: r.review_account_kind ?? null,
    hasAccessToExemptionAccount: r.review_has_access === true,
    foreignAccessibleAccounts: r.review_foreign_accounts == null ? -1 : Number(r.review_foreign_accounts),
  };
}
