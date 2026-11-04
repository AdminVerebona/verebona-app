/**
 * Lot 109F — GARDE SERVEUR « e-mail jetable » appelée par TOUTES les voies de
 * création de compte et de changement d'adresse principale :
 *   · POST /api/users (inscription e-mail / mot de passe, invitations Duo,
 *     compte partagé, transmission) — `signup` ;
 *   · inscription Google / Apple : adresse principale choisie
 *     (`social_signup`), avant tout envoi de code (`social_email_code`),
 *     garde finale dans `createSocialAccount` (`social_final`) ;
 *   · changement d'adresse : demande (`email_change_request`) et
 *     confirmation (`email_change_confirm`).
 * Jamais appelée par la connexion, la réinitialisation du mot de passe, la
 * liaison d'une identité Google / Apple à un compte existant ni la session :
 * un compte existant n'est jamais bloqué rétroactivement.
 *
 * Réponse : code `DISPOSABLE_EMAIL_NOT_ALLOWED` et message unique ; le refus
 * ne dépend QUE du domaine (jamais de l'existence d'un compte), il est donc
 * placé avant toute lecture de compte (anti-énumération).
 *
 * Métriques AGRÉGÉES (`disposable_email_refusals`, migration 1125) : jour,
 * voie, entrée de liste qui a décidé (domaine, jamais l'adresse), motif,
 * version du référentiel. Écriture après la réponse, jamais bloquante.
 */
import { pgClient } from '@/db';
import { runDetached } from '@/lib/auth/anti-enumeration';
import { classifyEmailDomain } from '@/lib/auth/disposable-email';
import { DISPOSABLE_EMAIL_MESSAGE, DISPOSABLE_EMAIL_NOT_ALLOWED } from '@/lib/auth/disposable-email/messages';
import { DISPOSABLE_REFUSAL_RETENTION_DAYS, type DisposableChannel } from '@/lib/auth/disposable-email/policy';

export interface DisposableRefusal {
  code: typeof DISPOSABLE_EMAIL_NOT_ALLOWED;
  message: string;
}

/** `null` : adresse acceptée. Sinon refus (et métrique agrégée enregistrée après la réponse). */
export function checkDisposableEmail(email: unknown, channel: DisposableChannel): DisposableRefusal | null {
  const c = classifyEmailDomain(email);
  if (!c.disposable || !c.matched || !c.decidedBy) return null;
  const matched = c.matched;
  const reason = c.decidedBy;
  console.info(`[disposable-email] refus voie=${channel} domaine=${matched} motif=${reason} version=${c.listVersion}`);
  runDetached('métrique refus e-mail jetable', () => recordDisposableRefusal({ channel, domain: matched, reason, listVersion: c.listVersion }));
  return { code: DISPOSABLE_EMAIL_NOT_ALLOWED, message: DISPOSABLE_EMAIL_MESSAGE };
}

/** Compteur agrégé (jour, voie, domaine de liste, motif, version) ; table absente tolérée. */
export async function recordDisposableRefusal(input: { channel: DisposableChannel; domain: string; reason: string; listVersion: string; now?: Date }): Promise<void> {
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  try {
    await pgClient`
      INSERT INTO disposable_email_refusals (day, channel, domain, reason, list_version, refusals, first_at, last_at)
      VALUES (${day}, ${input.channel}, ${input.domain.slice(0, 253)}, ${input.reason}, ${input.listVersion.slice(0, 80)}, 1, now(), now())
      ON CONFLICT (day, channel, domain, reason, list_version)
      DO UPDATE SET refusals = disposable_email_refusals.refusals + 1, last_at = now()`;
    await pgClient`DELETE FROM disposable_email_refusals WHERE day < ${day}::date - ${DISPOSABLE_REFUSAL_RETENTION_DAYS}::int`;
  } catch (e) {
    if ((e as { code?: string })?.code === '42P01') return; // migration 1125 pas encore appliquée
    console.error('[disposable-email] métrique non enregistrée :', (e as Error)?.message ?? e);
  }
}
