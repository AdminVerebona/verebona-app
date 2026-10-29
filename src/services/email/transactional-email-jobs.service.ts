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
 * Lot 73B : sixième type, DUO_INVITATION_DECLINED (information du TITULAIRE :
 * la personne invitée a refusé l'invitation), enregistré dans la transaction
 * du refus (`services/duo/duo-invitation-decline.service.ts`, `dedupe_key`
 * par Duo × jeton refusé).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 72F — IDENTITÉ D'ENVOI STABLE ET ACCEPTATION INCERTAINE
 *
 * La clé d'idempotence Resend était `vb-email-job-<id>-<tentative>` : elle
 * changeait à chaque tentative. Si Resend acceptait l'e-mail mais que la
 * réponse était perdue (réseau, délai, 5xx, arrêt du processus avant
 * l'enregistrement), la reprise envoyait un SECOND e-mail. Désormais :
 *   · clé STABLE `vb-email-job-<id>-g<génération>` ; la génération ne change
 *     qu'après un refus CONFIRMÉ du prestataire (4xx hors idempotence) pour un
 *     premier appel avec cette clé, ou une décision explicite du BO ;
 *   · l'appel est marqué AVANT la transmission (`provider_call_started_at`) ;
 *     réponse perdue / 5xx / 409 d'idempotence : « acceptation incertaine »
 *     (`provider_outcome = uncertain`), jamais un échec confirmé ;
 *   · une demande dont un appel est incertain est RÉCONCILIÉE avant toute
 *     nouvelle émission : journal des envois (`email_logs`), webhooks Resend
 *     étiquetés (`vb_email_job`), puis — dans la fenêtre d'idempotence Resend
 *     (24 h, marge : 23 h) — réémission avec la MÊME clé et le même contenu
 *     (Resend renvoie la réponse d'origine sans second e-mail) ; au-delà, ou si
 *     la clé a déjà servi avec un autre contenu : consultation de l'e-mail chez
 *     Resend (liste + identifiant, étiquette de la demande) ;
 *   · incertitude non résolue : statut `uncertain`, AUCUNE réémission
 *     automatique, anomalie BO (Communications) avec décision manuelle ;
 *   · rappel annuel : la suspension de la tâche (BO ou variable d'arrêt) et la
 *     bascule non déclarée bloquent l'envoi au moment même de l'envoi, demandes
 *     déjà préparées comprises — sans consommer de tentative ni bloquer les
 *     autres e-mails de la file.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { emailService } from '@/lib/email/email-service';
import { buildEmailVerificationUrl, EMAIL_VERIFICATION_TTL_MS } from '@/services/auth/email-verification.service';

type EmailJobKind = 'EMAIL_VERIFICATION' | 'DUO_INVITATION' | 'DUO_MEMBERSHIP_ENDED' | 'DUO_MEMBERSHIP_LEFT' | 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER' | 'DUO_INVITATION_DECLINED'
  | 'PREMIUM_CONFIRMATION' | 'DOWNGRADE_NOTIFICATION';

/**
 * Lot 81E — e-mails CONTRACTUELS (confirmation de souscription, fin d'offre),
 * enregistrés par `subscription-communications.service` (une demande par
 * opération, `dedupe_key`). Un échec définitif ou une acceptation incertaine
 * non résolue ouvre une anomalie de Supervision (domaine communications) ;
 * une acceptation la résout.
 */
const CONTRACTUAL_EMAIL_KINDS: ReadonlySet<EmailJobKind> = new Set(['PREMIUM_CONFIRMATION', 'DOWNGRADE_NOTIFICATION']);
type EmailJobStatus = 'pending' | 'sending' | 'accepted' | 'failed' | 'cancelled' | 'uncertain';

const MIN = 60_000;
export const EMAIL_JOB_MAX_ATTEMPTS = 6;
/** Délai avant la tentative suivante, après la n-ième tentative échouée. */
const EMAIL_JOB_BACKOFF_MS: readonly number[] = [MIN, 5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN];
/** Verrou d'une tentative : au-delà, elle est réputée interrompue (processus arrêté). */
const EMAIL_JOB_LOCK_MS = 2 * MIN;
/** Durée de validité de l'invitation Duo (même valeur que la route et le BO). */
export const DUO_INVITE_TTL_DAYS = 7;
/** Lot 72F : fenêtre d'idempotence Resend (24 h) — réémission avec la même clé jusqu'à 23 h (marge). */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * MIN;
export const PROVIDER_REPLAY_WINDOW_MS = 23 * 60 * MIN;
/** Lot 72F : délai minimal avant de conclure à l'absence d'un e-mail dans la liste Resend. */
const PROVIDER_LISTING_GRACE_MS = 10 * MIN;
/** Lot 72F : consultation bornée de la liste Resend (pages de 100). */
const PROVIDER_LIST_MAX_PAGES = 10;
/**
 * Lot 76D : bornes de la consultation Resend. Au-delà (candidats trop nombreux,
 * pages, durée), la recherche est INCOMPLÈTE : jamais « absent » (unknown, motif
 * persistant, réémission bloquée). Toutes les candidates retenues sont inspectées.
 */
export const PROVIDER_LOOKUP_MAX_CANDIDATES = 50;
export const PROVIDER_LOOKUP_MAX_MS = 25_000;
/** Lot 76D : nouvelle consultation d'une demande neutralisée restée incertaine (retour arrière en cours). */
const NEUTRALIZED_RECHECK_MS = 15 * MIN;
/** Lot 72F : étiquettes Resend de la demande d'origine. */
export const EMAIL_JOB_TAG = 'vb_email_job';
const EMAIL_JOB_GENERATION_TAG = 'vb_send_gen';

/** Lot 72F : identité d'envoi STABLE (une génération = une clé, toutes tentatives confondues). */
export function emailJobIdempotencyKey(jobId: number, generation: number): string {
  return `vb-email-job-${jobId}-g${generation}`;
}

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
  /** Lot 72F (0524). */
  send_generation: number;
  provider_call_started_at: string | Date | null;
  provider_outcome: string | null;
  provider_detail: string | null;
  /** Lot 76D (0585). */
  neutralized_at?: string | Date | null;
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
  | { ok: true; templateCode: string; variables: Record<string, string>; recipientUserId: number | null; triggeredByUserId: number | null; onAccepted?: (now: Date, tx: Exec) => Promise<void>; /** Adresse actuelle du destinataire (sinon celle de la demande). */ to?: string }
  | { ok: false; reason: string; /** Lot 68C : échec temporaire (reprise), pas une annulation. */ temporary?: boolean };

function contextOf(job: JobRow): Record<string, unknown> {
  if (!job.context) return {};
  if (typeof job.context === 'string') {
    try { return JSON.parse(job.context) as Record<string, unknown>; } catch { return {}; }
  }
  return job.context;
}

async function buildVerification(job: JobRow, now: Date, contentAt: Date = now): Promise<Built> {
  // Lot 96A : `signup_nonce` — le lien est signé pour CETTE inscription.
  const [user] = job.user_id != null
    ? await pgClient.unsafe<{ id: number; email: string; first_name: string; is_active: boolean; status: string | null; signup_nonce: string | null }[]>(
        `SELECT id, email, first_name, is_active, status, signup_nonce FROM users WHERE id = $1`, [job.user_id as never])
    : await pgClient.unsafe<{ id: number; email: string; first_name: string; is_active: boolean; status: string | null; signup_nonce: string | null }[]>(
        `SELECT id, email, first_name, is_active, status, signup_nonce FROM users WHERE email = $1 ORDER BY is_active, id DESC LIMIT 1`,
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
    // Lot 72F : réémission d'un appel incertain → lien signé À L'INSTANT de cet appel (contenu identique).
    variables: { firstName: user.first_name, verificationUrl: buildEmailVerificationUrl(appBaseUrl(), { id: user.id, email: user.email, signupNonce: user.signup_nonce }, plan, contentAt.getTime()) },
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
      // Lot 73A : rappel d'export (Mon compte › Mes données, export RGPD).
      dataExportUrl: `${base}/mon-compte#mes-donnees`,
    },
    recipientUserId: user.id,
    triggeredByUserId: job.triggered_by_user_id,
    to: user.email,
  };
}

/**
 * Lot 73B — refus de l'invitation Premium Duo : information du TITULAIRE
 * (son adresse ACTUELLE). Adresse invitée et date du refus figées dans le
 * contexte au moment du refus (le titulaire a lui-même saisi l'adresse).
 * Sans objet si le titulaire n'existe plus, si son compte est fermé ou s'il
 * ne porte plus ce Duo. Valeurs utilisateur échappées (gabarit rendu en HTML).
 */
async function buildDuoInvitationDeclined(job: JobRow): Promise<Built> {
  if (job.user_id == null) return { ok: false, reason: 'ACCOUNT_GONE' };
  const [user] = await pgClient.unsafe<{ id: number; email: string; first_name: string | null; status: string | null }[]>(
    `SELECT id, email, first_name, status FROM users WHERE id = $1`, [job.user_id as never]);
  if (!user || !user.email) return { ok: false, reason: 'ACCOUNT_GONE' };
  if (CLOSED_ACCOUNT_STATUSES.has(String(user.status ?? '').toUpperCase())) return { ok: false, reason: 'ACCOUNT_CLOSED' };
  const ctx = contextOf(job);
  const duoId = Number(ctx.duoId);
  const [duo] = Number.isFinite(duoId)
    ? await pgClient.unsafe<{ id: number }[]>(`SELECT id FROM duo_accounts WHERE id = $1 AND billing_owner_user_id = $2`, [duoId, user.id] as never[])
    : [];
  if (!duo) return { ok: false, reason: 'DUO_GONE' };
  const declinedAt = typeof ctx.declinedAt === 'string' ? new Date(ctx.declinedAt) : null;
  const inviteEmail = typeof ctx.inviteEmail === 'string' && ctx.inviteEmail.trim() ? ctx.inviteEmail.trim() : 'la personne invitée';
  return {
    ok: true,
    templateCode: 'DUO_INVITATION_DECLINED',
    variables: {
      firstName: escapeHtml((user.first_name ?? '').trim()),
      inviteEmail: escapeHtml(inviteEmail),
      declinedAt: declinedAt && !Number.isNaN(declinedAt.getTime())
        ? declinedAt.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' })
        : 'récemment',
      invitationUrl: `${appBaseUrl()}/mon-compte#duo-invitation`,
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
async function buildAnnualRenewal(job: JobRow, now: Date, contentAt: Date = now): Promise<Built> {
  const { buildAnnualRenewalReminder } = await import('@/services/billing/annual-renewal-reminder.service');
  const r = await buildAnnualRenewalReminder({ user_id: job.user_id, context: contextOf(job) }, now, undefined, contentAt);
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
 * Lot 81E — confirmation contractuelle (PREMIUM_CONFIRMATION) : données
 * FIGÉES à l'opération (offre, montant, périodicité, échéance), destinataire
 * = adresse ACTUELLE du titulaire. Contexte illisible : échec TEMPORAIRE
 * (jamais une annulation silencieuse — l'échec final est supervisé).
 */
async function buildPremiumConfirmation(job: JobRow): Promise<Built> {
  if (job.user_id == null) return { ok: false, reason: 'ACCOUNT_GONE' };
  const [user] = await pgClient.unsafe<{ id: number; email: string; first_name: string | null; status: string | null }[]>(
    `SELECT id, email, first_name, status FROM users WHERE id = $1`, [job.user_id as never]);
  if (!user || !user.email) return { ok: false, reason: 'ACCOUNT_GONE' };
  if (CLOSED_ACCOUNT_STATUSES.has(String(user.status ?? '').toUpperCase())) return { ok: false, reason: 'ACCOUNT_CLOSED' };
  const ctx = contextOf(job);
  const next = typeof ctx.nextBillingDate === 'string' ? new Date(ctx.nextBillingDate) : null;
  if (!next || Number.isNaN(next.getTime())) return { ok: false, reason: 'CONTRACT_CONTEXT_INVALID', temporary: true };
  const { premiumConfirmationVariables } = await import('@/lib/email/billing-emails');
  const period = ctx.billingPeriod === 'monthly' || ctx.billingPeriod === 'yearly' ? ctx.billingPeriod : null;
  const variables = premiumConfirmationVariables(escapeHtml((user.first_name ?? '').trim()), next, {
    planLabel: typeof ctx.planLabel === 'string' ? ctx.planLabel : undefined,
    unitAmountCents: typeof ctx.unitAmountCents === 'number' ? ctx.unitAmountCents : null,
    billingPeriod: period,
  });
  return { ok: true, templateCode: 'PREMIUM_CONFIRMATION', variables, recipientUserId: user.id, triggeredByUserId: null, to: user.email };
}

/** Lot 81E — fin d'offre (DOWNGRADE_NOTIFICATION), une fois par opération. */
async function buildDowngradeNotification(job: JobRow): Promise<Built> {
  if (job.user_id == null) return { ok: false, reason: 'ACCOUNT_GONE' };
  const [user] = await pgClient.unsafe<{ id: number; email: string; first_name: string | null; status: string | null }[]>(
    `SELECT id, email, first_name, status FROM users WHERE id = $1`, [job.user_id as never]);
  if (!user || !user.email) return { ok: false, reason: 'ACCOUNT_GONE' };
  if (CLOSED_ACCOUNT_STATUSES.has(String(user.status ?? '').toUpperCase())) return { ok: false, reason: 'ACCOUNT_CLOSED' };
  const { downgradeNotificationVariables } = await import('@/lib/email/billing-emails');
  return {
    ok: true, templateCode: 'DOWNGRADE_NOTIFICATION', variables: downgradeNotificationVariables(escapeHtml((user.first_name ?? '').trim())),
    recipientUserId: user.id, triggeredByUserId: null, to: user.email,
  };
}

/** Lot 81E — supervision des e-mails contractuels (ne lève jamais). */
async function superviseContractual(job: Pick<JobRow, 'id' | 'kind' | 'user_id'>, status: EmailJobStatus, detail: string | null): Promise<void> {
  if (!CONTRACTUAL_EMAIL_KINDS.has(job.kind)) return;
  try {
    const { reportAnomaly, autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
    const fingerprint = `communications:transactional:${job.kind.toLowerCase()}:${job.id}`;
    if (status === 'accepted') {
      await autoResolveAnomaly(fingerprint, { origin: 'email_accepted' });
    } else if (status === 'failed' || status === 'uncertain') {
      await reportAnomaly({
        domain: 'communications',
        fingerprint,
        title: status === 'failed'
          ? `E-mail contractuel non envoyé : ${job.kind} (demande ${job.id})`
          : `E-mail contractuel à acceptation incertaine : ${job.kind} (demande ${job.id})`,
        userId: job.user_id ?? null,
        detail: { jobId: job.id, kind: job.kind, status, detail },
      });
    }
  } catch (e) {
    console.error(`[transactional-email] supervision de la demande ${job.id} impossible :`, (e as Error)?.message ?? e);
  }
}

/** Mise à jour de clôture / report d'une tentative (lot 72F : état du prestataire). */
interface CloseFields {
  error?: string | null;
  logId?: number | null;
  messageId?: string | null;
  next?: Date | null;
  /** Dernier résultat du prestataire (inchangé si absent). */
  providerOutcome?: 'accepted' | 'rejected' | 'uncertain' | 'reconciled' | 'reconciled_absent' | null;
  providerDetail?: string | null;
  /** Refus confirmé d'un premier appel : nouvelle génération de clé. */
  newGeneration?: boolean;
}

/** Ne lève pas : un retour de l'appel garde la trace de l'issue. */
type Close = (status: EmailJobStatus, fields?: CloseFields, exec?: Exec) => Promise<void>;

function closerFor(job: JobRow, now: Date): Close {
  return async (status, fields = {}, exec = pgClient) => {
    // Lot 81E : e-mail contractuel — échec ou incertitude supervisés au BO.
    if (CONTRACTUAL_EMAIL_KINDS.has(job.kind) && (status === 'accepted' || status === 'failed' || status === 'uncertain')) {
      await superviseContractual(job, status, fields.error ?? fields.providerDetail ?? null);
    }
    await exec.unsafe(
      `UPDATE transactional_email_jobs
          SET status = $2, locked_until = NULL, last_error = $3,
              last_email_log_id = COALESCE($4, last_email_log_id),
              provider_message_id = COALESCE($5, provider_message_id),
              accepted_at = CASE WHEN $2 = 'accepted' THEN $6::timestamptz ELSE accepted_at END,
              next_attempt_at = COALESCE($7::timestamptz, next_attempt_at),
              updated_at = $6::timestamptz,
              provider_outcome = COALESCE($8, provider_outcome),
              provider_detail = CASE WHEN $8::text IS NULL THEN provider_detail ELSE $9 END,
              uncertain_since = CASE WHEN $8 = 'uncertain' THEN COALESCE(uncertain_since, $6::timestamptz)
                                     WHEN $8 IS NULL THEN uncertain_since ELSE NULL END,
              send_generation = send_generation + CASE WHEN $10::boolean THEN 1 ELSE 0 END,
              provider_call_started_at = CASE WHEN $10::boolean THEN NULL ELSE provider_call_started_at END
        WHERE id = $1`,
      [job.id, status, fields.error ?? null, fields.logId ?? null, fields.messageId ?? null, iso(now), fields.next ? iso(fields.next) : null,
        fields.providerOutcome ?? null, fields.providerDetail ?? null, !!fields.newGeneration] as never[],
    );
  };
}

/**
 * Lot 72F : envoi annuel bloqué (tâche suspendue, bascule non déclarée) ?
 * État illisible (migration non passée, base indisponible) : les rappels
 * annuels sont RETENUS, les autres e-mails de la file continuent.
 */
async function annualBlock(): Promise<string | null> {
  try {
    const { annualRemindersSendBlock } = await import('@/services/billing/annual-renewal-reminder.service');
    return await annualRemindersSendBlock();
  } catch (e) {
    console.error('[transactional-email] état du rappel annuel illisible — rappels annuels retenus :', (e as Error)?.message ?? e);
    return 'SEND_STATE_UNREADABLE';
  }
}

type ProviderReconciliation =
  | { kind: 'accepted'; messageId: string; via: 'journal' | 'webhook' | 'provider' }
  | { kind: 'absent' }
  | { kind: 'unknown'; detail: string };

/** Lot 76D : bornes de consultation (tests : valeurs réduites). */
export interface ProviderLookupBudget { maxPages?: number; maxCandidates?: number; maxMs?: number }

/**
 * Lot 72F — issue d'un appel au prestataire resté sans réponse connue.
 * Sources, dans l'ordre : journal des envois (réponse reçue mais clôture non
 * écrite), webhooks Resend étiquetés, puis (si `providerLookup`) consultation
 * de la liste des e-mails Resend et de chaque e-mail candidat par son
 * identifiant (étiquette `vb_email_job` = cette demande). Jamais d'envoi ici.
 *
 * Lot 76D — « absent » exige une preuve COMPLÈTE : liste parcourue jusqu'à
 * l'instant de l'appel (complétude de la LISTE) ET toutes les candidates
 * inspectées (complétude de l'INSPECTION) — l'ancienne tranche des 20
 * premières est supprimée. Toute limite atteinte (candidates, pages, durée),
 * réponse inexploitable ou consultation en échec donne `unknown` avec un motif
 * (persisté par l'appelant) : l'acceptation reste incertaine, aucune nouvelle
 * génération de clé, aucune réémission automatique. Une acceptation retrouvée
 * parmi les candidates inspectées reste une preuve, même si la recherche est
 * par ailleurs incomplète.
 */
export async function reconcileProviderCall(
  job: Pick<JobRow, 'id' | 'recipient_email' | 'send_generation' | 'provider_call_started_at'>,
  now: Date,
  opts: { providerLookup: boolean; budget?: ProviderLookupBudget },
): Promise<ProviderReconciliation> {
  const started = job.provider_call_started_at ? new Date(job.provider_call_started_at) : now;
  const [log] = await pgClient.unsafe<{ provider_message_id: string }[]>(
    `SELECT provider_message_id FROM email_logs
      WHERE email_job_id = $1 AND status = 'sent' AND provider_message_id IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [job.id as never],
  );
  if (log) return { kind: 'accepted', messageId: log.provider_message_id, via: 'journal' };
  const [ev] = await pgClient.unsafe<{ provider_message_id: string }[]>(
    `SELECT provider_message_id FROM email_provider_events
      WHERE email_job_id = $1 AND provider_message_id IS NOT NULL
        AND occurred_at >= $2::timestamptz - interval '5 minutes'
      ORDER BY id LIMIT 1`,
    [job.id, iso(started)] as never[],
  );
  if (ev) return { kind: 'accepted', messageId: ev.provider_message_id, via: 'webhook' };
  if (!opts.providerLookup) return { kind: 'unknown', detail: 'NO_EVIDENCE' };

  const maxPages = opts.budget?.maxPages ?? PROVIDER_LIST_MAX_PAGES;
  const maxCandidates = opts.budget?.maxCandidates ?? PROVIDER_LOOKUP_MAX_CANDIDATES;
  const deadline = Date.now() + (opts.budget?.maxMs ?? PROVIDER_LOOKUP_MAX_MS);
  const unknown = (detail: string): ProviderReconciliation => ({ kind: 'unknown', detail: detail.slice(0, 120) });
  const recipient = job.recipient_email.trim().toLowerCase();
  const floor = started.getTime() - 5 * MIN;
  const candidates: string[] = [];
  /** Motif d'une recherche INCOMPLÈTE (null : liste parcourue jusqu'à l'appel). */
  let truncated: string | null = 'RESEND_LISTING_PAGE_LIMIT';
  let after: string | undefined;
  pages: for (let page = 0; page < maxPages; page += 1) {
    if (Date.now() >= deadline) { truncated = 'RESEND_LOOKUP_TIMEOUT:LIST'; break; }
    const r = await emailService.listProviderEmails({ after, limit: 100 });
    if (!r.ok) { truncated = `RESEND_LOOKUP_${r.code}`; break; }
    const items = Array.isArray(r.value?.items) ? r.value.items : null;
    if (!items) { truncated = 'RESEND_LISTING_UNREADABLE'; break; }
    for (const item of items) {
      if (!item?.id) { truncated = 'RESEND_LISTING_UNREADABLE'; break pages; }
      const created = item.createdAt ? new Date(item.createdAt).getTime() : NaN;
      if (Number.isFinite(created) && created < floor) { truncated = null; break pages; }
      const to = (item.to ?? []).map((t) => t.trim().toLowerCase());
      // Destinataire illisible : impossible d'écarter l'e-mail sans l'inspecter.
      if (to.length === 0 || to.includes(recipient)) {
        if (candidates.length >= maxCandidates) { truncated = `RESEND_CANDIDATES_LIMIT:${maxCandidates}`; break pages; }
        candidates.push(item.id);
      }
    }
    if (!r.value.hasMore || items.length === 0) { truncated = null; break; }
    after = items[items.length - 1].id;
  }
  let failure: string | null = null;
  let inspected = 0;
  for (const id of candidates) {
    if (Date.now() >= deadline) { failure = `RESEND_LOOKUP_TIMEOUT:${inspected}/${candidates.length}`; break; }
    const g = await emailService.getProviderEmail(id);
    if (!g.ok) { failure ??= `RESEND_LOOKUP_${g.code}`; continue; }
    // Listé mais introuvable à la consultation : réponse inexploitable.
    if (!g.value) { failure ??= 'RESEND_CANDIDATE_MISSING'; continue; }
    inspected += 1;
    const tags = g.value.tags ?? [];
    const jobTag = tags.find((t) => t.name === EMAIL_JOB_TAG)?.value;
    const genTag = tags.find((t) => t.name === EMAIL_JOB_GENERATION_TAG)?.value;
    if (jobTag === String(job.id) && (genTag == null || genTag === String(job.send_generation))) {
      return { kind: 'accepted', messageId: id, via: 'provider' };
    }
  }
  if (failure) return unknown(failure);
  if (truncated) return unknown(truncated);
  // Liste complète ET toutes les candidates inspectées : seule preuve d'absence admise.
  if (inspected === candidates.length && now.getTime() - started.getTime() >= PROVIDER_LISTING_GRACE_MS) return { kind: 'absent' };
  return unknown('RESEND_LISTING_TOO_RECENT');
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
      WHERE id = $1 AND neutralized_at IS NULL
        AND ((status = 'pending' AND next_attempt_at <= $3::timestamptz)
          OR (status = 'sending' AND locked_until < $3::timestamptz))
      RETURNING id, kind, user_id, duo_id, triggered_by_user_id, recipient_email, context, status, attempts, max_attempts, created_at,
                send_generation, provider_call_started_at, provider_outcome, provider_detail`,
    [jobId, iso(new Date(now.getTime() + EMAIL_JOB_LOCK_MS)), iso(now)] as never[],
  );
  if (!job) return { jobId, status: 'busy' };
  const close = closerFor(job, now);

  // Lot 72F : rappel annuel suspendu (ou bascule non déclarée) — jamais envoyé,
  // demande conservée telle quelle (tentative non consommée).
  const holdAnnual = async (reason: string): Promise<EmailJobOutcome> => {
    const next = new Date(now.getTime() + 5 * MIN);
    await pgClient.unsafe(
      `UPDATE transactional_email_jobs
          SET status = 'pending', attempts = GREATEST(attempts - 1, 0), locked_until = NULL, last_error = $2,
              next_attempt_at = $3::timestamptz, updated_at = $4::timestamptz
        WHERE id = $1`,
      [job.id, reason, iso(next), iso(now)] as never[],
    );
    return { jobId: job.id, status: 'pending', error: reason, nextAttemptAt: iso(next) };
  };

  try {
    if (job.kind === 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER') {
      const block = await annualBlock();
      if (block) return await holdAnnual(block);
    }

    // ── Réconciliation d'un appel précédent sans réponse connue ───────────
    let started = job.provider_call_started_at ? new Date(job.provider_call_started_at) : null;
    let replay = false;
    if (started) {
      const withinWindow = now.getTime() - started.getTime() < PROVIDER_REPLAY_WINDOW_MS;
      const keyUsed = job.provider_detail === 'IDEMPOTENT_KEY_USED';
      const rec = await reconcileProviderCall(job, now, { providerLookup: !withinWindow || keyUsed });
      if (rec.kind === 'accepted') return await acceptReconciled(job, rec, now, close);
      if (rec.kind === 'absent') {
        // Absence constatée chez le prestataire : nouvelle clé, envoi normal.
        await pgClient.unsafe(
          `UPDATE transactional_email_jobs
              SET send_generation = send_generation + 1, provider_call_started_at = NULL,
                  provider_outcome = 'reconciled_absent', provider_detail = NULL, uncertain_since = NULL
            WHERE id = $1`, [job.id as never]);
        job.send_generation += 1;
        job.provider_call_started_at = null;
        started = null;
      } else if (withinWindow && !keyUsed) {
        replay = true; // même clé, même contenu : Resend renvoie la réponse d'origine
      } else {
        await close('uncertain', { error: 'UNCERTAIN_ACCEPTANCE', providerOutcome: 'uncertain', providerDetail: rec.detail });
        console.error(`[transactional-email] ${job.kind} #${job.id} : acceptation incertaine non résolue (${rec.detail}) — réémission bloquée, décision BO requise`);
        return { jobId: job.id, status: 'uncertain', error: 'UNCERTAIN_ACCEPTANCE' };
      }
    }

    if (job.attempts > job.max_attempts) {
      if (replay) {
        await close('uncertain', { error: 'UNCERTAIN_ACCEPTANCE', providerOutcome: 'uncertain', providerDetail: job.provider_detail });
        return { jobId: job.id, status: 'uncertain', error: 'UNCERTAIN_ACCEPTANCE' };
      }
      await close('failed', { error: 'MAX_ATTEMPTS' });
      return { jobId: job.id, status: 'failed', error: 'MAX_ATTEMPTS' };
    }
    // Réémission d'un appel incertain : contenu figé à l'instant de cet appel.
    const contentAt = replay && started ? started : now;
    const built = job.kind === 'EMAIL_VERIFICATION' ? await buildVerification(job, now, contentAt)
      : job.kind === 'DUO_MEMBERSHIP_ENDED' || job.kind === 'DUO_MEMBERSHIP_LEFT' ? await buildDuoMembershipEnded(job)
      : job.kind === 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER' ? await buildAnnualRenewal(job, now, contentAt)
      : job.kind === 'DUO_INVITATION' ? await buildDuoInvitation(job, now)
      : job.kind === 'DUO_INVITATION_DECLINED' ? await buildDuoInvitationDeclined(job)
      : job.kind === 'PREMIUM_CONFIRMATION' ? await buildPremiumConfirmation(job)
      : job.kind === 'DOWNGRADE_NOTIFICATION' ? await buildDowngradeNotification(job)
      : ({ ok: false, reason: 'UNKNOWN_KIND' } as Built);
    if (!built.ok && built.temporary) {
      return await failed(job, built.reason, null, now, close);
    }
    if (!built.ok) {
      // Un appel antérieur incertain reste signalé (provider_outcome) : jamais compté envoyé.
      await close('cancelled', { error: built.reason });
      return { jobId: job.id, status: 'cancelled', error: built.reason };
    }
    // Dernier contrôle de la suspension, juste avant l'envoi.
    if (job.kind === 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER') {
      const block = await annualBlock();
      if (block) return await holdAnnual(block);
    }
    const to = built.to ?? job.recipient_email;
    const res = await emailService.send({
      templateCode: built.templateCode,
      to: built.to ?? job.recipient_email,
      variables: built.variables,
      userId: built.recipientUserId ?? undefined,
      triggeredByUserId: built.triggeredByUserId,
      idempotencyKey: emailJobIdempotencyKey(job.id, job.send_generation),
      tags: [{ name: EMAIL_JOB_TAG, value: String(job.id) }, { name: EMAIL_JOB_GENERATION_TAG, value: String(job.send_generation) }],
      emailJobId: job.id,
      beforeProviderCall: async () => {
        await pgClient.unsafe(
          `UPDATE transactional_email_jobs
              SET provider_call_started_at = COALESCE(provider_call_started_at, $2::timestamptz), recipient_email = $3
            WHERE id = $1`,
          [job.id, iso(now), to] as never[],
        );
      },
    });
    if (res?.success) {
      // Clôture et effets de l'acceptation : une seule transaction (61B).
      await pgClient.begin(async (tx) => {
        const exec = tx as unknown as Exec;
        await close('accepted', { logId: res.logId ?? null, messageId: res.providerMessageId ?? null, providerOutcome: 'accepted' }, exec);
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
    // Lot 79C : e-mail supprimé — clos sans reprise, jamais compté envoyé.
    if (res?.error === 'COMMUNICATION_RETIRED') {
      await close('cancelled', { error: 'COMMUNICATION_RETIRED', logId: res.logId ?? null });
      return { jobId: job.id, status: 'cancelled', error: 'COMMUNICATION_RETIRED' };
    }
    const detail = res?.providerCode === 'invalid_idempotent_request' ? 'IDEMPOTENT_KEY_USED'
      : `${res?.providerCode ?? (res?.providerCalled ? 'NETWORK' : 'LOCAL')}${res?.providerStatus ? `:${res.providerStatus}` : ''}`.slice(0, 120);
    // Lot 72F : réponse perdue, 5xx, 409 d'idempotence — ou refus d'une RÉÉMISSION
    // (n'efface pas l'incertitude de l'appel d'origine) : incertain, même clé.
    if (res?.uncertain || (res?.providerCalled && replay)) {
      return await uncertainAttempt(job, res?.error ?? 'réponse inconnue', detail, res?.logId ?? null, now, close);
    }
    // Refus CONFIRMÉ d'un premier appel avec cette clé : génération suivante.
    return await failed(job, res?.error ?? 'Échec d’envoi (cause inconnue)', res?.logId ?? null, now, close,
      res?.providerCalled ? { providerOutcome: 'rejected', providerDetail: detail, newGeneration: true } : {});
  } catch (e) {
    return failed(job, (e as Error)?.message ?? String(e), null, now, close);
  }
}

/** Lot 72F : acceptation établie par réconciliation (jamais d'envoi). */
async function acceptReconciled(job: JobRow, rec: Extract<ProviderReconciliation, { kind: 'accepted' }>, now: Date, close: Close): Promise<EmailJobOutcome> {
  let logId: number | null = null;
  if (rec.via !== 'journal') {
    // Ligne d'envoi « accepté » : suivi de livraison (webhooks) et BO.
    const [row] = await pgClient.unsafe<{ id: number }[]>(
      `INSERT INTO email_logs (template_code, recipient_email, recipient_user_id, email_job_id, subject, status, error_message, sent_at,
                               provider_message_id, delivery_status, delivery_status_at)
       SELECT $1, $2, $3, $4, $5, 'sent', $6, $7::timestamptz, $8, 'accepted', $7::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM email_logs WHERE provider_message_id = $8)
       RETURNING id`,
      [job.kind, job.recipient_email, job.user_id, job.id, `[Réconcilié] ${job.kind}`,
        `Acceptation établie par réconciliation (${rec.via === 'webhook' ? 'webhook Resend' : 'consultation Resend'})`, iso(now), rec.messageId] as never[],
    );
    logId = row?.id ?? null;
    try {
      const { replayStoredProviderEvents } = await import('@/services/email/email-provider-events.service');
      await replayStoredProviderEvents(rec.messageId);
    } catch { /* suivi de livraison seulement */ }
  }
  const onAccepted = job.kind === 'DUO_INVITATION' ? (await buildDuoInvitation(job, now).catch(() => null)) : null;
  await pgClient.begin(async (tx) => {
    const exec = tx as unknown as Exec;
    await close('accepted', { logId, messageId: rec.messageId, providerOutcome: 'reconciled', providerDetail: rec.via }, exec);
    if (onAccepted?.ok) await onAccepted.onAccepted?.(now, exec);
  });
  return { jobId: job.id, status: 'accepted' };
}

/** Lot 72F : acceptation incertaine — même clé à la tentative suivante, jamais « échec confirmé ». */
async function uncertainAttempt(job: JobRow, error: string, detail: string, logId: number | null, now: Date, close: Close): Promise<EmailJobOutcome> {
  console.error(`[transactional-email] ${job.kind} #${job.id} tentative ${job.attempts}/${job.max_attempts} : acceptation incertaine (${detail})`);
  if (job.attempts >= job.max_attempts) {
    await close('uncertain', { error: 'UNCERTAIN_ACCEPTANCE', logId, providerOutcome: 'uncertain', providerDetail: detail });
    return { jobId: job.id, status: 'uncertain', error: 'UNCERTAIN_ACCEPTANCE' };
  }
  const next = new Date(now.getTime() + emailJobBackoffMs(job.attempts));
  await close('pending', { error: `UNCERTAIN: ${error}`.slice(0, 500), logId, next, providerOutcome: 'uncertain', providerDetail: detail });
  return { jobId: job.id, status: 'pending', error: `UNCERTAIN: ${error}`.slice(0, 500), nextAttemptAt: iso(next) };
}

async function failed(
  job: JobRow,
  error: string,
  logId: number | null,
  now: Date,
  close: Close,
  provider: Pick<CloseFields, 'providerOutcome' | 'providerDetail' | 'newGeneration'> = {},
): Promise<EmailJobOutcome> {
  console.error(`[transactional-email] ${job.kind} #${job.id} tentative ${job.attempts}/${job.max_attempts} échouée : ${error}`);
  if (job.attempts >= job.max_attempts) {
    await close('failed', { error, logId, ...provider });
    return { jobId: job.id, status: 'failed', error };
  }
  const next = new Date(now.getTime() + emailJobBackoffMs(job.attempts));
  await close('pending', { error, logId, next, ...provider });
  return { jobId: job.id, status: 'pending', error, nextAttemptAt: iso(next) };
}

/**
 * Tâche planifiée `transactional-emails-retry` : demandes dues ou
 * interrompues, par lots, jusqu'à l'échéance. Idempotente (prise atomique).
 */
export async function runTransactionalEmailRetry(opts: { deadline?: number; now?: () => Date; limit?: number } = {}): Promise<{ processed: number; accepted: number; pending: number; failed: number; cancelled: number; uncertain: number }> {
  const clock = opts.now ?? (() => new Date());
  const deadline = opts.deadline ?? Date.now() + 50_000;
  const at = clock();
  // Lot 72F : rappels annuels suspendus écartés de la sélection — ils ne
  // prennent jamais la place des autres e-mails de la file.
  const annualBlocked = (await annualBlock()) !== null;
  const due = await pgClient.unsafe<{ id: number }[]>(
    `SELECT id FROM transactional_email_jobs
      WHERE ((status = 'pending' AND next_attempt_at <= $1::timestamptz)
          OR (status = 'sending' AND locked_until < $1::timestamptz))
        AND NOT ($3::boolean AND kind = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER')
        AND neutralized_at IS NULL
      ORDER BY next_attempt_at, id LIMIT $2`,
    [iso(at), opts.limit ?? 50, annualBlocked] as never[],
  );
  const total = { processed: 0, accepted: 0, pending: 0, failed: 0, cancelled: 0, uncertain: 0 };
  // Rétention : demandes closes depuis plus de 30 jours (le détail des
  // envois reste dans `email_logs`). Lot borné, idempotent. Lot 76D : les
  // demandes neutralisées par un retour arrière sont conservées (preuves et
  // incertitudes d'acceptation, jamais effacées).
  await pgClient.unsafe(
    `DELETE FROM transactional_email_jobs WHERE id IN (
       SELECT id FROM transactional_email_jobs
        WHERE status IN ('accepted', 'failed', 'cancelled') AND updated_at < $1::timestamptz
          AND neutralized_at IS NULL LIMIT 500)`,
    [iso(new Date(at.getTime() - 30 * 24 * 60 * MIN))] as never[],
  );
  for (const { id } of due) {
    if (Date.now() >= deadline) break;
    const r = await processEmailJob(id, clock());
    if (r.status === 'busy') continue;
    total.processed += 1;
    if (r.status === 'accepted' || r.status === 'pending' || r.status === 'failed' || r.status === 'cancelled' || r.status === 'uncertain') total[r.status] += 1;
  }
  return total;
}

// ── Lot 76D : demandes neutralisées par le retour aux rappels Stripe ─────────

type NeutralizedOutcome = 'busy' | 'accepted' | 'neutralized' | 'uncertain';

/**
 * Lot 76D — qualification d'une demande NEUTRALISÉE (retour arrière en cours),
 * sans jamais rien émettre : la neutralisation arrête l'émission, cette
 * fonction qualifie l'appel déjà effectué.
 *   · prise atomique (verrou de tentative) : jamais deux contrôles simultanés ;
 *     un verrou expiré (arrêt du processus) est repris ICI, jamais par la file ;
 *   · aucun appel transmis avec la génération courante → close « annulée,
 *     neutralisée » (aucun envoi) ;
 *   · appel transmis → réconciliation par consultation SEULE (journal,
 *     webhooks, Resend) : acceptée (échéance notifiée), absence PROUVÉE
 *     (neutralisée sans envoi), sinon acceptation incertaine conservée (motif,
 *     nouvelle consultation dans 15 min ; décision BO possible, hors réémission).
 */
export async function reconcileNeutralizedEmailJob(jobId: number, now: Date = new Date(), budget?: ProviderLookupBudget): Promise<NeutralizedOutcome> {
  const [job] = await pgClient.unsafe<JobRow[]>(
    `UPDATE transactional_email_jobs
        SET status = 'sending', locked_until = $2::timestamptz, updated_at = $3::timestamptz
      WHERE id = $1 AND neutralized_at IS NOT NULL
        AND (status IN ('pending', 'failed')
          OR (status = 'uncertain' AND next_attempt_at <= $3::timestamptz)
          OR (status = 'sending' AND locked_until < $3::timestamptz))
      RETURNING id, kind, user_id, duo_id, triggered_by_user_id, recipient_email, context, status, attempts, max_attempts, created_at,
                send_generation, provider_call_started_at, provider_outcome, provider_detail, neutralized_at`,
    [jobId, iso(new Date(now.getTime() + EMAIL_JOB_LOCK_MS)), iso(now)] as never[],
  );
  if (!job) return 'busy';
  const close = closerFor(job, now);
  const keepUncertain = async (detail: string | null): Promise<NeutralizedOutcome> => {
    await close('uncertain', { error: 'ROLLBACK_UNCERTAIN', providerOutcome: 'uncertain', providerDetail: detail ?? job.provider_detail ?? 'ROLLBACK_CALL_UNRESOLVED', next: new Date(now.getTime() + NEUTRALIZED_RECHECK_MS) });
    return 'uncertain';
  };
  try {
    if (!job.provider_call_started_at) {
      // Jamais transmise avec cette génération. Une incertitude antérieure (sans
      // instant d'appel connu) n'est jamais présumée levée.
      if (job.provider_outcome === 'uncertain') return await keepUncertain(job.provider_detail);
      await close('cancelled', { error: 'ROLLBACK_NEUTRALIZED' });
      return 'neutralized';
    }
    const rec = await reconcileProviderCall(job, now, { providerLookup: true, budget });
    if (rec.kind === 'accepted') { await acceptReconciled(job, rec, now, close); return 'accepted'; }
    if (rec.kind === 'absent') {
      await close('cancelled', { error: 'ROLLBACK_NEUTRALIZED', providerOutcome: 'reconciled_absent', providerDetail: null });
      return 'neutralized';
    }
    return await keepUncertain(rec.detail);
  } catch (e) {
    console.error(`[transactional-email] demande neutralisée #${job.id} : contrôle impossible —`, (e as Error)?.message ?? e);
    return await keepUncertain('ROLLBACK_CHECK_FAILED');
  }
}

// ── Lot 72F : acceptations incertaines non résolues (BO) ────────────────────

type EmailJobDecision = 'RECHECK' | 'CONFIRM_SENT' | 'REISSUE' | 'ABANDON';
export const EMAIL_JOB_DECISIONS: readonly EmailJobDecision[] = ['RECHECK', 'CONFIRM_SENT', 'REISSUE', 'ABANDON'];

/**
 * Décision d'un administrateur sur une demande `uncertain` (après examen du
 * tableau de bord Resend) :
 *   · RECHECK      nouvelle réconciliation (jamais d'envoi sans preuve d'absence
 *                  ou dans la fenêtre d'idempotence avec la même clé) ;
 *   · CONFIRM_SENT e-mail trouvé chez Resend : clos « accepté » (confirmé par
 *                  l'administrateur — jamais « livré ») ;
 *   · REISSUE      e-mail absent chez Resend : nouvelle clé, nouvel envoi ;
 *   · ABANDON      clos sans envoi (définitif).
 */
export async function decideUncertainEmailJob(jobId: number, decision: EmailJobDecision, now: Date = new Date()): Promise<{ ok: true; status: EmailJobStatus } | { ok: false; code: 'NOT_FOUND' | 'NOT_UNCERTAIN' | 'NEUTRALIZED' }> {
  const [row] = await pgClient.unsafe<{ status: string; neutralized: boolean }[]>(
    `SELECT status, neutralized_at IS NOT NULL AS neutralized FROM transactional_email_jobs WHERE id = $1`, [jobId as never]);
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  if (row.status !== 'uncertain') return { ok: false, code: 'NOT_UNCERTAIN' };
  // Lot 76D : demande neutralisée par le retour aux rappels Stripe — jamais
  // réémise (RECHECK = consultation seule, par le contrôle du retour arrière).
  if (row.neutralized && decision === 'REISSUE') return { ok: false, code: 'NEUTRALIZED' };
  const sets: Record<EmailJobDecision, { status: EmailJobStatus; sql: string }> = {
    RECHECK: { status: 'pending', sql: `status = 'pending', attempts = 0, next_attempt_at = $2::timestamptz, last_error = 'ADMIN_RECHECK'` },
    CONFIRM_SENT: { status: 'accepted', sql: `status = 'accepted', accepted_at = $2::timestamptz, provider_outcome = 'admin_confirmed', last_error = 'ADMIN_CONFIRMED_SENT', uncertain_since = NULL` },
    REISSUE: { status: 'pending', sql: `status = 'pending', attempts = 0, next_attempt_at = $2::timestamptz, send_generation = send_generation + 1,
                                        provider_call_started_at = NULL, provider_outcome = 'admin_reissue', provider_detail = NULL,
                                        uncertain_since = NULL, last_error = 'ADMIN_REISSUE'` },
    ABANDON: { status: 'cancelled', sql: `status = 'cancelled', last_error = 'ADMIN_ABANDONED'` },
  };
  const d = sets[decision];
  const done = await pgClient.unsafe<{ id: number }[]>(
    `UPDATE transactional_email_jobs SET ${d.sql}, locked_until = NULL, updated_at = $2::timestamptz
      WHERE id = $1 AND status = 'uncertain' ${decision === 'REISSUE' ? 'AND neutralized_at IS NULL' : ''} RETURNING id`,
    [jobId, iso(now)] as never[],
  );
  return done.length ? { ok: true, status: d.status } : { ok: false, code: 'NOT_UNCERTAIN' };
}

// ── Lecture (titulaire Duo, BO) ──────────────────────────────────────────────

interface DuoInvitationEmailState {
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
