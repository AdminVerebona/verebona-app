/**
 * Anomalies de supervision — CDC Back-Office V1 §4.5 (SUP-001 à SUP-012,
 * SUP-H01/H02), AI-001, AUD-003.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CYCLE DE VIE
 *
 *   reportAnomaly(...)       appelé par le code applicatif au point d'échec
 *                            DÉFINITIF (après retries, SUP-009). Jamais par
 *                            l'administrateur (SUP-012).
 *     ├─ une anomalie OUVERTE a la même empreinte → consolidation : compteur
 *     │  +1, dernière occurrence, détail mis à jour, occurrence historisée
 *     │  (SUP-010) ;
 *     └─ sinon → nouvelle anomalie, liée à la dernière anomalie RÉSOLUE de
 *        même empreinte s'il y en a une (récurrence, SUP-011).
 *
 *   autoResolveAnomaly(...)  appelé quand le système constate objectivement
 *                            le retour à la normale (SUP-008) : date, source
 *                            (`auto` + mécanisme) et cause technique connue.
 *
 *   resolveAnomalyManually() « Marquer résolue » depuis l'écran de traitement,
 *                            journalisé (AUD-003) et idempotent (ERR-002).
 *
 * `reportAnomaly` et `autoResolveAnomaly` NE LÈVENT JAMAIS : la supervision
 * observe un traitement, elle ne doit pas le faire échouer.
 *
 * EMPREINTE : « même anomalie » = même empreinte. Elle est choisie par
 * l'appelant au grain utile au support — par événement Stripe, par type de
 * notification et canal, par événement de parrainage, une seule pour la
 * sauvegarde — et normalisée ici.
 *
 * Aucune notification administrateur (SUP-012) ; aucune criticité (§4.5).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { logAdminAction } from '@/lib/admin-audit';

// ─── Domaines (SUP-002, SUP-004) ────────────────────────────────────────────

/**
 * Domaines supervisés, dans l'ordre d'affichage. Tous sont affichés, y
 * compris à zéro (SUP-002). RGPD n'y figure pas : une échéance réglementaire
 * dépassée n'est pas une anomalie technique (SUP-004). Le stockage non plus
 * (DACT-008, STO-004). Liste alignée sur la contrainte CHECK de la
 * migration 0172.
 */
export const ANOMALY_DOMAINS = [
  { key: 'stripe', label: 'Paiements / Stripe' },
  { key: 'communications', label: 'Communications' },
  { key: 'exports', label: 'Exports / transmissions' },
  { key: 'backups', label: 'Sauvegardes' },
  { key: 'ai', label: 'IA' },
  { key: 'referrals', label: 'Parrainage' },
  { key: 'other', label: 'Autres traitements techniques' },
] as const;

export type AnomalyDomain = (typeof ANOMALY_DOMAINS)[number]['key'];

export function isAnomalyDomain(value: unknown): value is AnomalyDomain {
  return ANOMALY_DOMAINS.some((d) => d.key === value);
}

export function domainLabel(domain: string): string {
  return ANOMALY_DOMAINS.find((d) => d.key === domain)?.label ?? domain;
}

// ─── Fonctions pures ────────────────────────────────────────────────────────

const MAX_FINGERPRINT = 200;

/**
 * Empreinte normalisée : `domaine:partie:partie`, minuscules, espaces
 * compactés, bornée. Deux appels décrivant le même problème doivent produire
 * la même chaîne, quelle que soit la casse ou les espaces de leurs parties.
 */
export function buildFingerprint(domain: AnomalyDomain, ...parts: Array<string | number | null | undefined>): string {
  const norm = (v: string | number) => String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  const tail = parts.filter((p): p is string | number => p !== null && p !== undefined && String(p).trim() !== '').map(norm);
  return [domain, ...tail].join(':').slice(0, MAX_FINGERPRINT);
}

export type ReportDecision =
  | { action: 'consolidate'; anomalyId: number }
  | { action: 'create'; previousAnomalyId: number | null };

/**
 * SUP-010 / SUP-011 : consolider dans l'anomalie ouverte, sinon créer — en la
 * liant à la dernière anomalie résolue de même empreinte (récurrence).
 */
export function decideReport(
  open: { id: number } | null,
  lastResolved: { id: number } | null,
): ReportDecision {
  if (open) return { action: 'consolidate', anomalyId: open.id };
  return { action: 'create', previousAnomalyId: lastResolved?.id ?? null };
}

const MAX_DETAIL_STRING = 2000;

/** Détail technique borné : pas de pavé de 5 Mo en base (payload Stripe…). */
export function sanitizeDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined) continue;
    if (typeof v === 'string') out[k] = v.length > MAX_DETAIL_STRING ? `${v.slice(0, MAX_DETAIL_STRING)}…` : v;
    else if (v instanceof Error) out[k] = v.message.slice(0, MAX_DETAIL_STRING);
    else if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else {
      const json = JSON.stringify(v) ?? '';
      out[k] = json.length > MAX_DETAIL_STRING ? `${json.slice(0, MAX_DETAIL_STRING)}…` : v;
    }
  }
  return out;
}

/**
 * SUP-009 appliqué aux webhooks Stripe : Stripe relance lui-même un
 * événement en échec (plusieurs jours, avec un intervalle croissant). Un
 * échec n'est une anomalie qu'une fois ce mécanisme manifestement en échec :
 * l'événement a au moins `STRIPE_WEBHOOK_ANOMALY_DELAY_MS` d'ancienneté,
 * donc plusieurs relances ont déjà échoué.
 */
export const STRIPE_WEBHOOK_ANOMALY_DELAY_MS = 60 * 60 * 1000;

export function isStripeRetryExhausted(eventCreatedUnix: number | null | undefined, now: Date = new Date()): boolean {
  if (!eventCreatedUnix) return true; // âge inconnu : on ne masque rien.
  return now.getTime() - eventCreatedUnix * 1000 >= STRIPE_WEBHOOK_ANOMALY_DELAY_MS;
}

export interface ManualResolutionInput {
  cause?: string | null;
  internalComment?: string | null;
  correctiveAction?: string | null;
}

const MAX_NOTE = 4000;

/** Nettoie une saisie : chaîne vide → null, longueur bornée. */
export function cleanNote(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v ? v.slice(0, MAX_NOTE) : null;
}

/**
 * Règle produit : l'historique (SUP-H01) affiche la cause et l'action
 * corrective d'une anomalie résolue. Une résolution MANUELLE exige donc
 * l'action corrective ; la cause reste facultative (pas toujours connue).
 */
export function validateManualResolution(input: ManualResolutionInput): 'CORRECTIVE_ACTION_REQUIRED' | null {
  return cleanNote(input.correctiveAction) ? null : 'CORRECTIVE_ACTION_REQUIRED';
}

// ─── Tri des listes (SUP-005, SUP-H02) ──────────────────────────────────────

export type AnomalyStatus = 'open' | 'resolved';
export type AnomalySortKey = 'date' | 'detected' | 'domain' | 'account' | 'user';
export const ANOMALY_SORT_KEYS: readonly AnomalySortKey[] = ['date', 'detected', 'domain', 'account', 'user'];

const DOMAIN_ORDER_SQL = `CASE an.domain ${ANOMALY_DOMAINS.map((d, i) => `WHEN '${d.key}' THEN ${i}`).join(' ')} ELSE 99 END`;

/**
 * Clause ORDER BY en liste blanche (aucune saisie injectée). « date » =
 * dernière occurrence pour les ouvertes, résolution pour l'historique.
 * Départage stable par identifiant, pour une pagination sans doublon.
 */
export function anomalyOrderBy(status: AnomalyStatus, sort: string | null, dir: string | null): string {
  const key: AnomalySortKey = (ANOMALY_SORT_KEYS as readonly string[]).includes(sort ?? '') ? (sort as AnomalySortKey) : 'date';
  const direction = dir === 'asc' ? 'ASC' : dir === 'desc' ? 'DESC' : key === 'date' || key === 'detected' ? 'DESC' : 'ASC';
  const column = {
    date: status === 'open' ? 'an.last_seen_at' : 'an.resolved_at',
    detected: 'an.first_seen_at',
    domain: DOMAIN_ORDER_SQL,
    account: 'lower(acc.name)',
    user: 'lower(u.email)',
  }[key];
  return `${column} ${direction} NULLS LAST, an.id ${direction}`;
}

// ─── Accès base ─────────────────────────────────────────────────────────────

type Sql = typeof pgClient;

async function q<T>(sql: string, params: unknown[] = [], client: Pick<Sql, 'unsafe'> = pgClient): Promise<T[]> {
  const rows = await client.unsafe(sql, params as never[]);
  return rows as unknown as T[];
}

export interface ReportAnomalyInput {
  domain: AnomalyDomain;
  /** Empreinte de consolidation (`buildFingerprint`). */
  fingerprint: string;
  /** Libellé court, lisible par l'administrateur. */
  title: string;
  accountId?: number | null;
  userId?: number | null;
  /** Détail technique de cette occurrence (code, message, identifiants…). */
  detail?: Record<string, unknown> | null;
}

async function reportOnce(input: ReportAnomalyInput): Promise<number> {
  const detail = sanitizeDetail(input.detail);
  const detailJson = detail ? JSON.stringify(detail) : null;
  const accountId = input.accountId ?? null;
  const userId = input.userId ?? null;

  const id = await pgClient.begin(async (tx) => {
    const [open] = await q<{ id: number }>(
      `SELECT id FROM admin_anomalies WHERE fingerprint = $1 AND status = 'open' FOR UPDATE`,
      [input.fingerprint], tx,
    );
    const [lastResolved] = open ? [] : await q<{ id: number }>(
      `SELECT id FROM admin_anomalies WHERE fingerprint = $1 AND status = 'resolved'
        ORDER BY resolved_at DESC, id DESC LIMIT 1`,
      [input.fingerprint], tx,
    );
    const decision = decideReport(open ?? null, lastResolved ?? null);

    let anomalyId: number;
    if (decision.action === 'consolidate') {
      anomalyId = decision.anomalyId;
      await q(
        `UPDATE admin_anomalies
            SET occurrence_count = occurrence_count + 1,
                last_seen_at = now(),
                technical_detail = COALESCE($2::jsonb, technical_detail),
                title = $3,
                account_id = COALESCE(account_id, $4),
                user_id = COALESCE(user_id, $5),
                updated_at = now()
          WHERE id = $1`,
        [anomalyId, detailJson, input.title, accountId, userId], tx,
      );
    } else {
      const [row] = await q<{ id: number }>(
        `INSERT INTO admin_anomalies
           (domain, fingerprint, title, status, account_id, user_id, technical_detail, previous_anomaly_id)
         VALUES ($1, $2, $3, 'open', $4, $5, $6::jsonb, $7)
         RETURNING id`,
        [input.domain, input.fingerprint, input.title, accountId, userId, detailJson, decision.previousAnomalyId], tx,
      );
      anomalyId = row.id;
    }

    // Historique des occurrences (SUP-010), y compris la première.
    await q(
      `INSERT INTO admin_anomaly_occurrences (anomaly_id, account_id, user_id, technical_detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [anomalyId, accountId, userId, detailJson], tx,
    );
    return anomalyId;
  });
  return Number(id);
}

/**
 * Signale une anomalie (voir l'en-tête). Renvoie son identifiant, ou `null`
 * si l'écriture a échoué — ce qui est journalisé mais jamais propagé.
 */
export async function reportAnomaly(input: ReportAnomalyInput): Promise<number | null> {
  if (!isAnomalyDomain(input.domain) || !input.fingerprint) {
    console.error('[anomaly] signalement ignoré : domaine ou empreinte invalide', input.domain, input.fingerprint);
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await reportOnce(input);
    } catch (error) {
      // Deux premières occurrences simultanées : l'index unique partiel en
      // refuse une (23505). Le second passage la consolide dans l'autre.
      if ((error as { code?: string }).code === '23505' && attempt === 0) continue;
      console.error(`[anomaly] signalement impossible (${input.fingerprint}) :`, (error as Error).message);
      return null;
    }
  }
  return null;
}

export interface AutoResolveOptions {
  /** Mécanisme ayant constaté le retour à la normale (ex. `stripe_webhook_retry`). */
  origin: string;
  /** Cause technique connue, si disponible. */
  cause?: string | null;
}

/**
 * SUP-008 : résolution automatique de l'anomalie ouverte d'une empreinte.
 * Sans effet s'il n'y en a pas (cas nominal : une requête indexée, aucune
 * écriture). Renvoie vrai si une anomalie a été résolue.
 */
export async function autoResolveAnomaly(fingerprint: string, opts: AutoResolveOptions): Promise<boolean> {
  try {
    const rows = await q<{ id: number }>(
      `UPDATE admin_anomalies
          SET status = 'resolved', resolved_at = now(), resolution_source = 'auto',
              auto_resolution_origin = $2, auto_resolution_cause = $3, updated_at = now()
        WHERE fingerprint = $1 AND status = 'open'
        RETURNING id`,
      [fingerprint, opts.origin.slice(0, 200), cleanNote(opts.cause)],
    );
    return rows.length > 0;
  } catch (error) {
    console.error(`[anomaly] résolution automatique impossible (${fingerprint}) :`, (error as Error).message);
    return false;
  }
}

// ─── Points d'intégration : notifications (outbox) ──────────────────────────

/** Empreinte d'un échec de notification : type d'événement × canal. */
export function notificationFingerprint(eventType: string, channel: string): string {
  return buildFingerprint('communications', 'notification', eventType, channel);
}

/**
 * Échec DÉFINITIF d'une notification de l'outbox : tous retries épuisés
 * (`releaseOrFail`), ou canal(aux) en échec au traitement (`failed` /
 * `partial`). Une anomalie par type d'événement et canal, consolidée ; le
 * destinataire est dans l'historique des occurrences.
 */
export async function reportNotificationFailure(outboxId: string): Promise<void> {
  try {
    const [row] = await q<{ event_type: string; account_id: number | null; recipient_user_id: number; last_error: string | null; attempt_count: number }>(
      `SELECT event_type, account_id, recipient_user_id, last_error, attempt_count
         FROM notification_outbox WHERE id = $1`,
      [outboxId],
    );
    if (!row) return;
    const failed = await q<{ channel: string; last_error_code: string | null; last_error_message: string | null }>(
      `SELECT DISTINCT ON (channel) channel, last_error_code, last_error_message
         FROM notification_deliveries WHERE outbox_id = $1 AND status = 'failed'
        ORDER BY channel, created_at DESC`,
      [outboxId],
    );
    // Aucun canal en échec enregistré : échec technique du traitement lui-même.
    const targets = failed.length > 0
      ? failed
      : [{ channel: 'dispatch', last_error_code: null, last_error_message: row.last_error }];
    for (const f of targets) {
      await reportAnomaly({
        domain: 'communications',
        fingerprint: notificationFingerprint(row.event_type, f.channel),
        title: `Échec d'envoi de la notification ${row.event_type} (${f.channel === 'dispatch' ? 'traitement' : f.channel})`,
        accountId: row.account_id,
        userId: row.recipient_user_id,
        detail: {
          outboxId,
          eventType: row.event_type,
          channel: f.channel,
          attempts: row.attempt_count,
          errorCode: f.last_error_code,
          error: f.last_error_message,
        },
      });
    }
  } catch (error) {
    console.error(`[anomaly] échec de notification ${outboxId} non signalé :`, (error as Error).message);
  }
}

/**
 * Retour à la normale d'un canal : une notification du même type vient d'être
 * délivrée sur ce canal. Une seule requête ; sans effet si rien n'est ouvert.
 */
export async function autoResolveNotificationChannels(outboxId: string): Promise<void> {
  try {
    await q(
      `UPDATE admin_anomalies an
          SET status = 'resolved', resolved_at = now(), resolution_source = 'auto',
              auto_resolution_origin = 'notification_delivered', updated_at = now()
         FROM (SELECT DISTINCT 'communications:notification:' || lower(o.event_type) || ':' || d.channel AS fp
                 FROM notification_outbox o
                 JOIN notification_deliveries d ON d.outbox_id = o.id AND d.status = 'sent'
                WHERE o.id = $1) f
        WHERE an.fingerprint = f.fp AND an.status = 'open'`,
      [outboxId],
    );
  } catch (error) {
    console.error(`[anomaly] résolution automatique (notification ${outboxId}) impossible :`, (error as Error).message);
  }
}

// ─── Lecture et traitement (écrans Supervision) ─────────────────────────────

export interface DomainCounter { domain: AnomalyDomain; label: string; open: number }

/** SUP-001 / SUP-002 : total ouvert et compteur par domaine, zéros compris. */
export async function getSupervisionCounters(): Promise<{ totalOpen: number; domains: DomainCounter[] }> {
  const rows = await q<{ domain: string; n: number }>(
    `SELECT domain, count(*)::int AS n FROM admin_anomalies WHERE status = 'open' GROUP BY domain`,
  );
  return buildCounters(rows.map((r) => ({ domain: r.domain, open: Number(r.n) })));
}

/** Pur : complète les domaines absents à zéro, dans l'ordre d'affichage. */
export function buildCounters(rows: Array<{ domain: string; open: number }>): { totalOpen: number; domains: DomainCounter[] } {
  const domains = ANOMALY_DOMAINS.map((d) => ({
    domain: d.key,
    label: d.label,
    open: rows.find((r) => r.domain === d.key)?.open ?? 0,
  }));
  return { totalOpen: rows.reduce((s, r) => s + r.open, 0), domains };
}

export interface AnomalyListItem {
  id: number;
  domain: AnomalyDomain;
  domainLabel: string;
  title: string;
  accountId: number | null;
  accountName: string | null;
  userId: number | null;
  userEmail: string | null;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolutionSource: 'manual' | 'auto' | null;
  cause: string | null;
  correctiveAction: string | null;
  autoResolutionOrigin: string | null;
  autoResolutionCause: string | null;
  previousAnomalyId: number | null;
  technicalDetail: Record<string, unknown> | null;
}

interface AnomalyRow {
  id: number; domain: AnomalyDomain; title: string; account_id: number | null; account_name: string | null;
  user_id: number | null; user_email: string | null; occurrence_count: number; first_seen_at: Date; last_seen_at: Date;
  resolved_at: Date | null; resolution_source: 'manual' | 'auto' | null; cause: string | null;
  corrective_action: string | null; auto_resolution_origin: string | null; auto_resolution_cause: string | null;
  previous_anomaly_id: number | null; technical_detail: Record<string, unknown> | null;
}

const SELECT_ANOMALY = `
  SELECT an.id, an.domain, an.title, an.account_id, acc.name AS account_name, an.user_id, u.email AS user_email,
         an.occurrence_count, an.first_seen_at, an.last_seen_at, an.resolved_at, an.resolution_source,
         an.cause, an.corrective_action, an.auto_resolution_origin, an.auto_resolution_cause,
         an.previous_anomaly_id, an.technical_detail
    FROM admin_anomalies an
    LEFT JOIN accounts acc ON acc.id = an.account_id
    LEFT JOIN users u ON u.id = an.user_id`;

const toIso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

function mapRow(r: AnomalyRow): AnomalyListItem {
  return {
    id: Number(r.id),
    domain: r.domain,
    domainLabel: domainLabel(r.domain),
    title: r.title,
    accountId: r.account_id,
    accountName: r.account_name,
    userId: r.user_id,
    userEmail: r.user_email,
    occurrenceCount: Number(r.occurrence_count),
    firstSeenAt: toIso(r.first_seen_at)!,
    lastSeenAt: toIso(r.last_seen_at)!,
    resolvedAt: toIso(r.resolved_at),
    resolutionSource: r.resolution_source,
    cause: r.cause,
    correctiveAction: r.corrective_action,
    autoResolutionOrigin: r.auto_resolution_origin,
    autoResolutionCause: r.auto_resolution_cause,
    previousAnomalyId: r.previous_anomaly_id,
    technicalDetail: r.technical_detail,
  };
}

export const ANOMALY_PAGE_SIZE = 25;

/**
 * Liste paginée (GEN-004), triable (SUP-005, SUP-H02). Ni recherche ni filtre
 * (domaine, période, manuel/automatique) : volontairement aucun paramètre.
 */
export async function listAnomalies(opts: {
  status: AnomalyStatus;
  sort?: string | null;
  dir?: string | null;
  page?: number;
}): Promise<{ items: AnomalyListItem[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(opts.page ?? 1) || 1);
  const orderBy = anomalyOrderBy(opts.status, opts.sort ?? null, opts.dir ?? null);
  const [rows, [count]] = await Promise.all([
    q<AnomalyRow>(
      `${SELECT_ANOMALY} WHERE an.status = $1 ORDER BY ${orderBy} LIMIT $2 OFFSET $3`,
      [opts.status, ANOMALY_PAGE_SIZE, (page - 1) * ANOMALY_PAGE_SIZE],
    ),
    q<{ n: number }>(`SELECT count(*)::int AS n FROM admin_anomalies WHERE status = $1`, [opts.status]),
  ]);
  return { items: rows.map(mapRow), total: Number(count?.n ?? 0), page, pageSize: ANOMALY_PAGE_SIZE };
}

export interface AnomalyDetail extends AnomalyListItem {
  status: AnomalyStatus;
  internalComment: string | null;
  resolvedByEmail: string | null;
  occurrences: Array<{ id: number; occurredAt: string; accountId: number | null; userId: number | null; technicalDetail: Record<string, unknown> | null }>;
  /** Anomalie précédente (récurrence, SUP-011). */
  previous: { id: number; title: string; resolvedAt: string | null; resolutionSource: string | null } | null;
  /** Récurrence ultérieure de cette anomalie, si elle a réapparu. */
  recurrence: { id: number; status: AnomalyStatus; firstSeenAt: string } | null;
  /** AI-001 : écran IA pertinent pour le diagnostic. */
  diagnosticLink: { href: string; label: string } | null;
}

/** AI-001 : lien vers l'écran IA pertinent, sans dupliquer la gestion IA. */
export function diagnosticLinkFor(domain: string, detail: Record<string, unknown> | null): AnomalyDetail['diagnosticLink'] {
  if (domain !== 'ai') return null;
  const operationId = detail?.operationId;
  if (typeof operationId === 'string' || typeof operationId === 'number') {
    return { href: `/admin/ai-executions?operationId=${encodeURIComponent(String(operationId))}`, label: 'Ouvrir dans Exécutions IA' };
  }
  return { href: '/admin/ai-queue', label: 'Ouvrir la File IA' };
}

const MAX_OCCURRENCES_SHOWN = 200;

export async function getAnomaly(id: number): Promise<AnomalyDetail | null> {
  const [row] = await q<AnomalyRow & { status: AnomalyStatus; internal_comment: string | null; resolved_by_email: string | null }>(
    `SELECT x.*, an2.status, an2.internal_comment, rb.email AS resolved_by_email
       FROM (${SELECT_ANOMALY} WHERE an.id = $1) x
       JOIN admin_anomalies an2 ON an2.id = x.id
       LEFT JOIN users rb ON rb.id = an2.resolved_by`,
    [id],
  );
  if (!row) return null;
  const [occurrences, [previous], [recurrence]] = await Promise.all([
    q<{ id: number; occurred_at: Date; account_id: number | null; user_id: number | null; technical_detail: Record<string, unknown> | null }>(
      `SELECT id, occurred_at, account_id, user_id, technical_detail FROM admin_anomaly_occurrences
        WHERE anomaly_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT ${MAX_OCCURRENCES_SHOWN}`,
      [id],
    ),
    row.previous_anomaly_id
      ? q<{ id: number; title: string; resolved_at: Date | null; resolution_source: string | null }>(
        `SELECT id, title, resolved_at, resolution_source FROM admin_anomalies WHERE id = $1`, [row.previous_anomaly_id])
      : Promise.resolve([]),
    q<{ id: number; status: AnomalyStatus; first_seen_at: Date }>(
      `SELECT id, status, first_seen_at FROM admin_anomalies WHERE previous_anomaly_id = $1 ORDER BY id LIMIT 1`, [id]),
  ]);
  return {
    ...mapRow(row),
    status: row.status,
    internalComment: row.internal_comment,
    resolvedByEmail: row.resolved_by_email,
    occurrences: occurrences.map((o) => ({
      id: Number(o.id), occurredAt: toIso(o.occurred_at)!, accountId: o.account_id, userId: o.user_id, technicalDetail: o.technical_detail,
    })),
    previous: previous
      ? { id: Number(previous.id), title: previous.title, resolvedAt: toIso(previous.resolved_at), resolutionSource: previous.resolution_source }
      : null,
    recurrence: recurrence ? { id: Number(recurrence.id), status: recurrence.status, firstSeenAt: toIso(recurrence.first_seen_at)! } : null,
    diagnosticLink: diagnosticLinkFor(row.domain, row.technical_detail),
  };
}

export type AnomalyMutationError = 'NOT_FOUND' | 'ALREADY_RESOLVED' | 'CORRECTIVE_ACTION_REQUIRED';

/**
 * Enregistre cause, commentaire interne et action corrective (SUP-007).
 * Seules les anomalies ouvertes sont modifiables : l'historique ne se
 * réécrit pas.
 */
export async function updateAnomalyNotes(id: number, input: ManualResolutionInput): Promise<AnomalyMutationError | null> {
  const rows = await q<{ id: number }>(
    `UPDATE admin_anomalies
        SET cause = $2, internal_comment = $3, corrective_action = $4, updated_at = now()
      WHERE id = $1 AND status = 'open' RETURNING id`,
    [id, cleanNote(input.cause), cleanNote(input.internalComment), cleanNote(input.correctiveAction)],
  );
  if (rows.length > 0) return null;
  const [exists] = await q<{ id: number }>(`SELECT id FROM admin_anomalies WHERE id = $1`, [id]);
  return exists ? 'ALREADY_RESOLVED' : 'NOT_FOUND';
}

/**
 * « Marquer résolue » (SUP-007). Idempotent : la condition `status = 'open'`
 * garantit qu'un double clic ne résout (ni ne journalise un succès) qu'une
 * fois (ERR-002). Journalisé dans tous les cas utiles (AUD-001, AUD-003).
 */
export async function resolveAnomalyManually(
  id: number,
  adminId: number,
  input: ManualResolutionInput,
): Promise<AnomalyMutationError | null> {
  const invalid = validateManualResolution(input);
  if (invalid) return invalid;
  const cause = cleanNote(input.cause);
  const comment = cleanNote(input.internalComment);
  const action = cleanNote(input.correctiveAction);

  const rows = await q<{ id: number; domain: string; fingerprint: string }>(
    `UPDATE admin_anomalies
        SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution_source = 'manual',
            cause = $3, internal_comment = $4, corrective_action = $5, updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING id, domain, fingerprint`,
    [id, adminId, cause, comment, action],
  );
  if (rows.length === 0) {
    const [exists] = await q<{ id: number }>(`SELECT id FROM admin_anomalies WHERE id = $1`, [id]);
    return exists ? 'ALREADY_RESOLVED' : 'NOT_FOUND';
  }
  await logAdminAction({
    adminId,
    action: 'ANOMALY_RESOLVE',
    targetType: 'ANOMALY',
    targetId: id,
    result: 'SUCCESS',
    before: { status: 'open' },
    after: { status: 'resolved', cause, correctiveAction: action },
    details: { domain: rows[0].domain, fingerprint: rows[0].fingerprint },
  });
  return null;
}

// ─── Points d'intégration : sauvegardes ─────────────────────────────────────

/** Une seule anomalie « sauvegarde » : c'est l'état du dispositif qui compte. */
export const BACKUP_FINGERPRINT = buildFingerprint('backups', 'database');

/**
 * Délai au-delà duquel l'absence de sauvegarde réussie est une anomalie,
 * même sans échec signalé (planificateur arrêté). Même seuil que l'ancien
 * indicateur du tableau de bord (erreur au-delà de 48 h).
 */
export const BACKUP_STALE_HOURS = 48;

/**
 * Échec d'une sauvegarde planifiée. La sauvegarde est quotidienne : un échec
 * est définitif pour la journée (aucune relance automatique, SUP-009).
 */
export async function reportBackupFailure(trigger: 'cron' | 'scheduler', error: unknown): Promise<void> {
  await reportAnomaly({
    domain: 'backups',
    fingerprint: BACKUP_FINGERPRINT,
    title: 'Sauvegarde de la base en échec',
    detail: { trigger, error: error instanceof Error ? error.message : String(error) },
  });
}

/** Sauvegarde réussie : retour à la normale (SUP-008). */
export async function resolveBackupFailure(): Promise<void> {
  await autoResolveAnomaly(BACKUP_FINGERPRINT, { origin: 'backup_succeeded' });
}

/** Pur : la dernière sauvegarde réussie est-elle trop ancienne ? */
export function isBackupStale(lastBackupAt: Date | null, now: Date = new Date()): boolean {
  if (!lastBackupAt) return true;
  return now.getTime() - lastBackupAt.getTime() > BACKUP_STALE_HOURS * 60 * 60 * 1000;
}

/**
 * Contrôle de fraîcheur, appelé à l'ouverture de la Supervision : absence de
 * sauvegarde depuis plus de 48 h → anomalie ; sauvegarde récente → résolution.
 * `lastBackupAt === undefined` : état inconnu (stockage injoignable), rien
 * n'est conclu.
 */
export async function checkBackupFreshness(lastBackupAt: Date | null | undefined, now: Date = new Date()): Promise<void> {
  if (lastBackupAt === undefined) return;
  if (isBackupStale(lastBackupAt, now)) {
    // Une consultation n'est pas une occurrence : on ne signale que si rien
    // n'est déjà ouvert (sinon chaque ouverture de l'écran incrémenterait
    // le compteur).
    const open = await q<{ id: number }>(
      `SELECT id FROM admin_anomalies WHERE fingerprint = $1 AND status = 'open'`, [BACKUP_FINGERPRINT],
    ).catch(() => [{ id: 0 }]);
    if (open.length > 0) return;
    await reportAnomaly({
      domain: 'backups',
      fingerprint: BACKUP_FINGERPRINT,
      title: 'Sauvegarde de la base en échec',
      detail: {
        check: 'freshness',
        lastBackupAt: lastBackupAt ? lastBackupAt.toISOString() : null,
        thresholdHours: BACKUP_STALE_HOURS,
      },
    });
  } else {
    await autoResolveAnomaly(BACKUP_FINGERPRINT, { origin: 'backup_freshness_check', cause: null });
  }
}

// ─── Points d'intégration : parrainage ──────────────────────────────────────

/**
 * La récompense de parrainage est retentée à chaque passage quotidien du cron
 * tant qu'elle n'est pas accordée. SUP-009 : l'échec ne devient une anomalie
 * qu'au-delà de ce nombre de jours d'échecs après l'éligibilité.
 */
export const REFERRAL_REWARD_ANOMALY_AFTER_DAYS = 2;

export function referralRewardFingerprint(referralEventId: number): string {
  return buildFingerprint('referrals', 'reward', referralEventId);
}

/** Pur : les relances quotidiennes ont-elles eu le temps d'échouer ? */
export function isReferralRetryExhausted(firstBilledAt: Date | null, eligibleSince: Date): boolean {
  if (!firstBilledAt) return false;
  const limit = eligibleSince.getTime() - REFERRAL_REWARD_ANOMALY_AFTER_DAYS * 24 * 60 * 60 * 1000;
  return firstBilledAt.getTime() <= limit;
}

/** Échec technique de l'attribution de la récompense au parrain. */
export async function reportReferralRewardFailure(
  event: { id: number; referrerAccountId: number | null; firstBilledAt: Date | null },
  cutoff: Date,
  error: unknown,
): Promise<void> {
  if (!isReferralRetryExhausted(event.firstBilledAt, cutoff)) return;
  await reportAnomaly({
    domain: 'referrals',
    fingerprint: referralRewardFingerprint(event.id),
    title: 'Récompense de parrainage non attribuée',
    accountId: event.referrerAccountId,
    detail: { referralEventId: event.id, error: error instanceof Error ? error.message : String(error) },
  });
}

/**
 * Échec d'enregistrement de l'attribution à l'inscription. Aucune relance
 * n'existe (l'inscription ne doit pas échouer pour un parrainage) : l'échec
 * est définitif, le support doit pouvoir rattacher le filleul.
 */
export async function reportReferralAttributionFailure(
  input: { userId: number; accountId: number | null; code: string },
  error: unknown,
): Promise<void> {
  await reportAnomaly({
    domain: 'referrals',
    fingerprint: buildFingerprint('referrals', 'attribution', 'user', input.userId),
    title: 'Attribution de parrainage non enregistrée à l\'inscription',
    accountId: input.accountId,
    userId: input.userId,
    detail: { code: input.code, error: error instanceof Error ? error.message : String(error) },
  });
}
