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
 * ══════════════════════════════════════════════════════════════════════════
 */
import { SESSION_UNAVAILABLE_CODE } from '../session-errors';
import { isAdminRole, type MfaEnforcementScope } from './constants';

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
  role: string | null;
}

export interface MfaPolicyStore {
  /** État d'un utilisateur et réglages en vigueur (une requête). `null` : utilisateur absent. */
  load(userId: number): Promise<{ role: string | null; enabledAt: Date | null; settings: MfaEnforcementSettings } | null>;
  readSettings(): Promise<MfaEnforcementSettings>;
  writeSetting(scope: MfaEnforcementScope, enforcedFrom: Date | null, adminId: number): Promise<void>;
}

const sqlClient = async () => (await import('@/db')).pgClient;

const dbStore: MfaPolicyStore = {
  async load(userId) {
    const sql = await sqlClient();
    const rows = await sql<{ role: string | null; enabled_at: Date | null; users_from: Date | null; admins_from: Date | null }[]>`
      SELECT u.role, m.enabled_at,
             (SELECT enforced_from FROM mfa_enforcement_settings WHERE scope = 'users') AS users_from,
             (SELECT enforced_from FROM mfa_enforcement_settings WHERE scope = 'admins') AS admins_from
        FROM users u
        LEFT JOIN user_mfa_state m ON m.user_id = u.id
       WHERE u.id = ${userId}`;
    const r = rows[0];
    if (!r) return null;
    return {
      role: r.role,
      enabledAt: r.enabled_at ? new Date(r.enabled_at) : null,
      settings: { users: r.users_from ? new Date(r.users_from) : null, admins: r.admins_from ? new Date(r.admins_from) : null },
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
      return { required: false, enrolled: false, enforced: false, role: null };
    }
    throw new Error(SESSION_UNAVAILABLE_CODE);
  }
  // Utilisateur absent : la session sera refusée ailleurs ; ici, fail closed.
  if (!state) return { required: true, enrolled: false, enforced: true, role: null };
  const enrolled = !!state.enabledAt;
  const enforced = isEnforcedFor(state.role, state.settings, now);
  return { required: enrolled || enforced, enrolled, enforced, role: state.role };
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
