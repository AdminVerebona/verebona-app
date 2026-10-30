/**
 * Lot 100G — séquence d'e-mails de fin d'essai (décision PO « Questions PO 3 »,
 * E, E1, E2, F). Tests unitaires (sans base) :
 *
 *   L100G-TPL-01  modèles E1 : aucun expéditeur, aucune signature, aucun « De »,
 *                 variables déclarées = variables employées
 *   L100G-TPL-02  migration 0887 : textes livrés identiques aux modèles du code
 *   L100G-TPL-03  éditeur du BO : textes livrés valides ; désinscription
 *                 obligatoire des relances ; jamais dans une notification de service
 *   L100G-OBS-01  plus aucune mention d'un essai de 60 jours / 2 mois offerts / 59 €
 *   L100G-RUL-01  jalons, décalages, fenêtres ; J+60 maximum ; défauts prudents
 *   L100G-RUL-02  chaque jalon envoyé à sa date (état nominal, horloge figée)
 *   L100G-RUL-03  chaque motif de non-envoi (terminal ou en attente)
 *   L100G-RUL-04  J+80 bloqué côté serveur, quels que soient les réglages
 *   L100G-LNK-01  {{offersUrl}} (parcours Web, ancre configurable), désinscription signée
 *   L100G-INT-01  un seul circuit : notifications TRIAL_* sans e-mail propre,
 *                 anciens modèles retirés, tâche planifiée, en-têtes, lien discret
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMMERCIAL_LAST_DAY_MAX, DEFAULT_SETTINGS, MILESTONES, NON_SEND_REASONS, TRIAL_RETENTION_PURGE_IMPLEMENTED,
  decideMessage, dueAtOf, envSwitches, mergeSettings, milestoneDef, validateSettings, windowEndOf,
  type CurrentState, type DecisionEnv, type TrialLifecycleSettings,
} from '../milestones';
import { OBSOLETE_TRIAL_MENTION, RETIRED_TRIAL_TEMPLATES, TRIAL_SHIPPED_TEMPLATES } from '../templates';
import { buildOffersUrl, buildUnsubscribeUrl, createUnsubscribeToken, formatTrialDate, unsubscribeSecret, verifyUnsubscribeToken } from '../links';
import { templateFormat, validateDraft, variableSpecFor, limitedEditReason, extractVariables } from '@/lib/email/template-editor';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ── Modèles ─────────────────────────────────────────────────────────────────

describe('L100G-TPL-01 — modèles E1 (règle absolue : ni expéditeur, ni signature, ni « De »)', () => {
  it('7 modèles, un par jalon', () => {
    expect(TRIAL_SHIPPED_TEMPLATES.map((t) => t.type.toUpperCase())).toEqual(MILESTONES.map((m) => m.templateCode));
  });
  for (const t of TRIAL_SHIPPED_TEMPLATES) {
    it(`${t.type} : aucune adresse, signature ou champ « De » ; variables déclarées`, () => {
      const all = `${t.subject}\n${t.body}`;
      expect(all).not.toMatch(/@|cordialement|l[’']équipe|bien à vous|^\s*(de|from|exp[ée]diteur)\s*:/im);
      expect(all).not.toMatch(/noreply|support|verebona\.(fr|com)/i);
      expect(extractVariables(all).sort()).toEqual([...t.placeholders].sort());
      expect(templateFormat(t.body)).toBe('text');
    });
  }
  it('service (J−2, J0) : aucun lien de désinscription ; relances : toujours un', () => {
    for (const t of TRIAL_SHIPPED_TEMPLATES) {
      const code = t.type.toUpperCase();
      const m = MILESTONES.find((x) => x.templateCode === code)!;
      if (m.nature === 'service') expect(t.body).not.toContain('{{unsubscribeUrl}}');
      else expect(t.body).toMatch(/Ne plus recevoir (ces relances|de communications commerciales) : \{\{unsubscribeUrl\}\}/);
    }
  });
  it('J−2 et J0 : « aucun prélèvement » et « 7 jours » / « deux jours » (essai actuel)', () => {
    const [j2, j0] = TRIAL_SHIPPED_TEMPLATES;
    expect(j2.body).toContain('se termine dans deux jours');
    expect(j2.body).toContain('Aucun prélèvement automatique n’aura lieu à la fin de votre essai.');
    expect(j0.body).toContain('Votre période d’essai gratuite de 7 jours vient de se terminer.');
    expect(j0.body).toContain('Aucun prélèvement automatique n’a été effectué à la fin de votre essai.');
  });
});

describe('L100G-TPL-02 — migration 0887 = textes du code', () => {
  const sql = read('src/db/migrations/0887_l100g_modeles_fin_essai.sql');
  for (const t of TRIAL_SHIPPED_TEMPLATES) {
    it(t.type, () => {
      expect(sql).toContain(`${t.body}$l100g_b`);
      expect(sql).toContain(`${t.subject}$l100g_s`);
      expect(sql).toContain(`'${JSON.stringify(t.placeholders)}'`);
    });
  }
  it('migration additive et idempotente (aucune suppression, garde des gabarits personnalisés)', () => {
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b|\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bTRUNCATE\b/i);
    expect(sql).toMatch(/IS DISTINCT FROM l\.body/);
    expect(sql).toMatch(/WHERE NOT x\.is_customized/);
    expect(read('src/db/migrations/0886_l100g_sequence_fin_essai.sql')).not.toMatch(/\bDELETE\s+FROM\b|\bDROP\s+(TABLE|COLUMN|INDEX)\b|\bTRUNCATE\b/i);
  });
});

describe('L100G-TPL-03 — éditeur du BO : variables et mentions', () => {
  const check = (code: string, subject: string, body: string) =>
    validateDraft({ code, subject, body, format: templateFormat(body), spec: variableSpecFor(code, { format: templateFormat(body) }) });
  for (const t of TRIAL_SHIPPED_TEMPLATES) {
    it(`${t.type} : texte livré accepté tel quel, édition limitée motivée`, () => {
      expect(check(t.type.toUpperCase(), t.subject, t.body)).toEqual([]);
      expect(limitedEditReason(t.type)).toBeTruthy();
    });
  }
  it('relance sans lien de désinscription : refusée', () => {
    const t = TRIAL_SHIPPED_TEMPLATES.find((x) => x.type === 'TRIAL_FOLLOWUP_J3')!;
    const codes = check('TRIAL_FOLLOWUP_J3', t.subject, t.body.replace(/\n\nNe plus recevoir[\s\S]*$/, '')).map((i) => i.code);
    expect(codes).toContain('REQUIRED_VARIABLE_MISSING');
    expect(codes).toContain('REQUIRED_MENTION_MISSING');
  });
  it('notification de service : {{unsubscribeUrl}} inconnu (jamais ajouté à un e-mail de service)', () => {
    const t = TRIAL_SHIPPED_TEMPLATES[1];
    expect(check('NOTIF_TRIAL_ENDED', t.subject, `${t.body}\n\nNe plus recevoir : {{unsubscribeUrl}}`).map((i) => i.code)).toContain('UNKNOWN_VARIABLE');
  });
  it('ancien texte 0077 personnalisé ({{body}}, {{actionUrl}}) toujours accepté', () => {
    expect(check('NOTIF_TRIAL_ENDED', 'Votre essai est terminé', '{{body}}\n\nAccéder à Verebona : {{actionUrl}}')).toEqual([]);
  });
});

describe('L100G-OBS-01 — aucune mention d’un essai de 60 jours, de 2 mois offerts ou de 59 €', () => {
  it('motif de détection', () => {
    for (const s of ['essai de 60 jours', 'Verebona Premium (2 mois offerts)', 'abonnement annuel de 59 € / an', '2 mois gratuits', 'Essai de 60']) expect(s).toMatch(OBSOLETE_TRIAL_MENTION);
    for (const s of ['7 jours', 'dans deux jours', 'J+60', '160 jours', '590 €']) expect(s).not.toMatch(OBSOLETE_TRIAL_MENTION);
  });
  it.each([
    'src/services/trial-lifecycle/templates.ts',
    'src/lib/email/email-html-templates.ts',
    'src/lib/email-defaults.ts',
    'src/db/seeds/email_templates_trial.ts',
    'src/app/abonnement/onboarding/page.tsx',
    'src/app/desinscription/page.tsx',
    'src/app/admin/communications/fin-essai/page.tsx',
  ])('%s', (file) => {
    // Hors commentaires : le texte visible et les gabarits.
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/OBSOLETE_TRIAL_MENTION\s*=.*$/m, '');
    expect(code).not.toMatch(OBSOLETE_TRIAL_MENTION);
  });
  it('texte livré par défaut de TRIAL_CONFIRMATION : essai de 7 jours, sans prélèvement', async () => {
    const { DEFAULT_EMAIL_TEMPLATES } = await import('@/lib/email-defaults');
    expect(DEFAULT_EMAIL_TEMPLATES.TRIAL_CONFIRMATION.body).toContain('de 7 jours');
    expect(DEFAULT_EMAIL_TEMPLATES.TRIAL_CONFIRMATION.body).toMatch(/aucun prélèvement automatique/i);
    expect(`${DEFAULT_EMAIL_TEMPLATES.TRIAL_CONFIRMATION.subject}${DEFAULT_EMAIL_TEMPLATES.TRIAL_CONFIRMATION.body}`).not.toMatch(OBSOLETE_TRIAL_MENTION);
  });
});

// ── Règles ──────────────────────────────────────────────────────────────────

const END = new Date('2033-03-10T14:05:00Z'); // fin d'essai (15 h 05 à Paris)
const at = (iso: string) => new Date(iso);
const COMMERCIAL_ON: TrialLifecycleSettings = { ...DEFAULT_SETTINGS, commercialEnabled: true };

function state(over: Partial<CurrentState> = {}, sub: Partial<NonNullable<CurrentState['subscription']>> = {}): CurrentState {
  return {
    subscription: { status: 'readonly', trialEndsAt: END, firstBilledAt: null, stripeSubscriptionId: null, ...sub },
    account: { exists: true, isActive: true, archived: false, checkoutPending: false },
    owner: { exists: true, status: 'ACTIVE', deleted: false, hasEmail: true },
    deletionPending: false, trialDeletionScheduledAt: null, opposed: false, consented: true, alreadySent: false,
    emailPreference: true, channelDisabled: false, templateExists: true,
    ...over,
  };
}
const ENV: DecisionEnv = { allOff: false, commercialOff: false, retentionPurgeImplemented: false, unsubscribeAvailable: true, linksAvailable: true };
const decide = (code: string, now: Date, st: CurrentState = state(), settings: TrialLifecycleSettings = COMMERCIAL_ON, env: DecisionEnv = ENV) =>
  decideMessage({ milestone: milestoneDef(code)!, trialEndsAt: END, now, settings, state: st, env });

describe('L100G-RUL-01 — jalons, bornes et défauts prudents', () => {
  it('J−2, J0 service ; J+3 → J+60 commercial ; J+80 conditionnel', () => {
    expect(MILESTONES.map((m) => [m.code, m.nature, m.defaultOffsetDays])).toEqual([
      ['J_MINUS_2', 'service', -2], ['J0', 'service', 0], ['J3', 'commercial', 3], ['J10', 'commercial', 10],
      ['J30', 'commercial', 30], ['J60', 'commercial', 60], ['J80', 'conditional', 80],
    ]);
  });
  it('défauts : service actif, campagne commerciale DÉSACTIVÉE, base « consentement », lien vers les offres de l’application, ancre #pricing', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ serviceEnabled: true, commercialEnabled: false, legalBasis: 'consent', softOptInDeclaration: null, offers: { target: 'app_offers', pricingAnchor: 'pricing' } });
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  });
  it('aucune relance après J+60 ; ordre imposé ; base « client existant » sans déclaration refusée', () => {
    const bad = (patch: Partial<TrialLifecycleSettings>) => validateSettings({ ...DEFAULT_SETTINGS, ...patch }).map((i) => i.field);
    expect(COMMERCIAL_LAST_DAY_MAX).toBe(60);
    expect(bad({ commercialOffsets: { J3: 3, J10: 10, J30: 30, J60: 61 } })).toContain('commercialOffsets.J60');
    expect(bad({ commercialOffsets: { J3: 3, J10: 30, J30: 10, J60: 60 } })).toContain('commercialOffsets');
    expect(bad({ commercialOffsets: { J3: 0, J10: 10, J30: 30, J60: 60 } })).toContain('commercialOffsets.J3');
    expect(bad({ legalBasis: 'soft_opt_in' })).toContain('softOptInDeclaration');
    expect(bad({ offers: { target: 'public_pricing', pricingAnchor: '#tarifs' } })).toContain('offers.pricingAnchor');
    expect(bad({ sendHours: { from: 22, to: 23 } })).toContain('sendHours');
  });
  it('valeur stockée invalide : jamais d’élargissement (campagne commerciale coupée)', () => {
    expect(mergeSettings({ commercialEnabled: true, commercialOffsets: { J60: 400 } }).commercialEnabled).toBe(false);
    expect(mergeSettings({ commercialEnabled: true }).commercialEnabled).toBe(true);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
  it('fenêtres : J−2 jamais après la fin de l’essai', () => {
    const j2 = milestoneDef('J_MINUS_2')!;
    expect(dueAtOf(END, j2, DEFAULT_SETTINGS).toISOString()).toBe('2033-03-08T14:05:00.000Z');
    expect(windowEndOf(END, j2, { ...DEFAULT_SETTINGS, catchUpHours: { ...DEFAULT_SETTINGS.catchUpHours, J_MINUS_2: 200 } }).toISOString()).toBe(END.toISOString());
  });
  it('coupures par variables', () => {
    expect(envSwitches({ TRIAL_LIFECYCLE_EMAILS: 'off' })).toEqual({ allOff: true, commercialOff: false });
    expect(envSwitches({ TRIAL_COMMERCIAL_EMAILS: 'false' })).toEqual({ allOff: false, commercialOff: true });
    expect(envSwitches({})).toEqual({ allOff: false, commercialOff: false });
  });
});

describe('L100G-RUL-02 — chaque jalon envoyé à sa date (horloge figée, 10 h à Paris)', () => {
  it.each([
    ['J_MINUS_2', '2033-03-08T15:00:00Z', 'trialing'],
    ['J0', '2033-03-10T15:00:00Z', 'readonly'],
    ['J3', '2033-03-13T15:00:00Z', 'readonly'],
    ['J10', '2033-03-20T15:00:00Z', 'readonly'],
    ['J30', '2033-04-09T15:00:00Z', 'readonly'],
    ['J60', '2033-05-09T15:00:00Z', 'readonly'],
  ])('%s le %s', (code, nowIso, status) => {
    expect(decide(code, at(nowIso), state({}, { status }))).toEqual({ kind: 'send' });
  });
  it('un jalon n’est jamais envoyé avant sa date', () => {
    expect(decide('J3', at('2033-03-13T13:00:00Z'))).toEqual({ kind: 'defer', reason: 'not_yet_due' });
  });
});

describe('L100G-RUL-03 — motifs de non-envoi, sur l’état actuel', () => {
  const J3 = at('2033-03-13T15:00:00Z');
  it.each<[string, CurrentState, { kind: string; reason: string }]>([
    ['souscription active', state({}, { firstBilledAt: at('2033-03-12T10:00:00Z') }), { kind: 'skip', reason: 'subscription_active' }],
    ['souscription Stripe active', state({}, { status: 'active', stripeSubscriptionId: 'sub_1' }), { kind: 'skip', reason: 'subscription_active' }],
    ['paiement en cours (Checkout)', state({ account: { exists: true, isActive: true, archived: false, checkoutPending: true } }), { kind: 'defer', reason: 'payment_in_progress' }],
    ['paiement en cours (incomplete)', state({}, { status: 'incomplete', stripeSubscriptionId: 'sub_2' }), { kind: 'defer', reason: 'payment_in_progress' }],
    ['compte supprimé', state({ account: { exists: false, isActive: true, archived: false, checkoutPending: false } }), { kind: 'skip', reason: 'account_deleted' }],
    ['compte archivé', state({ account: { exists: true, isActive: true, archived: true, checkoutPending: false } }), { kind: 'skip', reason: 'account_deleted' }],
    ['utilisateur supprimé', state({ owner: { exists: true, status: 'DELETED', deleted: true, hasEmail: true } }), { kind: 'skip', reason: 'account_deleted' }],
    ['compte suspendu', state({ account: { exists: true, isActive: false, archived: false, checkoutPending: false } }), { kind: 'defer', reason: 'account_suspended' }],
    ['utilisateur suspendu', state({ owner: { exists: true, status: 'SUSPENDED', deleted: false, hasEmail: true } }), { kind: 'defer', reason: 'account_suspended' }],
    ['suppression en cours', state({ deletionPending: true }), { kind: 'skip', reason: 'account_deletion_pending' }],
    ['clôture demandée', state({ owner: { exists: true, status: 'PENDING_DELETION', deleted: false, hasEmail: true } }), { kind: 'skip', reason: 'account_deletion_pending' }],
    ['opposition / désinscription', state({ opposed: true }), { kind: 'skip', reason: 'opposition' }],
    ['doublon', state({ alreadySent: true }), { kind: 'skip', reason: 'duplicate' }],
    ['dates d’essai modifiées', state({}, { trialEndsAt: at('2033-04-01T00:00:00Z') }), { kind: 'skip', reason: 'trial_changed' }],
    ['plus en lecture seule', state({}, { status: 'canceled' }), { kind: 'skip', reason: 'trial_state_changed' }],
    ['sans consentement', state({ consented: false }), { kind: 'defer', reason: 'no_consent' }],
    ['e-mail désactivé dans le BO', state({ channelDisabled: true }), { kind: 'defer', reason: 'channel_disabled_by_admin' }],
    ['modèle absent', state({ templateExists: false }), { kind: 'defer', reason: 'template_missing' }],
    ['sans adresse', state({ owner: { exists: true, status: 'ACTIVE', deleted: false, hasEmail: false } }), { kind: 'skip', reason: 'no_recipient' }],
  ])('%s', (_l, st, expected) => {
    expect(decide('J3', J3, st)).toEqual(expected);
  });
  it('hors fenêtre (rattrapage dépassé) : clos, jamais envoyé', () => {
    expect(decide('J3', at('2033-03-16T15:00:00Z'))).toEqual({ kind: 'skip', reason: 'out_of_window' });
    expect(decide('J_MINUS_2', at('2033-03-10T14:05:00Z'), state({}, { status: 'trialing' }))).toEqual({ kind: 'skip', reason: 'out_of_window' });
  });
  it('heures d’envoi : jamais la nuit, même en rattrapage', () => {
    expect(decide('J3', at('2033-03-13T23:30:00Z'))).toEqual({ kind: 'defer', reason: 'outside_send_hours' });
  });
  it('réglages et coupures', () => {
    expect(decide('J3', J3, state(), DEFAULT_SETTINGS)).toEqual({ kind: 'defer', reason: 'campaign_disabled' });
    expect(decide('J0', at('2033-03-10T15:00:00Z'), state(), { ...DEFAULT_SETTINGS, serviceEnabled: false })).toEqual({ kind: 'defer', reason: 'service_disabled' });
    expect(decide('J3', J3, state(), COMMERCIAL_ON, { ...ENV, commercialOff: true })).toEqual({ kind: 'defer', reason: 'disabled_by_env' });
    expect(decide('J0', at('2033-03-10T15:00:00Z'), state(), COMMERCIAL_ON, { ...ENV, commercialOff: true })).toEqual({ kind: 'send' });
    expect(decide('J0', at('2033-03-10T15:00:00Z'), state(), COMMERCIAL_ON, { ...ENV, allOff: true })).toEqual({ kind: 'defer', reason: 'disabled_by_env' });
    expect(decide('J3', J3, state(), { ...COMMERCIAL_ON, legalBasis: 'soft_opt_in' })).toEqual({ kind: 'defer', reason: 'legal_basis_not_declared' });
    expect(decide('J3', J3, state({ consented: false }), { ...COMMERCIAL_ON, legalBasis: 'soft_opt_in', softOptInDeclaration: { declaredAt: '2033-01-01', declaredBy: 'po@x' } })).toEqual({ kind: 'send' });
    expect(decide('J3', J3, state(), COMMERCIAL_ON, { ...ENV, unsubscribeAvailable: false })).toEqual({ kind: 'defer', reason: 'unsubscribe_unavailable' });
  });
  it('notification de service : préférence de l’utilisateur respectée ; opposition commerciale sans effet', () => {
    const J0 = at('2033-03-10T15:00:00Z');
    expect(decide('J0', J0, state({ emailPreference: false }))).toEqual({ kind: 'defer', reason: 'user_preference_email_off' });
    expect(decide('J0', J0, state({ opposed: true }))).toEqual({ kind: 'send' });
    expect(decide('J0', J0, state({}, { status: 'trialing' }))).toEqual({ kind: 'defer', reason: 'trial_not_yet_expired' });
    expect(decide('J_MINUS_2', at('2033-03-08T15:00:00Z'), state({}, { status: 'readonly' }))).toEqual({ kind: 'skip', reason: 'trial_state_changed' });
  });
  it('chaque motif a un libellé simple', () => {
    for (const [k, v] of Object.entries(NON_SEND_REASONS)) expect(v.label.length, k).toBeGreaterThan(5);
  });
});

describe('L100G-RUL-04 — J+80 : envoi impossible (verrou serveur)', () => {
  const J80 = at('2033-05-29T15:00:00Z');
  it('aucune purge implémentée : bloqué, même campagne active, consentement et suppression planifiée', () => {
    expect(TRIAL_RETENTION_PURGE_IMPLEMENTED).toBe(false);
    expect(decide('J80', J80, state({ trialDeletionScheduledAt: at('2033-06-08T00:00:00Z') }))).toEqual({ kind: 'block', reason: 'retention_policy_not_set' });
  });
  it('même déverrouillé par une livraison : jamais sans suppression réellement planifiée', () => {
    expect(decide('J80', J80, state(), COMMERCIAL_ON, { ...ENV, retentionPurgeImplemented: true })).toEqual({ kind: 'block', reason: 'deletion_not_scheduled' });
  });
  it('aucun réglage du BO ne débloque le J+80', () => {
    expect(Object.keys(DEFAULT_SETTINGS)).not.toEqual(expect.arrayContaining([expect.stringMatching(/retention|J80|conservation/i)]));
  });
});

// ── Liens ───────────────────────────────────────────────────────────────────

describe('L100G-LNK-01 — {{offersUrl}} et {{unsubscribeUrl}}', () => {
  const env = { NEXT_PUBLIC_APP_URL: 'https://app.preprod.verebona.fr/', NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://www.verebona.fr', JWT_SECRET: 's3cr3t-e2e' };
  it('défaut : page Offres de l’application (connexion puis retour), aucun jeton', () => {
    expect(buildOffersUrl(DEFAULT_SETTINGS, env)).toBe('https://app.preprod.verebona.fr/mon-compte/offres');
    expect(buildOffersUrl(DEFAULT_SETTINGS, {})).toBeNull();
  });
  it('section Tarifs du site public : ancre réglable (#pricing par défaut, la seule réelle)', () => {
    expect(buildOffersUrl({ offers: { target: 'public_pricing', pricingAnchor: 'pricing' } }, env)).toBe('https://www.verebona.fr/#pricing');
    expect(buildOffersUrl({ offers: { target: 'public_pricing', pricingAnchor: 'tarifs' } }, env)).toBe('https://www.verebona.fr/#tarifs');
    expect(read('src/__tests__/lot72/l72e-liens-vitrine.test.ts')).toContain("'/#pricing'");
  });
  it('jeton de désinscription : signé, propre à l’utilisateur, sans expiration, falsification refusée', () => {
    const t = createUnsubscribeToken(42, 'k1');
    expect(verifyUnsubscribeToken(t, 'k1')).toBe(42);
    expect(verifyUnsubscribeToken(t, 'k2')).toBeNull();
    expect(verifyUnsubscribeToken(t.replace(/^42/, '43'), 'k1')).toBeNull();
    expect(verifyUnsubscribeToken(`${t}x`, 'k1')).toBeNull();
    expect(verifyUnsubscribeToken(null, 'k1')).toBeNull();
    expect(buildUnsubscribeUrl(42, env)).toMatch(/^https:\/\/app\.preprod\.verebona\.fr\/desinscription\?t=42\.[A-Za-z0-9_-]{32}$/);
  });
  it('production sans secret réel : aucun lien (relances en attente)', () => {
    expect(unsubscribeSecret({ NODE_ENV: 'production' })).toBeNull();
    expect(unsubscribeSecret({ NODE_ENV: 'production', JWT_SECRET: 'your-secret-key-change-in-production' })).toBeNull();
    expect(unsubscribeSecret({ NODE_ENV: 'production', MARKETING_UNSUBSCRIBE_SECRET: 'abc' })).toBe('abc');
  });
  it('date de fin d’essai à l’heure de Paris', () => {
    expect(formatTrialDate(END)).toBe('10 mars 2033 à 15 h 05');
  });
});

// ── Intégration (sources) ───────────────────────────────────────────────────

describe('L100G-INT-01 — un seul circuit', () => {
  it('TRIAL_ENDING / TRIAL_ENDED : gabarits notif_trial_* , e-mail porté par la séquence', async () => {
    const { NOTIFICATION_CATALOG } = await import('@/lib/notifications/catalog');
    for (const [type, tpl] of [['TRIAL_ENDING', 'notif_trial_ending'], ['TRIAL_ENDED', 'notif_trial_ended']] as const) {
      const e = NOTIFICATION_CATALOG[type as keyof typeof NOTIFICATION_CATALOG]!;
      expect(e.emailDeliveredBy).toBe('trial-lifecycle');
      expect(e.render({}).emailTemplateCode).toBe(tpl);
    }
    expect(read('src/lib/notifications/dispatcher.ts')).toMatch(/channels\.email && entry\.emailDeliveredBy/);
  });
  it('anciens modèles d’essai retirés de l’envoi, plus amorcés', async () => {
    const { transactionalRetiredReason } = await import('@/lib/notifications/channel-activation');
    for (const t of RETIRED_TRIAL_TEMPLATES) expect(transactionalRetiredReason(t)).toMatch(/lot 100G/);
    expect(read('src/db/seeds/email_templates_trial.ts')).not.toMatch(/TRIAL_REMINDER_J3_HTML|delete\(/);
  });
  it('tâche planifiée : fenêtre de jour, non critique, coupure par variable', async () => {
    const { findTask, taskEnvVar } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const t = findTask('trial-lifecycle-emails')!;
    expect(t.schedule).toMatchObject({ kind: 'interval', window: { from: [9, 0], to: [19, 0] } });
    expect(t.critical).toBeUndefined();
    expect(taskEnvVar('trial-lifecycle-emails')).toBe('SCHEDULED_TASK_TRIAL_LIFECYCLE_EMAILS');
  });
  it('en-têtes : seulement la désinscription (jamais From / Reply-To / Bcc)', async () => {
    const { safeExtraHeaders } = await import('@/lib/email/email-service');
    expect(safeExtraHeaders({ 'List-Unsubscribe': '<https://a/b>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', From: 'x@y', Bcc: 'z@y', 'Reply-To': 'r@y' }))
      .toEqual({ 'List-Unsubscribe': '<https://a/b>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(safeExtraHeaders({ 'List-Unsubscribe': '<a>\r\nBcc: x' })).toBeNull();
  });
  it('« Ne plus recevoir … » rendu en lien discret, l’offre en bouton', async () => {
    const { emailService } = await import('@/lib/email/email-service');
    const r = await emailService.renderTemplate(
      { subject: 'S', body: TRIAL_SHIPPED_TEMPLATES[2].body },
      { firstName: 'Léa', offersUrl: 'https://app.x/mon-compte/offres', unsubscribeUrl: 'https://app.x/desinscription?t=1.a' },
      { senderName: 'Verebona', replyToEmail: 'support@verebona.com', footerText: null, logoUrl: null },
    );
    expect(r.html).toMatch(/class="vb-btn" href="https:\/\/app\.x\/mon-compte\/offres"[^>]*>Choisir mon abonnement sur le site Verebona</);
    expect(r.html).toMatch(/<a class="vb-link" href="https:\/\/app\.x\/desinscription\?t=1\.a"[^>]*>Ne plus recevoir ces relances<\/a>/);
    expect(r.html).not.toContain('{{');
    expect(r.subject).toBe('S');
  });
  it('désinscription : route publique, exemptée de l’origine (jeton signé), jamais en GET', () => {
    expect(read('src/lib/csrf.ts')).toContain("'/api/public/marketing/unsubscribe'");
    expect(read('src/middleware.ts')).toContain("'/api/public/marketing/unsubscribe'");
    const route = read('src/app/api/public/marketing/unsubscribe/route.ts');
    expect(route).toMatch(/export async function POST/);
    expect(route).not.toMatch(/export async function GET/);
  });
  it('tables déclarées au diagnostic, à l’export de recette et conservées à la restauration', () => {
    for (const t of ['trial_lifecycle_messages', 'trial_lifecycle_events', 'trial_lifecycle_settings', 'marketing_oppositions']) {
      expect(read('src/services/admin/diagnostics-export/coverage.ts')).toContain(`${t}:`);
      expect(read('src/services/admin/diagnostics-export/recette-catalog.ts')).toContain(`${t}:`);
    }
    for (const t of ['marketing_oppositions', 'trial_lifecycle_messages', 'trial_lifecycle_events']) expect(read('src/services/backup/schema-signature.ts')).toContain(`'${t}'`);
  });
  it('écran BO : synthèse puis détail, état OK / À surveiller / Incident, desktop et mobile', () => {
    const page = read('src/app/admin/communications/fin-essai/page.tsx');
    expect(page).toContain('fin-essai-synthese');
    expect(page).toContain('fin-essai-detail');
    expect(page).toMatch(/hidden md:block/);
    expect(page).toMatch(/md:hidden/);
    expect(read('src/services/trial-lifecycle/supervision.service.ts')).toMatch(/OK: 'OK', WATCH: 'À surveiller', INCIDENT: 'Incident'/);
  });
});
