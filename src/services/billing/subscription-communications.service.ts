/**
 * Communications d'abonnement décidées PAR OPÉRATION — lot 81E.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES DÉFAUTS CORRIGÉS
 *
 *   · plusieurs producteurs (synchronisation d'abonnement, webhook
 *     `customer.subscription.deleted`, sortie de Premium Duo, changement BO)
 *     envoyaient chacun leur confirmation équivalente ;
 *   · la déduplication de la résiliation reposait sur « un e-mail
 *     DOWNGRADE_NOTIFICATION envoyé à ce titulaire dans les dernières 24 h » :
 *     deux opérations distinctes du même utilisateur dans la journée se
 *     neutralisaient, et l'e-mail était réputé « couvert » avant son envoi ;
 *   · `confirmationEmailSent: true` était posé AVANT l'envoi (« fire and
 *     forget ») de la confirmation Premium : l'e-mail générique était supprimé
 *     même quand la confirmation échouait.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA DÉCISION, UNE FOIS PAR TRANSITION MÉTIER
 *
 * `recordSubscriptionTransition` est appelé DANS la transaction qui applique
 * la transition (verrou de ligne du compte : une seule transaction constate
 * le passage de l'ancien état au nouveau). Il inscrit l'opération dans
 * `subscription_communication_operations` sous une clé STABLE
 * (`subscriptionOperationKey` : compte, abonnement, opération, ancien et
 * nouveau statut, ancienne et nouvelle offre, date d'effet) ; la PREMIÈRE
 * inscription décide des communications, dans la même transaction :
 *   · la notification (cloche, push, e-mail générique selon préférences) —
 *     outbox, clé de déduplication de l'opération ;
 *   · l'e-mail transactionnel indispensable, enregistré DURABLEMENT dans la
 *     file des lots 57A / 72F (`transactional_email_jobs`) : reprise, clé
 *     d'idempotence stable, acceptation incertaine sans doublon, supervision
 *     BO. Confirmation contractuelle (`PREMIUM_CONFIRMATION`, données
 *     contractuelles figées : offre, montant, périodicité, échéance) ou fin
 *     d'offre (`DOWNGRADE_NOTIFICATION`).
 * L'e-mail générique de la notification n'est omis que parce qu'un e-mail
 * transactionnel DURABLE a été enregistré pour la même opération (cause
 * tracée sur la livraison) — jamais sur la foi d'une intention d'envoi.
 *
 * Résiliation programmée et prise d'effet sont deux opérations distinctes.
 * Une prise d'effet est identifiée par l'abonnement (un abonnement ne se
 * termine qu'une fois) : le webhook `deleted` et la synchronisation d'un
 * abonnement `canceled` produisent la même clé, donc une seule communication.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db';

type SubscriptionOperationKind =
  | 'ACTIVATION' | 'PLAN_CHANGE' | 'CANCELLATION_SCHEDULED' | 'CANCELLATION_EFFECTIVE' | 'ADMIN_PLAN_CHANGE';

interface SubscriptionTransition {
  kind: SubscriptionOperationKind;
  accountId: number;
  ownerUserId: number;
  subscriptionId: string | null;
  oldPlan: string | null;
  newPlan: string | null;
  oldStatus: string | null;
  newStatus: string | null;
  /** Date d'effet de l'opération (voir `subscriptionOperationKey`). */
  effectiveAt: Date | null;
  /** Résiliation programmée : instant de la demande chez Stripe (`canceled_at`). */
  requestedAt?: Date | null;
  billingPeriod?: 'monthly' | 'yearly' | null;
  /** Prix contractuel de l'opération (centimes) — jamais la grille courante. */
  unitAmountCents?: number | null;
  /** Prochaine échéance (fin de période payée). */
  nextBillingDate?: Date | null;
  isPaid?: boolean;
  /** E-mails transactionnels au client (faux : resynchronisation BO, balayage, changement BO sans courriel). */
  notify: boolean;
  /** Aucune communication (écho d'un changement BO, ACC-A05) — l'opération reste tracée. */
  silent?: boolean;
  source: string;
}

export const PREMIUM_PLANS: readonly string[] = ['PREMIUM', 'PREMIUM_DUO'];

export const PLAN_LABELS: Record<string, string> = {
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  PREMIUM_DUO: 'Premium Duo',
  PREMIUM_PRO: 'Premium Pro',
};

const RANG: Record<string, number> = { STANDARD: 1, PREMIUM: 2, PREMIUM_DUO: 3, PREMIUM_PRO: 4 };

const iso = (d: Date | null | undefined): string => (d && !Number.isNaN(d.getTime()) ? d.toISOString() : '-');

/**
 * Clé STABLE de l'opération (pure). Mêmes entrées → même clé, quel que soit
 * le producteur ; deux opérations distinctes → deux clés.
 *   · activation : date de début de l'abonnement Stripe ;
 *   · changement d'offre : instant où la transition est constatée sous verrou
 *     (une seule transaction la constate) ;
 *   · résiliation programmée : échéance ET instant de la demande (résilier,
 *     reprendre puis résilier de nouveau = deux opérations) ;
 *   · prise d'effet : l'abonnement seul (il ne se termine qu'une fois).
 */
export function subscriptionOperationKey(t: Pick<SubscriptionTransition,
  'kind' | 'accountId' | 'subscriptionId' | 'oldPlan' | 'newPlan' | 'oldStatus' | 'newStatus' | 'effectiveAt' | 'requestedAt'>): string {
  const base = `acct:${t.accountId}:sub:${t.subscriptionId ?? '-'}:${t.kind}`;
  if (t.kind === 'CANCELLATION_EFFECTIVE') return base;
  const transition = `${t.oldPlan ?? '-'}>${t.newPlan ?? '-'}:${t.oldStatus ?? '-'}>${t.newStatus ?? '-'}`;
  if (t.kind === 'CANCELLATION_SCHEDULED') return `${base}:${transition}:eff:${iso(t.effectiveAt)}:req:${iso(t.requestedAt ?? null)}`;
  return `${base}:${transition}:eff:${iso(t.effectiveAt)}`;
}

/** Statuts de compte qui signifient « une offre payante était en place ». */
const STATUTS_AVEC_OFFRE = ['ACTIVE', 'PAST_DUE', 'CANCELED'];

const unix = (v: number | null | undefined): Date | null => (typeof v === 'number' && v > 0 ? new Date(v * 1000) : null);

interface TransitionInputs {
  /** État AVANT, relu sous verrou de ligne dans la transaction. */
  before: { planType: string | null; status: string | null; subscriptionId: string | null; cancelAtPeriodEnd: boolean };
  after: { planType: string; status: string };
  subscription: {
    id: string; start_date?: number | null; cancel_at_period_end?: boolean | null; cancel_at?: number | null;
    canceled_at?: number | null; ended_at?: number | null;
  };
  isPaid: boolean;
  isTerminal: boolean;
  withdrawn: boolean;
  periodEnd: Date | null;
  now: Date;
}

/**
 * Transitions métier constatées par une synchronisation (pure) : l'état
 * AVANT est celui lu sous verrou — une seule transaction constate chaque
 * transition, quel que soit le nombre de webhooks.
 */
export function detectSubscriptionTransitions(i: TransitionInputs): Array<Pick<SubscriptionTransition, 'kind' | 'effectiveAt' | 'requestedAt'>> {
  const out: Array<Pick<SubscriptionTransition, 'kind' | 'effectiveAt' | 'requestedAt'>> = [];
  const oldPlan = i.before.planType ?? 'STANDARD';
  const planChanged = oldPlan !== i.after.planType;
  if (i.isPaid && !i.withdrawn) {
    const activated = i.before.subscriptionId !== i.subscription.id || i.before.status !== 'ACTIVE';
    const avaitUneOffre = STATUTS_AVEC_OFFRE.includes(String(i.before.status ?? '').toUpperCase());
    if (!avaitUneOffre && (activated || planChanged)) {
      out.push({ kind: 'ACTIVATION', effectiveAt: unix(i.subscription.start_date) });
    } else if (avaitUneOffre && planChanged) {
      out.push({ kind: 'PLAN_CHANGE', effectiveAt: i.now });
    }
    const sameSub = i.before.subscriptionId === i.subscription.id;
    if (i.subscription.cancel_at_period_end && !(sameSub && i.before.cancelAtPeriodEnd)) {
      out.push({
        kind: 'CANCELLATION_SCHEDULED',
        effectiveAt: unix(i.subscription.cancel_at) ?? i.periodEnd,
        requestedAt: unix(i.subscription.canceled_at),
      });
    }
  }
  // Fin d'accès (rétractation comprise : comportement antérieur conservé).
  if (i.isTerminal && (planChanged || String(i.before.status ?? '').toUpperCase() !== 'EXPIRED')) {
    out.push({ kind: 'CANCELLATION_EFFECTIVE', effectiveAt: unix(i.subscription.ended_at) ?? i.now });
  }
  return out;
}

interface PlannedCommunications {
  notification: { type: string; payload: Record<string, unknown> } | null;
  /** E-mail transactionnel DURABLE (kind de la file = code du gabarit). */
  email: { kind: 'PREMIUM_CONFIRMATION' | 'DOWNGRADE_NOTIFICATION'; context: Record<string, unknown> } | null;
}

/** Décision centrale des communications d'une opération (pure). */
export function plannedCommunications(t: SubscriptionTransition): PlannedCommunications {
  const newPlan = t.newPlan ?? '';
  const oldPlan = t.oldPlan ?? '';
  const label = PLAN_LABELS[newPlan] ?? newPlan;
  const becomesPremium = PREMIUM_PLANS.includes(newPlan) && !PREMIUM_PLANS.includes(oldPlan);
  const confirmation = becomesPremium && t.isPaid !== false && t.nextBillingDate
    ? {
        kind: 'PREMIUM_CONFIRMATION' as const,
        context: {
          planCode: newPlan, planLabel: label,
          unitAmountCents: t.unitAmountCents ?? null,
          billingPeriod: t.billingPeriod ?? null,
          nextBillingDate: t.nextBillingDate.toISOString(),
          subscriptionId: t.subscriptionId,
        },
      }
    : null;

  switch (t.kind) {
    case 'ACTIVATION':
      return {
        notification: t.isPaid === false ? null : {
          type: 'SUBSCRIPTION_ACTIVATED',
          payload: { planCode: newPlan, planLabel: label, billingPeriod: t.billingPeriod ?? null },
        },
        email: confirmation,
      };
    case 'PLAN_CHANGE': {
      const avant = RANG[oldPlan] ?? 0;
      const apres = RANG[newPlan] ?? 0;
      return {
        notification: t.isPaid === false ? null : {
          type: 'SUBSCRIPTION_CHANGED',
          payload: {
            planCode: newPlan, planLabel: label, billingPeriod: t.billingPeriod ?? null,
            previousPlanCode: oldPlan, previousPlanLabel: PLAN_LABELS[oldPlan] ?? oldPlan,
            direction: apres > avant ? 'upgrade' : apres < avant ? 'downgrade' : 'lateral',
          },
        },
        email: confirmation,
      };
    }
    case 'CANCELLATION_SCHEDULED':
      return {
        notification: {
          type: 'SUBSCRIPTION_CANCELLATION_SCHEDULED',
          payload: { planCode: oldPlan || newPlan, planLabel: PLAN_LABELS[oldPlan || newPlan] ?? (oldPlan || newPlan), ...(t.effectiveAt ? { effectiveAt: t.effectiveAt.toISOString() } : {}) },
        },
        email: null,
      };
    case 'CANCELLATION_EFFECTIVE':
      return {
        notification: { type: 'SUBSCRIPTION_CANCELLED', payload: { previousPlanCode: oldPlan || null } },
        // Fin d'une offre supérieure : e-mail « Votre offre Verebona a changé »
        // (Standard n'est jamais présenté comme gratuit).
        email: oldPlan && oldPlan !== 'STANDARD'
          ? { kind: 'DOWNGRADE_NOTIFICATION', context: { previousPlanCode: oldPlan, subscriptionId: t.subscriptionId } }
          : null,
      };
    case 'ADMIN_PLAN_CHANGE':
      return {
        notification: null,
        email: newPlan === 'STANDARD' && oldPlan && oldPlan !== 'STANDARD'
          ? { kind: 'DOWNGRADE_NOTIFICATION', context: { previousPlanCode: oldPlan, subscriptionId: t.subscriptionId } }
          : null,
      };
  }
}

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function rowsOf<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  const rows = (r as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

export interface RecordedOperation {
  operationId: number;
  operationKey: string;
  emailJobId: number | null;
  /** Clé exacte de la ligne d'outbox (destinataire compris). */
  notificationDedupeKey: string | null;
  /** Communications non enregistrées (erreur) : supervisées au BO, transition conservée. */
  error?: string;
}

/**
 * Inscrit l'opération et décide ses communications — DANS la transaction de
 * la transition. `null` : opération déjà inscrite (autre webhook, rejeu) —
 * rien n'est produit une seconde fois. L'inscription de l'opération lève en
 * cas d'erreur de base (la transition est alors rejouée : Stripe relivre).
 * Les communications sont enregistrées sous point de sauvegarde : leur échec
 * ne bloque jamais l'application des droits payés — cause tracée sur
 * l'opération et anomalie de Supervision (`dispatchRecordedOperation`).
 */
export async function recordSubscriptionTransition(tx: DrizzleTx, t: SubscriptionTransition): Promise<RecordedOperation | null> {
  const key = subscriptionOperationKey(t);
  const planned = plannedCommunications(t);
  const [op] = rowsOf<{ id: number }>(await tx.execute(sql`
    INSERT INTO subscription_communication_operations
           (operation_key, account_id, owner_user_id, stripe_subscription_id, kind, old_plan, new_plan, old_status, new_status,
            effective_at, source, created_at)
    VALUES (${key}, ${t.accountId}, ${t.ownerUserId ?? null}, ${t.subscriptionId ?? null}, ${t.kind}, ${t.oldPlan ?? null}, ${t.newPlan ?? null},
            ${t.oldStatus ?? null}, ${t.newStatus ?? null}, ${t.effectiveAt ? t.effectiveAt.toISOString() : null}::timestamptz, ${t.source ?? null}, now())
    ON CONFLICT (operation_key) DO NOTHING
    RETURNING id`));
  if (!op) return null;
  const operationId = Number(op.id);

  if (t.silent || (!planned.notification && !planned.email)) {
    await tx.execute(sql`UPDATE subscription_communication_operations
                            SET communications_skipped = ${t.silent ? `SILENT:${t.source}`.slice(0, 120) : 'NONE_PLANNED'}
                          WHERE id = ${operationId}`);
    return { operationId, operationKey: key, emailJobId: null, notificationDedupeKey: null };
  }

  // Point de sauvegarde : une communication impossible à enregistrer (erreur
  // de base, charge utile refusée) ne bloque jamais l'application des droits
  // — l'opération reste tracée avec sa cause et supervisée au BO.
  try {
    return await tx.transaction(async (sp) => {
      // ── E-mail indispensable : enregistré durablement (file 57A / 72F) ──
      let emailJobId: number | null = null;
      if (planned.email && !t.notify) {
        await sp.execute(sql`UPDATE subscription_communication_operations
                                SET communications_skipped = ${`EMAIL_NOTIFY_FALSE:${t.source}`.slice(0, 120)}
                              WHERE id = ${operationId}`);
      }
      if (planned.email && t.notify) {
        const [owner] = rowsOf<{ email: string | null }>(await sp.execute(sql`SELECT email FROM users WHERE id = ${t.ownerUserId}`));
        if (owner?.email) {
          const dedupe = `subscription-op:${operationId}:${planned.email.kind}`;
          const [job] = rowsOf<{ id: number }>(await sp.execute(sql`
            INSERT INTO transactional_email_jobs
                   (kind, user_id, duo_id, triggered_by_user_id, recipient_email, context, dedupe_key, status, attempts,
                    max_attempts, next_attempt_at, created_at, updated_at)
            SELECT ${planned.email.kind}, ${t.ownerUserId}, NULL, NULL, ${owner.email},
                   ${JSON.stringify({ ...planned.email.context, operationKey: key })}::jsonb, ${dedupe}, 'pending', 0, 6, now(), now(), now()
             WHERE NOT EXISTS (SELECT 1 FROM transactional_email_jobs WHERE dedupe_key = ${dedupe})
            RETURNING id`));
          emailJobId = job ? Number(job.id) : null;
        }
      }

      // ── Notification (outbox, même transaction) ──
      let notificationDedupeKey: string | null = null;
      if (planned.notification) {
        const base = `subscription-op:${key}`;
        notificationDedupeKey = `${base}:u${t.ownerUserId}`;
        const coverage = emailJobId == null ? {}
          : planned.email?.kind === 'PREMIUM_CONFIRMATION' ? { confirmationJobId: emailJobId } : { endedEmailJobId: emailJobId };
        const { emit } = await import('@/lib/notifications');
        await emit({
          type: planned.notification.type as never,
          // Titulaire seulement (facturation, lot 72D) — passé explicitement :
          // aucune lecture hors de la transaction (pool de connexions).
          recipientUserIds: [t.ownerUserId],
          accountId: t.accountId,
          entityType: 'subscription',
          entityId: t.subscriptionId ?? String(t.accountId),
          payload: { ...planned.notification.payload, ...coverage } as never,
          dedupeKey: base,
          tx: sp,
        });
      }

      await sp.execute(sql`UPDATE subscription_communication_operations
                              SET notification_type = ${planned.notification?.type ?? null},
                                  notification_dedupe_key = ${notificationDedupeKey},
                                  email_job_id = ${emailJobId}
                            WHERE id = ${operationId}`);
      return { operationId, operationKey: key, emailJobId, notificationDedupeKey };
    });
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    console.error(`[subscription-communications] communications de l'opération ${operationId} (${t.kind}) non enregistrées :`, message);
    await tx.execute(sql`UPDATE subscription_communication_operations
                            SET communications_skipped = ${`ERROR:${message}`.slice(0, 200)}
                          WHERE id = ${operationId}`);
    return { operationId, operationKey: key, emailJobId: null, notificationDedupeKey: null, error: message };
  }
}

/**
 * Après validation de la transaction : tentative immédiate de l'e-mail et de
 * la notification (sinon : tâches `transactional-emails-retry` et
 * `notifications-dispatch`, chaque minute). Ne lève jamais.
 */
export async function dispatchRecordedOperation(op: RecordedOperation | null): Promise<void> {
  if (!op) return;
  if (op.error) {
    try {
      const { reportAnomaly } = await import('@/services/admin/anomaly.service');
      await reportAnomaly({
        domain: 'communications',
        fingerprint: `communications:subscription-operation:${op.operationId}`,
        title: `Communications d’abonnement non enregistrées (opération ${op.operationId})`,
        detail: { operationId: op.operationId, operationKey: op.operationKey, error: op.error.slice(0, 300) },
      });
    } catch { /* journalisé par l'appelant */ }
    return;
  }
  try {
    if (op.emailJobId != null) {
      const { processEmailJob } = await import('@/services/email/transactional-email-jobs.service');
      await processEmailJob(op.emailJobId);
    }
  } catch (e) {
    console.error(`[subscription-communications] e-mail de l'opération ${op.operationId} : tentative différée —`, (e as Error).message);
  }
  try {
    if (op.notificationDedupeKey) {
      const ids = rowsOf<{ id: string }>(await db.execute(sql`
        SELECT id FROM notification_outbox WHERE dedupe_key = ${op.notificationDedupeKey} AND status = 'pending'`));
      if (ids.length) {
        const { processOutboxIds } = await import('@/lib/notifications');
        await processOutboxIds(ids.map((r) => r.id));
      }
    }
  } catch (e) {
    console.error(`[subscription-communications] notification de l'opération ${op.operationId} : envoi différé —`, (e as Error).message);
  }
}

/**
 * Hors de toute transaction d'état (changement BO, sortie Duo) : inscrit
 * l'opération dans sa propre transaction puis tente l'envoi. Ne lève jamais.
 */
export async function recordAndDispatchSubscriptionTransition(t: SubscriptionTransition): Promise<RecordedOperation | null> {
  try {
    const op = await db.transaction((tx) => recordSubscriptionTransition(tx, t));
    await dispatchRecordedOperation(op);
    return op;
  } catch (e) {
    console.error(`[subscription-communications] opération ${t.kind} du compte ${t.accountId} non inscrite :`, (e as Error).message);
    return null;
  }
}
