/**
 * Lot 100G — exécution de la séquence de fin d'essai (tâche planifiée
 * `trial-lifecycle-emails`, catalogue des tâches internes).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * À CHAQUE PASSAGE (idempotent, rejouable, sûr en double exécution)
 *
 *   1. Pour chaque jalon, les essais dont la date du jalon est ATTEINTE et
 *      dont la fenêtre de rattrapage est ouverte (ou fermée depuis moins de
 *      7 jours, pour tracer « hors fenêtre ») — jamais au-delà.
 *   2. Un message par compte × fin d'essai × jalon (clé unique en base) ; il
 *      est PRIS atomiquement (UPDATE conditionnel) : deux passages simultanés
 *      ne traitent jamais le même message.
 *   3. L'ÉTAT ACTUEL est relu juste avant l'envoi (`decideMessage`) :
 *      souscription, paiement en cours, compte supprimé / suspendu,
 *      opposition, doublon (y compris l'ancien circuit des notifications),
 *      fenêtre, réglages BO, coupures, consentement, verrou J+80.
 *   4. Envoi par `EmailService` (journal `email_logs`), clé d'idempotence
 *      STABLE chez le prestataire (une reprise ne double jamais un e-mail
 *      accepté), au plus 3 tentatives dans la fenêtre.
 *   5. Journal auditable (`trial_lifecycle_events`) : envoi (modèle et
 *      version), échec, non-envoi motivé, blocage, puis conversions.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  MAX_SEND_ATTEMPTS, MILESTONES, OUT_OF_WINDOW_EVIDENCE_DAYS, STALE_SENDING_MS, TRIAL_RETENTION_PURGE_IMPLEMENTED,
  decideMessage, dueAtOf, envSwitches, offsetDaysOf, windowEndOf,
  type CurrentState, type Decision, type DecisionEnv, type MilestoneDef, type TrialLifecycleSettings,
} from './milestones';
import {
  appBaseUrl, buildExportUrl, buildOffersUrl, buildOneClickUnsubscribeUrl, buildUnsubscribeUrl, formatParisDay, formatTrialDate, unsubscribeSecret,
} from './links';
import { loadTrialLifecycleSettings } from './settings.service';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export interface TrialLifecycleRunResult {
  examined: number;
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
  blocked: number;
  conversions: number;
  /** Passage interrompu par l'échéance (reste à traiter au suivant). */
  more: boolean;
}

/** Envoi (injectable pour les tests unitaires ; par défaut `EmailService.send`). */
export type TrialEmailSender = (o: {
  templateCode: string; to: string; variables: Record<string, string>; userId: number;
  idempotencyKey: string; tags: Array<{ name: string; value: string }>; headers?: Record<string, string>;
}) => Promise<{ success: boolean; error?: string; logId?: number; providerMessageId?: string | null; uncertain?: boolean }>;

async function defaultSender(o: Parameters<TrialEmailSender>[0]) {
  const { emailService } = await import('@/lib/email/email-service');
  // Activation du canal contrôlée AVANT (motif tracé) : pas de second contrôle.
  return emailService.send({ ...o, skipChannelCheck: true });
}

interface Candidate { accountId: number; trialEndsAt: Date; ownerUserId: number }

/** Essais dont le jalon est dû (fenêtre ouverte, ou fermée depuis ≤ 7 jours). */
async function candidatesFor(m: MilestoneDef, s: TrialLifecycleSettings, now: Date, accountIds?: number[]): Promise<Candidate[]> {
  const offsetMs = offsetDaysOf(m, s) * DAY;
  const hi = new Date(now.getTime() - offsetMs);
  const lo = new Date(now.getTime() - offsetMs - s.catchUpHours[m.code] * HOUR - OUT_OF_WINDOW_EVIDENCE_DAYS * DAY);
  const rows = await pgClient<{ account_id: number; trial_ends_at: Date; owner_user_id: number }[]>`
    SELECT sub.account_id, sub.trial_ends_at, a.owner_user_id
      FROM account_subscriptions sub
      JOIN accounts a ON a.id = sub.account_id
      LEFT JOIN trial_lifecycle_messages msg
        ON msg.account_id = sub.account_id AND msg.trial_ends_at = sub.trial_ends_at AND msg.milestone = ${m.code}
     WHERE sub.trial_ends_at IS NOT NULL AND sub.trial_started_at IS NOT NULL
       AND sub.trial_ends_at <= ${hi.toISOString()} AND sub.trial_ends_at >= ${lo.toISOString()}
       ${accountIds ? pgClient`AND sub.account_id IN ${pgClient(accountIds.length ? accountIds : [-1])}` : pgClient``}
       AND (msg.id IS NULL
            OR msg.status IN ('pending', 'deferred', 'blocked')
            OR (msg.status = 'failed' AND msg.attempt_count < ${MAX_SEND_ATTEMPTS})
            OR (msg.status = 'sending' AND msg.claimed_at < ${new Date(now.getTime() - STALE_SENDING_MS).toISOString()}))
     ORDER BY sub.trial_ends_at, sub.account_id
     LIMIT 500`;
  return rows.map((r) => ({ accountId: r.account_id, trialEndsAt: new Date(r.trial_ends_at), ownerUserId: r.owner_user_id }));
}

interface ClaimedMessage { id: number; prevStatus: string; prevReason: string | null; attemptCount: number }

/** Crée le message s'il n'existe pas, puis le PREND (atomique). null : déjà pris ou clos. */
async function ensureAndClaim(c: Candidate, m: MilestoneDef, s: TrialLifecycleSettings, now: Date): Promise<ClaimedMessage | null> {
  await pgClient`
    INSERT INTO trial_lifecycle_messages (account_id, user_id, trial_ends_at, milestone, nature, template_code, status, due_at, window_ends_at, created_at, updated_at)
    VALUES (${c.accountId}, ${c.ownerUserId}, ${c.trialEndsAt.toISOString()}, ${m.code}, ${m.nature}, ${m.templateCode}, 'pending',
            ${dueAtOf(c.trialEndsAt, m, s).toISOString()}, ${windowEndOf(c.trialEndsAt, m, s).toISOString()}, ${now.toISOString()}, ${now.toISOString()})
    ON CONFLICT (account_id, trial_ends_at, milestone) DO NOTHING`;
  const stale = new Date(now.getTime() - STALE_SENDING_MS).toISOString();
  const [row] = await pgClient<{ id: number; prev_status: string; prev_reason: string | null; attempt_count: number }[]>`
    WITH prev AS (
      SELECT id, status, reason FROM trial_lifecycle_messages
       WHERE account_id = ${c.accountId} AND trial_ends_at = ${c.trialEndsAt.toISOString()} AND milestone = ${m.code}
    )
    UPDATE trial_lifecycle_messages t
       SET status = 'sending', claimed_at = ${now.toISOString()}, updated_at = ${now.toISOString()},
           due_at = ${dueAtOf(c.trialEndsAt, m, s).toISOString()}, window_ends_at = ${windowEndOf(c.trialEndsAt, m, s).toISOString()}
      FROM prev
     WHERE t.id = prev.id
       AND (t.status IN ('pending', 'deferred', 'blocked')
            OR (t.status = 'failed' AND t.attempt_count < ${MAX_SEND_ATTEMPTS})
            OR (t.status = 'sending' AND t.claimed_at < ${stale}))
    RETURNING t.id, prev.status AS prev_status, prev.reason AS prev_reason, t.attempt_count`;
  return row ? { id: Number(row.id), prevStatus: row.prev_status, prevReason: row.prev_reason, attemptCount: row.attempt_count } : null;
}

/** État ACTUEL du compte et du destinataire, relu juste avant l'envoi. */
async function readState(c: Candidate, m: MilestoneDef, now: Date): Promise<CurrentState & { email: string | null; firstName: string; templateVersion: number | null }> {
  const [r] = await pgClient<{
    account_id: number | null; is_active: boolean | null; archived_at: Date | null; checkout_session_id: string | null; checkout_session_created_at: Date | null;
    sub_status: string | null; trial_ends_at: Date | null; first_billed_at: Date | null; stripe_subscription_id: string | null;
    user_id: number | null; email: string | null; first_name: string | null; user_status: string | null;
  }[]>`
    SELECT a.id AS account_id, a.is_active, a.archived_at, a.checkout_session_id, a.checkout_session_created_at,
           s.status AS sub_status, s.trial_ends_at, s.first_billed_at, s.stripe_subscription_id,
           u.id AS user_id, u.email, u.first_name, u.status AS user_status
      FROM (SELECT ${c.accountId}::int AS id) k
      LEFT JOIN accounts a ON a.id = k.id
      LEFT JOIN account_subscriptions s ON s.account_id = k.id
      LEFT JOIN users u ON u.id = a.owner_user_id`;
  const userId = r?.user_id ?? null;
  const [deletion] = await pgClient<{ pending: boolean; trial_at: Date | null }[]>`
    SELECT bool_or(reason <> 'TRIAL_ABANDONED') AS pending,
           max(scheduled_at) FILTER (WHERE reason = 'TRIAL_ABANDONED') AS trial_at
      FROM scheduled_account_deletions WHERE account_id = ${c.accountId} AND status = 'SCHEDULED'`;
  const [flags] = await pgClient<{ opposed: boolean; consented: boolean; sent_here: boolean; template: boolean; version: number | null }[]>`
    SELECT EXISTS (SELECT 1 FROM marketing_oppositions o WHERE o.user_id = ${userId ?? -1}) AS opposed,
           EXISTS (SELECT 1 FROM news_consents n WHERE n.user_id = ${userId ?? -1} AND n.consented = true) AS consented,
           EXISTS (SELECT 1 FROM trial_lifecycle_messages x
                    WHERE x.status = 'sent' AND x.milestone = ${m.code} AND x.trial_ends_at = ${c.trialEndsAt.toISOString()}
                      AND (x.user_id = ${userId ?? -1} OR x.account_id = ${c.accountId})) AS sent_here,
           EXISTS (SELECT 1 FROM email_templates t WHERE upper(t.type) = ${m.templateCode}) AS template,
           (SELECT max(v.version_no) FROM email_template_versions v WHERE v.template_type = ${m.templateCode}) AS version`;
  // Ancien circuit (notifications) : un e-mail TRIAL_ENDING / TRIAL_ENDED déjà
  // envoyé pour cet essai n'est jamais doublé au déploiement.
  let legacySent = false;
  if (m.notificationEvent) {
    const [l] = await pgClient<{ n: number }[]>`
      SELECT 1 AS n FROM notification_outbox o JOIN notification_deliveries d ON d.outbox_id = o.id
       WHERE o.account_id = ${c.accountId} AND o.event_type = ${m.notificationEvent} AND d.channel = 'email' AND d.status = 'sent'
         AND d.created_at >= ${new Date(c.trialEndsAt.getTime() - 4 * DAY).toISOString()}
       LIMIT 1`;
    legacySent = !!l;
  }
  let emailPreference: boolean | null = null;
  let channelDisabled = false;
  if (m.notificationEvent) {
    const [{ getCatalogEntry }, { resolveChannels }, { loadDisabledChannels }] = await Promise.all([
      import('@/lib/notifications/catalog'), import('@/lib/notifications/policy-resolver'), import('@/lib/notifications/channel-activation'),
    ]);
    const entry = getCatalogEntry(m.notificationEvent);
    if (entry && userId) emailPreference = (await resolveChannels(userId, entry)).email;
    channelDisabled = (await loadDisabledChannels(m.notificationEvent)).has('email');
  } else {
    const { isTransactionalEmailActive } = await import('@/lib/notifications/channel-activation');
    channelDisabled = !(await isTransactionalEmailActive(m.templateCode));
  }
  const checkoutPending = !!r?.checkout_session_id && !!r.checkout_session_created_at
    && now.getTime() - new Date(r.checkout_session_created_at).getTime() < DAY;
  return {
    subscription: r?.sub_status ? {
      status: r.sub_status, trialEndsAt: r.trial_ends_at ? new Date(r.trial_ends_at) : null,
      firstBilledAt: r.first_billed_at ? new Date(r.first_billed_at) : null, stripeSubscriptionId: r.stripe_subscription_id,
    } : null,
    account: { exists: !!r?.account_id, isActive: r?.is_active !== false, archived: !!r?.archived_at, checkoutPending },
    owner: userId ? { exists: true, status: r!.user_status, deleted: r!.user_status === 'DELETED', hasEmail: !!r!.email } : null,
    deletionPending: !!deletion?.pending,
    trialDeletionScheduledAt: deletion?.trial_at ? new Date(deletion.trial_at) : null,
    opposed: !!flags?.opposed,
    consented: !!flags?.consented,
    alreadySent: !!flags?.sent_here || legacySent,
    emailPreference,
    channelDisabled,
    templateExists: !!flags?.template,
    email: r?.email ?? null,
    firstName: r?.first_name ?? '',
    templateVersion: flags?.version ?? null,
  };
}

/** Variables de l'e-mail (anciens noms {{title}} / {{body}} / {{actionUrl}} pour un gabarit personnalisé antérieur). */
function variablesFor(m: MilestoneDef, c: Candidate, st: { firstName: string; trialDeletionScheduledAt: Date | null }, s: TrialLifecycleSettings, now: Date): Record<string, string> {
  const offersUrl = buildOffersUrl(s) ?? '';
  const v: Record<string, string> = { firstName: st.firstName, offersUrl, trialEndsAt: formatTrialDate(c.trialEndsAt) };
  if (m.code === 'J_MINUS_2') Object.assign(v, { title: 'Votre essai se termine bientôt', body: 'Votre période d’essai se termine bientôt.', actionUrl: offersUrl });
  if (m.code === 'J0') Object.assign(v, { title: 'Votre essai est terminé', body: 'Votre période d’essai est terminée.', actionUrl: offersUrl });
  if (m.nature !== 'service') v.unsubscribeUrl = buildUnsubscribeUrl(c.ownerUserId) ?? '';
  if (m.code === 'J80' && st.trialDeletionScheduledAt) {
    v.daysRemaining = String(Math.max(0, Math.ceil((st.trialDeletionScheduledAt.getTime() - now.getTime()) / DAY)));
    v.dataDeletionDate = formatParisDay(st.trialDeletionScheduledAt);
    v.exportUrl = buildExportUrl() ?? '';
  }
  return v;
}

async function logEvent(e: {
  messageId: number; c: Candidate; m: MilestoneDef; type: 'sent' | 'failed' | 'not_sent' | 'deferred' | 'blocked';
  reason?: string | null; templateVersion?: number | null; detail?: Record<string, unknown>; now: Date;
}): Promise<void> {
  await pgClient`
    INSERT INTO trial_lifecycle_events (account_id, user_id, message_id, trial_ends_at, milestone, event_type, template_code, template_version, reason, detail, actor, created_at)
    VALUES (${e.c.accountId}, ${e.c.ownerUserId}, ${e.messageId}, ${e.c.trialEndsAt.toISOString()}, ${e.m.code}, ${e.type}, ${e.m.templateCode},
            ${e.templateVersion ?? null}, ${e.reason ?? null}, ${JSON.stringify(e.detail ?? {})}::jsonb, 'system', ${e.now.toISOString()})`;
}

/** Applique une décision de non-envoi (clos, en attente ou bloqué). */
async function applyNonSend(msg: ClaimedMessage, c: Candidate, m: MilestoneDef, d: Exclude<Decision, { kind: 'send' }>, legalBasis: string | null, now: Date): Promise<'skipped' | 'deferred' | 'blocked'> {
  // Fenêtre refermée sur un message en attente : clos avec son DERNIER motif.
  let reason: string = d.reason;
  let detail: Record<string, unknown> = {};
  if (d.kind === 'skip' && d.reason === 'out_of_window' && msg.prevReason && ['deferred', 'blocked', 'failed'].includes(msg.prevStatus)) {
    reason = msg.prevStatus === 'failed' ? 'out_of_window' : msg.prevReason;
    detail = { windowExpired: true, lastReason: msg.prevReason, lastStatus: msg.prevStatus };
  }
  const status = d.kind === 'skip' ? 'skipped' : d.kind === 'block' ? 'blocked' : 'deferred';
  await pgClient`
    UPDATE trial_lifecycle_messages
       SET status = ${status}, reason = ${reason}, legal_basis = ${legalBasis}, updated_at = ${now.toISOString()},
           decided_at = ${status === 'skipped' ? now.toISOString() : null}, claimed_at = NULL
     WHERE id = ${msg.id}`;
  // Journal : chaque clôture ; une attente ou un blocage seulement quand son motif change (pas une ligne par heure).
  if (status === 'skipped' || msg.prevStatus !== status || msg.prevReason !== reason) {
    await logEvent({ messageId: msg.id, c, m, type: status === 'skipped' ? 'not_sent' : status, reason, detail, now });
  }
  return status;
}

/**
 * Un passage de la séquence. `accountIds` : restreint aux comptes cités
 * (tests, rattrapage ciblé). `sender` : envoi injecté (tests unitaires).
 */
export async function runTrialLifecycle(opts: {
  now?: Date; deadline?: number; accountIds?: number[]; sender?: TrialEmailSender;
} = {}): Promise<TrialLifecycleRunResult> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadline ?? Date.now() + 8 * 60_000;
  const send = opts.sender ?? defaultSender;
  const { settings } = await loadTrialLifecycleSettings();
  const sw = envSwitches();
  const env: DecisionEnv = {
    allOff: sw.allOff,
    commercialOff: sw.commercialOff,
    retentionPurgeImplemented: TRIAL_RETENTION_PURGE_IMPLEMENTED,
    unsubscribeAvailable: !!unsubscribeSecret() && !!appBaseUrl(),
    linksAvailable: !!buildOffersUrl(settings),
  };
  const out: TrialLifecycleRunResult = { examined: 0, sent: 0, failed: 0, skipped: 0, deferred: 0, blocked: 0, conversions: 0, more: false };

  for (const m of MILESTONES) {
    const candidates = await candidatesFor(m, settings, now, opts.accountIds);
    for (const c of candidates) {
      if (Date.now() >= deadline) { out.more = true; break; }
      const msg = await ensureAndClaim(c, m, settings, now);
      if (!msg) continue;
      out.examined += 1;
      try {
        const st = await readState(c, m, now);
        const legalBasis = m.nature === 'service' ? null : settings.legalBasis;
        const d = decideMessage({ milestone: m, trialEndsAt: c.trialEndsAt, now, settings, state: st, env });
        if (d.kind !== 'send') {
          out[await applyNonSend(msg, c, m, d, legalBasis, now)] += 1;
          continue;
        }
        const variables = variablesFor(m, c, st, settings, now);
        const oneClick = m.nature !== 'service' ? buildOneClickUnsubscribeUrl(c.ownerUserId) : null;
        const attempt = msg.attemptCount + 1;
        const res = await send({
          templateCode: m.templateCode, to: st.email!, variables, userId: c.ownerUserId,
          // Stable par message : une reprise après acceptation incertaine n'envoie jamais deux fois.
          idempotencyKey: `trial-lifecycle-${msg.id}`,
          tags: [{ name: 'flow', value: 'trial_lifecycle' }, { name: 'milestone', value: m.code }],
          ...(oneClick ? { headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
        });
        if (res.success) {
          await pgClient`
            UPDATE trial_lifecycle_messages
               SET status = 'sent', reason = NULL, attempt_count = ${attempt}, sent_at = ${now.toISOString()}, decided_at = ${now.toISOString()},
                   template_version = ${st.templateVersion}, legal_basis = ${legalBasis}, email_log_id = ${res.logId ?? null},
                   provider_message_id = ${res.providerMessageId ?? null}, last_error = NULL, claimed_at = NULL, updated_at = ${now.toISOString()}
             WHERE id = ${msg.id}`;
          await logEvent({ messageId: msg.id, c, m, type: 'sent', templateVersion: st.templateVersion, now,
            detail: { attempt, emailLogId: res.logId ?? null, legalBasis, offsetDays: offsetDaysOf(m, settings) } });
          out.sent += 1;
        } else {
          const error = String(res.error ?? 'échec').slice(0, 300);
          await pgClient`
            UPDATE trial_lifecycle_messages
               SET status = 'failed', reason = 'send_failed', attempt_count = ${attempt}, template_version = ${st.templateVersion},
                   legal_basis = ${legalBasis}, email_log_id = ${res.logId ?? null}, last_error = ${error}, claimed_at = NULL,
                   decided_at = ${attempt >= MAX_SEND_ATTEMPTS ? now.toISOString() : null}, updated_at = ${now.toISOString()}
             WHERE id = ${msg.id}`;
          await logEvent({ messageId: msg.id, c, m, type: 'failed', reason: 'send_failed', templateVersion: st.templateVersion, now,
            detail: { attempt, final: attempt >= MAX_SEND_ATTEMPTS, uncertain: !!res.uncertain, error, emailLogId: res.logId ?? null } });
          out.failed += 1;
        }
      } catch (e) {
        // Lecture ou écriture impossible : message rendu (repris au passage suivant), jamais envoyé à l'aveugle.
        await pgClient`UPDATE trial_lifecycle_messages SET status = 'deferred', reason = 'technical_error', last_error = ${String((e as Error).message ?? e).slice(0, 300)}, claimed_at = NULL, updated_at = ${now.toISOString()} WHERE id = ${msg.id} AND status = 'sending'`.catch(() => undefined);
        console.error(`[trial-lifecycle] message ${msg.id} :`, (e as Error).message);
        out.deferred += 1;
      }
    }
    if (out.more) break;
  }
  out.conversions = await recordConversions(now);
  return out;
}

/**
 * Conversions : compte ayant reçu au moins un e-mail de la séquence puis
 * souscrit. Attribuée au dernier e-mail envoyé avant la souscription.
 * Une seule par compte × essai (index unique) — rejouable.
 */
export async function recordConversions(now: Date = new Date()): Promise<number> {
  const rows = await pgClient<{ account_id: number; trial_ends_at: Date; user_id: number | null; converted_at: Date | null }[]>`
    SELECT DISTINCT ON (m.account_id, m.trial_ends_at) m.account_id, m.trial_ends_at, m.user_id,
           coalesce(s.contract_concluded_at, s.first_billed_at, s.updated_at) AS converted_at
      FROM trial_lifecycle_messages m
      JOIN account_subscriptions s ON s.account_id = m.account_id
     WHERE m.status = 'sent' AND m.sent_at >= ${new Date(now.getTime() - 120 * DAY).toISOString()}
       AND (s.first_billed_at IS NOT NULL OR (s.stripe_subscription_id IS NOT NULL AND s.status IN ('active', 'past_due')))
       AND NOT EXISTS (SELECT 1 FROM trial_lifecycle_events e
                        WHERE e.event_type = 'conversion' AND e.account_id = m.account_id AND e.trial_ends_at = m.trial_ends_at)
     LIMIT 500`;
  let n = 0;
  for (const r of rows) {
    const convertedAt = r.converted_at ? new Date(r.converted_at) : now;
    const [last] = await pgClient<{ milestone: string; template_code: string; template_version: number | null }[]>`
      SELECT milestone, template_code, template_version FROM trial_lifecycle_messages
       WHERE account_id = ${r.account_id} AND trial_ends_at = ${r.trial_ends_at} AND status = 'sent' AND sent_at <= ${convertedAt.toISOString()}
       ORDER BY sent_at DESC LIMIT 1`;
    const ins = await pgClient`
      INSERT INTO trial_lifecycle_events (account_id, user_id, trial_ends_at, milestone, event_type, template_code, template_version, detail, actor, created_at)
      VALUES (${r.account_id}, ${r.user_id}, ${r.trial_ends_at}, ${last?.milestone ?? null}, 'conversion', ${last?.template_code ?? null},
              ${last?.template_version ?? null}, ${JSON.stringify({ convertedAt: convertedAt.toISOString(), attributed: !!last })}::jsonb, 'system', ${now.toISOString()})
      ON CONFLICT DO NOTHING RETURNING id`;
    n += ins.length;
  }
  return n;
}
