/**
 * BO › Communications › E-mails transactionnels — suivi des envois (lot 57A,
 * ticket P0 e-mails, volet E « Back-Office »).
 *
 * Recherche par type de message (gabarit) et destinataire ; pour chaque
 * tentative : statut d'envoi (`status`, sens inchangé), état de LIVRAISON
 * (webhooks Resend), cause technique, identifiant Resend, demande durable
 * (tentatives, prochaine reprise). Les demandes enregistrées mais pas encore
 * tentées sont listées à part (« demande d'envoi enregistrée »).
 *
 * JAMAIS de jeton : ni `metadata` (variables, liens d'action), ni contexte de
 * la demande ne sont renvoyés. Réservé aux administrateurs (route).
 */
import { pgClient } from '@/db';

export interface TransactionalEmailSearch {
  type?: string | null;
  recipient?: string | null;
  problemsOnly?: boolean;
  limit?: number;
}

export interface TransactionalEmailLogRow {
  id: number;
  at: string | null;
  templateCode: string;
  recipientEmail: string;
  recipientUserId: number | null;
  triggeredByUserId: number | null;
  status: string;
  errorMessage: string | null;
  providerMessageId: string | null;
  deliveryStatus: string | null;
  deliveryStatusAt: string | null;
  deliveredAt: string | null;
  deliveryError: string | null;
  job: { id: number; status: string; attempts: number; maxAttempts: number; nextAttemptAt: string | null } | null;
}

export interface PendingEmailRequestRow {
  jobId: number;
  kind: string;
  recipientEmail: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string | null;
}

const PROBLEM_DELIVERY = ['bounced', 'complained', 'failed', 'suppressed', 'delivery_delayed'];
const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);

/** Filtres normalisés (pur) : type en majuscules, destinataire échappé pour LIKE. */
export function normalizeEmailSearch(q: TransactionalEmailSearch): { type: string | null; like: string | null; problemsOnly: boolean; limit: number } {
  const type = q.type?.trim() ? q.type.trim().toUpperCase().slice(0, 100) : null;
  const r = q.recipient?.trim().toLowerCase().slice(0, 200) ?? '';
  const like = r ? `%${r.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 50) || 50, 1), 200);
  return { type, like, problemsOnly: !!q.problemsOnly, limit };
}

/**
 * Lot 68C — demandes CLOSES SANS ENVOI (annulées avec motif, ou échouées) des
 * 30 derniers jours : un rappel annulé (abonnement résilié entre-temps, date
 * changée, e-mail désactivé…) n'a parfois aucune ligne d'envoi ; son motif
 * doit rester consultable depuis le BO, jamais présenté comme envoyé.
 */
export interface ClosedEmailRequestRow {
  jobId: number;
  kind: string;
  recipientEmail: string;
  status: 'failed' | 'cancelled';
  attempts: number;
  reason: string | null;
  updatedAt: string | null;
}

export async function searchTransactionalEmails(q: TransactionalEmailSearch): Promise<{ logs: TransactionalEmailLogRow[]; pendingRequests: PendingEmailRequestRow[]; closedRequests: ClosedEmailRequestRow[] }> {
  const f = normalizeEmailSearch(q);
  const rows = await pgClient.unsafe<Record<string, unknown>[]>(
    `SELECT l.id, l.sent_at, l.template_code, l.recipient_email, l.recipient_user_id, l.triggered_by_user_id, l.status,
            l.error_message, l.provider_message_id, l.delivery_status, l.delivery_status_at, l.delivered_at, l.delivery_error,
            j.id AS job_id, j.status AS job_status, j.attempts, j.max_attempts, j.next_attempt_at
       FROM email_logs l
       LEFT JOIN transactional_email_jobs j ON j.id = l.email_job_id
      WHERE ($1::text IS NULL OR upper(l.template_code) = $1)
        AND ($2::text IS NULL OR lower(l.recipient_email) LIKE $2)
        AND (NOT $3::boolean OR l.status = 'failed' OR l.delivery_status = ANY($4::text[]))
      ORDER BY l.sent_at DESC NULLS LAST, l.id DESC
      LIMIT $5`,
    [f.type, f.like, f.problemsOnly, PROBLEM_DELIVERY, f.limit] as never[],
  );
  // Lot 72F : acceptations incertaines (bloquées) listées avec les demandes non acceptées.
  const pending = await pgClient.unsafe<Record<string, unknown>[]>(
    `SELECT id, kind, recipient_email, status, attempts, max_attempts, next_attempt_at, last_error, created_at
       FROM transactional_email_jobs
      WHERE status IN ('pending', 'sending', 'uncertain')
        AND ($1::text IS NULL OR kind = $1)
        AND ($2::text IS NULL OR lower(recipient_email) LIKE $2)
      ORDER BY next_attempt_at LIMIT 50`,
    [f.type, f.like] as never[],
  );
  const closed = await pgClient.unsafe<Record<string, unknown>[]>(
    `SELECT id, kind, recipient_email, status, attempts, last_error, updated_at
       FROM transactional_email_jobs
      WHERE status IN ('failed', 'cancelled')
        AND updated_at > now() - interval '30 days'
        AND ($1::text IS NULL OR kind = $1)
        AND ($2::text IS NULL OR lower(recipient_email) LIKE $2)
      ORDER BY updated_at DESC LIMIT 50`,
    [f.type, f.like] as never[],
  );
  return {
    closedRequests: closed.map((r) => ({
      jobId: Number(r.id),
      kind: String(r.kind),
      recipientEmail: String(r.recipient_email),
      status: String(r.status) as 'failed' | 'cancelled',
      attempts: Number(r.attempts),
      reason: (r.last_error as string | null) ?? null,
      updatedAt: iso(r.updated_at as string | null),
    })),
    logs: rows.map((r) => ({
      id: Number(r.id),
      at: iso(r.sent_at as string | null),
      templateCode: String(r.template_code),
      recipientEmail: String(r.recipient_email),
      recipientUserId: (r.recipient_user_id as number | null) ?? null,
      triggeredByUserId: (r.triggered_by_user_id as number | null) ?? null,
      status: String(r.status),
      errorMessage: (r.error_message as string | null) ?? null,
      providerMessageId: (r.provider_message_id as string | null) ?? null,
      deliveryStatus: (r.delivery_status as string | null) ?? null,
      deliveryStatusAt: iso(r.delivery_status_at as string | null),
      deliveredAt: iso(r.delivered_at as string | null),
      deliveryError: (r.delivery_error as string | null) ?? null,
      job: r.job_id == null ? null : {
        id: Number(r.job_id), status: String(r.job_status), attempts: Number(r.attempts),
        maxAttempts: Number(r.max_attempts), nextAttemptAt: iso(r.next_attempt_at as string | null),
      },
    })),
    pendingRequests: pending.map((r) => ({
      jobId: Number(r.id),
      kind: String(r.kind),
      recipientEmail: String(r.recipient_email),
      status: String(r.status),
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      nextAttemptAt: iso(r.next_attempt_at as string | null),
      lastError: (r.last_error as string | null) ?? null,
      createdAt: iso(r.created_at as string | null),
    })),
  };
}

// ── Configuration d'envoi effective (lecture seule) ─────────────────────────

export interface TransactionalEmailConfig {
  /** `base` : ligne `email_settings` ; `defaut` : valeurs de repli du code (aucune ligne). */
  source: 'base' | 'defaut';
  emailsEnabled: boolean;
  senderName: string;
  senderEmail: string;
  senderDomain: string;
  replyToEmail: string;
  apiKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  /** Gabarits indispensables présents en base. */
  templates: Record<string, boolean>;
  lastWebhookAt: string | null;
}

const REQUIRED_TEMPLATES = ['EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT', 'DUO_INVITATION_DECLINED', 'PASSWORD_RESET', 'WELCOME', 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER'];

/**
 * Lot 57A — ce que le diagnostic exige de vérifier SANS SQL : expéditeur
 * réellement utilisé (et son domaine, à comparer au domaine vérifié chez
 * Resend), e-mails activés, clé et secret de webhook PRÉSENTS (jamais leur
 * valeur), gabarits indispensables, dernier webhook reçu.
 */
export async function getTransactionalEmailConfig(env: Record<string, string | undefined> = process.env): Promise<TransactionalEmailConfig> {
  const [row] = await pgClient.unsafe<{ emails_enabled: boolean; sender_name: string; sender_email: string; reply_to_email: string }[]>(
    `SELECT emails_enabled, sender_name, sender_email, reply_to_email FROM email_settings WHERE id = 1`,
  );
  // Mêmes valeurs de repli que `email-service.ts` (getSettings).
  const s = row ?? { emails_enabled: true, sender_name: 'Verebona', sender_email: 'noreply@verebona.com', reply_to_email: 'support@verebona.com' };
  const present = await pgClient.unsafe<{ code: string }[]>(
    `SELECT DISTINCT upper(type) AS code FROM email_templates WHERE upper(type) = ANY($1::text[])`, [REQUIRED_TEMPLATES] as never[],
  );
  const [hook] = await pgClient.unsafe<{ at: string | null }[]>(`SELECT max(received_at) AS at FROM email_provider_events`);
  const codes = new Set(present.map((p) => p.code));
  return {
    source: row ? 'base' : 'defaut',
    emailsEnabled: !!s.emails_enabled,
    senderName: s.sender_name,
    senderEmail: s.sender_email,
    senderDomain: (s.sender_email.split('@')[1] ?? '').toLowerCase(),
    replyToEmail: s.reply_to_email,
    apiKeyConfigured: !!env.RESEND_API_KEY,
    webhookSecretConfigured: !!env.RESEND_WEBHOOK_SECRET,
    templates: Object.fromEntries(REQUIRED_TEMPLATES.map((t) => [t, codes.has(t)])),
    lastWebhookAt: iso(hook?.at ?? null),
  };
}

// ── Correction de l'expéditeur depuis le BO (lot 61B) ───────────────────────

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 61B — AUDIT DU TICKET P0 E-MAILS, ÉCART RÉSIDUEL §3-A
 *
 * « Corriger la cause établie » : quand le diagnostic (configuration d'envoi
 * effective ci-dessus, docs/exploitation/emails-delivrabilite.md) établit que
 * l'expéditeur n'est pas sur le domaine vérifié chez Resend, sa correction
 * exigeait du SQL (`email_settings`, aucun écran) — interdit en exploitation.
 * Champs modifiables : nom et adresse d'expédition, adresse de réponse,
 * activation globale. Validés (adresse simple, aucun retour à la ligne : pas
 * d'injection d'en-tête), adresse en minuscules ; ligne `id = 1` créée si
 * absente (valeurs par défaut du code sinon). Aucun secret ici (clé et secret
 * de webhook restent des variables d'environnement).
 * ══════════════════════════════════════════════════════════════════════════
 */
export interface EmailSettingsPatch {
  senderName?: string;
  senderEmail?: string;
  replyToEmail?: string;
  emailsEnabled?: boolean;
}

const EMAIL_SETTINGS_FIELDS = new Set(['senderName', 'senderEmail', 'replyToEmail', 'emailsEnabled']);
const SIMPLE_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** Validation (pure) : corps normalisé, ou liste des champs refusés. */
export function validateEmailSettingsPatch(body: unknown): { ok: true; patch: EmailSettingsPatch } | { ok: false; rejected: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, rejected: ['body'] };
  const b = body as Record<string, unknown>;
  const rejected = Object.keys(b).filter((k) => !EMAIL_SETTINGS_FIELDS.has(k));
  const patch: EmailSettingsPatch = {};
  if ('senderName' in b) {
    const v = typeof b.senderName === 'string' ? b.senderName.trim() : '';
    if (!v || v.length > 100 || /[\r\n<>"]/.test(v)) rejected.push('senderName'); else patch.senderName = v;
  }
  for (const k of ['senderEmail', 'replyToEmail'] as const) {
    if (!(k in b)) continue;
    const v = typeof b[k] === 'string' ? (b[k] as string).trim().toLowerCase() : '';
    if (v.length > 254 || !SIMPLE_EMAIL.test(v)) rejected.push(k); else patch[k] = v;
  }
  if ('emailsEnabled' in b) {
    if (typeof b.emailsEnabled !== 'boolean') rejected.push('emailsEnabled'); else patch.emailsEnabled = b.emailsEnabled;
  }
  if (rejected.length) return { ok: false, rejected };
  if (Object.keys(patch).length === 0) return { ok: false, rejected: ['body'] };
  return { ok: true, patch };
}

type SettingsSnapshot = { senderName: string; senderEmail: string; replyToEmail: string; emailsEnabled: boolean };

/** Applique la correction ; renvoie l'avant / après (audit). */
export async function updateTransactionalEmailSettings(patch: EmailSettingsPatch, adminId: number): Promise<{ before: SettingsSnapshot; after: SettingsSnapshot }> {
  const current = await getTransactionalEmailConfig();
  const before: SettingsSnapshot = { senderName: current.senderName, senderEmail: current.senderEmail, replyToEmail: current.replyToEmail, emailsEnabled: current.emailsEnabled };
  const after: SettingsSnapshot = { ...before, ...patch };
  await pgClient.unsafe(
    `INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email, updated_at, updated_by)
     VALUES (1, $1, $2, $3, $4, now(), $5)
     ON CONFLICT (id) DO UPDATE SET emails_enabled = $1, sender_name = $2, sender_email = $3, reply_to_email = $4,
                                    updated_at = now(), updated_by = $5`,
    [after.emailsEnabled, after.senderName, after.senderEmail, after.replyToEmail, adminId] as never[],
  );
  return { before, after };
}
