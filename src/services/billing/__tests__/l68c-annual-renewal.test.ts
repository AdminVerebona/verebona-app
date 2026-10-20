/**
 * Lot 68C — ticket P1 « Abonnements annuels — e-mail automatique à J−7 avant
 * renouvellement » : règles pures, gabarit, migration, tâche, lien permanent.
 *
 * ANN-J7-01  J−8 : aucun e-mail ; J−7 : un e-mail ; calendrier de Paris
 *            (changement d'heure compris).
 * ANN-J7-02  Année suivante : nouvelle échéance = nouvelle clé (nouveau rappel).
 * ANN-J7-03  Mensuel, mixte, essai (trialing), premier paiement après essai : exclus.
 * ANN-J7-04  Résiliation programmée (cancel_at_period_end, cancel_at), échéancier
 *            qui se termine, passage programmé au mensuel : exclus ; échéancier
 *            annuel (revalorisation) : éligible.
 * ANN-J7-05  Montant : aperçu Stripe (remises, taxes, crédits : amount_due),
 *            format FR (virgule, espace insécable, €) ; 0 € → « aucun prélèvement » ;
 *            aperçu incohérent → jamais de montant inventé.
 * ANN-J7-06  Rattrapage : « dans N jours » / « demain » ; jamais le jour de
 *            l'échéance ni après ; jamais avant le début de couverture (bascule).
 * ANN-J7-07  Gabarit : texte exact du ticket, migration 0477 identique au défaut
 *            du code, lien obligatoire, mise en page de la charte (bouton).
 * ANN-J7-08  Tâche planifiée : toutes les heures de 8 h 30 à 20 h (Paris),
 *            premier passage à 8 h 30, créée suspendue par la migration.
 * ANN-J7-09  Lien permanent : navigation (navigateur / application installée),
 *            refus explicites (invité Duo) sans donnée du titulaire.
 * ANN-J7-10  Portail Stripe : désactivation du renouvellement offerte ou non.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  amountLabelOf, annualRenewalDedupeKey, evaluateStripeEligibility, formatAmountFr, formatRenewalDate,
  portalAllowsRenewalDisable, reminderTiming, renewalAmountFromPreview, renewalDelayLabel,
  type ReminderSubscription,
} from '../annual-renewal-reminder.rules';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const ts = (isoStr: string) => Math.floor(new Date(isoStr).getTime() / 1000);
const YEAR = { recurring: { interval: 'year', interval_count: 1 } };
const MONTH = { recurring: { interval: 'month', interval_count: 1 } };

function sub(over: Partial<ReminderSubscription> & { end?: string; price?: typeof YEAR } = {}): ReminderSubscription {
  const end = over.end ?? '2026-11-09T10:00:00Z';
  return {
    id: 'sub_test', status: 'active', cancel_at_period_end: false, cancel_at: null, trial_end: null, customer: 'cus_test', schedule: null,
    items: { data: [{ price: over.price ?? YEAR, current_period_start: ts(end) - 365 * 86400, current_period_end: ts(end) }] },
    ...over,
  };
}

describe('ANN-J7-01 — J−8 / J−7, calendrier de Paris', () => {
  const renewal = new Date('2026-11-09T10:00:00Z');
  it('J−8 : aucun envoi ; J−7 : envoi nominal', () => {
    expect(reminderTiming(new Date('2026-11-01T08:00:00Z'), renewal, '2026-10-01')).toMatchObject({ send: false, reason: 'TOO_EARLY', days: 8 });
    expect(reminderTiming(new Date('2026-11-02T08:00:00Z'), renewal, '2026-10-01')).toEqual({ send: true, days: 7, catchUp: false });
  });
  it('jours CALENDAIRES de Paris : échéance à 0 h 30 heure de Paris (veille en UTC), passage d’heure d’hiver', () => {
    // 2026-11-09 00:30 Paris = 2026-11-08 23:30 UTC : J−7 = 2 novembre (Paris), pas le 1er.
    const r = new Date('2026-11-08T23:30:00Z');
    expect(reminderTiming(new Date('2026-11-01T22:59:00Z'), r, null)).toMatchObject({ send: false, reason: 'TOO_EARLY' }); // 1er nov. 23 h 59 Paris
    expect(reminderTiming(new Date('2026-11-01T23:01:00Z'), r, null)).toMatchObject({ send: true, days: 7 }); // 2 nov. 0 h 01 Paris
    // Échéance le 1er novembre ; J−7 le 25 octobre (jour du changement d'heure).
    expect(reminderTiming(new Date('2026-10-25T07:30:00Z'), new Date('2026-11-01T09:00:00Z'), null)).toMatchObject({ send: true, days: 7 });
  });
  it('date affichée en français, fuseau de Paris', () => {
    expect(formatRenewalDate(new Date('2026-11-08T23:30:00Z'))).toBe('9 novembre 2026');
  });
});

describe('ANN-J7-02 — année suivante : nouvelle clé', () => {
  it('une clé par abonnement et par échéance', () => {
    expect(annualRenewalDedupeKey('sub_1', '2026-11-09')).toBe('annual-renewal-reminder:sub_1:2026-11-09');
    expect(annualRenewalDedupeKey('sub_1', '2027-11-09')).not.toBe(annualRenewalDedupeKey('sub_1', '2026-11-09'));
  });
});

describe('ANN-J7-03 — mensuel, essai, premier paiement après essai', () => {
  it('annuel actif : éligible, échéance = current_period_end des items (basil)', () => {
    const e = evaluateStripeEligibility(sub());
    expect(e).toMatchObject({ ok: true, renewalTs: ts('2026-11-09T10:00:00Z'), scheduleId: null });
  });
  it('mensuel : exclu ; un item mensuel parmi des annuels : exclu', () => {
    expect(evaluateStripeEligibility(sub({ price: MONTH }))).toEqual({ ok: false, reason: 'NOT_ANNUAL' });
    const mixte = sub();
    mixte.items.data.push({ price: MONTH, current_period_end: ts('2026-11-09T10:00:00Z') });
    expect(evaluateStripeEligibility(mixte)).toEqual({ ok: false, reason: 'NOT_ANNUAL' });
    expect(evaluateStripeEligibility(sub({ price: { recurring: { interval: 'year', interval_count: 2 } } }))).toEqual({ ok: false, reason: 'NOT_ANNUAL' });
  });
  it('essai de 7 jours (trialing) : exclu — c’est aussi le premier paiement après essai', () => {
    expect(evaluateStripeEligibility(sub({ status: 'trialing', trial_end: ts('2026-11-09T10:00:00Z') }))).toEqual({ ok: false, reason: 'TRIALING' });
  });
  it('fin d’essai qui coïncide avec l’échéance (statut déjà actif) : exclu', () => {
    expect(evaluateStripeEligibility(sub({ trial_end: ts('2026-11-09T10:00:00Z') }))).toEqual({ ok: false, reason: 'FIRST_PAYMENT_AFTER_TRIAL' });
  });
  it('premier RENOUVELLEMENT après un essai terminé il y a un an : éligible', () => {
    expect(evaluateStripeEligibility(sub({ trial_end: ts('2025-11-09T10:00:00Z') })).ok).toBe(true);
  });
  it('impayé, incomplet, annulé : exclus', () => {
    for (const status of ['past_due', 'unpaid', 'canceled', 'incomplete']) {
      expect(evaluateStripeEligibility(sub({ status }))).toEqual({ ok: false, reason: 'NOT_ACTIVE' });
    }
  });
});

describe('ANN-J7-04 — résiliation programmée, échéanciers', () => {
  it('cancel_at_period_end / cancel_at : exclus', () => {
    expect(evaluateStripeEligibility(sub({ cancel_at_period_end: true }))).toEqual({ ok: false, reason: 'CANCEL_AT_PERIOD_END' });
    expect(evaluateStripeEligibility(sub({ cancel_at: ts('2026-11-09T10:00:00Z') }))).toEqual({ ok: false, reason: 'CANCEL_AT_SET' });
  });
  const renewal = ts('2026-11-09T10:00:00Z');
  const phases = (next: unknown) => [
    { start_date: renewal - 365 * 86400, end_date: renewal, items: [{ price: YEAR }] },
    ...(next ? [next as never] : []),
  ];
  it('passage programmé au mensuel (phase suivante mensuelle) : exclu', () => {
    const s = sub({ schedule: { id: 'sub_sched_1', status: 'active', end_behavior: 'release', phases: phases({ start_date: renewal, end_date: null, items: [{ price: MONTH }] }) } });
    expect(evaluateStripeEligibility(s)).toEqual({ ok: false, reason: 'MONTHLY_SCHEDULED' });
  });
  it('échéancier qui résilie à l’échéance : exclu ; qui se libère : éligible', () => {
    expect(evaluateStripeEligibility(sub({ schedule: { id: 's', status: 'active', end_behavior: 'cancel', phases: phases(null) } }))).toEqual({ ok: false, reason: 'SCHEDULE_ENDS' });
    expect(evaluateStripeEligibility(sub({ schedule: { id: 's', status: 'active', end_behavior: 'release', phases: phases(null) } })).ok).toBe(true);
  });
  it('revalorisation annuelle programmée (nouveau prix annuel) : éligible, aperçu par échéancier', () => {
    const e = evaluateStripeEligibility(sub({ schedule: { id: 'sub_sched_2', status: 'active', end_behavior: 'release', phases: phases({ start_date: renewal, items: [{ price: { id: 'price_new', ...YEAR } }] }) } }));
    expect(e).toMatchObject({ ok: true, scheduleId: 'sub_sched_2' });
  });
  it('échéancier non développé ou prix non développé : suspendu par prudence', () => {
    expect(evaluateStripeEligibility(sub({ schedule: 'sub_sched_3' }))).toEqual({ ok: false, reason: 'SCHEDULE_UNREADABLE' });
    expect(evaluateStripeEligibility(sub({ schedule: { id: 's', status: 'active', phases: phases({ start_date: renewal, items: [{ price: 'price_x' }] }) } }))).toEqual({ ok: false, reason: 'SCHEDULE_UNREADABLE' });
  });
});

describe('ANN-J7-05 — montant prévisionnel', () => {
  const renewal = ts('2026-11-09T10:00:00Z');
  const line = (start = renewal, days = 365) => ({ period: { start, end: start + days * 86400 } });
  it('amount_due de l’aperçu (remises, taxes, crédits) sur la période renouvelée', () => {
    expect(renewalAmountFromPreview({ amount_due: 4720, currency: 'eur', lines: { data: [line()] } }, renewal)).toEqual({ cents: 4720, currency: 'eur' });
  });
  it('aperçu d’une autre échéance, d’un mois, ou sans montant : null (jamais inventé)', () => {
    expect(renewalAmountFromPreview({ amount_due: 4720, currency: 'eur', lines: { data: [line(renewal + 86400 * 30)] } }, renewal)).toBeNull();
    expect(renewalAmountFromPreview({ amount_due: 590, currency: 'eur', lines: { data: [line(renewal, 30)] } }, renewal)).toBeNull();
    expect(renewalAmountFromPreview({ amount_due: null, currency: 'eur', lines: { data: [line()] } }, renewal)).toBeNull();
    expect(renewalAmountFromPreview(null, renewal)).toBeNull();
  });
  it('format français : virgule, espace insécable, €', () => {
    expect(formatAmountFr(5900, 'eur')).toBe('59,00 €');
    expect(formatAmountFr(123456, 'eur')).toBe('1 234,56 €');
  });
  it('0 € : mention explicite de l’absence de prélèvement', () => {
    expect(amountLabelOf(0, 'eur')).toBe('0,00 € (aucun prélèvement n’est prévu)');
    expect(amountLabelOf(5900, 'eur')).toBe('59,00 €');
  });
});

describe('ANN-J7-06 — rattrapage avant l’échéance, jamais après', () => {
  const renewal = new Date('2026-11-09T10:00:00Z');
  it('J−3 et J−1 : rattrapage (« dans 3 jours », « demain »)', () => {
    expect(reminderTiming(new Date('2026-11-06T08:00:00Z'), renewal, '2026-10-01')).toEqual({ send: true, days: 3, catchUp: true });
    expect(renewalDelayLabel(7)).toBe('dans 7 jours');
    expect(renewalDelayLabel(3)).toBe('dans 3 jours');
    expect(renewalDelayLabel(1)).toBe('demain');
  });
  it('jour de l’échéance et après : jamais', () => {
    expect(reminderTiming(new Date('2026-11-09T07:00:00Z'), renewal, '2026-10-01')).toMatchObject({ send: false, reason: 'TOO_LATE' });
    expect(reminderTiming(new Date('2026-11-10T07:00:00Z'), renewal, '2026-10-01')).toMatchObject({ send: false, reason: 'TOO_LATE' });
  });
  it('bascule : J−7 antérieur au début de couverture → « couverture incertaine » (lot 72F : jamais présumé rappelé par Stripe)', () => {
    expect(reminderTiming(new Date('2026-11-06T08:00:00Z'), renewal, '2026-11-05')).toMatchObject({ send: false, reason: 'COVERAGE_UNCERTAIN' });
    // J−7 nominal le premier jour couvert : envoyé.
    expect(reminderTiming(new Date('2026-11-02T08:00:00Z'), renewal, '2026-11-02')).toMatchObject({ send: true, catchUp: false });
    // Lot 72F : J−7 nominal AVANT le premier jour couvert (jour de la désactivation Stripe) : incertain.
    expect(reminderTiming(new Date('2026-11-02T08:00:00Z'), renewal, '2026-11-03')).toMatchObject({ send: false, reason: 'COVERAGE_UNCERTAIN' });
  });
});

describe('ANN-J7-07 — gabarit et migration 0477', () => {
  it('texte exact du ticket ; migration identique au défaut du code ; jamais l’ancien SUBSCRIPTION_EXPIRING', async () => {
    const { DEFAULT_EMAIL_TEMPLATES } = await import('@/lib/email-defaults');
    const t = DEFAULT_EMAIL_TEMPLATES.SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER;
    expect(t.subject).toBe('Votre abonnement annuel Verebona sera renouvelé le {{renewalDate}}');
    for (const phrase of [
      'Bonjour {{firstName}},',
      'Votre abonnement annuel {{planLabel}} sera renouvelé automatiquement le {{renewalDate}}, {{renewalDelayLabel}}.',
      'Le renouvellement automatique est activé par défaut. Sans action de votre part, votre abonnement sera reconduit pour une nouvelle année.',
      'Montant prévu pour ce renouvellement : {{amountLabel}}.',
      'Si vous ne souhaitez pas renouveler votre abonnement, vous pouvez désactiver son renouvellement automatique avant cette date depuis votre espace de gestion Stripe.',
      'Gérer mon abonnement sur Stripe : {{manageSubscriptionUrl}}',
      'Vous pouvez également y consulter vos informations de facturation et vos moyens de paiement.',
      'L’équipe Verebona',
    ]) expect(t.body).toContain(phrase);
    // Jamais de demande de renouvellement ou de paiement manuel.
    expect(t.body).not.toMatch(/renouveler maintenant|payer|expire/i);
    const mig = read('src/db/migrations/0477_annual_renewal_reminder.sql');
    expect(mig).toContain(`$l68c_subject$${t.subject}$l68c_subject$`);
    expect(mig).toContain(`$l68c_body$${t.body}$l68c_body$`);
    expect(mig).toContain("WHERE NOT EXISTS (SELECT 1 FROM email_templates WHERE upper(type) = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER')");
    expect(mig).not.toMatch(/UPDATE email_templates|SUBSCRIPTION_EXPIRING'\s*,/);
  });
  it('lien obligatoire : sans bouton, l’e-mail n’est pas envoyé', async () => {
    const { LINK_REQUIRED_TEMPLATES } = await import('@/lib/email/email-service');
    expect(LINK_REQUIRED_TEMPLATES.has('SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER')).toBe(true);
  });
  it('BO › Communications : gabarit listé (aperçu, test), ancien modèle signalé non utilisé', async () => {
    const { TRANSACTIONAL_EMAILS, resolveTemplateVariables } = await import('@/services/admin/communications.service');
    expect(TRANSACTIONAL_EMAILS.find((x) => x.templateCode === 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER')).toBeTruthy();
    expect(TRANSACTIONAL_EMAILS.find((x) => x.templateCode === 'SUBSCRIPTION_EXPIRING')?.label).toMatch(/NON UTILISÉ/);
    const { variables, missingCount } = resolveTemplateVariables(['{{manageSubscriptionUrl}} {{renewalDelayLabel}} {{planLabel}} {{renewalDate}}'],
      { firstName: 'A', lastName: 'B', email: 'a@b.c', accountName: null, planLabel: 'PREMIUM_DUO' }, 'https://app.test');
    expect(variables).toMatchObject({ manageSubscriptionUrl: 'https://app.test/mon-compte/abonnement/gerer', renewalDelayLabel: 'dans 7 jours', planLabel: 'Premium Duo' });
    // Date sans contexte d'abonnement choisi : signalée manquante, jamais inventée.
    expect(missingCount).toBe(1);
  });
});

describe('ANN-J7-08 — tâche planifiée', () => {
  it('toutes les heures de 8 h 30 à 20 h (Paris) ; premier passage du jour à 8 h 30', async () => {
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const { computeNextRun, describeSchedule } = await import('@/services/scheduling/task-calendar');
    const t = SCHEDULED_TASKS.find((x) => x.code === 'subscription-annual-renewal-reminders')!;
    expect(t).toBeTruthy();
    expect(t.critical).toBeUndefined(); // suspendable depuis le BO
    expect(describeSchedule(t.schedule)).toBe('toutes les heures, de 8 h 30 à 20 h (Paris)');
    // Après le passage de 19 h 30 (Paris, hiver) : lendemain 8 h 30 = 7 h 30 UTC.
    expect(computeNextRun(t.schedule, new Date('2026-11-02T18:31:00Z'))?.toISOString()).toBe('2026-11-03T07:30:00.000Z');
    // Été : 8 h 30 Paris = 6 h 30 UTC.
    expect(computeNextRun(t.schedule, new Date('2026-06-02T18:31:00Z'))?.toISOString()).toBe('2026-06-03T06:30:00.000Z');
  });
  it('créée SUSPENDUE par la migration (activation = bascule, depuis le BO)', () => {
    const mig = read('src/db/migrations/0477_annual_renewal_reminder.sql');
    expect(mig).toMatch(/INSERT INTO scheduled_task_state \(code, admin_disabled[\s\S]*'subscription-annual-renewal-reminders', true/);
    expect(mig).toContain('ON CONFLICT (code) DO NOTHING');
  });
});

describe('ANN-J7-09 — lien permanent (navigation, refus)', () => {
  it('navigateur : replace ; application installée : navigation confiée au système, repli affiché', async () => {
    const { goToPortal } = await import('@/lib/billing/manage-subscription-redirect');
    const calls: string[] = [];
    const browser = { location: { href: '', protocol: 'https:', replace: (u: string) => calls.push(`replace:${u}`) } };
    expect(goToPortal('https://billing.stripe.com/p/session/x', browser)).toBe('replace');
    expect(calls).toEqual(['replace:https://billing.stripe.com/p/session/x']);
    const app = { location: { href: '', protocol: 'capacitor:', replace: () => calls.push('jamais') }, Capacitor: { isNativePlatform: () => true } };
    expect(goToPortal('https://billing.stripe.com/p/session/y', app)).toBe('external');
    expect(app.location.href).toBe('https://billing.stripe.com/p/session/y');
    expect(() => goToPortal('javascript:alert(1)', browser)).toThrow('PORTAL_URL_INVALID');
  });
  it('invité Duo : refus explicite, sans donnée du titulaire', async () => {
    const { portalErrorView } = await import('@/lib/billing/manage-subscription-redirect');
    const v = portalErrorView('DUO_GUEST');
    expect(v).toMatchObject({ title: 'Gestion réservée au titulaire', retry: false });
    expect(portalErrorView('PORTAL_SESSION_FAILED').retry).toBe(true);
  });
  it('page : session créée à l’ouverture par la route existante (aucune URL Stripe dans l’e-mail)', () => {
    // Lot 72F : vue partagée (lien permanent et lien contextualisé au compte facturé).
    expect(read('src/app/(dashboard)/mon-compte/abonnement/gerer/page.tsx')).toContain('ManageSubscriptionView');
    const page = read('src/components/billing/ManageSubscriptionView.tsx');
    expect(page).toContain("'/api/billing/create-customer-portal-session'");
    const route = read('src/app/api/billing/create-customer-portal-session/route.ts');
    expect(route).toContain('resolveBillingPortalAccess');
    expect(route).not.toContain('billingPortal.sessions.create'); // logique unique dans le service
    expect(read('src/middleware.ts')).toContain("'/mon-compte'"); // page protégée → connexion puis retour
  });
});

describe('ANN-J7-10 — portail Stripe : désactivation du renouvellement', () => {
  it('à l’échéance : oui ; immédiate ou désactivée : non ; inconnue : indéterminé', () => {
    expect(portalAllowsRenewalDisable({ features: { subscription_cancel: { enabled: true, mode: 'at_period_end' } } })).toBe(true);
    expect(portalAllowsRenewalDisable({ features: { subscription_cancel: { enabled: true, mode: 'immediately' } } })).toBe(false);
    expect(portalAllowsRenewalDisable({ features: { subscription_cancel: { enabled: false } } })).toBe(false);
    expect(portalAllowsRenewalDisable(null)).toBeNull();
  });
});
