/**
 * Lot 72F — ticket P1 « Abonnements annuels — Fiabiliser le rappel J−7 avant
 * renouvellement » : règles pures, contrats statiques (migration, tâche, file,
 * BO). Le comportement intégré (PostgreSQL 16, doubles Stripe et Resend) est
 * prouvé par `src/test/e2e/scenarios/l72f-rappel-j7-fiabilisation.e2e.ts`.
 *
 * RJ7F-01 Identité d'envoi stable : clé `vb-email-job-<id>-g<génération>`,
 *         jamais le numéro de tentative ; classement des réponses Resend
 *         (refus confirmé / acceptation incertaine).
 * RJ7F-02 Fenêtre d'idempotence Resend (24 h, réémission ≤ 23 h) ;
 *         étiquette de la demande lue dans les webhooks.
 * RJ7F-03 Lien contextualisé : référence du compte facturé, lecture stricte,
 *         messages de refus sans donnée d'un autre compte.
 * RJ7F-04 Bascule : couverture au lendemain de la désactivation Stripe ;
 *         J−7 antérieurs ou du jour même → « couverture incertaine ».
 * RJ7F-05 Suspension respectée à l'envoi, sans bloquer les autres e-mails.
 * RJ7F-06 Réconciliation : écarts Stripe / copie locale détectés ; tâche
 *         planifiée créée suspendue.
 * RJ7F-07 Journal et BO : états distincts, jamais « livré » sans
 *         confirmation ; aucun secret journalisé.
 * RJ7F-08 Offre du prochain renouvellement : prix de la ligne de
 *         renouvellement (changement programmé), à défaut phase d'échéancier.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coverageFromSwitch, redactSecrets, reminderTiming, renewalPriceIdsFromPreview, renewalPriceIdsFromSubscription,
  type ReminderSchedule, type ReminderSubscription,
} from '../annual-renewal-reminder.rules';

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const ts = (isoStr: string) => Math.floor(new Date(isoStr).getTime() / 1000);

describe('RJ7F-01 — identité d’envoi stable, classement des réponses du prestataire', () => {
  it('clé stable par génération, jamais par tentative', async () => {
    const { emailJobIdempotencyKey } = await import('@/services/email/transactional-email-jobs.service');
    expect(emailJobIdempotencyKey(42, 0)).toBe('vb-email-job-42-g0');
    expect(emailJobIdempotencyKey(42, 3)).toBe('vb-email-job-42-g3');
    const src = read('src/services/email/transactional-email-jobs.service.ts');
    expect(src).not.toMatch(/vb-email-job-\$\{job\.id\}-\$\{job\.attempts\}/);
    expect(src).toContain('idempotencyKey: emailJobIdempotencyKey(job.id, job.send_generation)');
    // Marque persistante AVANT la transmission (reprise après arrêt du processus).
    expect(src).toMatch(/beforeProviderCall: async \(\) => \{[\s\S]*provider_call_started_at = COALESCE\(provider_call_started_at/);
  });
  it('réseau, délai, 5xx, 409 d’idempotence : acceptation INCERTAINE ; 4xx explicites : refus confirmé', async () => {
    const { classifyProviderError } = await import('@/lib/email/email-service');
    expect(classifyProviderError({ name: 'application_error', statusCode: null, message: 'Unable to fetch data.' })).toBe('uncertain');
    expect(classifyProviderError({ name: 'internal_server_error', statusCode: 500 })).toBe('uncertain');
    expect(classifyProviderError({ name: 'application_error', statusCode: 503 })).toBe('uncertain');
    expect(classifyProviderError({ name: 'concurrent_idempotent_requests', statusCode: 409 })).toBe('uncertain');
    expect(classifyProviderError({ name: 'invalid_idempotent_request', statusCode: 409 })).toBe('uncertain');
    expect(classifyProviderError({ name: 'something_new', statusCode: null })).toBe('uncertain');
    expect(classifyProviderError({ name: 'validation_error', statusCode: 422 })).toBe('rejected');
    expect(classifyProviderError({ name: 'rate_limit_exceeded' })).toBe('rejected');
    expect(classifyProviderError({ name: 'invalid_from_address', statusCode: 403 })).toBe('rejected');
    expect(classifyProviderError(null)).toBe('uncertain');
  });
  it('un échec de journal APRÈS l’acceptation reste une acceptation (jamais de reprise aveugle)', () => {
    const src = read('src/lib/email/email-service.ts');
    expect(src).toMatch(/if \(acceptedId\) return \{ success: true, providerMessageId: acceptedId, providerCalled: true \}/);
    expect(src).toMatch(/journal de l’envoi accepté impossible/);
  });
  it('refus d’une RÉÉMISSION : l’incertitude d’origine est conservée (même clé)', () => {
    const src = read('src/services/email/transactional-email-jobs.service.ts');
    expect(src).toContain('if (res?.uncertain || (res?.providerCalled && replay))');
    expect(src).toContain("res?.providerCalled ? { providerOutcome: 'rejected', providerDetail: detail, newGeneration: true } : {}");
  });
});

describe('RJ7F-02 — fenêtre d’idempotence Resend, webhooks étiquetés', () => {
  it('réémission avec la même clé jusqu’à 23 h ; au-delà consultation Resend, sinon blocage', async () => {
    const m = await import('@/services/email/transactional-email-jobs.service');
    expect(m.PROVIDER_IDEMPOTENCY_WINDOW_MS).toBe(24 * 3_600_000);
    expect(m.PROVIDER_REPLAY_WINDOW_MS).toBeLessThan(m.PROVIDER_IDEMPOTENCY_WINDOW_MS);
    const src = read('src/services/email/transactional-email-jobs.service.ts');
    expect(src).toContain("await close('uncertain', { error: 'UNCERTAIN_ACCEPTANCE'");
    // Une demande incertaine n'est jamais reprise par la file (statut hors sélection).
    expect(src).toMatch(/WHERE \(\(status = 'pending' AND next_attempt_at <= \$1::timestamptz\)\s+OR \(status = 'sending' AND locked_until < \$1::timestamptz\)\)/);
  });
  it('étiquette `vb_email_job` lue dans un webhook (objet ou tableau)', async () => {
    const { emailJobIdFromTags } = await import('@/services/email/email-provider-events.service');
    expect(emailJobIdFromTags({ vb_email_job: '17', vb_send_gen: '0' })).toBe(17);
    expect(emailJobIdFromTags([{ name: 'vb_email_job', value: '18' }])).toBe(18);
    expect(emailJobIdFromTags({ vb_email_job: 'x' })).toBeNull();
    expect(emailJobIdFromTags(undefined)).toBeNull();
  });
});

describe('RJ7F-03 — lien contextualisé au compte facturé', () => {
  it('référence stricte : entier positif, sinon invalide ; absente : comportement historique', async () => {
    const { parseAccountRef } = await import('@/services/billing/customer-portal.service');
    expect(parseAccountRef('123')).toBe(123);
    expect(parseAccountRef(45)).toBe(45);
    expect(parseAccountRef(undefined)).toBeNull();
    expect(parseAccountRef('')).toBeNull();
    for (const bad of ['abc', '0', '-1', '1.5', '12a', '99999999999', ' 1 2']) expect(parseAccountRef(bad)).toBe('INVALID');
  });
  it('lien de l’e-mail : /mon-compte/abonnement/gerer/<compte> ; aucune URL de session Stripe', async () => {
    const { manageSubscriptionUrlFor } = await import('@/services/billing/annual-renewal-reminder.service');
    expect(manageSubscriptionUrlFor(321, 'https://app.test')).toBe('https://app.test/mon-compte/abonnement/gerer/321');
    const page = read('src/app/(dashboard)/mon-compte/abonnement/gerer/[compte]/page.tsx');
    expect(page).toContain('ManageSubscriptionView');
    expect(read('src/components/billing/ManageSubscriptionView.tsx')).toContain('accountRef ? { accountRef } : {}');
  });
  it('refus explicites, sans donnée d’un autre compte ; jamais de repli silencieux', async () => {
    const { portalErrorView } = await import('@/lib/billing/manage-subscription-redirect');
    expect(portalErrorView('ACCOUNT_FORBIDDEN')).toMatchObject({ title: 'Lien réservé au titulaire de cet abonnement', retry: false });
    expect(portalErrorView('BILLING_MISMATCH').retry).toBe(false);
    expect(portalErrorView('INVALID_ACCOUNT_REF').retry).toBe(false);
    const route = read('src/app/api/billing/create-customer-portal-session/route.ts');
    expect(route).toMatch(/ref === null\s+\? await resolveBillingPortalAccess\(session\.userId, session\.currentAccountId\)\s+: await resolveBillingPortalAccessForAccount\(session\.userId, ref\)/);
    const svc = read('src/services/billing/customer-portal.service.ts');
    expect(svc).toContain("if (acc.duo_guest || (acc.any_member && acc.duo_billing_owner != null)) return deny('DUO_GUEST', 403);");
    expect(svc).toContain("if (sub && subCustomer !== customerId) return mismatch(accountId, 'STRIPE_CUSTOMER_DIFFERS');");
  });
});

describe('RJ7F-04 — bascule sans chevauchement, couverture incertaine signalée', () => {
  const renewal = new Date('2026-11-12T10:00:00Z'); // J−7 = 5 novembre (Paris)
  it('couverture = lendemain (Paris) de la désactivation déclarée des rappels Stripe', () => {
    expect(coverageFromSwitch(new Date('2026-11-04T09:00:00Z'))).toBe('2026-11-05');
    // 23 h 30 à Paris le 4 = 22 h 30 UTC : toujours le 4 à Paris.
    expect(coverageFromSwitch(new Date('2026-11-04T22:30:00Z'))).toBe('2026-11-05');
    expect(coverageFromSwitch(new Date('2026-11-04T23:30:00Z'))).toBe('2026-11-06');
  });
  it('J−7 le jour de la désactivation ou avant : incertain (jamais présumé envoyé par Stripe) ; après : envoyé', () => {
    expect(reminderTiming(new Date('2026-11-05T08:00:00Z'), renewal, '2026-11-06')).toMatchObject({ send: false, reason: 'COVERAGE_UNCERTAIN' });
    expect(reminderTiming(new Date('2026-11-07T08:00:00Z'), renewal, '2026-11-06')).toMatchObject({ send: false, reason: 'COVERAGE_UNCERTAIN' });
    expect(reminderTiming(new Date('2026-11-05T08:00:00Z'), renewal, '2026-11-05')).toEqual({ send: true, days: 7, catchUp: false });
    // Revalidation avant l'envoi : pas de contrôle de couverture (décision déjà prise).
    expect(reminderTiming(new Date('2026-11-07T08:00:00Z'), renewal, null)).toEqual({ send: true, days: 5, catchUp: true });
  });
  it('sans bascule déclarée, rien n’est préparé ni envoyé ; retour arrière exige la tâche suspendue', () => {
    const src = read('src/services/billing/annual-renewal-reminder.service.ts');
    expect(src).toContain("if (!sw.stripeRemindersDisabledAt) return { ...result, skipped: 'SWITCH_NOT_DECLARED' };");
    expect(src).toContain("if (!sched.suspended && !sched.stoppedByEnv) return { ok: false, code: 'TASK_ACTIVE' };");
    expect(src).toContain("SET status = 'cancelled', last_error = 'ROLLBACK_NEUTRALIZED'");
    expect(src).toMatch(/FINAL_CANCEL_REASONS = \[[^\]]*'ROLLBACK_NEUTRALIZED'/);
    const cat = read('src/services/scheduling/scheduled-tasks.catalog.ts');
    expect(cat).toContain("if (r.skipped === 'SWITCH_NOT_DECLARED')");
  });
});

describe('RJ7F-05 — suspension respectée au moment de l’envoi', () => {
  it('file : rappels annuels écartés de la sélection quand ils sont bloqués ; envoi : contrôle juste avant', () => {
    const src = read('src/services/email/transactional-email-jobs.service.ts');
    expect(src).toContain("AND NOT ($3::boolean AND kind = 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER')");
    expect((src.match(/const block = await annualBlock\(\);/g) ?? []).length).toBe(2);
    // Tentative non consommée.
    expect(src).toContain('attempts = GREATEST(attempts - 1, 0)');
    const svc = read('src/services/billing/annual-renewal-reminder.service.ts');
    expect(svc).toContain("if (!isTaskEnabled(ANNUAL_RENEWAL_TASK_CODE)) return 'TASK_SUSPENDED';");
    expect(svc).toContain("if (!r?.declared) return 'SWITCH_NOT_DECLARED';");
  });
});

describe('RJ7F-06 — réconciliation planifiée avec Stripe', () => {
  it('écarts détectés : absent, statut, périodicité, échéance, résiliation', async () => {
    const { desyncReasons } = await import('../annual-renewal-reconcile.service');
    const v = { id: 'sub_1', customer: 'cus_1', status: 'active', annual: true, renewalTs: ts('2026-11-12T10:00:00Z'), cancelScheduled: false };
    const ok = { account_id: 1, status: 'active', billing_period: 'yearly', cancel_at_period_end: false, current_period_end_at: '2026-11-12T10:00:30Z' };
    expect(desyncReasons(v, ok)).toEqual([]);
    expect(desyncReasons(v, null)).toEqual(['LOCAL_MISSING']);
    expect(desyncReasons(v, { ...ok, billing_period: 'monthly' })).toEqual(['BILLING_PERIOD']);
    expect(desyncReasons(v, { ...ok, cancel_at_period_end: true })).toEqual(['CANCELLATION']);
    expect(desyncReasons(v, { ...ok, status: 'canceled', current_period_end_at: '2025-11-12T10:00:00Z' })).toEqual(['STATUS', 'PERIOD_END']);
    expect(desyncReasons({ ...v, cancelScheduled: true }, ok)).toEqual(['CANCELLATION']);
  });
  it('réutilise subscription-sync ; tâche quotidienne 7 h 40 créée suspendue (0524)', async () => {
    expect(read('src/services/billing/annual-renewal-reconcile.service.ts')).toContain("syncSubscriptionFromStripe({ subscription: sub as Stripe.Subscription, source: 'annual-reminder-reconcile', notify: false })");
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const t = SCHEDULED_TASKS.find((x) => x.code === 'subscription-annual-renewal-reconcile')!;
    expect(t.schedule).toMatchObject({ kind: 'daily', at: [7, 40] });
    expect(t.critical).toBeUndefined();
    const mig = read('src/db/migrations/0524_l72f_rappel_annuel_fiabilisation.sql');
    expect(mig).toMatch(/INSERT INTO scheduled_task_state \(code, admin_disabled[\s\S]*'subscription-annual-renewal-reconcile', true/);
    expect(mig).toContain("CHECK (status IN ('pending', 'sending', 'accepted', 'failed', 'cancelled', 'uncertain'))");
    expect(mig).not.toMatch(/CONCURRENTLY/);
    expect(read('src/db/migrations/0524_l72f_rappel_annuel_fiabilisation_idx_1.sql')).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS email_provider_events_email_job_idx/);
    expect(read('docs/exploitation/taches-planifiees.md')).toContain('`subscription-annual-renewal-reconcile`');
  });
});

describe('RJ7F-07 — journal et BO : états distincts, aucun secret', () => {
  it('état consolidé : jamais « livré » sans confirmation, jamais « accepté » pour un e-mail désactivé ou incertain', async () => {
    const { reminderStateOf } = await import('@/services/billing/annual-renewal-reminder.service');
    const base = { outcome: 'ENQUEUED', job_status: 'pending', job_attempts: 0, job_last_error: null, provider_outcome: null, delivery_status: null };
    expect(reminderStateOf({ ...base, job_status: null, outcome: 'EXCLUDED' })).toBe('EXCLUDED');
    expect(reminderStateOf({ ...base, job_status: null, outcome: 'STRIPE_ERROR' })).toBe('STRIPE_ERROR');
    expect(reminderStateOf(base)).toBe('PREPARED');
    expect(reminderStateOf({ ...base, job_status: 'sending' })).toBe('SENDING');
    expect(reminderStateOf({ ...base, job_attempts: 2, job_last_error: 'AMOUNT_UNAVAILABLE' })).toBe('TEMPORARY_FAILURE');
    expect(reminderStateOf({ ...base, job_last_error: 'TASK_SUSPENDED' })).toBe('HELD');
    expect(reminderStateOf({ ...base, provider_outcome: 'uncertain', job_attempts: 1, job_last_error: 'UNCERTAIN: x' })).toBe('UNCERTAIN');
    expect(reminderStateOf({ ...base, job_status: 'uncertain' })).toBe('UNCERTAIN');
    expect(reminderStateOf({ ...base, job_status: 'accepted' })).toBe('ACCEPTED');
    expect(reminderStateOf({ ...base, job_status: 'accepted', delivery_status: 'delivered' })).toBe('DELIVERED');
    expect(reminderStateOf({ ...base, job_status: 'accepted', delivery_status: 'bounced' })).toBe('DELIVERY_PROBLEM');
    expect(reminderStateOf({ ...base, job_status: 'failed' })).toBe('FINAL_FAILURE');
    expect(reminderStateOf({ ...base, job_status: 'cancelled', job_last_error: 'CHANNEL_DISABLED' })).toBe('CANCELLED');
  });
  it('motifs journalisés sans clé ni secret ni lien de session Stripe', () => {
    expect(redactSecrets('Invalid API Key provided: sk_live_abcdEFGH1234')).toBe('Invalid API Key provided: [clé masquée]');
    expect(redactSecrets('rk_test_51Habc et whsec_AbC+/= et re_123456789abc')).toBe('[clé masquée] et [secret masqué] et [clé masquée]');
    expect(redactSecrets('voir https://billing.stripe.com/p/session/test_x')).toBe('voir [lien Stripe masqué]');
  });
  it('BO : composant desktop et mobile (tableaux défilants, boutons empilés), route administrateur journalisée', () => {
    const ui = read('src/app/admin/communications/_components/AnnualRenewalOps.tsx');
    expect(ui).toContain('overflow-x-auto');
    expect(ui).toContain('flex flex-col gap-1 sm:flex-row');
    expect(ui).not.toMatch(/billing\.stripe\.com|stripe_customer_id/);
    const route = read('src/app/api/admin/communications/annual-renewal/route.ts');
    expect(route).toContain('requireAdmin(request)');
    expect(route).toContain("action: 'ANNUAL_RENEWAL_OPERATION'");
  });
});

describe('RJ7F-08 — offre du prochain renouvellement (Stripe), jamais plan_code local', () => {
  const renewalTs = ts('2026-11-12T10:00:00Z');
  it('prix de la ligne de renouvellement de l’aperçu (API basil et anciennes versions)', () => {
    expect(renewalPriceIdsFromPreview({ amount_due: 8900, currency: 'eur', lines: { data: [
      { period: { start: renewalTs, end: renewalTs + 365 * 86400 }, pricing: { type: 'price_details', price_details: { price: 'price_duo_y' } } },
      { period: { start: renewalTs - 86400, end: renewalTs }, pricing: { price_details: { price: 'price_prorata' } } },
    ] } }, renewalTs)).toEqual(['price_duo_y']);
    expect(renewalPriceIdsFromPreview({ lines: { data: [{ period: { start: renewalTs, end: renewalTs + 1 }, price: { id: 'price_old' } }] } }, renewalTs)).toEqual(['price_old']);
    expect(renewalPriceIdsFromPreview(null, renewalTs)).toEqual([]);
  });
  it('à défaut : phase d’échéancier qui couvre l’échéance, sinon prix courant', () => {
    const sub = { id: 's', status: 'active', items: { data: [{ price: { id: 'price_now', recurring: { interval: 'year' } }, current_period_end: renewalTs }] } } as ReminderSubscription;
    const schedule: ReminderSchedule = { id: 'sch', status: 'active', phases: [
      { start_date: renewalTs - 365 * 86400, end_date: renewalTs, items: [{ price: 'price_now' }] },
      { start_date: renewalTs, end_date: null, items: [{ price: { id: 'price_next', recurring: { interval: 'year' } } }] },
    ] };
    expect(renewalPriceIdsFromSubscription(sub, schedule, renewalTs)).toEqual(['price_next']);
    expect(renewalPriceIdsFromSubscription(sub, null, renewalTs)).toEqual(['price_now']);
  });
  it('libellé : registre des prix (annuel, une seule offre) ; non identifiable → échec temporaire', () => {
    const src = read('src/services/billing/annual-renewal-reminder.service.ts');
    expect(src).toContain("if (plan === 'UNAVAILABLE' || !plan) return { ok: false, reason: 'PLAN_UNAVAILABLE', temporary: true };");
    expect(src).not.toMatch(/planLabelOf\(\{ planCode: acc\.plan_code/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Lot 76D — ticket P1 « Rappel annuel J−7 — risques résiduels de doublon et
// rollback ». Comportements prouvés sur PostgreSQL 16 par RJ7R-E2E-01 à 09
// (`src/test/e2e/scenarios/l72f-rappel-j7-fiabilisation.e2e.ts`) ; ici :
// règles pures et contrats (migration, tâche, documentation).
// ══════════════════════════════════════════════════════════════════════════

describe('RJ7R-01 — recherche Resend : jamais d’absence déduite d’une recherche partielle', () => {
  it('toutes les candidates sont inspectées (plus de tranche des 20 premières), limites explicites', async () => {
    const m = await import('@/services/email/transactional-email-jobs.service');
    expect(m.PROVIDER_LOOKUP_MAX_CANDIDATES).toBeGreaterThan(20);
    expect(m.PROVIDER_LOOKUP_MAX_MS).toBeGreaterThan(0);
    const src = read('src/services/email/transactional-email-jobs.service.ts');
    expect(src).not.toMatch(/candidates\.slice\(0,\s*20\)/);
    for (const motif of ['RESEND_CANDIDATES_LIMIT', 'RESEND_LISTING_PAGE_LIMIT', 'RESEND_LOOKUP_TIMEOUT', 'RESEND_CANDIDATE_MISSING']) expect(src).toContain(motif);
  });
  it('une demande neutralisée n’est jamais prise par la file (prise atomique et sélection)', () => {
    const src = read('src/services/email/transactional-email-jobs.service.ts');
    expect((src.match(/AND neutralized_at IS NULL/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('RJ7R-02 — BO : neutralisation, acceptation, incertitude et fin du retour arrière distinctes', () => {
  it('état consolidé : neutralisé ≠ annulé ; clos après un envoi incertain ≠ annulé sans envoi', async () => {
    const { reminderStateOf, REMINDER_STATE_LABELS } = await import('@/services/billing/annual-renewal-reminder.service');
    const base = { outcome: 'ENQUEUED', job_status: 'cancelled', job_attempts: 0, job_last_error: 'ROLLBACK_NEUTRALIZED', provider_outcome: null, delivery_status: null };
    expect(reminderStateOf(base)).toBe('NEUTRALIZED');
    expect(reminderStateOf({ ...base, provider_outcome: 'reconciled_absent' })).toBe('NEUTRALIZED');
    expect(reminderStateOf({ ...base, job_last_error: 'ADMIN_ABANDONED', provider_outcome: 'uncertain' })).toBe('CANCELLED_UNCERTAIN');
    expect(reminderStateOf({ ...base, job_last_error: 'SUBSCRIPTION_REPLACED', provider_outcome: 'uncertain' })).toBe('CANCELLED_UNCERTAIN');
    expect(reminderStateOf({ ...base, job_status: 'uncertain', job_last_error: 'ROLLBACK_UNCERTAIN', provider_outcome: 'uncertain' })).toBe('UNCERTAIN');
    expect(reminderStateOf({ ...base, job_status: null, outcome: 'RECONCILE_ERROR' })).toBe('RECONCILE_ERROR');
    expect(reminderStateOf({ ...base, job_status: null, outcome: 'RECONCILE_RESOLVED' })).toBe('RECONCILE_RESOLVED');
    expect(REMINDER_STATE_LABELS.CANCELLED_UNCERTAIN).not.toMatch(/sans envoi/);
    expect(REMINDER_STATE_LABELS.NEUTRALIZED).toMatch(/aucun envoi/);
    const ui = read('src/app/admin/communications/_components/AnnualRenewalOps.tsx');
    for (const k of ['NEUTRALIZED', 'CANCELLED_UNCERTAIN', 'RECONCILE_ERROR', 'RECONCILE_RESOLVED']) expect(ui).toContain(`${k}:`);
    expect(ui).toContain('annual-renewal-rollback-state');
  });
});

describe('RJ7R-03 — rollback en phases : en cours tant que des envois ne sont pas résolus', () => {
  it('route BO : contrôle et finalisation (arbitrage explicite des échéances notifiées)', () => {
    const route = read('src/app/api/admin/communications/annual-renewal/route.ts');
    expect(route).toContain("action === 'rollback-check'");
    expect(route).toContain("action === 'rollback-finalize'");
    expect(route).toContain('acknowledgeNotified');
  });
  it('contrôle du retour arrière par la tâche existante `transactional-emails-retry` (aucune requête HTTP maintenue ouverte)', () => {
    const cat = read('src/services/scheduling/scheduled-tasks.catalog.ts');
    expect(cat).toMatch(/code: 'transactional-emails-retry'[\s\S]{0,1500}advanceAnnualRenewalRollback/);
  });
});

describe('RJ7R-04 — statuts Stripe et locaux comparés dans les deux sens', () => {
  const v = { id: 'sub_1', customer: 'cus_1', status: 'active', annual: true, renewalTs: ts('2026-11-12T10:00:00Z'), cancelScheduled: false };
  const ok = { account_id: 1, status: 'active', billing_period: 'yearly', cancel_at_period_end: false, current_period_end_at: '2026-11-12T10:00:30Z' };
  it('local actif, Stripe past_due / unpaid / canceled / paused / incomplete : divergence STATUS', async () => {
    const { desyncReasons } = await import('../annual-renewal-reconcile.service');
    for (const s of ['past_due', 'unpaid', 'canceled', 'paused', 'incomplete', 'incomplete_expired']) expect(desyncReasons({ ...v, status: s }, ok)).toContain('STATUS');
  });
  it('correspondances du modèle (subscription-sync) : trialing → active, unpaid → canceled ; cohérent → aucun écart', async () => {
    const { desyncReasons, expectedLocalStatus } = await import('../annual-renewal-reconcile.service');
    expect(expectedLocalStatus('trialing')).toBe('active');
    expect(expectedLocalStatus('past_due')).toBe('past_due');
    expect(expectedLocalStatus('unpaid')).toBe('canceled');
    expect(expectedLocalStatus('paused')).toBeNull();
    expect(desyncReasons({ ...v, status: 'past_due' }, { ...ok, status: 'past_due' })).toEqual([]);
    expect(desyncReasons({ ...v, status: 'unpaid' }, { ...ok, status: 'canceled' })).toEqual([]);
    expect(desyncReasons({ ...v, status: 'trialing' }, ok)).toEqual([]);
  });
});

describe('RJ7R-05 — erreurs du parcours inverse persistées ; passage partiel jamais présenté comme réussi', () => {
  it('compte rendu de tâche : erreur dès qu’une relecture échoue ou que le parcours est incomplet', async () => {
    const { describeReconcileRun } = await import('../annual-renewal-reconcile.service');
    const r = { scanned: 3, inWindow: 1, consistent: 1, resynced: 0, unresolved: 0, stripeOnly: 0, localOnlyChecked: 2, errors: 0, complete: true, reverseComplete: true };
    expect(describeReconcileRun(r).error).toBeUndefined();
    expect(describeReconcileRun({ ...r, errors: 1 }).error).toMatch(/relecture/);
    expect(describeReconcileRun({ ...r, reverseComplete: false }).error).toBeTruthy();
    expect(describeReconcileRun({ ...r, complete: false }).error).toBeTruthy();
    const cat = read('src/services/scheduling/scheduled-tasks.catalog.ts');
    expect(cat).toContain('describeReconcileRun(r)');
  });
});

describe('RJ7R-06 — migration 0585 et documentation d’exploitation', () => {
  it('migration idempotente, index séparé CONCURRENTLY', () => {
    const mig = read('src/db/migrations/0585_l76d_rappel_j7_rollback.sql');
    expect(mig).toContain('ADD COLUMN IF NOT EXISTS neutralized_at timestamptz');
    expect(mig).toContain("CHECK (rollback_status IS NULL OR rollback_status IN ('in_progress', 'completed'))");
    expect(mig).toContain("'RECONCILE_ERROR', 'RECONCILE_RESOLVED'");
    expect(mig).toContain('renewal_date_verified boolean NOT NULL DEFAULT true');
    expect(mig).not.toMatch(/CONCURRENTLY/);
    expect(read('src/db/migrations/0585_l76d_rappel_j7_rollback_idx_1.sql')).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS transactional_email_jobs_neutralized_idx/);
  });
  it('doc : la suspension n’arrête pas un appel déjà transmis ; états et arbitrages du retour arrière', () => {
    const doc = read('docs/exploitation/rappel-renouvellement-annuel.md');
    expect(doc).not.toContain('plus aucun rappel annuel n\'est envoyé, même déjà préparé');
    expect(doc).toMatch(/n['’]arrête pas un appel déjà transmis/);
    expect(doc).toContain('Retour arrière en cours');
    expect(doc).toContain('Retour arrière terminé');
    expect(doc).toMatch(/ne réactivez? (pas )?les rappels Stripe|Ne pas réactiver les rappels Stripe/i);
    expect(doc).not.toMatch(/whsec_|re_[A-Za-z0-9]{8,}/);
  });
});
