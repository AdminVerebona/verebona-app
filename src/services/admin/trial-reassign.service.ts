/**
 * « Réattribuer un essai » — lot 72D (ticket P0 « Premium Duo — compte
 * partagé », décision PO Q4). Action BO MANUELLE et tracée, au cas par cas.
 *
 * Avant le lot 72D, l'invité d'un Premium Duo recevait un compte personnel
 * artificiel avec un essai de 7 jours : son adresse a donc CONSOMMÉ l'essai
 * (`trial_grants`, unique par adresse). Le rattrapage ne remet jamais un
 * essai à zéro automatiquement (ticket §7). Si un ex-membre veut créer son
 * propre espace, l'administration peut lui rendre l'essai :
 *
 *   · la trace d'origine n'est PAS supprimée : son adresse normalisée est
 *     suffixée (`<adresse>#reattribue:<id>:<date>`), ce qui libère l'adresse
 *     pour un nouvel essai tout en gardant l'historique anti-abus ;
 *   · motif obligatoire, journal d'audit administrateur (avant / après) ;
 *   · refusé si l'adresse n'a pas d'essai consommé, ou si un essai est EN
 *     COURS sur un compte non archivé (rien à rendre).
 *
 * L'essai lui-même est accordé à la création de l'espace (« Créer mon
 * espace », `POST /api/accounts/personal`).
 */
import { pgClient } from '@/db';

type TrialReassignError = 'USER_NOT_FOUND' | 'NO_CONSUMED_TRIAL' | 'TRIAL_IN_PROGRESS';

export const TRIAL_REASSIGN_MESSAGES: Record<TrialReassignError, string> = {
  USER_NOT_FOUND: 'Utilisateur introuvable.',
  NO_CONSUMED_TRIAL: 'Cette adresse n’a consommé aucun essai : rien à réattribuer.',
  TRIAL_IN_PROGRESS: 'Un essai est en cours sur un espace actif de cet utilisateur : rien à réattribuer.',
};

type TrialReassignResult =
  | { ok: true; grantId: number; before: string; after: string }
  | { ok: false; error: TrialReassignError };

export async function reassignTrial(userId: number, now: Date = new Date()): Promise<TrialReassignResult> {
  return pgClient.begin(async (tx) => {
    const [u] = await tx<{ email: string }[]>`SELECT email FROM users WHERE id = ${userId}`;
    if (!u) return { ok: false, error: 'USER_NOT_FOUND' } as const;
    const email = u.email.trim().toLowerCase();
    const [grant] = await tx<{ id: number }[]>`SELECT id FROM trial_grants WHERE email_normalized = ${email} FOR UPDATE`;
    if (!grant) return { ok: false, error: 'NO_CONSUMED_TRIAL' } as const;
    const [enCours] = await tx<{ ok: number }[]>`
      SELECT 1 AS ok FROM account_subscriptions s
        JOIN account_memberships m ON m.account_id = s.account_id AND m.user_id = ${userId} AND m.role = 'owner' AND lower(m.status) = 'active'
        JOIN accounts a ON a.id = s.account_id AND a.archived_at IS NULL
       WHERE s.status = 'trialing' LIMIT 1`;
    if (enCours) return { ok: false, error: 'TRIAL_IN_PROGRESS' } as const;
    const after = `${email}#reattribue:${grant.id}:${now.toISOString().slice(0, 10)}`;
    await tx`UPDATE trial_grants SET email_normalized = ${after} WHERE id = ${grant.id}`;
    return { ok: true, grantId: grant.id, before: email, after } as const;
  });
}
