/**
 * Obligation de double authentification — réglages et décision (lot 110B).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ACTIVATION GLOBALE CONTRÔLÉE (réglages BO › Exploitation › Double
 * authentification ; table `mfa_enforcement_settings`, migration 1167)
 *
 *   · deux réglages DISTINCTS : `users` (tous les comptes) et `admins`
 *     (rôles ADMIN / SUPER_ADMIN, activable plus tôt — P0) ;
 *   · chaque réglage est une DATE D'ENTRÉE EN VIGUEUR (`enforced_from`) :
 *     NULL = non activée (défaut) ; une date future est affichable pour la
 *     communication préalable ; à partir de cette date l'obligation
 *     s'applique sans période de grâce, dès la première requête métier ;
 *   · un retour arrière (date effacée) ne désactive JAMAIS la MFA d'un
 *     compte qui a enrôlé un facteur : `user_mfa_state.enabled_at` n'est
 *     jamais remis à NULL par ce réglage.
 *
 * DÉCISION (`mfaRequirementFor`) : lue en base à chaque appel, SANS cache —
 * une seule requête indexée, faite uniquement pour les sessions de niveau 1
 * (les sessions de niveau 2 n'en ont pas besoin). Base injoignable :
 * `SESSION_UNAVAILABLE` (503), jamais « non requis ». Table absente
 * (migration non appliquée) : aucune obligation (aucun facteur ne peut
 * exister), avertissement unique.
 *
 * Carte #876 — COMPTES DE REVUE APPLE / GOOGLE : l'obligation GLOBALE ne
 * s'applique pas à une identité explicitement autorisée par un SUPER_ADMIN
 * sur un compte de revue (`app-review.ts`, faits lus dans la MÊME requête,
 * sans cache). `required = enrolled || (enforced && !exempt)` : un facteur
 * enrôlé reste TOUJOURS exigé, aucune preuve forte n'est fabriquée. Tables de
 * la migration 2020 absentes : aucune exemption (jamais un « non requis »
 * deviné). Erreur de lecture : `SESSION_UNAVAILABLE`, comme avant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { SESSION_UNAVAILABLE_CODE } from '../session-errors';
import { isAdminRole, type MfaEnforcementScope } from './constants';
import {
  APP_REVIEW_FACTS_JOIN, APP_REVIEW_FACTS_SQL, appReviewEligibility, appReviewFactsFromRow,
  type AppReviewFacts, type AppReviewKind,
} from './app-review';

export interface MfaEnforcementSettings {
  users: Date | null;
  admins: Date | null;
}

export interface MfaRequirement {
  required: boolean;
  /** Un facteur a été enrôlé (obligation permanente pour ce compte). */
  enrolled: boolean;
  /** Obligation globale en vigueur pour la population de l'utilisateur. */
  enforced: boolean;
  /**
   * Carte #876 : identité de revue Apple / Google exemptée de l'obligation
   * GLOBALE (jamais d'un facteur enrôlé). Faux par défaut et en cas de doute.
   */
  exempt: boolean;
  /** Store du compte de revue quand `exempt` (journal), `null` sinon. */
  reviewKind: AppReviewKind | null;
  role: string | null;
}

export interface MfaPolicyState {
  role: string | null;
  enabledAt: Date | null;
  settings: MfaEnforcementSettings;
  /** Carte #876 : faits d'exemption (absents = aucune exemption). */
  appReview?: AppReviewFacts | null;
}

export interface MfaPolicyStore {
  /** État d'un utilisateur et réglages en vigueur (une requête). `null` : utilisateur absent. */
  load(userId: number): Promise<MfaPolicyState | null>;
  readSettings(): Promise<MfaEnforcementSettings>;
  writeSetting(scope: MfaEnforcementScope, enforcedFrom: Date | null, adminId: number): Promise<void>;
}

const sqlClient = async () => (await import('@/db')).pgClient;
type SqlClient = Awaited<ReturnType<typeof sqlClient>>;

/** Carte #876 : migration 2020 absente (détectée une fois) → requête historique, aucune exemption. */
let appReviewSchemaMissing = false;
function isMissingRelationOrColumn(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '42P01' || code === '42703';
}

/** Requête d'avant la carte #876 (aucun fait d'exemption : `review_*` NULL). */
async function legacyLoad(sql: SqlClient, userId: number) {
  return sql<{
    role: string | null; status: string | null; enabled_at: Date | null; users_from: Date | null; admins_from: Date | null;
    review_account_id: number | null; review_account_kind: string | null; review_has_access: boolean | null; review_foreign_accounts: number | null;
  }[]>`
    SELECT u.role, u.status, m.enabled_at,
           (SELECT enforced_from FROM mfa_enforcement_settings WHERE scope = 'users') AS users_from,
           (SELECT enforced_from FROM mfa_enforcement_settings WHERE scope = 'admins') AS admins_from,
           NULL::int AS review_account_id, NULL::text AS review_account_kind,
           NULL::boolean AS review_has_access, NULL::int AS review_foreign_accounts
      FROM users u
      LEFT JOIN user_mfa_state m ON m.user_id = u.id
     WHERE u.id = ${userId}`;
}

const dbStore: MfaPolicyStore = {
  async load(userId) {
    const sql = await sqlClient();
    type Row = {
      role: string | null; status: string | null; enabled_at: Date | null; users_from: Date | null; admins_from: Date | null;
      review_account_id: number | null; review_account_kind: string | null; review_has_access: boolean | null; review_foreign_accounts: number | null;
    };
    let rows: Row[];
    if (!appReviewSchemaMissing) {
      try {
        rows = await sql.unsafe<Row[]>(`
          SELECT u.role, u.status, m.enabled_at,
                 (SELECT enforced_from FROM mfa_enforcement_settings WHERE scope = 'users') AS users_from,
                 (SELECT enforced_from FROM mfa_enforcement_settings WHERE scope = 'admins') AS admins_from,
                 ${APP_REVIEW_FACTS_SQL}
            FROM users u
            LEFT JOIN user_mfa_state m ON m.user_id = u.id
            ${APP_REVIEW_FACTS_JOIN}
           WHERE u.id = $1`, [userId] as never[]);
      } catch (e) {
        // Migration 2020 non appliquée : décision sans exemption (relue ci-dessous).
        if (!isMissingRelationOrColumn(e)) throw e;
        // Requête historique : si ELLE échoue aussi (tables MFA absentes), son
        // erreur remonte telle quelle (traitement inchangé ci-dessous).
        rows = await legacyLoad(sql, userId);
        if (!appReviewSchemaMissing) console.warn('[mfa] tables des comptes de revue absentes (migration 2020) : aucune exemption accordée.');
        appReviewSchemaMissing = true;
      }
    } else {
      rows = await legacyLoad(sql, userId);
    }
    const r = rows[0];
    if (!r) return null;
    return {
      role: r.role,
      enabledAt: r.enabled_at ? new Date(r.enabled_at) : null,
      settings: { users: r.users_from ? new Date(r.users_from) : null, admins: r.admins_from ? new Date(r.admins_from) : null },
      appReview: r.review_account_id == null ? null : appReviewFactsFromRow(r),
    };
  },
  async readSettings() {
    const sql = await sqlClient();
    const rows = await sql<{ scope: string; enforced_from: Date | null }[]>`SELECT scope, enforced_from FROM mfa_enforcement_settings`;
    const get = (s: string) => { const r = rows.find((x) => x.scope === s); return r?.enforced_from ? new Date(r.enforced_from) : null; };
    return { users: get('users'), admins: get('admins') };
  },
  async writeSetting(scope, enforcedFrom, adminId) {
    const sql = await sqlClient();
    await sql`
      INSERT INTO mfa_enforcement_settings (scope, enforced_from, updated_by, updated_at)
      VALUES (${scope}, ${enforcedFrom ? enforcedFrom.toISOString() : null}, ${adminId}, now())
      ON CONFLICT (scope) DO UPDATE SET enforced_from = EXCLUDED.enforced_from, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  },
};

// Surcharge portée par `globalThis` : elle survit à `vi.resetModules()` dans les tests.
const OVERRIDE_KEY = '__verebonaMfaPolicyStore';
const store = (): MfaPolicyStore =>
  ((globalThis as Record<string, unknown>)[OVERRIDE_KEY] as MfaPolicyStore | null | undefined) ?? dbStore;

/** TESTS UNITAIRES SEULEMENT (`src/test/setup.ts`). `null` rétablit la base. */
export function __setMfaPolicyStoreForTests(s: MfaPolicyStore | null): void {
  (globalThis as Record<string, unknown>)[OVERRIDE_KEY] = s;
}

let missingWarned = false;
function isMissingTable(e: unknown): boolean {
  return (e as { code?: string })?.code === '42P01';
}

/** Réglage en vigueur à `now` pour ce rôle ? (pur) */
export function isEnforcedFor(role: string | null | undefined, settings: MfaEnforcementSettings, now: Date = new Date()): boolean {
  const t = now.getTime();
  if (settings.users && settings.users.getTime() <= t) return true;
  if (isAdminRole(role) && settings.admins && settings.admins.getTime() <= t) return true;
  return false;
}

/** Décision unique : la MFA est-elle obligatoire pour cet utilisateur MAINTENANT ? */
export async function mfaRequirementFor(userId: number, now: Date = new Date()): Promise<MfaRequirement> {
  let state;
  try {
    state = await store().load(userId);
  } catch (e) {
    if (isMissingTable(e)) {
      if (!missingWarned) { missingWarned = true; console.warn('[mfa] tables MFA absentes : obligation inactive jusqu’à l’application des migrations 1165-1167.'); }
      return { required: false, enrolled: false, enforced: false, exempt: false, reviewKind: null, role: null };
    }
    throw new Error(SESSION_UNAVAILABLE_CODE);
  }
  // Utilisateur absent : la session sera refusée ailleurs ; ici, fail closed.
  if (!state) return { required: true, enrolled: false, enforced: true, exempt: false, reviewKind: null, role: null };
  const enrolled = !!state.enabledAt;
  const enforced = isEnforcedFor(state.role, state.settings, now);
  // Carte #876 : l'exemption ne neutralise QUE l'obligation globale. Le rôle
  // lu ici (même ligne) doit concorder avec celui des faits : sinon, aucune.
  const review = state.appReview && state.appReview.role === state.role ? appReviewEligibility(state.appReview) : null;
  const exempt = !enrolled && enforced && review?.exempt === true;
  return {
    required: enrolled || (enforced && !exempt),
    enrolled,
    enforced,
    exempt,
    reviewKind: exempt && review?.exempt ? review.kind : null,
    role: state.role,
  };
}

export async function readMfaEnforcementSettings(): Promise<MfaEnforcementSettings> {
  try {
    return await store().readSettings();
  } catch (e) {
    if (isMissingTable(e)) return { users: null, admins: null };
    throw e;
  }
}

export async function writeMfaEnforcementSetting(scope: MfaEnforcementScope, enforcedFrom: Date | null, adminId: number): Promise<void> {
  await store().writeSetting(scope, enforcedFrom, adminId);
}
