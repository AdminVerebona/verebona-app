/**
 * Rappel J−7 avant le renouvellement d'un abonnement ANNUEL — règles pures
 * (lot 68C, ticket P1 « Abonnements annuels — e-mail automatique à J−7 »).
 *
 * Module PUR : aucune lecture d'horloge implicite, aucun accès base ni Stripe.
 * Tout est testable avec un `now` fixé (changements d'heure compris).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * STRIPE EST LA SOURCE
 *
 * L'éligibilité est décidée sur l'objet Stripe relu (abonnement + échéancier
 * éventuel), jamais sur la seule copie locale :
 *   · statut `active` (essai `trialing` exclu : c'est aussi l'exclusion du
 *     « premier paiement après essai », qui tombe à la fin de l'essai) ;
 *   · TOUS les prix récurrents en `year` × 1 (aucun mensuel) ;
 *   · reconduction confirmée : ni `cancel_at_period_end`, ni `cancel_at`, ni
 *     échéancier qui s'arrête (`end_behavior = cancel` sans phase suivante),
 *     ni phase suivante mensuelle (passage programmé au mensuel) ;
 *   · échéance = `items[].current_period_end` (API 2025-08-27.basil : la
 *     période vit sur les items).
 *
 * J−7 = SEPT JOURS CALENDAIRES de Paris entre aujourd'hui et la date locale de
 * l'échéance. Rattrapage (J−6 … J−1) avant l'échéance. Jamais le jour de
 * l'échéance ni après (décision prudente : le prélèvement peut avoir lieu dans
 * l'heure).
 *
 * Lot 72F — COUVERTURE : début = lendemain (Paris) de la désactivation DÉCLARÉE
 * des rappels Stripe (BO). Une échéance dont le J−7 tombe avant (Stripe encore
 * actif ce jour-là, au moins en partie) n'est JAMAIS présumée rappelée par
 * Stripe : « couverture incertaine », signalée dans le BO, sans envoi
 * automatique (décision de l'administrateur) — ni doublon, ni omission
 * silencieuse. Le J−7 nominal y est soumis aussi.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { addDaysToDateStr, parisNow } from '@/lib/notifications/time-paris';

export const ANNUAL_RENEWAL_REMINDER = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER' as const;
/** Code de la tâche planifiée interne. */
export const ANNUAL_RENEWAL_TASK_CODE = 'subscription-annual-renewal-reminders' as const;
/** Rappel nominal : sept jours calendaires avant l'échéance. */
export const REMINDER_DAYS_BEFORE = 7;
/** Route Verebona permanente du bouton (session Stripe créée au clic). */
export const MANAGE_SUBSCRIPTION_PATH = '/mon-compte/abonnement/gerer';
/** Fenêtre d'envoi du traitement (heures de Paris). */
export const REMINDER_WINDOW = { from: [8, 30] as const, to: [20, 0] as const };

// ── Objets Stripe minimaux (sous-ensemble lu ; testable sans le SDK) ─────────

export interface ReminderPrice {
  id?: string;
  recurring?: { interval?: string | null; interval_count?: number | null } | null;
}
export interface ReminderSubscriptionItem {
  price?: ReminderPrice | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
}
export interface ReminderSubscription {
  id: string;
  status: string;
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  trial_end?: number | null;
  customer?: string | { id: string } | null;
  schedule?: string | ReminderSchedule | null;
  items: { data: ReminderSubscriptionItem[] };
}
export interface ReminderSchedulePhase {
  start_date: number;
  end_date?: number | null;
  items: Array<{ price?: string | ReminderPrice | null }>;
}
export interface ReminderSchedule {
  id: string;
  status?: string | null;
  end_behavior?: string | null;
  phases: ReminderSchedulePhase[];
}

export type IneligibleReason =
  | 'TRIALING'
  | 'NOT_ACTIVE'
  | 'CANCEL_AT_PERIOD_END'
  | 'CANCEL_AT_SET'
  | 'NOT_ANNUAL'
  | 'NO_PERIOD_END'
  | 'FIRST_PAYMENT_AFTER_TRIAL'
  | 'MONTHLY_SCHEDULED'
  | 'SCHEDULE_ENDS'
  | 'SCHEDULE_UNREADABLE';

export type Eligibility =
  | { ok: true; renewalAt: Date; renewalTs: number; scheduleId: string | null }
  | { ok: false; reason: IneligibleReason };

/** Libellés BO / journal des motifs d'exclusion. */
export const REMINDER_REASON_LABELS: Readonly<Record<string, string>> = {
  TRIALING: 'Période d’essai en cours (premier paiement après essai exclu)',
  NOT_ACTIVE: 'Abonnement non actif chez Stripe',
  CANCEL_AT_PERIOD_END: 'Renouvellement automatique désactivé (résiliation programmée)',
  CANCEL_AT_SET: 'Résiliation programmée à une date',
  NOT_ANNUAL: 'Facturation non annuelle',
  NO_PERIOD_END: 'Échéance inconnue chez Stripe',
  FIRST_PAYMENT_AFTER_TRIAL: 'Premier paiement après essai',
  MONTHLY_SCHEDULED: 'Passage programmé à la facturation mensuelle',
  SCHEDULE_ENDS: 'Échéancier Stripe sans reconduction',
  SCHEDULE_UNREADABLE: 'Échéancier Stripe illisible (envoi suspendu par prudence)',
  TOO_EARLY: 'Échéance à plus de 7 jours',
  TOO_LATE: 'Échéance atteinte ou dépassée : plus de rappel',
  BEFORE_COVERAGE: 'J−7 antérieur à l’activation du traitement (ancien motif, lot 68C)',
  COVERAGE_UNCERTAIN: 'J−7 au plus tard le jour de la désactivation des rappels Stripe : envoi Stripe non prouvé — décision BO',
  STRIPE_REMINDER_CONFIRMED: 'Rappel Stripe constaté par un administrateur',
  BO_DECISION: 'Rappel Verebona demandé par un administrateur',
  ROLLBACK_NEUTRALIZED: 'Retour aux rappels Stripe : demande neutralisée avant l’envoi',
  ADMIN_ABANDONED: 'Abandonnée par un administrateur',
  TASK_SUSPENDED: 'Tâche du rappel annuel suspendue : envoi retenu',
  SWITCH_NOT_DECLARED: 'Bascule Stripe → Verebona non déclarée : envoi retenu',
  SEND_STATE_UNREADABLE: 'État du rappel annuel illisible : envoi retenu par prudence',
  PLAN_UNAVAILABLE: 'Offre du prochain renouvellement non identifiable chez Stripe (nouvelle tentative)',
  BILLING_MISMATCH: 'Compte, abonnement et client Stripe incohérents',
  UNCERTAIN_ACCEPTANCE: 'Acceptation par Resend incertaine : réémission bloquée, décision BO',
  STRIPE_ERROR: 'Vérification Stripe impossible (nouvelle tentative)',
  DESYNC_RESYNCED: 'Données locales désynchronisées, resynchronisées depuis Stripe',
  DESYNC_UNRESOLVED: 'Données locales désynchronisées, resynchronisation impossible',
  STRIPE_ONLY: 'Abonnement annuel Stripe sans compte Verebona correspondant',
  RENEWAL_DATE_CHANGED: 'Date d’échéance modifiée depuis la préparation',
  SUBSCRIPTION_REPLACED: 'Abonnement remplacé sur le compte',
  ACCOUNT_CLOSED: 'Compte du titulaire fermé ou en suppression',
  RECIPIENT_MISMATCH: 'Titulaire payeur introuvable ou incohérent',
  AMOUNT_UNAVAILABLE: 'Montant prévisionnel indisponible chez Stripe (nouvelle tentative)',
  PORTAL_CANCEL_DISABLED: 'Le portail Stripe ne permet pas de désactiver le renouvellement',
  CHANNEL_DISABLED: 'E-mail désactivé dans le BO › Communications',
};

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  !v ? null : typeof v === 'string' ? v : v.id ?? null;

const isAnnualPrice = (p: ReminderPrice | null | undefined): boolean | null => {
  if (!p?.recurring) return null; // pas récurrent (ou non développé) : ignoré
  return p.recurring.interval === 'year' && (p.recurring.interval_count ?? 1) === 1;
};

/** Éligibilité d'après l'objet Stripe relu (et son échéancier, développé ou non). */
export function evaluateStripeEligibility(
  sub: ReminderSubscription,
  opts: { schedule?: ReminderSchedule | null } = {},
): Eligibility {
  if (sub.status === 'trialing') return { ok: false, reason: 'TRIALING' };
  if (sub.status !== 'active') return { ok: false, reason: 'NOT_ACTIVE' };
  if (sub.cancel_at_period_end) return { ok: false, reason: 'CANCEL_AT_PERIOD_END' };
  if (sub.cancel_at) return { ok: false, reason: 'CANCEL_AT_SET' };

  const items = sub.items?.data ?? [];
  const recurring = items.map((i) => isAnnualPrice(i.price)).filter((v): v is boolean => v !== null);
  if (recurring.length === 0 || recurring.some((v) => !v)) return { ok: false, reason: 'NOT_ANNUAL' };

  const ends = items.map((i) => i.current_period_end).filter((v): v is number => typeof v === 'number' && v > 0);
  if (ends.length === 0) return { ok: false, reason: 'NO_PERIOD_END' };
  const renewalTs = Math.min(...ends);
  // Défense : une fin d'essai qui coïncide avec l'échéance = premier paiement.
  if (sub.trial_end && sub.trial_end >= renewalTs - 60) return { ok: false, reason: 'FIRST_PAYMENT_AFTER_TRIAL' };

  const scheduleId = idOf(sub.schedule as string | { id: string } | null);
  if (scheduleId) {
    const sch = opts.schedule ?? (typeof sub.schedule === 'object' ? (sub.schedule as ReminderSchedule) : null);
    if (!sch || !Array.isArray(sch.phases)) return { ok: false, reason: 'SCHEDULE_UNREADABLE' };
    const verdict = scheduleVerdict(sch, renewalTs);
    if (verdict) return { ok: false, reason: verdict };
  }
  return { ok: true, renewalAt: new Date(renewalTs * 1000), renewalTs, scheduleId };
}

/**
 * Échéancier : la phase qui démarre À l'échéance (ou la couvre) doit rester
 * annuelle ; sans phase au-delà, l'échéancier doit se « libérer » (release),
 * pas résilier.
 */
function scheduleVerdict(sch: ReminderSchedule, renewalTs: number): IneligibleReason | null {
  if (sch.status && !['active', 'not_started'].includes(sch.status)) return null; // libéré / terminé : sans effet
  const next = sch.phases.find((p) => p.start_date <= renewalTs && (p.end_date == null || p.end_date > renewalTs))
    ?? sch.phases.find((p) => p.start_date >= renewalTs);
  if (!next) return sch.end_behavior === 'cancel' ? 'SCHEDULE_ENDS' : null;
  for (const it of next.items ?? []) {
    const price = typeof it.price === 'object' ? it.price : null;
    if (!price) return 'SCHEDULE_UNREADABLE'; // prix non développé : on ne devine pas
    const annual = isAnnualPrice(price);
    if (annual === false) return 'MONTHLY_SCHEDULED';
  }
  return null;
}

// ── Calendrier ───────────────────────────────────────────────────────────────

/** Date locale de Paris (YYYY-MM-DD) d'un instant. */
export function parisDateOf(at: Date): string {
  return parisNow(at).dateStr;
}

/** Nombre de jours calendaires de Paris entre deux dates locales. */
export function daysBetween(fromDateStr: string, toDateStr: string): number {
  const [y1, m1, d1] = fromDateStr.split('-').map(Number);
  const [y2, m2, d2] = toDateStr.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

export type ReminderTiming =
  | { send: true; days: number; catchUp: boolean }
  | { send: false; days: number; reason: 'TOO_EARLY' | 'TOO_LATE' | 'COVERAGE_UNCERTAIN' };

/**
 * Décision de calendrier (J−7, rattrapage, trop tôt / trop tard, couverture).
 * `coverageFrom` : premier J−7 entièrement couvert par Verebona (lendemain de
 * la désactivation déclarée des rappels Stripe) ; `null` : aucun contrôle
 * (revalidation juste avant l'envoi d'une demande déjà décidée).
 */
export function reminderTiming(now: Date, renewalAt: Date, coverageFrom: string | null): ReminderTiming {
  const today = parisDateOf(now);
  const renewalDate = parisDateOf(renewalAt);
  const days = daysBetween(today, renewalDate);
  if (days > REMINDER_DAYS_BEFORE) return { send: false, days, reason: 'TOO_EARLY' };
  if (days < 1 || renewalAt.getTime() <= now.getTime()) return { send: false, days, reason: 'TOO_LATE' };
  const j7 = addDaysToDateStr(renewalDate, -REMINDER_DAYS_BEFORE);
  if (coverageFrom && j7 < coverageFrom) return { send: false, days, reason: 'COVERAGE_UNCERTAIN' };
  return { send: true, days, catchUp: days !== REMINDER_DAYS_BEFORE };
}

/** Lot 72F : premier J−7 couvert = lendemain (Paris) de la désactivation des rappels Stripe. */
export function coverageFromSwitch(stripeRemindersDisabledAt: Date): string {
  return addDaysToDateStr(parisDateOf(stripeRemindersDisabledAt), 1);
}

/**
 * Lot 72F — texte d'erreur journalisable : jamais de clé ni de secret (Stripe
 * « Invalid API Key provided: sk_live_…», secrets de webhook, clé Resend).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9*]+/g, '[clé masquée]')
    .replace(/\bwhsec_[A-Za-z0-9+/=*]+/g, '[secret masqué]')
    .replace(/\bre_[A-Za-z0-9_*]{8,}/g, '[clé masquée]')
    .replace(/https:\/\/billing\.stripe\.com\/\S+/g, '[lien Stripe masqué]');
}

/** « dans 7 jours » ; rattrapage : « dans 3 jours », « demain ». */
export function renewalDelayLabel(days: number): string {
  if (days === 1) return 'demain';
  return `dans ${days} jours`;
}

/** « 12 novembre 2026 » (date de Paris). */
export function formatRenewalDate(at: Date): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }).format(at);
}

/**
 * Montant français : virgule, ESPACE INSÉCABLE (U+00A0) avant le symbole et
 * entre les milliers — `Intl` produit l'espace fine insécable U+202F, mal
 * rendue par certains clients de messagerie.
 */
export function formatAmountFr(cents: number, currency: string): string {
  let out: string;
  try {
    out = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    out = `${(cents / 100).toFixed(2).replace('.', ',')} ${currency.toUpperCase()}`;
  }
  return out.replace(/[   ]/g, ' ');
}

/** Libellé du montant ; 0 : mention explicite d'absence de prélèvement. */
export function amountLabelOf(cents: number, currency: string): string {
  const amount = formatAmountFr(cents, currency);
  return cents === 0 ? `${amount} (aucun prélèvement n’est prévu)` : amount;
}

/** Clé d'idempotence : un rappel par abonnement Stripe et par échéance (date de Paris). */
export function annualRenewalDedupeKey(subscriptionId: string, renewalDate: string): string {
  return `annual-renewal-reminder:${subscriptionId}:${renewalDate}`;
}

// ── Montant prévisionnel (aperçu de la prochaine facture Stripe) ─────────────

export interface ReminderInvoiceLine {
  period?: { start?: number | null; end?: number | null } | null;
  /** API basil : prix de la ligne. */
  pricing?: { type?: string | null; price_details?: { price?: string | { id: string } | null } | null } | null;
  /** Anciennes versions de l'API. */
  price?: string | { id: string } | null;
}
export interface ReminderInvoicePreview {
  amount_due?: number | null;
  currency?: string | null;
  lines?: { data?: ReminderInvoiceLine[] } | null;
}

/**
 * Lot 72F — prix facturés au RENOUVELLEMENT (lignes de l'aperçu Stripe dont la
 * période commence à l'échéance) : changement d'offre programmé compris.
 */
export function renewalPriceIdsFromPreview(preview: ReminderInvoicePreview | null | undefined, renewalTs: number): string[] {
  const ids = new Set<string>();
  for (const l of preview?.lines?.data ?? []) {
    if (l.period?.start == null || Math.abs((l.period.start as number) - renewalTs) > 60) continue;
    const p = l.pricing?.price_details?.price ?? l.price ?? null;
    const id = !p ? null : typeof p === 'string' ? p : p.id;
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Lot 72F — prix de la phase d'échéancier qui couvre l'échéance (à défaut de l'aperçu). */
export function renewalPriceIdsFromSubscription(sub: ReminderSubscription, schedule: ReminderSchedule | null, renewalTs: number): string[] {
  if (schedule && Array.isArray(schedule.phases) && (!schedule.status || ['active', 'not_started'].includes(schedule.status))) {
    const next = schedule.phases.find((p) => p.start_date <= renewalTs && (p.end_date == null || p.end_date > renewalTs))
      ?? schedule.phases.find((p) => p.start_date >= renewalTs);
    if (next) {
      return [...new Set(next.items.map((i) => (typeof i.price === 'string' ? i.price : i.price?.id ?? null)).filter((v): v is string => !!v))];
    }
  }
  return [...new Set((sub.items?.data ?? []).filter((i) => i.price?.recurring).map((i) => i.price?.id ?? null).filter((v): v is string => !!v))];
}

/**
 * Montant de la facture de RENOUVELLEMENT (remises, taxes, crédits du solde
 * client et changements programmés compris : `amount_due` de l'aperçu Stripe).
 * `null` si l'aperçu ne porte pas sur l'échéance attendue ou ne couvre pas une
 * année : on n'invente jamais un montant.
 */
export function renewalAmountFromPreview(preview: ReminderInvoicePreview | null | undefined, renewalTs: number): { cents: number; currency: string } | null {
  if (!preview || typeof preview.amount_due !== 'number' || preview.amount_due < 0 || !preview.currency) return null;
  const lines = preview.lines?.data ?? [];
  const renewalLines = lines.filter((l) => l.period?.start != null && Math.abs((l.period.start as number) - renewalTs) <= 60);
  if (renewalLines.length === 0) return null;
  // Période renouvelée d'environ un an (360 à 370 jours) : jamais un mensuel.
  const annual = renewalLines.some((l) => {
    const len = ((l.period?.end ?? 0) - (l.period?.start ?? 0)) / 86_400;
    return len >= 360 && len <= 370;
  });
  if (!annual) return null;
  return { cents: preview.amount_due, currency: preview.currency };
}

/** Portail Stripe par défaut : la désactivation du renouvellement est-elle offerte ? */
export function portalAllowsRenewalDisable(conf: { features?: { subscription_cancel?: { enabled?: boolean; mode?: string } } } | null | undefined): boolean | null {
  const c = conf?.features?.subscription_cancel;
  if (!c || typeof c.enabled !== 'boolean') return null; // indéterminé
  return c.enabled && c.mode !== 'immediately';
}
