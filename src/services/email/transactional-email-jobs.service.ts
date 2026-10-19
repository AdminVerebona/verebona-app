/**
 * E-mails indispensables au parcours — envoi DURABLE (lot 57A, ticket P0
 * « échecs d'e-mails bloquant l'inscription, la vérification et les
 * invitations Duo »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 *
 * L'e-mail de vérification (inscription, renvoi) partait dans une promesse
 * détachée (`runDetached`) : un échec du fournisseur, ou un arrêt du
 * processus, et le compte restait inactif sans que rien ne le reprenne.
 * L'invitation Duo partait « fire and forget » : `success: true` et date
 * d'envoi posés avant de connaître le résultat.
 *
 * Désormais la DEMANDE d'envoi est enregistrée en base
 * (`transactional_email_jobs`, migration 0405) avant toute tentative :
 *   · tentative immédiate (après la réponse pour les parcours publics — la
 *     neutralité du lot 53A est inchangée ; avant la réponse pour le
 *     titulaire Duo, qui doit savoir si l'e-mail est parti) ;
 *   · reprise par la tâche planifiée interne `transactional-emails-retry`
 *     (toutes les minutes) : demandes jamais tentées (processus arrêté),
 *     échecs temporaires, tentative interrompue (verrou expiré) ;
 *   · bornée : `max_attempts` (6) tentatives espacées de 1, 5, 15, 60 puis
 *     180 min ; au-delà, `failed` (visible dans le BO) ;
 *   · sans doublon : une seule demande ouverte par compte (vérification) ou
 *     par Duo (invitation) — un renvoi relance la demande ouverte au lieu
 *     d'en créer une autre ; la prise d'une tentative est un UPDATE
 *     conditionnel (deux instances ne tentent jamais la même) ; clé
 *     d'idempotence Resend par tentative.
 *
 * AUCUN JETON N'EST STOCKÉ ICI. Le lien est reconstruit à chaque tentative :
 * lien de vérification SIGNÉ neuf (24 h, usage unique — inchangés), jeton
 * d'invitation Duo relu dans `duo_accounts`. Une demande devenue sans objet
 * (compte vérifié entre-temps, invitation retirée ou expirée, compte suspendu)
 * est close `cancelled` sans envoi. Rien ici n'active un compte.
 *
 * Lot 64A : troisième type, DUO_MEMBERSHIP_ENDED (information du membre
 * retiré d'un Duo), enregistré par la sortie de Duo
 * (`services/duo/duo-membership-ended-email.ts`, une demande par sortie via
 * `dedupe_key`) et envoyé par la reprise planifiée.
 * Lot 65A : quatrième type, DUO_MEMBERSHIP_LEFT (confirmation au membre qui
 * quitte lui-même le Duo), même construction que DUO_MEMBERSHIP_ENDED.
 * Lot 68C : cinquième type, SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER (rappel J−7
 * avant le renouvellement d'un abonnement annuel), enregistré par la tâche
 * `subscription-annual-renewal-reminders` (`dedupe_key` par abonnement Stripe ×
 * échéance) ; la construction REVALIDE l'abonnement chez Stripe juste avant
 * l'envoi (`services/billing/annual-renewal-reminder.service.ts`). Un montant
 * indisponible est un échec TEMPORAIRE (`temporary`), jamais une annulation.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { emailService } from '@/lib/email/email-service';
import { buildEmailVerificationUrl, EMAIL_VERIFICATION_TTL_MS } from '@/services/auth/email-verification.service';

export type EmailJobKind = 'EMAIL_VERIFICATION' | 'DUO_INVITATION' | 'DUO_MEMBERSHIP_ENDED' | 'DUO_MEMBERSHIP_LEFT' | 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER';
export type EmailJobStatus = 'pending' | 'sending' | 'accepted' | 'failed' | 'cancelled';

const MIN = 60_000;
export const EMAIL_JOB_MAX_ATTEMPTS = 6;
/** Délai avant la tentative suivante, après la n-ième tentative échouée. */
export const EMAIL_JOB_BACKOFF_MS: readonly number[] = [MIN, 5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN];
/** Verrou d'une tentative : au-delà, elle est réputée interrompue (processus arrêté). */
export const EMAIL_JOB_LOCK_MS = 2 * MIN;
/** Durée de validité de l'invitation Duo (même valeur que la route et le BO). */
export const DUO_INVITE_TTL_DAYS = 7;

export function emailJobBackoffMs(attempts: number): number {
  const i = Math.max(0, Math.min(attempts - 1, EMAIL_JOB_BACKOFF_MS.length - 1));
  return EMAIL_JOB_BACKOFF_MS[i];
}

export interface EmailJobOutcome {
  jobId: number;
  status: EmailJobStatus | 'busy';
  error?: string | null;
  nextAttemptAt?: string | null;
}

interface JobRow {
  id: number;
  kind: EmailJobKind;
  user_id: number | null;
  duo_id: number | null;
  triggered_by_user_id: number | null;
  recipient_email: string;
  context: Record<string, unknown> | string | null;
  status: EmailJobStatus;
  attempts: number;
  max_attempts: number;
  created_at: string | Date;
}

const iso = (d: Date) => d.toISOString();
const appBaseUrl = () => (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

// ── Enregistrement de la demande ─────────────────────────────────────────────

async function enqueue(
  kind: EmailJobKind,
  key: { col: 'recipient_email' | 'duo_id'; value: number | string },
  fields: { userId: number | null; duoId: number | null; triggeredByUserId: number | null; recipientEmail: string; context: Record<string, unknown> },
  now: Date,
): Promise<{ jobId: number; created: boolean }> {
  return pgClient.begin(async (tx) => {
    // Sérialise les demandes concurrentes pour la même cible (double clic,
    // deux onglets, renvoi pendant l'inscription) : jamais deux demandes ouvertes.
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`email-job:${kind}:${key.col}:${key.value}`]);
    // Lot 61B (E) : une invitation Duo n'est jamais fusionnée dans une
    // tentative EN COURS (`sending`) — elle a pu être construite avec
    // l'ancien lien ou l'ancienne adresse et se clore `accepted` sans que la
    // nouvelle invitation (remplacement, nouveau lien) parte. Une nouvelle
    // demande est ouverte ; l'ancienne se termine (sa trace d'envoi reste).
    const openStatuses = kind === 'DUO_INVITATION' ? `('pending')` : `('pending', 'sending')`;
    const [open] = await tx.unsafe<{ id: number; status: EmailJobStatus }[]>(
      `SELECT id, status FROM transactional_email_jobs
        WHERE kind = $1 AND ${key.col === 'recipient_email' ? 'lower(recipient_email) = lower($2)' : 'duo_id = $2'}
          AND status IN ${openStatuses}
        ORDER BY id DESC LIMIT 1`,
      [kind, key.value] as never[],
    );
    if (open) {
      // Demande déjà ouverte : relancée tout de suite (renvoi demandé), sans
      // nouvelle demande ni nouveau budget de tentatives.
      await tx.unsafe(
        `UPDATE transactional_email_jobs
            SET recipient_email = $2, context = CASE WHEN $3::jsonb = '{}'::jsonb THEN context ELSE $3::jsonb END, triggered_by_user_id = COALESCE($4, triggered_by_user_id),
                user_id = COALESCE($6, user_id),
                next_attempt_at = LEAST(next_attempt_at, $5::timestamptz), updated_at = $5::timestamptz
          WHERE id = $1`,
        [open.id, fields.recipientEmail, JSON.stringify(fields.context), fields.triggeredByUserId, iso(now), fields.userId] as never[],
      );
      return { jobId: open.id, created: false };
    }
    const [row] = await tx.unsafe<{ id: number }[]>(
      `INSERT INTO transactional_email_jobs
         (kind, user_id, duo_id, triggered_by_user_id, recipient_email, context, status, attempts, max_attempts,
          next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', 0, $7, $8::timestamptz, $8::timestamptz, $8::timestamptz)
       RETURNING id`,
      [kind, fields.userId, fields.duoId, fields.triggeredByUserId, fields.recipientEmail, JSON.stringify(fields.context),
        EMAIL_JOB_MAX_ATTEMPTS, iso(now)] as never[],
    );
    return { jobId: row.id, created: true };
  });
}

/**
 * Demande d'e-mail de vérification. Une seule demande ouverte par ADRESSE.
 *
 * `userId` absent : demande de RENVOI publique — enregistrée telle quelle,
 * sans lire le compte (même coût, que l'adresse ait un compte ou non : lot
 * 53A) ; le compte est résolu à la tentative, et une adresse sans compte non
 * vérifié est close sans envoi.
 */
export function enqueueVerificationEmail(input: {
  userId?: number | null;
  email: string;
  plan?: string | null;
  now?: Date;
}): Promise<{ jobId: number; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  return enqueue(
    'EMAIL_VERIFICATION',
    { col: 'recipient_email', value: email },
    {
      userId: input.userId ?? null, duoId: null, triggeredByUserId: null,
      recipientEmail: email,
      context: input.plan ? { plan: input.plan } : {},
    },
    input.now ?? new Date(),
  );
}

/** Demande d'e-mail d'invitation Duo (destinataire = adresse invitée). */
export function enqueueDuoInvitationEmail(input: {
  duoId: number;
  recipientEmail: string;
  triggeredByUserId: number;
  baseUrl: string;
  now?: Date;
}): Promise<{ jobId: number; created: boolean }> {
  return enqueue(
    'DUO_INVITATION',
    { col: 'duo_id', value: input.duoId },
    {
      userId: null, duoId: input.duoId, triggeredByUserId: input.triggeredByUserId,
      recipientEmail: input.recipientEmail.trim(),
      context: { baseUrl: input.baseUrl.replace(/\/$/, '') },
    },
    input.now ?? new Date(),
  );
}

// ── Tentative ────────────────────────────────────────────────────────────────

type Exec = { unsafe: typeof pgClient.unsafe };
type Built =
  | { ok: true; templateCode: EmailJobKind; variables: Record<string, string>; recipientUserId: number | null; triggeredByUserId: number | null; onAccepted?: (now: Date, tx: Exec) => Promise<void>; /** Adresse actuelle du destinataire (sinon celle de la demande). */ to?: string }
  | { ok: false; reason: string; /** Lot 68C : échec temporaire (reprise), pas une annulation. */ temporary?: boolean };

function contextOf(job: JobRow): Record<string, unknown> {
  if (!job.context) return {};
  if (typeof job.context === 'string') {
    try { return JSON.parse(job.context) as Record<string, unknown>; } catch { return {}; }
  }
  return job.context;
}

async function buildVerification(job: JobRow, now: Date): Promise<Built> {
  const [user] = job.user_id != null
    ? await pgClient.unsafe<{ id: number; email: string; first_name: string; is_active: boolean; status: string | null }[]>(
        `SELECT id, email, first_name, is_active, status FROM users WHERE id = $1`, [job.user_id as never])
    : await pgClient.unsafe<{ id: number; email: string; first_name: string; is_active: boolean; status: string | null }[]>(
        `SELECT id, email, first_name, is_active, status FROM users WHERE email = $1 ORDER BY is_active, id DESC LIMIT 1`,
        [job.recipient_email.trim().toLowerCase() as never]);
  if (!user) return { ok: false, reason: 'ACCOUNT_GONE' };
  if (job.user_id == null) {
    await pgClient.unsafe(`UPDATE transactional_email_jobs SET user_id = $2 WHERE id = $1`, [job.id, user.id] as never[]);
  }
  if (user.is_active) return { ok: false, reason: 'ALREADY_VERIFIED' };
  if (user.email.trim().toLowerCase() !== job.recipient_email.trim().toLowerCase()) return { ok: false, reason: 'EMAIL_CHANGED' };
  // Lot 53A : un compte suspendu ou supprimé n'obtient pas de lien d'activation.
  if (user.status === 'SUSPENDED' || user.status === 'DELETED') return { ok: false, reason: 'ACCOUNT_SUSPENDED' };
  // Au-delà de 24 h sans tentative aboutie, la demande est close : l'utilisateur
  // en refait une (« Renvoyer le lien »), qui ouvre une nouvelle demande.
  if (now.getTime() - new Date(job.created_at).getTime() > EMAIL_VERIFICATION_TTL_MS) return { ok: false, reason: 'REQUEST_EXPIRED' };
  const plan = typeof contextOf(job).plan === 'string' ? (contextOf(job).plan as string) : null;
  return {
    ok: true,
    templateCode: 'EMAIL_VERIFICATION',
    // Lien SIGNÉ neuf, valable 24 h à compter de CETTE tentative.
    variables: { firstName: user.first_name, verificationUrl: buildEmailVerificationUrl(appBaseUrl(), { id: user.id, email: user.email }, plan, now.getTime()) },
    recipientUserId: user.id,
    triggeredByUserId: null,
  };
}

async function buildDuoInvitation(job: JobRow, now: Date): Promise<Built> {
  const [duo] = await pgClient.unsafe<{
    id: number; billing_owner_user_id: number; pending_invite_email: string | null; pending_invite_token: string | null;
    pending_invite_token_expires_at: string | null; first_name: string | null; last_name: string | null;
    /** Période de souscription, en texte (précision microseconde conservée). */
    period: string | null;
  }[]>(
    `SELECT d.id, d.billing_owner_user_id, d.pending_invite_email, d.pending_invite_token, d.pending_invite_token_expires_at,
            u.first_name, u.last_name, d.duo_subscription_started_at::text AS period
       FROM duo_accounts d LEFT JOIN users u ON u.id = d.billing_owner_user_id
      WHERE d.id = $1`,
    [job.duo_id as never],
  );
  if (!duo || !duo.pending_invite_token || !duo.pending_invite_email) return { ok: false, reason: 'INVITATION_WITHDRAWN' };
  if (duo.pending_invite_email.trim().toLowerCase() !== job.recipient_email.trim().toLowerCase()) return { ok: false, reason: 'INVITATION_REPLACED' };
  if (duo.pending_invite_token_expires_at && new Date(duo.pending_invite_token_expires_at) < now) return { ok: false, reason: 'INVITATION_EXPIRED' };

  // Destinataire = la personne invitée (son compte s'il existe), émetteur = le
  // titulaire : l'historique n'attribue plus l'e-mail au titulaire (P1-E).
  const [invitee] = await pgClient.unsafe<{ id: number }[]>(
    `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [duo.pending_invite_email as never],
  );
  const baseUrl = typeof contextOf(job).baseUrl === 'string' ? (contextOf(job).baseUrl as string) : appBaseUrl();
  const inviteUrl = `${baseUrl}/duo/join/${duo.pending_invite_token}`;
  const token = duo.pending_invite_token;
  return {
    ok: true,
    templateCode: 'DUO_INVITATION',
    variables: {
      ownerFirstName: duo.first_name ?? '',
      ownerLastName: duo.last_name ?? '',
      ownerFullName: duo.first_name || duo.last_name ? `${duo.first_name ?? ''} ${duo.last_name ?? ''}`.trim() : '',
      inviteUrl,
      // Gabarit en base (0125) : {{actionUrl}} ; gabarit du code : {{inviteUrl}}.
      actionUrl: inviteUrl,
      expiresIn: `${DUO_INVITE_TTL_DAYS} jours`,
    },
    recipientUserId: invitee?.id ?? null,
    triggeredByUserId: duo.billing_owner_user_id,
    // ══════════════════════════════════════════════════════════════════
    // ACCEPTATION PAR RESEND (lot 61B, écart E)
    //
    // La trace du premier envoi dépendait du jeton courant : une annulation
    // ou un remplacement pendant l'expédition l'effaçait de fait (UPDATE sans
    // ligne), et la mascotte reproposait l'invitation alors qu'un e-mail
    // était parti. Désormais :
    //   · trace du premier envoi : posée dès qu'une expédition est
    //     ACCEPTÉE, quel que soit le jeton courant (annulation, expiration,
    //     remplacement ne l'effacent pas), sans écraser la première
    //     (COALESCE, idempotent), et SEULEMENT pour la souscription de la
    //     tentative (`duo_subscription_started_at` relu à la construction) :
    //     une ancienne expédition ne pollue jamais une nouvelle souscription ;
    //   · date d'envoi affichée au titulaire : seulement si l'invitation
    //     envoyée est toujours celle en cours (inchangé) ;
    //   · écrites dans la MÊME transaction que la clôture `accepted` de la
    //     demande. Un échec n'écrit rien (jamais présenté comme accepté).
    // ══════════════════════════════════════════════════════════════════
    onAccepted: async (at: Date, tx: Exec) => {
      await tx.unsafe(
        `UPDATE duo_accounts
            SET duo_first_invite_sent_at = COALESCE(duo_first_invite_sent_at, $3::timestamptz)
          WHERE id = $1 AND duo_subscription_started_at IS NOT DISTINCT FROM $2::timestamptz`,
        [duo.id, duo.period ?? null, iso(at)] as never[],
      );
      await tx.unsafe(
        `UPDATE duo_accounts
            SET pending_invite_sent_at = $3::timestamptz, updated_at = $3::timestamptz
          WHERE id = $1 AND pending_invite_token = $2`,
        [duo.id, token, iso(at)] as never[],
      );
    },
  };
}

/** Texte inséré dans un gabarit rendu en HTML : jamais de balise injectée. */
const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Comptes qui ne reçoivent pas l'information (lot 53A : suspendu, supprimé ou en suppression). */
const CLOSED_ACCOUNT_STATUSES = new Set(['SUSPENDED', 'PENDING_DELETION', 'DELETED']);

/**
 * Lot 64A — fin de l'accès d'un membre à un Premium Duo. Destinataire = le
 * membre (son adresse ACTUELLE), émetteur = le titulaire. Le prénom du
 * titulaire vient du contexte figé à la sortie (jamais son e-mail) ; aucun
 * motif de fermeture. Sans objet si le membre a rejoint à nouveau le Duo ou
 * si son compte est fermé.
 *
 * Lot 65A — même construction pour DUO_MEMBERSHIP_LEFT (le membre a quitté
 * lui-même le Duo) : seul le gabarit change. Émetteur = le membre lui-même
 * (c'est son action).
 */
async function buildDuoMembershipEnded(job: JobRow): Promise<Built> {
  if (job.user_id == null) return { ok: false, reason: 'ACCOUNT_GONE' };
  const [user] = await pgClient.unsafe<{ id: number; email: string; first_name: string | null; status: string | null }[]>(
    `SELECT id, email, first_name, status FROM users WHERE id = $1`, [job.user_id as never]);
  if (!user || !user.email) return { ok: false, reason: 'ACCOUNT_GONE' };
  if (CLOSED_ACCOUNT_STATUSES.has(String(user.status ?? '').toUpperCase())) return { ok: false, reason: 'ACCOUNT_CLOSED' };
  const ctx = contextOf(job);
  const membershipId = Number(ctx.membershipId);
  if (Number.isFinite(membershipId)) {
    const [m] = await pgClient.unsafe<{ status: string }[]>(
      `SELECT status FROM duo_memberships WHERE id = $1 AND user_id = $2`, [membershipId, user.id] as never[]);
    if (m?.status === 'ACTIVE') return { ok: false, reason: 'MEMBERSHIP_RESTORED' };
  }
  const owner = typeof ctx.ownerFirstName === 'string' && ctx.ownerFirstName.trim() ? ctx.ownerFirstName.trim() : 'le titulaire de l’abonnement';
  const base = appBaseUrl();
  return {
    ok: true,
    templateCode: job.kind === 'DUO_MEMBERSHIP_LEFT' ? 'DUO_MEMBERSHIP_LEFT' : 'DUO_MEMBERSHIP_ENDED',
    variables: {
      firstName: escapeHtml((user.first_name ?? '').trim()),
      ownerFirstName: escapeHtml(owner),
      accountUrl: `${base}/mon-compte`,
      subscriptionUrl: `${base}/mon-compte/offres`,
    },
    recipientUserId: user.id,
    triggeredByUserId: job.triggered_by_user_id,
    to: user.email,
  };
}

/**
 * Lot 68C — rappel J−7 avant renouvellement annuel : revalidation Stripe et
 * variables (montant de l'aperçu de facture, date, lien permanent). Une
 * erreur Stripe lève : échec temporaire, repris par la file.
 */
async function buildAnnualRenewal(job: JobRow, now: Date): Promise<Built> {
  const { buildAnnualRenewalReminder } = await import('@/services/billing/annual-renewal-reminder.service');
  const r = await buildAnnualRenewalReminder({ user_id: job.user_id, context: contextOf(job) }, now);
  if (!r.ok) return { ok: false, reason: r.reason, temporary: r.temporary };
  return {
    ok: true,
    templateCode: 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER',
    variables: r.variables,
    recipientUserId: r.recipientUserId,
    triggeredByUserId: null,
    to: r.to,
  };
}

/**
 * Tente l'envoi d'une demande. Ne lève pas (erreur inattendue → tentative
 * comptée comme échouée). `busy` : demande non due, déjà prise ou close.
 */
export async function processEmailJob(jobId: number, now: Date = new Date()): Promise<EmailJobOutcome> {
  // Prise atomique : due et libre, ou tentative interrompue (verrou expiré).
  const [job] = await pgClient.unsafe<JobRow[]>(
    `UPDATE transactional_email_jobs
        SET status = 'sending', attempts = attempts + 1, locked_until = $2::timestamptz, updated_at = $3::timestamptz
      WHERE id = $1
        AND ((status = 'pending' AND next_attempt_at <= $3::timestamptz)
          OR (status = 'sending' AND locked_until < $3::timestamptz))
      RETURNING id, kind, user_id, duo_id, triggered_by_user_id, recipient_email, context, status, attempts, max_attempts, created_at`,
    [jobId, iso(new Date(now.getTime() + EMAIL_JOB_LOCK_MS)), iso(now)] as never[],
  );
  if (!job) return { jobId, status: 'busy' };

  const close = async (status: EmailJobStatus, fields: { error?: string | null; logId?: number | null; messageId?: string | null; next?: Date | null } = {}, exec: Exec = pgClient) => {
    await exec.unsafe(
      `UPDATE transactional_email_jobs
          SET status = $2, locked_until = NULL, last_error = $3,
              last_email_log_id = COALESCE($4, last_email_log_id),
              provider_message_id = COALESCE($5, provider_message_id),
              accepted_at = CASE WHEN $2 = 'accepted' THEN $6::timestamptz ELSE accepted_at END,
              next_attempt_at = COALESCE($7::timestamptz, next_attempt_at),
              updated_at = $6::timestamptz
        WHERE id = $1`,
      [job.id, status, fields.error ?? null, fields.logId ?? null, fields.messageId ?? null, iso(now), fields.next ? iso(fields.next) : null] as never[],
    );
  };

  try {
    if (job.attempts > job.max_attempts) {
      await close('failed', { error: 'MAX_ATTEMPTS' });
      return { jobId: job.id, status: 'failed', error: 'MAX_ATTEMPTS' };
    }
    const built = job.kind === 'EMAIL_VERIFICATION' ? await buildVerification(job, now)
      : job.kind === 'DUO_MEMBERSHIP_ENDED' || job.kind === 'DUO_MEMBERSHIP_LEFT' ? await buildDuoMembershipEnded(job)
      : job.kind === 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER' ? await buildAnnualRenewal(job, now)
      : job.kind === 'DUO_INVITATION' ? await buildDuoInvitation(job, now)
      : ({ ok: false, reason: 'UNKNOWN_KIND' } as Built);
    if (!built.ok && built.temporary) {
      return await failed(job, built.reason, null, now, close);
    }
    if (!built.ok) {
      await close('cancelled', { error: built.reason });
      return { jobId: job.id, status: 'cancelled', error: built.reason };
    }
    const res = await emailService.send({
      templateCode: built.templateCode,
      to: built.to ?? job.recipient_email,
      variables: built.variables,
      userId: built.recipientUserId ?? undefined,
      triggeredByUserId: built.triggeredByUserId,
      idempotencyKey: `vb-email-job-${job.id}-${job.attempts}`,
      emailJobId: job.id,
    });
    if (res?.success) {
      // Clôture et effets de l'acceptation : une seule transaction (61B).
      await pgClient.begin(async (tx) => {
        const exec = tx as unknown as Exec;
        await close('accepted', { logId: res.logId ?? null, messageId: res.providerMessageId ?? null }, exec);
        await built.onAccepted?.(now, exec);
      });
      return { jobId: job.id, status: 'accepted' };
    }
    // Lot 64A : e-mail désactivable (BO › Communications) coupé par
    // l'administrateur — décision volontaire, pas une panne : clos sans reprise.
    if (res?.error === 'CHANNEL_DISABLED') {
      await close('cancelled', { error: 'CHANNEL_DISABLED', logId: res.logId ?? null });
      return { jobId: job.id, status: 'cancelled', error: 'CHANNEL_DISABLED' };
    }
    return await failed(job, res?.error ?? 'Échec d’envoi (cause inconnue)', res?.logId ?? null, now, close);
  } catch (e) {
    return failed(job, (e as Error)?.message ?? String(e), null, now, close);
  }
}

async function failed(
  job: JobRow,
  error: string,
  logId: number | null,
  now: Date,
  close: (s: EmailJobStatus, f: { error?: string | null; logId?: number | null; next?: Date | null }) => Promise<void>,
): Promise<EmailJobOutcome> {
  console.error(`[transactional-email] ${job.kind} #${job.id} tentative ${job.attempts}/${job.max_attempts} échouée : ${error}`);
  if (job.attempts >= job.max_attempts) {
    await close('failed', { error, logId });
    return { jobId: job.id, status: 'failed', error };
  }
  const next = new Date(now.getTime() + emailJobBackoffMs(job.attempts));
  await close('pending', { error, logId, next });
  return { jobId: job.id, status: 'pending', error, nextAttemptAt: iso(next) };
}

/**
 * Tâche planifiée `transactional-emails-retry` : demandes dues ou
 * interrompues, par lots, jusqu'à l'échéance. Idempotente (prise atomique).
 */
export async function runTransactionalEmailRetry(opts: { deadline?: number; now?: () => Date; limit?: number } = {}): Promise<{ processed: number; accepted: number; pending: number; failed: number; cancelled: number }> {
  const clock = opts.now ?? (() => new Date());
  const deadline = opts.deadline ?? Date.now() + 50_000;
  const at = clock();
  const due = await pgClient.unsafe<{ id: number }[]>(
    `SELECT id FROM transactional_email_jobs
      WHERE (status = 'pending' AND next_attempt_at <= $1::timestamptz)
         OR (status = 'sending' AND locked_until < $1::timestamptz)
      ORDER BY next_attempt_at, id LIMIT $2`,
    [iso(at), opts.limit ?? 50] as never[],
  );
  const total = { processed: 0, accepted: 0, pending: 0, failed: 0, cancelled: 0 };
  // Rétention : demandes closes depuis plus de 30 jours (le détail des
  // envois reste dans `email_logs`). Lot borné, idempotent.
  await pgClient.unsafe(
    `DELETE FROM transactional_email_jobs WHERE id IN (
       SELECT id FROM transactional_email_jobs
        WHERE status IN ('accepted', 'failed', 'cancelled') AND updated_at < $1::timestamptz LIMIT 500)`,
    [iso(new Date(at.getTime() - 30 * 24 * 60 * MIN))] as never[],
  );
  for (const { id } of due) {
    if (Date.now() >= deadline) break;
    const r = await processEmailJob(id, clock());
    if (r.status === 'busy') continue;
    total.processed += 1;
    if (r.status === 'accepted' || r.status === 'pending' || r.status === 'failed' || r.status === 'cancelled') total[r.status] += 1;
  }
  return total;
}

// ── Lecture (titulaire Duo, BO) ──────────────────────────────────────────────

export interface DuoInvitationEmailState {
  /** queued : demande enregistrée, pas encore acceptée ; accepted : acceptée par Resend ; delivered : remise au serveur destinataire ; failed : échec. */
  state: 'queued' | 'accepted' | 'delivered' | 'delayed' | 'failed';
  acceptedAt: string | null;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  /** Motif lisible par le titulaire (jamais de jeton). */
  reason: string | null;
}

const PROBLEM_DELIVERY = new Set(['bounced', 'complained', 'failed', 'suppressed']);

/** Dernière demande d'invitation du Duo, avec l'état de livraison connu. */
export async function getDuoInvitationEmailState(duoId: number): Promise<DuoInvitationEmailState | null> {
  const [r] = await pgClient.unsafe<{
    status: EmailJobStatus; last_error: string | null; accepted_at: string | null; next_attempt_at: string | null;
    delivery_status: string | null; delivered_at: string | null; delivery_error: string | null;
  }[]>(
    `SELECT j.status, j.last_error, j.accepted_at, j.next_attempt_at, l.delivery_status, l.delivered_at, l.delivery_error
       FROM transactional_email_jobs j
       LEFT JOIN email_logs l ON l.id = j.last_email_log_id AND j.status = 'accepted'
      WHERE j.duo_id = $1 AND j.kind = 'DUO_INVITATION' AND j.status <> 'cancelled'
      ORDER BY j.id DESC LIMIT 1`,
    [duoId as never],
  );
  if (!r) return null;
  const isoOrNull = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);
  if (r.status === 'accepted') {
    if (r.delivery_status && PROBLEM_DELIVERY.has(r.delivery_status)) {
      return { state: 'failed', acceptedAt: isoOrNull(r.accepted_at), deliveredAt: null, nextAttemptAt: null, reason: deliveryReason(r.delivery_status) };
    }
    if (r.delivery_status === 'delivered') return { state: 'delivered', acceptedAt: isoOrNull(r.accepted_at), deliveredAt: isoOrNull(r.delivered_at), nextAttemptAt: null, reason: null };
    if (r.delivery_status === 'delivery_delayed') return { state: 'delayed', acceptedAt: isoOrNull(r.accepted_at), deliveredAt: null, nextAttemptAt: null, reason: null };
    return { state: 'accepted', acceptedAt: isoOrNull(r.accepted_at), deliveredAt: null, nextAttemptAt: null, reason: null };
  }
  if (r.status === 'failed') return { state: 'failed', acceptedAt: null, deliveredAt: null, nextAttemptAt: null, reason: 'L’e-mail n’a pas pu être expédié.' };
  return { state: 'queued', acceptedAt: null, deliveredAt: null, nextAttemptAt: isoOrNull(r.next_attempt_at), reason: null };
}

function deliveryReason(status: string): string {
  switch (status) {
    case 'bounced': return 'Le serveur de messagerie du destinataire a refusé l’e-mail.';
    case 'suppressed': return 'L’adresse est bloquée par notre prestataire d’envoi après des refus précédents.';
    case 'complained': return 'Le destinataire a signalé l’e-mail comme indésirable.';
    default: return 'L’e-mail n’a pas pu être remis.';
  }
}
