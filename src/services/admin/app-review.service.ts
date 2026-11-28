/**
 * Fiche compte (BO) — dispense de l'obligation globale de double
 * authentification par identité, et compte de revue des stores (#876, #879).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * OPÉRATIONS (administrateur : rôle ADMIN — SUPER_ADMIN historique accepté
 * comme partout au BO —, rôle ET statut relus en base ; contrôles dans la
 * route : session de niveau 2, réauthentification FORTE fraîche consommée,
 * phrase de confirmation, motif obligatoire) :
 *
 *   « Double authentification » (#879 — AUCUNE qualification nécessaire) :
 *   · grant       : dispense UNE identité (rôle USER, active, droit actif sur
 *                   le compte, aucun autre compte accessible). Jamais héritée
 *                   par un invité Duo actuel ou futur. Aucun effet sur l'offre,
 *                   la facturation, le rôle ni la qualification.
 *   · revoke      : « Rétablir la politique générale » — immédiat, toutes les
 *                   sessions de l'identité révoquées.
 *
 *   « Compte de revue des stores » (facultatif, indépendant de la dispense) :
 *   · qualify     : libellé « Compte de revue Apple / Google ». Refusée sur
 *                   un compte facturé (Stripe), le compte technique du corpus
 *                   IA, un compte dont un utilisateur est administrateur.
 *   · unqualify   : retour à « Compte client » — les dispenses ne sont PLUS
 *                   touchées (#879 : elles ne dépendent pas de la qualification).
 *   · demo_rights : droits Premium Duo DURABLES sans facturation — compte
 *                   qualifié et non facturé seulement ; jamais attribués
 *                   implicitement par une dispense.
 *
 * Chaque opération écrit l'historique `app_review_events` (motif, auteur,
 * date) dans la MÊME transaction ; la route écrit en plus le journal BO.
 * Aucun secret (mot de passe, code) n'est jamais lu, reçu ni journalisé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  APP_REVIEW_FACTS_JOIN, APP_REVIEW_FACTS_SQL, APP_REVIEW_INELIGIBILITY_LABELS, APP_REVIEW_KIND_LABELS,
  appReviewEligibility, appReviewFactsFromRow, isAppReviewKind, type AppReviewEligibility, type AppReviewKind,
} from '@/lib/auth/mfa/app-review';

export class AppReviewAdminError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 409) {
    super(message);
    this.name = 'AppReviewAdminError';
  }
}

export const APP_REVIEW_REASON_MIN_LENGTH = 10;
/** Phrase de confirmation explicite exigée par toute modification. */
export const APP_REVIEW_CONFIRMATION = 'CONFIRMER';
export const APP_REVIEW_ACTIONS = ['qualify', 'unqualify', 'grant', 'revoke', 'demo_rights'] as const;
export type AppReviewAction = (typeof APP_REVIEW_ACTIONS)[number];
/**
 * Rôles habilités à modifier (#879, GEN-002) : l'ADMIN opérationnel ; le
 * SUPER_ADMIN historique reste accepté comme par `requireAdmin`. Relus en
 * base avec le statut, jamais déduits du jeton.
 */
export const APP_REVIEW_MANAGER_ROLES: readonly string[] = ['ADMIN', 'SUPER_ADMIN'];
export function canManageAppReview(role: string | null | undefined, status: string | null | undefined): boolean {
  return !!role && APP_REVIEW_MANAGER_ROLES.includes(role) && status === 'ACTIVE';
}

export function normalizeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const r = raw.replace(/\s+/g, ' ').trim();
  return r.length >= APP_REVIEW_REASON_MIN_LENGTH && r.length <= 500 ? r : null;
}

/** Client ou transaction (même interface à l'exécution : requêtes balisées et `unsafe`). */
type Tx = typeof pgClient;

interface AccountRow {
  id: number; name: string; owner_user_id: number; app_review_kind: string | null; technical_kind: string | null;
  plan_type: string; subscription_status: string; stripe_customer_id: string | null; stripe_subscription_id: string | null;
  sub_stripe_customer_id: string | null; sub_stripe_subscription_id: string | null; sub_plan_code: string | null; sub_status: string | null;
}

async function loadAccount(db: Tx, accountId: number, lock = false): Promise<AccountRow> {
  const rows = await db.unsafe<AccountRow[]>(`
    SELECT a.id, a.name, a.owner_user_id, a.app_review_kind, a.technical_kind, a.plan_type, a.subscription_status,
           a.stripe_customer_id, a.stripe_subscription_id,
           s.stripe_customer_id AS sub_stripe_customer_id, s.stripe_subscription_id AS sub_stripe_subscription_id,
           s.plan_code AS sub_plan_code, s.status AS sub_status
      FROM accounts a LEFT JOIN account_subscriptions s ON s.account_id = a.id
     WHERE a.id = $1 ${lock ? 'FOR UPDATE OF a' : ''}`, [accountId] as never[]);
  if (!rows[0]) throw new AppReviewAdminError('ACCOUNT_NOT_FOUND', 'Compte introuvable.', 404);
  return rows[0];
}

const isBilled = (a: AccountRow) => !!(a.stripe_customer_id || a.stripe_subscription_id || a.sub_stripe_customer_id || a.sub_stripe_subscription_id);

interface AccountUserRow { id: number; email: string; first_name: string | null; role: string; status: string; mfa_enrolled: boolean; access: string }

/** Identités ayant un droit actif sur le compte (titulaire + adhésions actives). */
async function accountUsers(db: Tx, accountId: number): Promise<AccountUserRow[]> {
  return db.unsafe<AccountUserRow[]>(`
    SELECT u.id, u.email, u.first_name, u.role, u.status, (m.enabled_at IS NOT NULL) AS mfa_enrolled,
           CASE WHEN a.owner_user_id = u.id THEN 'owner' ELSE COALESCE(am.role, 'member') END AS access
      FROM accounts a
      JOIN users u ON u.id = a.owner_user_id
         OR u.id IN (SELECT user_id FROM account_memberships WHERE account_id = a.id AND status IN ('active', 'ACTIVE') AND user_id IS NOT NULL)
      LEFT JOIN account_memberships am ON am.account_id = a.id AND am.user_id = u.id AND am.status IN ('active', 'ACTIVE')
      LEFT JOIN user_mfa_state m ON m.user_id = u.id
     WHERE a.id = $1
     ORDER BY (a.owner_user_id = u.id) DESC, u.id`, [accountId] as never[]);
}

/** Faits d'exemption d'une identité — MÊME fragment SQL que la décision MFA. */
async function eligibilityOf(db: Tx, userId: number): Promise<AppReviewEligibility> {
  const rows = await db.unsafe<Parameters<typeof appReviewFactsFromRow>[0][]>(`
    SELECT u.role, u.status, ${APP_REVIEW_FACTS_SQL}
      FROM users u ${APP_REVIEW_FACTS_JOIN}
     WHERE u.id = $1`, [userId] as never[]);
  const r = rows[0];
  return r && r.review_account_id != null ? appReviewEligibility(appReviewFactsFromRow(r)) : { exempt: false, reason: 'NO_EXEMPTION' };
}

/** Comptes accessibles par l'identité AUTRES que `accountId` (même définition que la décision MFA). */
async function foreignAccountsOf(db: Tx, userId: number, accountId: number): Promise<number> {
  const [r] = await db.unsafe<{ n: number }[]>(`
    SELECT COUNT(*)::int AS n FROM accounts x
     WHERE (x.owner_user_id = $1
            OR x.id IN (SELECT account_id FROM account_memberships WHERE user_id = $1 AND status IN ('active', 'ACTIVE')))
       AND x.id <> $2`, [userId, accountId] as never[]);
  return r?.n ?? 0;
}

async function recordEvent(tx: Tx, e: { accountId: number; userId?: number | null; event: string; kind: string | null; reason: string; actorId: number }): Promise<void> {
  await tx`
    INSERT INTO app_review_events (account_id, user_id, event, review_kind, reason, actor_id, created_at)
    VALUES (${e.accountId}, ${e.userId ?? null}, ${e.event}, ${e.kind}, ${e.reason}, ${e.actorId}, now())`;
}

// ── Lecture (tout administrateur) ───────────────────────────────────────────

export interface AppReviewView {
  account: {
    id: number; name: string; kind: AppReviewKind | null; kindLabel: string; technical: boolean; billed: boolean;
    planType: string; subscriptionStatus: string; rights: { planCode: string | null; status: string | null };
  };
  /** Obligation globale de double authentification en vigueur pour les utilisateurs. */
  mfaEnforcement: { users: boolean };
  users: Array<{
    id: number; email: string; firstName: string | null; role: string; status: string; access: string; mfaEnrolled: boolean;
    exemption: { id: number; accountId: number; grantedAt: string; grantedBy: number | null; reason: string } | null;
    /**
     * POLICY : politique générale (aucune dispense) ; EFFECTIVE : dispense
     * appliquée ; INACTIVE_POLICY : dispense enregistrée et éligible, sans
     * effet tant que l'obligation globale n'est pas en vigueur ; NOT_EFFECTIVE :
     * dispense enregistrée mais non appliquée (`diagnostic`).
     */
    state: 'POLICY' | 'EFFECTIVE' | 'INACTIVE_POLICY' | 'NOT_EFFECTIVE';
    effective: boolean; diagnostic: string | null;
  }>;
  exemptions: Array<{ id: number; userId: number; email: string | null; grantedAt: string; grantedBy: number | null; grantedReason: string; revokedAt: string | null; revokedBy: number | null; revokedReason: string | null }>;
  events: Array<{ id: number; event: string; userId: number | null; kind: string | null; reason: string | null; actorId: number | null; actorEmail: string | null; createdAt: string }>;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export async function loadAppReviewView(accountId: number): Promise<AppReviewView> {
  const a = await loadAccount(pgClient, accountId);
  const kind = isAppReviewKind(a.app_review_kind) ? a.app_review_kind : null;
  const members = await accountUsers(pgClient, accountId);
  const active = await pgClient.unsafe<{ id: number; user_id: number; account_id: number; granted_at: Date; granted_by: number | null; granted_reason: string }[]>(`
    SELECT id, user_id, account_id, granted_at, granted_by, granted_reason FROM app_review_mfa_exemptions
     WHERE revoked_at IS NULL AND user_id = ANY($1::int[])`, [members.map((m) => m.id)] as never[]);
  const { readMfaEnforcementSettings } = await import('@/lib/auth/mfa/policy');
  const settings = await readMfaEnforcementSettings();
  const enforcedUsers = !!settings.users && settings.users.getTime() <= Date.now();
  const users: AppReviewView['users'] = [];
  for (const m of members) {
    const ex = active.find((x) => Number(x.user_id) === Number(m.id)) ?? null;
    const el = ex ? await eligibilityOf(pgClient, m.id) : null;
    const here = !!ex && Number(ex.account_id) === accountId;
    const eligible = here && !!el?.exempt && !m.mfa_enrolled;
    const state: AppReviewView['users'][number]['state'] = !ex ? 'POLICY'
      : eligible ? (enforcedUsers ? 'EFFECTIVE' : 'INACTIVE_POLICY')
      : 'NOT_EFFECTIVE';
    users.push({
      id: Number(m.id), email: m.email, firstName: m.first_name, role: m.role, status: m.status, access: m.access, mfaEnrolled: !!m.mfa_enrolled,
      exemption: ex ? { id: Number(ex.id), accountId: Number(ex.account_id), grantedAt: iso(ex.granted_at)!, grantedBy: ex.granted_by, reason: ex.granted_reason } : null,
      state,
      effective: state === 'EFFECTIVE',
      diagnostic: !ex ? null
        : !here ? `Dispense enregistrée sur un autre compte (#${Number(ex.account_id)}).`
        : el && !el.exempt ? APP_REVIEW_INELIGIBILITY_LABELS[el.reason]
        : m.mfa_enrolled ? 'Un facteur est déjà enrôlé : la dispense de l’obligation globale ne dispense pas d’un facteur configuré (double authentification toujours exigée).'
        : !enforcedUsers ? 'Dispense enregistrée : sans effet tant que l’obligation globale n’est pas en vigueur (la double authentification reste facultative pour tous).'
        : null,
    });
  }
  const exemptions = await pgClient.unsafe<{ id: number; user_id: number; email: string | null; granted_at: Date; granted_by: number | null; granted_reason: string; revoked_at: Date | null; revoked_by: number | null; revoked_reason: string | null }[]>(`
    SELECT e.id, e.user_id, u.email, e.granted_at, e.granted_by, e.granted_reason, e.revoked_at, e.revoked_by, e.revoked_reason
      FROM app_review_mfa_exemptions e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.account_id = $1 ORDER BY e.granted_at DESC LIMIT 50`, [accountId] as never[]);
  const events = await pgClient.unsafe<{ id: number; event: string; user_id: number | null; review_kind: string | null; reason: string | null; actor_id: number | null; actor_email: string | null; created_at: Date }[]>(`
    SELECT ev.id, ev.event, ev.user_id, ev.review_kind, ev.reason, ev.actor_id, au.email AS actor_email, ev.created_at
      FROM app_review_events ev LEFT JOIN users au ON au.id = ev.actor_id
     WHERE ev.account_id = $1 ORDER BY ev.created_at DESC, ev.id DESC LIMIT 50`, [accountId] as never[]);
  return {
    account: {
      id: Number(a.id), name: a.name, kind, kindLabel: APP_REVIEW_KIND_LABELS[kind ?? 'CLIENT'],
      technical: a.technical_kind != null, billed: isBilled(a), planType: a.plan_type, subscriptionStatus: a.subscription_status,
      rights: { planCode: a.sub_plan_code, status: a.sub_status },
    },
    mfaEnforcement: { users: enforcedUsers },
    users,
    exemptions: exemptions.map((e) => ({
      id: Number(e.id), userId: Number(e.user_id), email: e.email, grantedAt: iso(e.granted_at)!, grantedBy: e.granted_by, grantedReason: e.granted_reason,
      revokedAt: iso(e.revoked_at), revokedBy: e.revoked_by, revokedReason: e.revoked_reason,
    })),
    events: events.map((e) => ({
      id: Number(e.id), event: e.event, userId: e.user_id, kind: e.review_kind, reason: e.reason, actorId: e.actor_id, actorEmail: e.actor_email, createdAt: iso(e.created_at)!,
    })),
  };
}

// ── Écritures (administrateur, contrôles de la route faits en amont) ───────

export interface AppReviewChange {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Identités dont les sessions doivent être révoquées (après validation). */
  revokeSessionsOf: number[];
  warning?: string;
}

export async function qualifyAccount(accountId: number, kind: AppReviewKind, actorId: number, reason: string): Promise<AppReviewChange> {
  return pgClient.begin(async (t) => {
    const tx = t as unknown as Tx;
    const a = await loadAccount(tx, accountId, true);
    if (a.app_review_kind === kind) throw new AppReviewAdminError('ALREADY_QUALIFIED', 'Le compte a déjà cette qualification.');
    if (a.app_review_kind) throw new AppReviewAdminError('OTHER_QUALIFICATION', 'Le compte est déjà un compte de revue d’un autre store : retirez d’abord cette qualification.');
    if (a.technical_kind) throw new AppReviewAdminError('TECHNICAL_ACCOUNT', 'Compte technique (corpus IA) : il ne peut pas devenir un compte de revue.');
    if (isBilled(a)) throw new AppReviewAdminError('BILLED_ACCOUNT', 'Compte facturé (identifiant Stripe) : un compte client réel ne peut pas devenir un compte de revue. Créez un compte dédié.');
    const users = await accountUsers(tx, accountId);
    if (users.some((u) => u.role !== 'USER')) throw new AppReviewAdminError('ADMIN_MEMBER', 'Un utilisateur du compte est administrateur : qualification refusée.');
    await tx`UPDATE accounts SET app_review_kind = ${kind}, updated_at = now() WHERE id = ${accountId} AND app_review_kind IS NULL`;
    await recordEvent(tx, { accountId, event: 'ACCOUNT_QUALIFIED', kind, reason, actorId });
    return { before: { appReviewKind: null }, after: { appReviewKind: kind }, revokeSessionsOf: [] };
  });
}

export async function unqualifyAccount(accountId: number, actorId: number, reason: string): Promise<AppReviewChange> {
  return pgClient.begin(async (t) => {
    const tx = t as unknown as Tx;
    const a = await loadAccount(tx, accountId, true);
    if (!a.app_review_kind) throw new AppReviewAdminError('NOT_QUALIFIED', 'Le compte est déjà un compte client.');
    // #879 : les dispenses de double authentification sont INDÉPENDANTES de la
    // qualification — ni révoquées ni modifiées ici (« Rétablir la politique
    // générale » par identité). Les droits de démonstration ne sont pas retirés.
    await tx`UPDATE accounts SET app_review_kind = NULL, updated_at = now() WHERE id = ${accountId}`;
    await recordEvent(tx, { accountId, event: 'ACCOUNT_UNQUALIFIED', kind: a.app_review_kind, reason, actorId });
    return { before: { appReviewKind: a.app_review_kind }, after: { appReviewKind: null }, revokeSessionsOf: [] };
  });
}

export async function grantExemption(accountId: number, userId: number, actorId: number, reason: string): Promise<AppReviewChange> {
  return pgClient.begin(async (t) => {
    const tx = t as unknown as Tx;
    // #879 : aucune qualification préalable ; la qualification éventuelle n'est
    // qu'un libellé de l'historique. Aucun effet sur l'offre ni la facturation.
    const a = await loadAccount(tx, accountId, true);
    const kind = isAppReviewKind(a.app_review_kind) ? a.app_review_kind : null;
    const [u] = await tx<{ id: number; role: string; status: string; mfa_enrolled: boolean }[]>`
      SELECT u.id, u.role, u.status, (m.enabled_at IS NOT NULL) AS mfa_enrolled
        FROM users u LEFT JOIN user_mfa_state m ON m.user_id = u.id WHERE u.id = ${userId} FOR UPDATE OF u`;
    if (!u) throw new AppReviewAdminError('USER_NOT_FOUND', 'Utilisateur introuvable.', 404);
    if (u.role !== 'USER') throw new AppReviewAdminError('ROLE_NOT_ELIGIBLE', 'Seule une identité utilisateur (USER) peut être dispensée : jamais un administrateur ni un rôle inconnu.');
    if (u.status !== 'ACTIVE') throw new AppReviewAdminError('STATUS_NOT_ACTIVE', 'Identité non active (suspendue, clôturée ou adresse non vérifiée).');
    const members = await accountUsers(tx, accountId);
    if (!members.some((m) => Number(m.id) === userId)) throw new AppReviewAdminError('NO_ACCESS', 'Cette identité n’a pas de droit actif sur ce compte.');
    if ((await foreignAccountsOf(tx, userId, accountId)) > 0) {
      throw new AppReviewAdminError('OTHER_ACCOUNT_ACCESS', 'Cette identité accède aussi à un autre compte : dispense impossible (elle reste confinée à un seul compte).');
    }
    const [existing] = await tx<{ account_id: number }[]>`SELECT account_id FROM app_review_mfa_exemptions WHERE user_id = ${userId} AND revoked_at IS NULL`;
    if (existing) throw new AppReviewAdminError('ALREADY_GRANTED', 'Cette identité est déjà dispensée.');
    await tx`
      INSERT INTO app_review_mfa_exemptions (user_id, account_id, granted_by, granted_reason, granted_at)
      VALUES (${userId}, ${accountId}, ${actorId}, ${reason}, now())`;
    await recordEvent(tx, { accountId, userId, event: 'EXEMPTION_GRANTED', kind, reason, actorId });
    return {
      before: { exemption: null }, after: { exemption: { userId, accountId, kind } }, revokeSessionsOf: [],
      ...(u.mfa_enrolled ? { warning: 'Un facteur est déjà enrôlé pour cette identité : la dispense de l’obligation globale ne dispense pas d’un facteur configuré (double authentification toujours exigée, aucun facteur supprimé).' } : {}),
    };
  });
}

export async function revokeExemption(accountId: number, userId: number, actorId: number, reason: string): Promise<AppReviewChange> {
  return pgClient.begin(async (t) => {
    const tx = t as unknown as Tx;
    const a = await loadAccount(tx, accountId, true);
    const rows = await tx<{ id: number }[]>`
      UPDATE app_review_mfa_exemptions SET revoked_at = now(), revoked_by = ${actorId}, revoked_reason = ${reason}
       WHERE user_id = ${userId} AND account_id = ${accountId} AND revoked_at IS NULL RETURNING id`;
    if (!rows.length) throw new AppReviewAdminError('NO_ACTIVE_EXEMPTION', 'Aucune dispense active pour cette identité sur ce compte.', 404);
    await recordEvent(tx, { accountId, userId, event: 'EXEMPTION_REVOKED', kind: a.app_review_kind, reason, actorId });
    return { before: { exemption: { userId, accountId } }, after: { exemption: null }, revokeSessionsOf: [userId] };
  });
}

/**
 * Droits Premium Duo DURABLES sans facturation (compte de revue non facturé) :
 * même propagation que tout changement d'offre (`applyPlanChange` : compte,
 * titulaire, Duo, historique — sans e-mail), puis droits effectifs
 * (`account_subscriptions`) : offre `premium_duo`, statut `active`, aucun
 * identifiant Stripe — aucun essai ne peut expirer, rien n'est facturé.
 */
export async function grantDemoRights(accountId: number, actorId: number, reason: string): Promise<AppReviewChange> {
  const a = await loadAccount(pgClient, accountId);
  if (!isAppReviewKind(a.app_review_kind)) throw new AppReviewAdminError('NOT_QUALIFIED', 'Réservé aux comptes qualifiés « compte de revue ».');
  if (isBilled(a)) throw new AppReviewAdminError('BILLED_ACCOUNT', 'Compte facturé (identifiant Stripe) : droits de démonstration refusés.');
  const { applyPlanChange } = await import('@/lib/plan-enforcement');
  await applyPlanChange({
    accountId, ownerUserId: Number(a.owner_user_id), oldPlanType: a.plan_type, newPlanType: 'PREMIUM_DUO',
    newSubStatus: 'ACTIVE', newPremiumUntil: null, newMaxMembers: 2, source: 'admin:app_review', sendEmails: false,
    recordHistory: a.plan_type !== 'PREMIUM_DUO',
  });
  await pgClient.begin(async (t) => {
    const tx = t as unknown as Tx;
    await tx`
      INSERT INTO account_subscriptions (account_id, plan_code, status, billing_period, created_at, updated_at)
      VALUES (${accountId}, 'premium_duo', 'active', NULL, now(), now())
      ON CONFLICT (account_id) DO UPDATE SET plan_code = 'premium_duo', status = 'active', cancel_at_period_end = false,
        scheduled_plan_code = NULL, scheduled_billing_period = NULL, scheduled_change_at = NULL, updated_at = now()`;
    await recordEvent(tx, { accountId, event: 'DEMO_RIGHTS_GRANTED', kind: a.app_review_kind, reason, actorId });
  });
  return {
    before: { planType: a.plan_type, rights: { planCode: a.sub_plan_code, status: a.sub_status } },
    after: { planType: 'PREMIUM_DUO', rights: { planCode: 'premium_duo', status: 'active' } },
    revokeSessionsOf: [],
  };
}
