/**
 * Invitations de parrainage par e-mail et lien partagé — lot 34I.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « TOUT VA BIEN SUR LE FRONT MAIS LE MAIL N'EST PAS REÇU »
 *
 * La route `/api/referral/send-email` appelait le SDK Resend directement et
 * comptait un envoi réussi dès que `resend.emails.send()` rendait la main.
 * Or ce SDK NE LÈVE PAS d'exception sur un refus : il renvoie
 * `{ data: null, error }`. Un expéditeur refusé, une clé invalide, un quota
 * atteint… étaient tous comptés « envoyés » — le front affichait
 * « Invitation envoyée » et rien ne partait.
 *
 * Et un refus était certain : l'expéditeur était codé en dur
 * (`RESEND_FROM_EMAIL`, à défaut `no-reply@verebona.fr`), alors que tous les
 * autres e-mails — qui arrivent — partent avec l'expéditeur réglé dans le BO
 * (`email_settings`), seul domaine vérifié chez Resend. Sans clé, la route
 * « simulait » même l'envoi et répondait succès.
 *
 * L'invitation passe désormais par le service e-mail commun
 * (`emailService.send`) : même expéditeur que les autres e-mails, gabarit
 * `REFERRAL_INVITATION` en base (migration 0301, modifiable dans le BO),
 * activation du canal depuis l'écran Communications, journal `email_logs`
 * (envoyé / échec / ignoré, motif) consultable dans le BO. Un envoi n'est
 * compté que si le fournisseur l'a ACCEPTÉ.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Gabarit e-mail de l'invitation (migration 0301). */
export const REFERRAL_INVITATION_TEMPLATE = 'REFERRAL_INVITATION';

/** Nombre maximal de destinataires par envoi. */
export const MAX_RECIPIENTS_PER_SEND = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Origine de l'application (liens de parrainage, liens des e-mails). */
export function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

/**
 * Lien de parrainage partagé : `<app>/r/<CODE>`.
 *
 * Seule source de ce format — Mon compte › Parrainage, l'e-mail d'invitation
 * et la route `src/app/r/[code]/route.ts` qui le reçoit doivent concorder.
 */
export function buildReferralUrl(code: string, base: string = appBaseUrl()): string {
  return `${base.replace(/\/+$/, '')}/r/${encodeURIComponent(code)}`;
}

/** Destinataires valides, normalisés, dédoublonnés, plafonnés. */
export function normalizeRecipients(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (typeof e !== 'string') continue;
    const email = e.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    if (seen.size >= MAX_RECIPIENTS_PER_SEND) break;
  }
  return [...seen];
}

/**
 * Nom du parrain tel qu'il apparaît dans l'objet et le corps de l'e-mail.
 *
 * Le gabarit est rendu en HTML sans échappement des variables : on retire
 * les caractères de balisage, le nom étant saisi librement par l'utilisateur
 * et l'e-mail adressé à un tiers.
 */
export function referralSenderName(firstName?: string | null, lastName?: string | null): string {
  const full = `${firstName ?? ''} ${lastName ?? ''}`.replace(/[<>"'`&]/g, '').replace(/\s+/g, ' ').trim();
  return full ? full.slice(0, 80) : 'Un proche';
}

export type InvitationFailureReason =
  | 'CHANNEL_DISABLED'
  | 'EMAILS_DISABLED'
  | 'NOT_CONFIGURED'
  | 'TEMPLATE_MISSING'
  | 'PROVIDER_REJECTED';

/** Classe l'erreur rendue par `emailService.send` (motif journalisé tel quel dans `email_logs`). */
export function classifySendError(error: string | undefined): InvitationFailureReason {
  const e = error ?? '';
  if (e === 'CHANNEL_DISABLED') return 'CHANNEL_DISABLED';
  if (e === 'Emails disabled') return 'EMAILS_DISABLED';
  if (e === 'Email provider not configured') return 'NOT_CONFIGURED';
  if (/^Template .* not found$/.test(e)) return 'TEMPLATE_MISSING';
  return 'PROVIDER_REJECTED';
}

/**
 * Message affiché quand AUCUNE invitation n'est partie. Jamais technique :
 * le détail est dans les journaux serveur et `email_logs`.
 */
export function invitationFailureMessage(reasons: InvitationFailureReason[]): string {
  if (reasons.length > 0 && reasons.every((r) => r === 'CHANNEL_DISABLED' || r === 'EMAILS_DISABLED')) {
    return 'L’envoi d’invitations par e-mail est momentanément désactivé. Copiez votre lien pour le partager.';
  }
  return 'L’invitation n’a pas pu être envoyée. Réessayez plus tard ou copiez votre lien pour le partager.';
}

type SendFn = (options: {
  templateCode: string;
  to: string;
  variables: Record<string, string>;
}) => Promise<{ success: boolean; error?: string }>;

export interface InvitationResult {
  sent: string[];
  failed: Array<{ email: string; reason: InvitationFailureReason }>;
}

/**
 * Envoie une invitation par destinataire. N'est compté « envoyé » que ce que
 * le service e-mail confirme (fournisseur ayant accepté le message).
 * Ne lève pas : une exception d'un envoi est un échec de CET envoi.
 */
export async function sendReferralInvitations(input: {
  recipients: string[];
  senderName: string;
  referralUrl: string;
  send: SendFn;
}): Promise<InvitationResult> {
  const result: InvitationResult = { sent: [], failed: [] };
  for (const email of input.recipients) {
    try {
      const r = await input.send({
        templateCode: REFERRAL_INVITATION_TEMPLATE,
        to: email,
        variables: {
          senderName: input.senderName,
          referralUrl: input.referralUrl,
          actionUrl: input.referralUrl,
        },
      });
      if (r.success) result.sent.push(email);
      else result.failed.push({ email, reason: classifySendError(r.error) });
    } catch {
      result.failed.push({ email, reason: 'PROVIDER_REJECTED' });
    }
  }
  return result;
}

/** Masque une adresse pour les journaux applicatifs (`j***@exemple.fr`). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${(local ?? '').slice(0, 1)}***@${domain ?? ''}`;
}

/**
 * Destination d'un lien de parrainage `/r/<code>` (CDC parrainage §4.1-§4.4) :
 *   - code connu et actif → inscription avec le code propagé par `?ref=`
 *     (le formulaire l'affiche et le transmet à `POST /api/users`, qui
 *     mémorise l'attribution, `referral-attribution.service`) ;
 *   - code inconnu, inactif ou mal formé → inscription sans code, sans erreur.
 *
 * Aucun cookie : le CDC §4.2 interdit toute conservation persistante du code ;
 * il ne circule que par l'URL et l'état mémoire du parcours (§4.3).
 */
export function referralRedirectPath(code: string | null): string {
  return code ? `/signup?ref=${encodeURIComponent(code)}` : '/signup';
}
