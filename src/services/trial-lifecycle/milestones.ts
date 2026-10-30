/**
 * Lot 100G — séquence de fin d'essai : jalons, réglages et DÉCISION d'envoi.
 * Module PUR (aucun accès base) : partagé par le traitement planifié, le BO
 * et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISION PO (Questions PO 3, E / E1 / E2 / F, 27/10/2026)
 *
 *   J−2  service       fin prochaine des 7 jours, aucun prélèvement
 *   J0   service       passage en lecture seule, offres du site Web
 *   J+3  commercial    } campagne commerciale DISTINCTE des notifications
 *   J+10 commercial    } de service : consentement / base légale, droit
 *   J+30 commercial    } d'opposition, désinscription simple, arrêt après
 *   J+60 commercial    } J+60 (aucune relance indéfinie)
 *   J+80 conditionnel  modèle créé, ENVOI IMPOSSIBLE tant que la conservation
 *                      des données n'est pas fixée ET appliquée (verrou serveur)
 *
 * CONTRÔLES JUSTE AVANT CHAQUE ENVOI, sur l'état ACTUEL (`decideMessage`) :
 * souscription active, paiement en cours, compte supprimé / suspendu /
 * en suppression, opposition, doublon, hors fenêtre, réglages, consentement.
 * Chaque non-envoi a un motif (`NON_SEND_REASONS`).
 *
 * TERMINAL ou EN ATTENTE : un motif terminal clôt le message (jamais
 * renvoyé) ; un motif « en attente » est réexaminé à chaque passage tant que
 * la fenêtre de rattrapage est ouverte — à sa fermeture, le message est clos
 * avec ce dernier motif. Jamais d'envoi hors fenêtre.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type MilestoneCode = 'J_MINUS_2' | 'J0' | 'J3' | 'J10' | 'J30' | 'J60' | 'J80';
export type MilestoneNature = 'service' | 'commercial' | 'conditional';

export interface MilestoneDef {
  code: MilestoneCode;
  label: string;
  nature: MilestoneNature;
  /** Gabarit `email_templates` (type en majuscules). */
  templateCode: string;
  defaultOffsetDays: number;
  /** Décalage modifiable dans le BO (relances commerciales seulement : les textes de service citent leur délai). */
  offsetEditable: boolean;
  defaultCatchUpHours: number;
  /** Événement du catalogue des notifications dont l'interrupteur « e-mail » du BO coupe aussi ce jalon. */
  notificationEvent?: 'TRIAL_ENDING' | 'TRIAL_ENDED';
}

export const MILESTONES: readonly MilestoneDef[] = [
  { code: 'J_MINUS_2', label: 'J−2 — fin d’essai proche', nature: 'service', templateCode: 'NOTIF_TRIAL_ENDING', defaultOffsetDays: -2, offsetEditable: false, defaultCatchUpHours: 24, notificationEvent: 'TRIAL_ENDING' },
  { code: 'J0', label: 'J0 — fin de l’essai', nature: 'service', templateCode: 'NOTIF_TRIAL_ENDED', defaultOffsetDays: 0, offsetEditable: false, defaultCatchUpHours: 48, notificationEvent: 'TRIAL_ENDED' },
  { code: 'J3', label: 'J+3 — relance commerciale', nature: 'commercial', templateCode: 'TRIAL_FOLLOWUP_J3', defaultOffsetDays: 3, offsetEditable: true, defaultCatchUpHours: 72 },
  { code: 'J10', label: 'J+10 — relance commerciale', nature: 'commercial', templateCode: 'TRIAL_FOLLOWUP_J10', defaultOffsetDays: 10, offsetEditable: true, defaultCatchUpHours: 120 },
  { code: 'J30', label: 'J+30 — relance commerciale', nature: 'commercial', templateCode: 'TRIAL_FOLLOWUP_J30', defaultOffsetDays: 30, offsetEditable: true, defaultCatchUpHours: 168 },
  { code: 'J60', label: 'J+60 — dernière relance commerciale', nature: 'commercial', templateCode: 'TRIAL_FOLLOWUP_J60', defaultOffsetDays: 60, offsetEditable: true, defaultCatchUpHours: 168 },
  { code: 'J80', label: 'J+80 — rappel conditionnel sur les données', nature: 'conditional', templateCode: 'TRIAL_DATA_RETENTION_J80', defaultOffsetDays: 80, offsetEditable: false, defaultCatchUpHours: 120 },
];

export const MILESTONE_CODES = MILESTONES.map((m) => m.code);

export function milestoneDef(code: string): MilestoneDef | undefined {
  return MILESTONES.find((m) => m.code === code);
}

/** Décision PO : aucune relance commerciale après J+60 (borne des réglages). */
export const COMMERCIAL_LAST_DAY_MAX = 60;
/** Fenêtre de rattrapage maximale réglable (14 jours). */
const CATCH_UP_MAX_HOURS = 14 * 24;
/**
 * Au-delà de la fenêtre, un jalon manqué est encore JOURNALISÉ « hors
 * fenêtre » pendant 7 jours (preuve d'un non-envoi, ex. tâche arrêtée) ;
 * jamais envoyé.
 */
export const OUT_OF_WINDOW_EVIDENCE_DAYS = 7;
/**
 * VERROU SERVEUR DU J+80 (E, E2, F). Le code actuel laisse les essais expirés
 * en lecture seule SANS aucune purge automatique : aucune date de suppression
 * ne peut être promise. Seule une livraison qui implémente la purge (et une
 * décision PO sur la durée, cohérente avec les CGU/CGVU et la politique de
 * confidentialité) peut passer cette constante à `true` — jamais un réglage
 * du BO. Même alors, le J+80 n'est envoyé qu'à un compte dont la suppression
 * « essai abandonné » est réellement planifiée (date affichée = cette date).
 */
export const TRIAL_RETENTION_PURGE_IMPLEMENTED = false;

/** Tentatives d'envoi (même clé d'idempotence chez le prestataire). */
export const MAX_SEND_ATTEMPTS = 3;
/** Un envoi « en cours » plus ancien est repris (processus arrêté). */
export const STALE_SENDING_MS = 30 * 60_000;

// ── Réglages (BO) ────────────────────────────────────────────────────────────

export type LegalBasis = 'consent' | 'soft_opt_in';
export type OffersTarget = 'app_offers' | 'public_pricing';

export interface TrialLifecycleSettings {
  /** Notifications de service J−2 / J0. */
  serviceEnabled: boolean;
  /** Campagne commerciale J+3 → J+60 (et J+80 s'il est un jour déverrouillé). */
  commercialEnabled: boolean;
  /**
   * Base légale des relances commerciales :
   *   · `consent` : consentement actif et distinct aux communications
   *     commerciales (`news_consents`) — seul démontrable aujourd'hui ;
   *   · `soft_opt_in` : exception « client existant » (information claire et
   *     droit d'opposition à l'inscription) — exige une déclaration du PO.
   */
  legalBasis: LegalBasis;
  softOptInDeclaration: { declaredAt: string; declaredBy: string } | null;
  /** Jour (après la fin d'essai) de chaque relance commerciale. */
  commercialOffsets: { J3: number; J10: number; J30: number; J60: number };
  catchUpHours: Record<MilestoneCode, number>;
  /** Heures d'envoi (Paris) : [from, to[. */
  sendHours: { from: number; to: number };
  /**
   * Lien {{offersUrl}} : parcours Web de souscription.
   *   · `app_offers` (défaut) : page Offres de l'application — un utilisateur
   *     déjà inscrit est reconnu (session, ou connexion puis retour) ;
   *   · `public_pricing` : section Tarifs du site public (`#<ancre>`).
   */
  offers: { target: OffersTarget; pricingAnchor: string };
}

export const DEFAULT_SETTINGS: TrialLifecycleSettings = {
  serviceEnabled: true,
  // Choix prudent (E : « Les e-mails commerciaux dépendent de l'éligibilité
  // légale ») : désactivé tant que le PO ne l'active pas.
  commercialEnabled: false,
  legalBasis: 'consent',
  softOptInDeclaration: null,
  commercialOffsets: { J3: 3, J10: 10, J30: 30, J60: 60 },
  catchUpHours: Object.fromEntries(MILESTONES.map((m) => [m.code, m.defaultCatchUpHours])) as Record<MilestoneCode, number>,
  sendHours: { from: 9, to: 19 },
  // Ancre réelle de la section Tarifs du site public : `#pricing` (lien
  // « Tarifs » de l'application, test L72E-LV-01b) — `#tarifs` n'existe pas.
  offers: { target: 'app_offers', pricingAnchor: 'pricing' },
};

export interface SettingsIssue { field: string; message: string }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Réglages complets à partir d'une valeur stockée partielle (valeurs invalides → défaut). */
export function mergeSettings(stored: unknown): TrialLifecycleSettings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<TrialLifecycleSettings>;
  const merged: TrialLifecycleSettings = {
    ...DEFAULT_SETTINGS,
    ...(typeof s.serviceEnabled === 'boolean' ? { serviceEnabled: s.serviceEnabled } : {}),
    ...(typeof s.commercialEnabled === 'boolean' ? { commercialEnabled: s.commercialEnabled } : {}),
    ...(s.legalBasis === 'consent' || s.legalBasis === 'soft_opt_in' ? { legalBasis: s.legalBasis } : {}),
    softOptInDeclaration: s.softOptInDeclaration && typeof s.softOptInDeclaration === 'object'
      && typeof s.softOptInDeclaration.declaredAt === 'string' && typeof s.softOptInDeclaration.declaredBy === 'string'
      ? { declaredAt: s.softOptInDeclaration.declaredAt, declaredBy: s.softOptInDeclaration.declaredBy } : null,
    commercialOffsets: { ...DEFAULT_SETTINGS.commercialOffsets, ...(s.commercialOffsets ?? {}) },
    catchUpHours: { ...DEFAULT_SETTINGS.catchUpHours, ...(s.catchUpHours ?? {}) },
    sendHours: { ...DEFAULT_SETTINGS.sendHours, ...(s.sendHours ?? {}) },
    offers: { ...DEFAULT_SETTINGS.offers, ...(s.offers ?? {}) },
  };
  // Une valeur stockée invalide (édition hors BO) ne doit jamais élargir l'envoi.
  return validateSettings(merged).length ? { ...DEFAULT_SETTINGS, commercialEnabled: false, serviceEnabled: merged.serviceEnabled } : merged;
}

export function validateSettings(s: TrialLifecycleSettings): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  const o = s.commercialOffsets;
  const seq = [o.J3, o.J10, o.J30, o.J60];
  if (!seq.every(isInt)) issues.push({ field: 'commercialOffsets', message: 'Les jours des relances doivent être des nombres entiers.' });
  else {
    if (seq[0] < 1) issues.push({ field: 'commercialOffsets.J3', message: 'La première relance ne peut pas précéder la fin de l’essai (jour 1 au plus tôt).' });
    if (seq.some((d, i) => i > 0 && d <= seq[i - 1])) issues.push({ field: 'commercialOffsets', message: 'Les relances doivent se suivre dans l’ordre (J+3 < J+10 < J+30 < J+60).' });
    if (seq[3] > COMMERCIAL_LAST_DAY_MAX) issues.push({ field: 'commercialOffsets.J60', message: `Décision PO : aucune relance commerciale après J+${COMMERCIAL_LAST_DAY_MAX}.` });
  }
  for (const m of MILESTONES) {
    const h = s.catchUpHours[m.code];
    if (!isInt(h) || h < 1 || h > CATCH_UP_MAX_HOURS) issues.push({ field: `catchUpHours.${m.code}`, message: `Fenêtre de rattrapage ${m.label} : entre 1 et ${CATCH_UP_MAX_HOURS} heures.` });
  }
  if (!isInt(s.sendHours.from) || !isInt(s.sendHours.to) || s.sendHours.from < 7 || s.sendHours.to > 21 || s.sendHours.from >= s.sendHours.to) {
    issues.push({ field: 'sendHours', message: 'Heures d’envoi : début et fin entières, entre 7 h et 21 h, début avant fin.' });
  }
  if (s.offers.target !== 'app_offers' && s.offers.target !== 'public_pricing') issues.push({ field: 'offers.target', message: 'Destination du lien « offres » inconnue.' });
  if (typeof s.offers.pricingAnchor !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(s.offers.pricingAnchor)) {
    issues.push({ field: 'offers.pricingAnchor', message: 'Ancre de la section Tarifs : lettres, chiffres, « - » ou « _ », sans « # ».' });
  }
  if (s.legalBasis === 'soft_opt_in' && !s.softOptInDeclaration) {
    issues.push({ field: 'softOptInDeclaration', message: 'Base « client existant » : la déclaration de vérification (information et opposition à l’inscription) est obligatoire.' });
  }
  return issues;
}

/** Décalage effectif (jours après la fin d'essai) d'un jalon. */
export function offsetDaysOf(m: MilestoneDef, s: TrialLifecycleSettings): number {
  if (m.nature === 'commercial') return s.commercialOffsets[m.code as keyof TrialLifecycleSettings['commercialOffsets']];
  return m.defaultOffsetDays;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

export function dueAtOf(trialEndsAt: Date, m: MilestoneDef, s: TrialLifecycleSettings): Date {
  return new Date(trialEndsAt.getTime() + offsetDaysOf(m, s) * DAY);
}

/** Fin de la fenêtre de rattrapage (exclue). J−2 : jamais après la fin de l'essai. */
export function windowEndOf(trialEndsAt: Date, m: MilestoneDef, s: TrialLifecycleSettings): Date {
  const end = dueAtOf(trialEndsAt, m, s).getTime() + s.catchUpHours[m.code] * HOUR;
  return new Date(m.code === 'J_MINUS_2' ? Math.min(end, trialEndsAt.getTime()) : end);
}

// ── Motifs ───────────────────────────────────────────────────────────────────

/** Motifs de non-envoi : libellé simple (BO) et nature (clos ou réexaminé). */
export const NON_SEND_REASONS = {
  out_of_window: { label: 'Hors fenêtre d’envoi (rattrapage dépassé)', terminal: true },
  not_yet_due: { label: 'Pas encore à la date du jalon', terminal: false },
  account_deleted: { label: 'Compte supprimé ou archivé', terminal: true },
  account_suspended: { label: 'Compte ou utilisateur suspendu', terminal: false },
  account_deletion_pending: { label: 'Suppression du compte en cours', terminal: true },
  subscription_active: { label: 'Souscription active (essai converti)', terminal: true },
  trial_changed: { label: 'Dates d’essai modifiées depuis la programmation', terminal: true },
  trial_state_changed: { label: 'Essai dans un autre état (plus en essai ni en lecture seule)', terminal: true },
  trial_not_yet_expired: { label: 'Essai pas encore basculé en lecture seule', terminal: false },
  payment_in_progress: { label: 'Paiement en cours', terminal: false },
  duplicate: { label: 'Doublon : déjà envoyé', terminal: true },
  opposition: { label: 'Opposition / désinscription aux communications commerciales', terminal: true },
  no_recipient: { label: 'Aucun destinataire (adresse absente)', terminal: true },
  disabled_by_env: { label: 'Coupé par variable d’environnement', terminal: false },
  service_disabled: { label: 'Notifications de service désactivées (réglage BO)', terminal: false },
  campaign_disabled: { label: 'Campagne commerciale désactivée (réglage BO)', terminal: false },
  channel_disabled_by_admin: { label: 'E-mail désactivé dans BO › Communications', terminal: false },
  user_preference_email_off: { label: 'Préférence de l’utilisateur : e-mail désactivé', terminal: false },
  no_consent: { label: 'Aucun consentement aux communications commerciales', terminal: false },
  legal_basis_not_declared: { label: 'Base légale « client existant » non déclarée', terminal: false },
  unsubscribe_unavailable: { label: 'Lien de désinscription indisponible (secret absent)', terminal: false },
  links_unavailable: { label: 'Adresse de l’application inconnue (liens impossibles)', terminal: false },
  template_missing: { label: 'Modèle d’e-mail absent', terminal: false },
  outside_send_hours: { label: 'En dehors des heures d’envoi', terminal: false },
  retention_policy_not_set: { label: 'Bloqué : politique de conservation non fixée', terminal: false },
  deletion_not_scheduled: { label: 'Bloqué : aucune suppression réellement planifiée pour ce compte', terminal: false },
  send_failed: { label: 'Échec d’envoi (prestataire ou configuration e-mail)', terminal: false },
  technical_error: { label: 'Erreur technique (reprise au passage suivant)', terminal: false },
} as const;

export type NonSendReason = keyof typeof NON_SEND_REASONS;

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return '';
  return (NON_SEND_REASONS as Record<string, { label: string }>)[reason]?.label ?? reason;
}

const BLOCKING_REASONS: ReadonlySet<NonSendReason> = new Set(['retention_policy_not_set', 'deletion_not_scheduled']);

// ── Décision (pure) ──────────────────────────────────────────────────────────

/** État ACTUEL relu juste avant l'envoi. */
export interface CurrentState {
  subscription: { status: string; trialEndsAt: Date | null; firstBilledAt: Date | null; stripeSubscriptionId: string | null } | null;
  account: { exists: boolean; isActive: boolean; archived: boolean; checkoutPending: boolean };
  owner: { exists: boolean; status: string | null; deleted: boolean; hasEmail: boolean } | null;
  /** Suppression engagée (hors fin d'essai) : volontaire, rétractation, administrateur, impayé. */
  deletionPending: boolean;
  /** Suppression « essai abandonné » réellement planifiée (source fiable du J+80). */
  trialDeletionScheduledAt: Date | null;
  opposed: boolean;
  consented: boolean;
  /** Déjà envoyé par ce circuit pour le même utilisateur, jalon et essai, ou par l'ancien circuit. */
  alreadySent: boolean;
  /** Préférence e-mail de l'utilisateur (service) ; null = sans objet. */
  emailPreference: boolean | null;
  channelDisabled: boolean;
  templateExists: boolean;
}

export interface DecisionEnv {
  allOff: boolean;
  commercialOff: boolean;
  /** Purge des essais expirés implémentée et en service (aucune à ce jour). */
  retentionPurgeImplemented: boolean;
  unsubscribeAvailable: boolean;
  linksAvailable: boolean;
}

export type Decision =
  | { kind: 'send' }
  | { kind: 'skip'; reason: NonSendReason }
  | { kind: 'defer'; reason: NonSendReason }
  | { kind: 'block'; reason: NonSendReason };

/** Statut d'essai attendu au jalon : en essai avant la fin, en lecture seule après. */
function trialStateIssue(m: MilestoneDef, status: string): Decision | null {
  if (m.code === 'J_MINUS_2') return status === 'trialing' ? null : { kind: 'skip', reason: 'trial_state_changed' };
  if (status === 'readonly') return null;
  if (status === 'trialing') return { kind: 'defer', reason: 'trial_not_yet_expired' };
  return { kind: 'skip', reason: 'trial_state_changed' };
}

function isConverted(sub: NonNullable<CurrentState['subscription']>): boolean {
  if (sub.firstBilledAt) return true;
  return Boolean(sub.stripeSubscriptionId) && ['active', 'past_due', 'trialing'].includes(sub.status);
}

/** Souscription engagée chez Stripe mais pas encore payée (3-D Secure, prélèvement en attente). */
function isPaymentPending(sub: NonNullable<CurrentState['subscription']>): boolean {
  return Boolean(sub.stripeSubscriptionId) && ['incomplete', 'unpaid'].includes(sub.status);
}

function parisHour(now: Date): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(now);
  return Number(h);
}

/**
 * Décision d'envoi d'un message (jalon × essai), sur l'état ACTUEL.
 * Ordre : fenêtre, compte, souscription, état de l'essai, paiement, doublon,
 * opposition, coupures, base légale, verrou J+80, modèle, heures d'envoi.
 */
export function decideMessage(input: {
  milestone: MilestoneDef;
  /** Fin d'essai au moment de la programmation (clé du message). */
  trialEndsAt: Date;
  now: Date;
  settings: TrialLifecycleSettings;
  state: CurrentState;
  env: DecisionEnv;
}): Decision {
  const { milestone: m, trialEndsAt, now, settings: s, state: st, env } = input;
  const due = dueAtOf(trialEndsAt, m, s);
  if (now.getTime() < due.getTime()) return { kind: 'defer', reason: 'not_yet_due' };
  if (now.getTime() >= windowEndOf(trialEndsAt, m, s).getTime()) return { kind: 'skip', reason: 'out_of_window' };

  if (!st.account.exists || st.account.archived || !st.owner?.exists || st.owner.deleted || st.owner.status === 'DELETED') {
    return { kind: 'skip', reason: 'account_deleted' };
  }
  if (st.deletionPending || st.owner.status === 'PENDING_DELETION') return { kind: 'skip', reason: 'account_deletion_pending' };
  if (!st.account.isActive || st.owner.status === 'SUSPENDED') return { kind: 'defer', reason: 'account_suspended' };
  if (!st.owner.hasEmail) return { kind: 'skip', reason: 'no_recipient' };

  const sub = st.subscription;
  if (!sub) return { kind: 'skip', reason: 'trial_state_changed' };
  if (isConverted(sub)) return { kind: 'skip', reason: 'subscription_active' };
  if (isPaymentPending(sub) || st.account.checkoutPending) return { kind: 'defer', reason: 'payment_in_progress' };
  if (!sub.trialEndsAt || sub.trialEndsAt.getTime() !== trialEndsAt.getTime()) return { kind: 'skip', reason: 'trial_changed' };
  const stateIssue = trialStateIssue(m, sub.status);
  if (stateIssue) return stateIssue;
  if (st.alreadySent) return { kind: 'skip', reason: 'duplicate' };

  const marketing = m.nature !== 'service';
  if (marketing && st.opposed) return { kind: 'skip', reason: 'opposition' };

  if (env.allOff || (marketing && env.commercialOff)) return { kind: 'defer', reason: 'disabled_by_env' };
  if (!marketing) {
    if (!s.serviceEnabled) return { kind: 'defer', reason: 'service_disabled' };
    if (st.channelDisabled) return { kind: 'defer', reason: 'channel_disabled_by_admin' };
    if (st.emailPreference === false) return { kind: 'defer', reason: 'user_preference_email_off' };
  } else {
    if (m.nature === 'conditional') {
      // Verrou SERVEUR (E, E2, F) : aucune date de suppression promise sans
      // source fiable — purge réellement implémentée ET suppression planifiée.
      if (!env.retentionPurgeImplemented) return { kind: 'block', reason: 'retention_policy_not_set' };
      if (!st.trialDeletionScheduledAt || st.trialDeletionScheduledAt.getTime() <= now.getTime()) return { kind: 'block', reason: 'deletion_not_scheduled' };
    }
    if (!s.commercialEnabled) return { kind: 'defer', reason: 'campaign_disabled' };
    if (st.channelDisabled) return { kind: 'defer', reason: 'channel_disabled_by_admin' };
    if (s.legalBasis === 'consent' && !st.consented) return { kind: 'defer', reason: 'no_consent' };
    if (s.legalBasis === 'soft_opt_in' && !s.softOptInDeclaration) return { kind: 'defer', reason: 'legal_basis_not_declared' };
    if (!env.unsubscribeAvailable) return { kind: 'defer', reason: 'unsubscribe_unavailable' };
  }
  if (!env.linksAvailable) return { kind: 'defer', reason: 'links_unavailable' };
  if (!st.templateExists) return { kind: 'defer', reason: 'template_missing' };
  const h = parisHour(now);
  if (h < s.sendHours.from || h >= s.sendHours.to) return { kind: 'defer', reason: 'outside_send_hours' };
  return { kind: 'send' };
}

export function isBlockingReason(reason: string | null | undefined): boolean {
  return BLOCKING_REASONS.has(reason as NonSendReason);
}

/**
 * Le J+80 est-il verrouillé pour TOUTE la plateforme ? Oui tant que la purge
 * des essais expirés n'existe pas : le code actuel laisse les essais expirés
 * en lecture seule sans aucune suppression automatique (E2, F).
 */
export function retentionLockState(env: Pick<DecisionEnv, 'retentionPurgeImplemented'>): { locked: boolean; label: string } {
  return env.retentionPurgeImplemented
    ? { locked: false, label: 'Envoi possible seulement pour un compte dont la suppression est réellement planifiée' }
    : { locked: true, label: 'Bloqué : politique de conservation non fixée' };
}

/** Coupures par variable d'environnement (Scalingo). */
export function envSwitches(env: Record<string, string | undefined> = process.env): { allOff: boolean; commercialOff: boolean } {
  const off = (v: string | undefined) => ['off', 'false', '0', 'disabled', 'no'].includes((v ?? '').trim().toLowerCase());
  return { allOff: off(env.TRIAL_LIFECYCLE_EMAILS), commercialOff: off(env.TRIAL_COMMERCIAL_EMAILS) };
}
