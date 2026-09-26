/**
 * Communications — CDC Back-Office V1 §10 (COM-001 à COM-015).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE L'ÉCRAN ADMINISTRE
 *
 * Les modèles de communication, groupés par ÉVÉNEMENT MÉTIER (COM-001) :
 *   · les événements du catalogue des notifications
 *     (`lib/notifications/catalog.ts`), avec leurs canaux e-mail, push et
 *     in-app (la cloche) ;
 *   · les e-mails transactionnels envoyés hors catalogue (bienvenue,
 *     vérification d'adresse, confirmation d'abonnement…), canal e-mail seul.
 *
 * Pour chaque canal : statut actif/inactif, dernier envoi RÉEL et nombre
 * total d'envois (COM-003) — les livraisons `sent` de
 * `notification_deliveries` pour le catalogue, les lignes `sent` de
 * `email_logs` pour le transactionnel. Pas de compteur d'échecs (COM-004), ni
 * date de modification ni variables techniques (COM-005).
 *
 * Seule mutation : l'activation d'un canal (COM-011), confirmée et journalisée
 * (COM-012). Le contenu n'est pas éditable (COM-013).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import {
  NOTIFICATION_CATALOG,
  CATEGORY_LABELS,
  type CatalogEntry,
  type NotificationCategory,
} from '@/lib/notifications/catalog';
import {
  COMMUNICATION_CHANNELS,
  TRANSACTIONAL_EMAIL_PREFIX,
  transactionalEventCode,
  transactionalLockReason,
  type CommunicationChannel,
} from '@/lib/notifications/channel-activation';

// ── Libellés ────────────────────────────────────────────────────────────────

/** Libellé métier des événements du catalogue (le catalogue n'en porte pas). */
const EVENT_LABELS: Record<string, string> = {
  DEADLINE_DUE_IN_7_DAYS: 'Échéance dans 7 jours',
  DOCUMENT_BATCH_COMPLETED: 'Lot de documents analysé',
  DOCUMENT_BATCH_PARTIALLY_FAILED: 'Lot de documents partiellement analysé',
  DOCUMENT_BATCH_FAILED: 'Échec d’analyse d’un lot de documents',
  ANALYSIS_FAILED_PERSISTENT: 'Échec persistant d’analyse',
  TO_PROCESS_ITEM_CREATED: 'Nouvel élément à traiter',
  TO_PROCESS_DAILY_DIGEST: 'Récapitulatif quotidien « À traiter »',
  DUO_INVITATION_RECEIVED: 'Invitation Duo reçue',
  ACCOUNT_INVITATION: 'Invitation à rejoindre un compte',
  DUO_MOVE_REQUEST: 'Demande de transfert Duo',
  DUO_DELETE_REQUEST: 'Demande de suppression Duo',
  DUO_MOVE_ACCEPTED: 'Transfert Duo accepté',
  DUO_MOVE_REFUSED: 'Transfert Duo refusé',
  DUO_DELETE_ACCEPTED: 'Suppression Duo acceptée',
  DUO_DELETE_REFUSED: 'Suppression Duo refusée',
  TRANSMISSION_RECEIVED: 'Transmission reçue',
  TRANSMISSION_ACCEPTED: 'Transmission acceptée',
  TRANSMISSION_REFUSED: 'Transmission refusée',
  TRANSMISSION_EXPIRED: 'Transmission expirée',
  TRIAL_ENDING: 'Fin d’essai proche',
  TRIAL_ENDED: 'Fin d’essai',
  SUBSCRIPTION_RENEWED: 'Abonnement renouvelé',
  SUBSCRIPTION_ACTIVATED: 'Offre activée',
  SUBSCRIPTION_CHANGED: 'Offre modifiée',
  SUBSCRIPTION_CHANGE_SCHEDULED: 'Changement d’offre programmé',
  SUBSCRIPTION_CANCELLATION_SCHEDULED: 'Résiliation programmée',
  SUBSCRIPTION_CANCELLED: 'Abonnement résilié',
  ANALYSIS_QUOTA_90: 'Quota d’analyses à 90 %',
  ANALYSIS_QUOTA_100: 'Quota d’analyses atteint',
  REFERRAL_REWARD_GRANTED: 'Avantage de parrainage attribué',
  PAYMENT_FAILED: 'Incident de paiement',
  PAYMENT_ACTION_REQUIRED: 'Action requise sur un paiement',
  SUBSCRIPTION_SUSPENDED: 'Abonnement suspendu',
  ACCOUNT_READ_ONLY: 'Compte en lecture seule',
  PASSWORD_CHANGED: 'Mot de passe modifié',
  EMAIL_CHANGE_REQUESTED: 'Changement d’e-mail demandé',
  EMAIL_CHANGED: 'E-mail modifié',
  PASSWORD_RESET_COMPLETED: 'Mot de passe réinitialisé',
  NEW_DEVICE_LOGIN: 'Connexion depuis un nouvel appareil',
  NEWS_ANNOUNCEMENT: 'Actualités Verebona',
};

/** E-mails transactionnels connus, envoyés hors catalogue. */
export const TRANSACTIONAL_EMAILS: ReadonlyArray<{ templateCode: string; label: string }> = [
  { templateCode: 'WELCOME', label: 'Bienvenue' },
  { templateCode: 'EMAIL_VERIFICATION', label: 'Vérification de l’adresse e-mail' },
  { templateCode: 'PASSWORD_RESET', label: 'Réinitialisation du mot de passe' },
  { templateCode: 'ACCOUNT_INVITATION', label: 'Invitation à rejoindre un compte (e-mail d’invitation)' },
  { templateCode: 'DUO_INVITATION', label: 'Invitation Duo (e-mail d’invitation)' },
  { templateCode: 'TRIAL_CONFIRMATION', label: 'Confirmation de l’essai' },
  { templateCode: 'PREMIUM_CONFIRMATION', label: 'Confirmation de l’abonnement' },
  { templateCode: 'DOWNGRADE_NOTIFICATION', label: 'Passage à une offre inférieure' },
  { templateCode: 'MEMBER_REMOVED_DUE_TO_DOWNGRADE', label: 'Membre retiré suite à un changement d’offre' },
  { templateCode: 'LEGAL_CONFIRMATION', label: 'Confirmation d’acceptation des conditions' },
  { templateCode: 'WITHDRAWAL_VERIFICATION', label: 'Rétractation — vérification de la demande' },
  { templateCode: 'WITHDRAWAL_RECEIPT', label: 'Rétractation — accusé de réception' },
];

export const CHANNEL_LABELS: Record<CommunicationChannel, string> = {
  email: 'E-mail',
  push: 'Push',
  in_app: 'In-app',
};

// ── Modèle ──────────────────────────────────────────────────────────────────

export interface CommunicationChannelView {
  channel: CommunicationChannel;
  active: boolean;
  /** Canal obligatoire : non désactivable (motif affiché, UX-003). */
  locked: boolean;
  lockReason: string | null;
  lastSentAt: string | null;
  sentCount: number;
}

export interface CommunicationEventView {
  /** Clé d'activation : type du catalogue, ou `email:<CODE>`. */
  code: string;
  label: string;
  kind: 'notification' | 'transactional';
  /** Gabarit e-mail (prévisualisation, test COM-010), si le canal existe. */
  emailTemplateCode: string | null;
  channels: CommunicationChannelView[];
}

export interface CommunicationGroup {
  key: string;
  label: string;
  events: CommunicationEventView[];
}

export interface ChannelDefinition {
  channel: CommunicationChannel;
  locked: boolean;
  lockReason: string | null;
}

export interface EventDefinition {
  code: string;
  label: string;
  kind: 'notification' | 'transactional';
  groupKey: string;
  groupLabel: string;
  emailTemplateCode: string | null;
  channels: ChannelDefinition[];
}

// ── Définitions (pures) ─────────────────────────────────────────────────────

/** Gabarit e-mail d'un événement du catalogue, ou `null` s'il n'en a pas. */
function catalogEmailTemplate(entry: CatalogEntry): string | null {
  try {
    return entry.render({})?.emailTemplateCode ?? null;
  } catch {
    // Rendu dépendant du payload : le gabarit ne se déduit pas à vide.
    return null;
  }
}

function catalogLabel(type: string, entry: CatalogEntry): string {
  if (EVENT_LABELS[type]) return EVENT_LABELS[type];
  try {
    return entry.render({})?.bellTitle || type;
  } catch {
    return type;
  }
}

const MANDATORY_REASON = 'Notification obligatoire du catalogue : canal non désactivable.';

/** Canaux disponibles d'un événement du catalogue (COM-001). */
export function catalogChannels(entry: CatalogEntry): ChannelDefinition[] {
  const out: ChannelDefinition[] = [];
  if (catalogEmailTemplate(entry)) {
    out.push({
      channel: 'email',
      locked: entry.mandatoryEmail,
      lockReason: entry.mandatoryEmail ? MANDATORY_REASON : null,
    });
  }
  // Le push est toujours facultatif (CDC notifications §5.2).
  out.push({ channel: 'push', locked: false, lockReason: null });
  if (!entry.neverBell) {
    out.push({
      channel: 'in_app',
      locked: entry.mandatoryBell,
      lockReason: entry.mandatoryBell ? MANDATORY_REASON : null,
    });
  }
  return out;
}

/**
 * Tous les événements administrables : catalogue, puis transactionnel connu,
 * puis gabarits e-mail présents en base et non rattachés (`extraTemplateCodes`).
 */
export function listEventDefinitions(
  extraTemplateCodes: string[] = [],
  catalog: Record<string, CatalogEntry | undefined> = NOTIFICATION_CATALOG,
): EventDefinition[] {
  const defs: EventDefinition[] = [];
  for (const [type, entry] of Object.entries(catalog)) {
    if (!entry) continue;
    const category = entry.category as NotificationCategory;
    defs.push({
      code: type,
      label: catalogLabel(type, entry),
      kind: 'notification',
      groupKey: category,
      groupLabel: CATEGORY_LABELS[category] ?? category,
      emailTemplateCode: catalogEmailTemplate(entry),
      channels: catalogChannels(entry),
    });
  }

  const known = new Set(TRANSACTIONAL_EMAILS.map((t) => t.templateCode));
  const transactional = [
    ...TRANSACTIONAL_EMAILS,
    ...extraTemplateCodes
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c && !known.has(c) && !c.startsWith('NOTIF_'))
      .filter((c, i, arr) => arr.indexOf(c) === i)
      .map((c) => ({ templateCode: c, label: c })),
  ];
  for (const t of transactional) {
    const lockReason = transactionalLockReason(t.templateCode);
    defs.push({
      code: transactionalEventCode(t.templateCode),
      label: t.label,
      kind: 'transactional',
      groupKey: 'transactional',
      groupLabel: 'E-mails transactionnels',
      emailTemplateCode: t.templateCode,
      channels: [{ channel: 'email', locked: !!lockReason, lockReason }],
    });
  }
  return defs;
}

export interface ChannelStats {
  sentCount: number;
  lastSentAt: Date | string | null;
}

export const settingKey = (eventCode: string, channel: CommunicationChannel) => `${eventCode}|${channel}`;

/**
 * Assemble la vue (pure). `settings` : état explicite par canal (absence =
 * actif) ; `stats` : envois réels par canal.
 */
export function buildCommunicationsView(
  defs: EventDefinition[],
  settings: ReadonlyMap<string, boolean>,
  stats: ReadonlyMap<string, ChannelStats>,
): CommunicationGroup[] {
  const groups = new Map<string, CommunicationGroup>();
  for (const def of defs) {
    const group = groups.get(def.groupKey) ?? { key: def.groupKey, label: def.groupLabel, events: [] };
    groups.set(def.groupKey, group);
    group.events.push({
      code: def.code,
      label: def.label,
      kind: def.kind,
      emailTemplateCode: def.emailTemplateCode,
      channels: def.channels.map((c) => {
        const key = settingKey(def.code, c.channel);
        const s = stats.get(key);
        const last = s?.lastSentAt ?? null;
        return {
          channel: c.channel,
          // Un canal verrouillé est toujours actif, quelle que soit la base.
          active: c.locked ? true : settings.get(key) ?? true,
          locked: c.locked,
          lockReason: c.lockReason,
          lastSentAt: last ? new Date(last).toISOString() : null,
          sentCount: s?.sentCount ?? 0,
        };
      }),
    });
  }
  return [...groups.values()];
}

/** Définition d'un canal d'événement, ou `null` s'il n'existe pas. */
export function findChannelDefinition(
  defs: EventDefinition[],
  eventCode: string,
  channel: string,
): { event: EventDefinition; channel: ChannelDefinition } | null {
  const event = defs.find((d) => d.code === eventCode);
  const def = event?.channels.find((c) => c.channel === channel);
  return event && def ? { event, channel: def } : null;
}

export function isCommunicationChannel(value: unknown): value is CommunicationChannel {
  return typeof value === 'string' && (COMMUNICATION_CHANNELS as readonly string[]).includes(value);
}

// ── Lectures ────────────────────────────────────────────────────────────────

/** Codes des gabarits e-mail présents en base. */
export async function loadEmailTemplateCodes(): Promise<string[]> {
  const rows = await pgClient.unsafe<{ type: string }[]>(`SELECT type FROM email_templates`);
  return rows.map((r) => r.type);
}

async function loadSettings(): Promise<Map<string, boolean>> {
  const rows = await pgClient.unsafe<{ event_code: string; channel: CommunicationChannel; is_active: boolean }[]>(
    `SELECT event_code, channel, is_active FROM communication_channel_settings`,
  );
  return new Map(rows.map((r) => [settingKey(r.event_code, r.channel), r.is_active]));
}

async function loadStats(): Promise<Map<string, ChannelStats>> {
  const stats = new Map<string, ChannelStats>();

  // Catalogue : livraisons réellement envoyées, par type et canal.
  const deliveries = await pgClient.unsafe<{ event_type: string; channel: string; sent_count: number; last_sent_at: Date | null }[]>(
    `SELECT o.event_type, d.channel, count(*)::int AS sent_count, max(d.sent_at) AS last_sent_at
       FROM notification_deliveries d
       JOIN notification_outbox o ON o.id = d.outbox_id
      WHERE d.status = 'sent'
      GROUP BY o.event_type, d.channel`,
  );
  for (const r of deliveries) {
    const channel: CommunicationChannel = r.channel === 'bell' ? 'in_app' : (r.channel as CommunicationChannel);
    stats.set(settingKey(r.event_type, channel), { sentCount: Number(r.sent_count), lastSentAt: r.last_sent_at });
  }

  // Transactionnel : journal des e-mails.
  const emails = await pgClient.unsafe<{ code: string; sent_count: number; last_sent_at: Date | null }[]>(
    `SELECT upper(template_code) AS code, count(*)::int AS sent_count, max(sent_at) AS last_sent_at
       FROM email_logs
      WHERE status = 'sent'
      GROUP BY upper(template_code)`,
  );
  for (const r of emails) {
    stats.set(settingKey(`${TRANSACTIONAL_EMAIL_PREFIX}${r.code}`, 'email'), {
      sentCount: Number(r.sent_count),
      lastSentAt: r.last_sent_at,
    });
  }
  return stats;
}

export async function getCommunicationsOverview(): Promise<CommunicationGroup[]> {
  const [templateCodes, settings, stats] = await Promise.all([loadEmailTemplateCodes(), loadSettings(), loadStats()]);
  return buildCommunicationsView(listEventDefinitions(templateCodes), settings, stats);
}

// ── Mutation ────────────────────────────────────────────────────────────────

export type ChannelToggleError = 'UNKNOWN_CHANNEL' | 'CHANNEL_LOCKED' | 'CONFIRMATION_REQUIRED';

export type ChannelToggleResult =
  | { ok: true; changed: boolean; before: boolean; after: boolean; event: EventDefinition }
  | { ok: false; error: ChannelToggleError; message: string };

/**
 * Active ou désactive un canal (COM-011). La désactivation exige
 * `confirmed: true` (COM-012) ; l'appelant journalise.
 * Idempotente : rejouer la même demande ne change rien (ERR-002).
 */
export async function setChannelActivation(input: {
  eventCode: string;
  channel: CommunicationChannel;
  isActive: boolean;
  confirmed: boolean;
  adminId: number;
}): Promise<ChannelToggleResult> {
  const defs = listEventDefinitions(await loadEmailTemplateCodes());
  const found = findChannelDefinition(defs, input.eventCode, input.channel);
  if (!found) {
    return { ok: false, error: 'UNKNOWN_CHANNEL', message: 'Canal inconnu pour cet événement.' };
  }
  if (found.channel.locked && !input.isActive) {
    return { ok: false, error: 'CHANNEL_LOCKED', message: found.channel.lockReason ?? 'Canal non désactivable.' };
  }
  if (!input.isActive && !input.confirmed) {
    return {
      ok: false,
      error: 'CONFIRMATION_REQUIRED',
      message: 'La désactivation d’un canal exige une confirmation explicite.',
    };
  }

  const [current] = await pgClient.unsafe<{ is_active: boolean }[]>(
    `SELECT is_active FROM communication_channel_settings WHERE event_code = $1 AND channel = $2`,
    [input.eventCode, input.channel],
  );
  const before = current?.is_active ?? true;
  if (before === input.isActive) {
    return { ok: true, changed: false, before, after: before, event: found.event };
  }

  await pgClient.unsafe(
    `INSERT INTO communication_channel_settings (event_code, channel, is_active, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (event_code, channel)
     DO UPDATE SET is_active = EXCLUDED.is_active, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [input.eventCode, input.channel, input.isActive, input.adminId],
  );
  return { ok: true, changed: true, before, after: input.isActive, event: found.event };
}

// ── Prévisualisation (COM-006 à COM-009) ────────────────────────────────────

export interface AdminPreviewContext {
  firstName: string;
  lastName: string;
  email: string;
  accountName: string | null;
  planLabel: string | null;
}

/** Données du PROPRE compte de l'administrateur connecté (COM-007, SEC-005). */
export async function loadAdminPreviewContext(adminUserId: number, accountId?: number | null): Promise<AdminPreviewContext> {
  const [user] = await pgClient.unsafe<{ first_name: string; last_name: string; email: string }[]>(
    `SELECT first_name, last_name, email FROM users WHERE id = $1`,
    [adminUserId],
  );
  // Le compte n'est retenu que si l'administrateur en est membre ou titulaire.
  const [account] = accountId
    ? await pgClient.unsafe<{ name: string; plan_type: string }[]>(
        `SELECT a.name, a.plan_type FROM accounts a
          WHERE a.id = $1
            AND (a.owner_user_id = $2 OR EXISTS (
                  SELECT 1 FROM account_memberships m
                   WHERE m.account_id = a.id AND m.user_id = $2))`,
        [accountId, adminUserId],
      )
    : [];
  return {
    firstName: user?.first_name ?? '',
    lastName: user?.last_name ?? '',
    email: user?.email ?? '',
    accountName: account?.name ?? null,
    planLabel: account?.plan_type ?? null,
  };
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Mention affichée à la place d'une donnée absente (COM-009). */
export const MISSING_DATA_MARK = '[donnée indisponible]';

/**
 * Variables d'un gabarit résolues depuis le contexte de l'administrateur.
 * Les variables sans valeur sont remplacées par une mention explicite et
 * comptées : la prévisualisation est alors signalée incomplète (COM-009).
 * Jamais de donnée fictive ni d'un autre compte (COM-007).
 */
export function resolveTemplateVariables(
  texts: string[],
  ctx: AdminPreviewContext,
  appUrl: string,
): { variables: Record<string, string>; missingCount: number } {
  const base = appUrl.replace(/\/$/, '');
  const known: Record<string, string> = {
    firstName: ctx.firstName,
    lastName: ctx.lastName,
    fullName: `${ctx.firstName} ${ctx.lastName}`.trim(),
    email: ctx.email,
    accountName: ctx.accountName ?? '',
    planType: ctx.planLabel ?? '',
    loginUrl: `${base}/login`,
    appUrl: base,
    year: String(new Date().getFullYear()),
  };
  const names = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(PLACEHOLDER)) names.add(m[1]);
  }
  const variables: Record<string, string> = {};
  let missingCount = 0;
  for (const name of names) {
    if (name === 'logoUrl') continue; // géré par le service d'e-mail
    const value = known[name];
    if (value) variables[name] = value;
    else {
      variables[name] = MISSING_DATA_MARK;
      missingCount++;
    }
  }
  return { variables, missingCount };
}

export function fillTemplate(text: string, variables: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (all, name: string) => variables[name] ?? all);
}

export interface EmailTemplateRow {
  id: number;
  type: string;
  subject: string;
  body: string;
}

export async function findEmailTemplate(templateCode: string): Promise<EmailTemplateRow | null> {
  const [row] = await pgClient.unsafe<EmailTemplateRow[]>(
    `SELECT id, type, subject, body FROM email_templates WHERE upper(type) = upper($1) LIMIT 1`,
    [templateCode],
  );
  return row ?? null;
}

export function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'https://app.verebona.fr';
}
