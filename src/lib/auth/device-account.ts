/**
 * Compte d'un appareil reconnu — intégration 96A + 96B (CDC 18 P5, Q6, Q8, Q10).
 *
 * L'entrée du cookie `vb_device` est liée à l'IDENTIFIANT utilisateur
 * (`device-trust.ts`) : un changement d'adresse (96A) ne rend ni l'appareil
 * courant ni les appareils connus « inconnus », et une adresse reprise par
 * un autre compte n'hérite d'aucun appareil.
 *
 * Ce module résout le `DeviceTrustAccount` d'un compte, avec les deux
 * informations de TRANSITION qui permettent d'accepter les entrées héritées
 * (étiquette d'adresse, émises avant l'intégration) sans usurpation :
 *   · `legacyEmail` : adresse D'ORIGINE du compte — l'ancienne adresse de son
 *     PREMIER changement confirmé (`email_change_requests`), sinon l'adresse
 *     actuelle ;
 *   · `legacyNotBeforeMs` : création du compte.
 * Aucune entrée héritée n'est plus émise ; elles expirent au plus tard 180
 * jours après la dernière connexion d'avant l'intégration. Les demandes de
 * changement CONFIRMÉES sont conservées 180 jours (purge, `email-change.service`)
 * pour que l'adresse d'origine reste connue pendant toute cette transition.
 *
 * Jamais bloquant : en cas d'erreur, le compte est rendu sans information de
 * transition (seules les entrées `uid` comptent) — prudent, jamais permissif.
 */
import { normalizeEmail } from './auth-rate-limit';
import { readDeviceCookie, trustedDeviceFor, type DeviceTrustAccount } from './device-trust';

interface AccountRow {
  id: number;
  email: string;
  created_at: Date | string | null;
  original_email: string | null;
}

function toAccount(r: AccountRow | undefined): DeviceTrustAccount | null {
  if (!r || !Number.isInteger(Number(r.id))) return null;
  const created = r.created_at ? new Date(r.created_at).getTime() : NaN;
  return {
    userId: Number(r.id),
    legacyEmail: normalizeEmail(r.original_email ?? r.email) || null,
    legacyNotBeforeMs: Number.isFinite(created) ? created : null,
  };
}

/**
 * Compte désigné par l'adresse SAISIE (connexion, rattachement par mot de
 * passe), avant toute vérification : sert uniquement à choisir la règle D1.
 * Même sélection que la route de connexion (adresse exacte préférée).
 */
export async function deviceAccountByEmail(email: string, normalized: string): Promise<DeviceTrustAccount | null> {
  if (!email && !normalized) return null;
  try {
    const { db } = await import('@/db');
    const rows = await db.$client<AccountRow[]>`
      SELECT id, email, created_at,
             (SELECT r.old_email FROM email_change_requests r
               WHERE r.user_id = users.id AND r.consumed_at IS NOT NULL
               ORDER BY r.consumed_at ASC LIMIT 1) AS original_email
        FROM users
       WHERE email IN (${email}, ${normalized})
       ORDER BY (email = ${email}) DESC
       LIMIT 1`;
    return toAccount(rows[0]);
  } catch {
    return null;
  }
}

/** Compte par identifiant (alerte « nouvel appareil », dépôt du cookie). */
export async function deviceAccountById(userId: number): Promise<DeviceTrustAccount> {
  try {
    const { db } = await import('@/db');
    const rows = await db.$client<AccountRow[]>`
      SELECT id, email, created_at,
             (SELECT r.old_email FROM email_change_requests r
               WHERE r.user_id = users.id AND r.consumed_at IS NOT NULL
               ORDER BY r.consumed_at ASC LIMIT 1) AS original_email
        FROM users
       WHERE id = ${userId}
       LIMIT 1`;
    return toAccount(rows[0]) ?? { userId };
  } catch {
    return { userId };
  }
}

/**
 * Règle A de D1 à la connexion : identifiant d'appareil si le cookie présenté
 * est reconnu pour le compte de l'adresse saisie. Sans cookie : aucune
 * lecture de compte. La décision ne dépend que du cookie signé (jamais d'un
 * en-tête) ; un compte inexistant donne `null`, comme un appareil inconnu.
 */
export async function trustedDeviceForLogin(request: { cookies: { get(name: string): { value: string } | undefined } }, email: string, normalized: string): Promise<string | null> {
  const raw = readDeviceCookie(request);
  if (!raw) return null;
  return trustedDeviceFor(raw, await deviceAccountByEmail(email, normalized));
}

/** Compte à inscrire dans le cookie après une preuve réussie (entrée `uid` ; l'héritée de l'adresse actuelle est retirée). */
export function deviceAccountOf(user: { id: number; email?: string | null }): DeviceTrustAccount {
  return { userId: user.id, legacyEmail: normalizeEmail(user.email ?? '') || null };
}
