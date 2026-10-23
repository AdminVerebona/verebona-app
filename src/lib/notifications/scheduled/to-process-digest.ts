/**
 * Récapitulatif quotidien « À traiter » à 8 h 30 Europe/Paris.
 * CDC Notifications §7.3.2, adapté par le CDC V2.0 §14.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX NATURES AU LIEU DE QUATRE FAMILLES
 *
 * Le décompte vient de `to_process_actions`, déjà dédupliquée (§13.4), par
 * nature (À arbitrer / À compléter) et par priorité, sans sous-structure dans
 * la page (§14). Rien n'est ajouté à la cloche — la page « À traiter » reste
 * le point d'accès interne.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 79C — FACULTATIF, ET JAMAIS RÉPÉTÉ À CONTENU INCHANGÉ
 *
 *   · désactivé par défaut (catalogue) : émis seulement pour les membres qui
 *     l'ont activé (préférence enregistrée push ou e-mail) ; une activation
 *     volontaire existante est conservée ;
 *   · aucune notification immédiate pour les actions ordinaires.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 81E — PRÉPARÉ ≠ ENVOYÉ, ÉVOLUTIONS SIGNIFICATIVES, COUVERTURE COMPLÈTE
 *
 * Écarts corrigés :
 *   · le contenu était enregistré comme « dernier récapitulatif » dès la MISE
 *     EN FILE : un envoi en échec rendait ce contenu définitivement
 *     « communiqué » ;
 *   · une action existante dont la priorité ou le contenu changeait ne
 *     déclenchait rien ;
 *   · le balayage s'arrêtait à 1 000 comptes, sans reprise.
 *
 * Désormais (`to_process_digest_state`, migrations 0621 / 0640) :
 *   · PRÉPARÉ (`prepared_*`, ligne d'outbox mise en file) puis promu
 *     COMMUNIQUÉ (`item_keys`, `sent_fingerprints`) seulement quand au moins
 *     un canal l'a accepté (`recordDigestOutcome`, appelé par le dispatcher ;
 *     rattrapé au passage suivant). Un échec (aucun canal accepté) n'est
 *     jamais communiqué : le contenu est re-préparé (au plus 3 tentatives par
 *     jour ; un envoi sans canal disponible, une fois par jour). Résultat par
 *     canal conservé (`channel_results`) : la réémission BO ne vise que les
 *     canaux en échec ;
 *   · nouveauté = nouvelle action, nouveau cycle (identifiant × cycle), ou
 *     évolution significative d'une action déjà communiquée : priorité,
 *     nature, question, échéance (`digestItemFingerprint`). Une action
 *     seulement résolue (compteur en baisse) ne déclenche rien ; un contenu
 *     inchangé n'est jamais réexpédié ;
 *   · exécutions concurrentes : verrou consultatif par compte × destinataire
 *     et clé de déduplication par préparation (`attempt_seq`) ;
 *   · parcours de TOUS les comptes ayant des actions actives, par pagination
 *     stable (identifiant de compte croissant), curseur en base par date
 *     locale (`to_process_digest_runs`) : un passage interrompu (délai) est
 *     repris au passage suivant (toutes les 15 min de 8 h 30 à 11 h).
 * ══════════════════════════════════════════════════════════════════════════
 */

import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { emit } from '@/lib/notifications';
import { getCatalogEntry } from '../catalog';
import { getPreference } from '../preferences';
import { resolveActiveAccountMembers } from '../recipient-resolver';
import { todayParisDateStr } from '../time-paris';

export interface DigestRunResult {
  accountsProcessed: number;
  emitted: number;
  /** Lot 81E : parcours non terminé (délai atteint) — repris au passage suivant. */
  capped: boolean;
  /** Lot 79C : destinataires sans nouveauté depuis leur dernier récapitulatif COMMUNIQUÉ. */
  unchanged: number;
  /** Lot 81E : récapitulatif précédent encore en cours d'envoi (rien n'est re-préparé). */
  inFlight?: number;
  /** Lot 81E : parcours de la date locale achevé. */
  completed?: boolean;
}

export interface DigestRunOptions {
  /** Comptes par page (pagination stable). */
  pageSize?: number;
  /** Échéance du passage (horodatage ms) : au-delà, le curseur est conservé. */
  deadline?: number;
}

/** Tentatives d'envoi d'un même contenu par jour après un échec (aucun canal accepté). */
export const DIGEST_MAX_ATTEMPTS_PER_DAY = 3;

/** Clé de contenu d'une action : identifiant public × cycle (une réapparition est nouvelle). */
export function digestItemKey(publicId: string, cycleNumber: number | null | undefined): string {
  return `${publicId}:c${cycleNumber ?? 1}`;
}

export interface DigestItem {
  publicId: string;
  cycleNumber: number | null;
  actionKind: string;
  priority: string;
  question: string;
  dueDate?: Date | string | null;
}

/** Empreinte d'une action : clé, priorité, nature, contenu (question, échéance) — pure. */
export function digestItemFingerprint(a: DigestItem): string {
  const due = a.dueDate ? new Date(a.dueDate).toISOString().slice(0, 10) : '';
  const contenu = createHash('sha1').update(`${a.question}\u0000${due}`).digest('hex').slice(0, 12);
  return `${digestItemKey(a.publicId, a.cycleNumber)}|${a.priority}|${a.actionKind}|${contenu}`;
}

/** Nouveauté réelle : au moins une action absente du dernier récapitulatif (pure, lot 79C). */
export function digestHasNews(current: readonly string[], previous: readonly string[] | null | undefined): boolean {
  if (!previous) return current.length > 0;
  const before = new Set(previous);
  return current.some((k) => !before.has(k));
}

export type DigestChangeReason = 'NEW_ACTION' | 'NEW_CYCLE' | 'PRIORITY_CHANGED' | 'CONTENT_CHANGED';

/**
 * Évolutions significatives depuis le dernier contenu COMMUNIQUÉ (pure).
 * Empreintes précédentes absentes (état antérieur au lot 81E) : comparaison
 * par clé seule — un changement de priorité ou de contenu n'est alors pas
 * déduit (jamais de renvoi en masse au déploiement).
 */
export function digestChanges(
  current: readonly string[],
  previousFingerprints: readonly string[] | null | undefined,
  previousKeys: readonly string[] | null | undefined,
): { news: boolean; reasons: DigestChangeReason[] } {
  const reasons = new Set<DigestChangeReason>();
  const keyOf = (fp: string) => fp.split('|')[0];
  const idOf = (key: string) => key.replace(/:c\d+$/, '');
  const prevByKey = new Map<string, string[]>();
  for (const fp of previousFingerprints ?? []) prevByKey.set(keyOf(fp), fp.split('|'));
  const prevKeys = new Set(previousFingerprints ? [...prevByKey.keys()] : previousKeys ?? []);
  const prevIds = new Set([...prevKeys].map(idOf));
  const premier = !previousFingerprints && !previousKeys;
  for (const fp of current) {
    const [key, priority, kind, contenu] = fp.split('|');
    if (premier) { reasons.add('NEW_ACTION'); continue; }
    if (!prevKeys.has(key)) { reasons.add(prevIds.has(idOf(key)) ? 'NEW_CYCLE' : 'NEW_ACTION'); continue; }
    const prev = prevByKey.get(key);
    if (!prev) continue;
    if (prev[1] !== priority) reasons.add('PRIORITY_CHANGED');
    if (prev[2] !== kind || prev[3] !== contenu) reasons.add('CONTENT_CHANGED');
  }
  return { news: reasons.size > 0, reasons: [...reasons] };
}

/** Le destinataire a-t-il activé le récapitulatif (push ou e-mail) ? */
async function digestEnabledFor(userId: number): Promise<boolean> {
  const entry = getCatalogEntry('TO_PROCESS_DAILY_DIGEST');
  if (!entry) return false;
  for (const channel of ['email', 'push'] as const) {
    const pref = await getPreference(userId, 'to_process', 'daily_digest', channel);
    if (pref ?? entry.defaults[channel]) return true;
  }
  return false;
}

type Exec = Pick<typeof db, 'execute'>;
function rowsOf<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  const rows = (r as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}
const pgArray = (values: readonly string[]) => `{${values.map((k) => `"${k.replace(/["\\]/g, '')}"`).join(',')}}`;

interface DigestStateRow {
  item_keys: string[] | null;
  sent_fingerprints: string[] | null;
  prepared_outbox_id: string | null;
  attempt_seq: number;
  attempts_on_date: number;
  last_attempt_date: string | null;
  last_outcome: string | null;
}

/**
 * Issue du récapitulatif préparé (ligne d'outbox `outboxId`) : promu
 * COMMUNIQUÉ si au moins un canal l'a accepté, sinon abandonné (le contenu
 * reste à communiquer). Sans effet tant que la ligne est en file / en cours.
 */
async function reconcilePrepared(exec: Exec, accountId: number, userId: number, outboxId: string): Promise<'in_flight' | 'sent' | 'not_sent'> {
  const [o] = rowsOf<{ status: string }>(await exec.execute(sql`SELECT status FROM notification_outbox WHERE id = ${outboxId}::uuid`));
  if (o && (o.status === 'pending' || o.status === 'processing')) return 'in_flight';
  const deliveries = rowsOf<{ channel: string; status: string; code: string | null }>(await exec.execute(sql`
    SELECT channel, status, last_error_code AS code FROM notification_deliveries WHERE outbox_id = ${outboxId}::uuid ORDER BY channel`));
  const results: Record<string, string> = {};
  for (const d of deliveries) {
    // Un canal envoyé l'emporte (plusieurs appareils push).
    if (results[d.channel] !== 'sent') results[d.channel] = d.status === 'sent' ? 'sent' : `${d.status}${d.code ? `:${d.code}` : ''}`;
  }
  const envoye = deliveries.some((d) => d.status === 'sent');
  if (envoye) {
    await exec.execute(sql`
      UPDATE to_process_digest_state
         SET item_keys = COALESCE(prepared_item_keys, item_keys), sent_fingerprints = prepared_fingerprints,
             total = COALESCE(prepared_total, total), last_emitted_at = now(),
             last_outcome = ${o?.status === 'partial' ? 'partial' : 'sent'}, channel_results = ${JSON.stringify(results)}::jsonb,
             prepared_item_keys = NULL, prepared_fingerprints = NULL, prepared_total = NULL, prepared_outbox_id = NULL, prepared_at = NULL
       WHERE account_id = ${accountId} AND user_id = ${userId} AND prepared_outbox_id = ${outboxId}::uuid`);
    return 'sent';
  }
  const outcome = !o ? 'lost' : o.status === 'skipped' ? 'skipped' : 'failed';
  await exec.execute(sql`
    UPDATE to_process_digest_state
       SET last_outcome = ${outcome}, channel_results = ${JSON.stringify(results)}::jsonb,
           prepared_item_keys = NULL, prepared_fingerprints = NULL, prepared_total = NULL, prepared_outbox_id = NULL, prepared_at = NULL
     WHERE account_id = ${accountId} AND user_id = ${userId} AND prepared_outbox_id = ${outboxId}::uuid`);
  return 'not_sent';
}

/**
 * Appelé par le dispatcher après le traitement d'un récapitulatif : promotion
 * « préparé → communiqué » ou abandon. Ne lève pas d'erreur métier.
 */
export async function recordDigestOutcome(outboxId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [st] = rowsOf<{ account_id: number; user_id: number }>(await tx.execute(sql`
      SELECT account_id, user_id FROM to_process_digest_state WHERE prepared_outbox_id = ${outboxId}::uuid FOR UPDATE`));
    if (!st) return;
    await reconcilePrepared(tx, st.account_id, st.user_id, outboxId);
  });
}

type UserOutcome = 'emitted' | 'unchanged' | 'in_flight' | 'busy' | 'retry_exhausted';

async function processUser(
  accountId: number, userId: number, actions: DigestItem[], localDate: string, now: Date,
): Promise<{ outcome: UserOutcome; outboxId?: string }> {
  const keys = actions.map((a) => digestItemKey(a.publicId, a.cycleNumber)).sort();
  const fingerprints = actions.map(digestItemFingerprint).sort();
  const byKind = { ARBITRATE: 0, COMPLETE: 0 };
  const byPriority = { DO_FIRST: 0, DO_NEXT: 0, CAN_WAIT: 0 };
  for (const a of actions) {
    if (a.actionKind in byKind) byKind[a.actionKind as keyof typeof byKind] += 1;
    if (a.priority in byPriority) byPriority[a.priority as keyof typeof byPriority] += 1;
  }

  return db.transaction(async (tx) => {
    // Exécutions concurrentes : une seule prépare pour ce destinataire.
    const [lock] = rowsOf<{ ok: boolean }>(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`to-process-digest:${accountId}:${userId}`})) AS ok`));
    if (!lock?.ok) return { outcome: 'busy' as const };

    let [st] = rowsOf<DigestStateRow>(await tx.execute(sql`
      SELECT item_keys, sent_fingerprints, prepared_outbox_id::text AS prepared_outbox_id, attempt_seq, attempts_on_date,
             last_attempt_date::text AS last_attempt_date, last_outcome
        FROM to_process_digest_state WHERE account_id = ${accountId} AND user_id = ${userId} FOR UPDATE`));
    if (st?.prepared_outbox_id) {
      if ((await reconcilePrepared(tx, accountId, userId, st.prepared_outbox_id)) === 'in_flight') return { outcome: 'in_flight' as const };
      [st] = rowsOf<DigestStateRow>(await tx.execute(sql`
        SELECT item_keys, sent_fingerprints, prepared_outbox_id::text AS prepared_outbox_id, attempt_seq, attempts_on_date,
               last_attempt_date::text AS last_attempt_date, last_outcome
          FROM to_process_digest_state WHERE account_id = ${accountId} AND user_id = ${userId}`));
    }

    const { news } = digestChanges(fingerprints, st?.sent_fingerprints ?? null, st ? st.item_keys ?? [] : null);
    if (!news) return { outcome: 'unchanged' as const };

    // Reprises bornées d'un contenu non communiqué le même jour.
    const memeJour = st?.last_attempt_date === localDate;
    if (memeJour && st?.last_outcome === 'skipped') return { outcome: 'retry_exhausted' as const };
    if (memeJour && (st?.attempts_on_date ?? 0) >= DIGEST_MAX_ATTEMPTS_PER_DAY) return { outcome: 'retry_exhausted' as const };

    const seq = (st?.attempt_seq ?? 0) + 1;
    const dedupeKey = `to-process:digest:${localDate}:a${accountId}:n${seq}`;
    await emit({
      type: 'TO_PROCESS_DAILY_DIGEST',
      recipientUserIds: [userId],
      accountId,
      entityType: 'to_process_digest',
      entityId: localDate,
      payload: { total: actions.length, byKind, byPriority },
      dedupeKey,
      scheduledFor: now,
      tx,
    });
    const [row] = rowsOf<{ id: string }>(await tx.execute(sql`SELECT id::text AS id FROM notification_outbox WHERE dedupe_key = ${`${dedupeKey}:u${userId}`}`));
    if (!row) return { outcome: 'unchanged' as const };
    await tx.execute(sql`
      INSERT INTO to_process_digest_state (account_id, user_id, item_keys, total, last_emitted_at,
                                           prepared_item_keys, prepared_fingerprints, prepared_total, prepared_outbox_id, prepared_at,
                                           attempt_seq, attempts_on_date, last_attempt_date)
      VALUES (${accountId}, ${userId}, '{}'::text[], 0, ${now.toISOString()}::timestamptz,
              ${pgArray(keys)}::text[], ${pgArray(fingerprints)}::text[], ${actions.length}, ${row.id}::uuid, ${now.toISOString()}::timestamptz,
              ${seq}, 1, ${localDate}::date)
      ON CONFLICT (account_id, user_id) DO UPDATE
         SET prepared_item_keys = EXCLUDED.prepared_item_keys, prepared_fingerprints = EXCLUDED.prepared_fingerprints,
             prepared_total = EXCLUDED.prepared_total, prepared_outbox_id = EXCLUDED.prepared_outbox_id,
             prepared_at = EXCLUDED.prepared_at, attempt_seq = EXCLUDED.attempt_seq,
             attempts_on_date = CASE WHEN to_process_digest_state.last_attempt_date = EXCLUDED.last_attempt_date
                                     THEN to_process_digest_state.attempts_on_date + 1 ELSE 1 END,
             last_attempt_date = EXCLUDED.last_attempt_date`);
    return { outcome: 'emitted' as const, outboxId: row.id };
  });
}

async function activeActions(accountId: number): Promise<DigestItem[]> {
  // Actions ACTIVES uniquement : `resolved_at IS NULL` (« mis de côté » a
  // disparu avec la V1, §7.1).
  return pgClient.unsafe<DigestItem[]>(
    `SELECT public_id::text AS "publicId", cycle_number AS "cycleNumber", action_kind AS "actionKind",
            priority, question, due_date AS "dueDate"
       FROM to_process_actions WHERE account_id = $1 AND resolved_at IS NULL`,
    [accountId] as never[],
  );
}

async function processAccount(accountId: number, localDate: string, now: Date, totals: { emitted: number; unchanged: number; inFlight: number }, toDispatch: string[]): Promise<void> {
  const actions = await activeActions(accountId);
  if (actions.length === 0) return; // pas de récapitulatif vide (§7.3.2)
  for (const userId of await resolveActiveAccountMembers(accountId)) {
    if (!(await digestEnabledFor(userId))) continue;
    const r = await processUser(accountId, userId, actions, localDate, now);
    if (r.outcome === 'emitted') { totals.emitted += 1; if (r.outboxId) toDispatch.push(r.outboxId); }
    else if (r.outcome === 'unchanged') totals.unchanged += 1;
    else if (r.outcome === 'in_flight') totals.inFlight += 1;
  }
}

/**
 * Passage du récapitulatif pour la date locale de `now`. Idempotent et
 * repris : curseur de compte en base ; après un parcours complet, seuls les
 * récapitulatifs non communiqués du jour sont repris.
 */
export async function runToProcessDigest(now: Date = new Date(), opts: number | DigestRunOptions = {}): Promise<DigestRunResult> {
  const o: DigestRunOptions = typeof opts === 'number' ? { pageSize: opts } : opts;
  const pageSize = Math.max(1, o.pageSize ?? 500);
  const deadline = o.deadline ?? Date.now() + 10 * 60_000;
  const localDate = todayParisDateStr(now);
  const totals = { emitted: 0, unchanged: 0, inFlight: 0 };
  const toDispatch: string[] = [];
  let accountsProcessed = 0;

  await pgClient.unsafe(
    `INSERT INTO to_process_digest_runs (local_date, started_at, updated_at) VALUES ($1::date, $2::timestamptz, $2::timestamptz)
     ON CONFLICT (local_date) DO NOTHING`, [localDate, now.toISOString()] as never[]);
  const [run] = await pgClient.unsafe<{ cursor_account_id: number; completed_at: string | null }[]>(
    `SELECT cursor_account_id, completed_at FROM to_process_digest_runs WHERE local_date = $1::date`, [localDate] as never[]);

  let completed = !!run?.completed_at;
  if (!completed) {
    let cursor = Number(run?.cursor_account_id ?? 0);
    for (;;) {
      const page = await pgClient.unsafe<{ account_id: number }[]>(
        // Lot 82A (C-Q10) : récapitulatif de contenu — comptes éligibles seulement.
        `SELECT DISTINCT account_id FROM to_process_actions
          WHERE resolved_at IS NULL AND account_id > $1 AND ${processingEligibleSql('to_process_actions.account_id')}
          ORDER BY account_id LIMIT $2`,
        [cursor, pageSize] as never[]);
      if (page.length === 0) {
        await pgClient.unsafe(
          `UPDATE to_process_digest_runs SET completed_at = now(), updated_at = now() WHERE local_date = $1::date AND completed_at IS NULL`,
          [localDate] as never[]);
        completed = true;
        break;
      }
      for (const { account_id: accountId } of page) {
        try {
          await processAccount(accountId, localDate, now, totals, toDispatch);
        } catch (err) {
          console.error('[to-process-digest] compte', accountId, err);
        }
        accountsProcessed += 1;
        cursor = accountId;
        await pgClient.unsafe(
          `UPDATE to_process_digest_runs SET cursor_account_id = GREATEST(cursor_account_id, $2), accounts_scanned = accounts_scanned + 1,
                  updated_at = now() WHERE local_date = $1::date`,
          [localDate, accountId] as never[]);
        if (Date.now() >= deadline) break;
      }
      if (Date.now() >= deadline) break;
    }
  } else {
    // Parcours du jour achevé : reprise des seuls récapitulatifs non
    // communiqués (échec de tous les canaux), dans la limite du jour.
    const reprises = await pgClient.unsafe<{ account_id: number }[]>(
      `SELECT DISTINCT account_id FROM to_process_digest_state
        WHERE last_attempt_date = $1::date AND prepared_outbox_id IS NULL AND last_outcome IN ('failed', 'lost')
          AND attempts_on_date < $2 AND ${processingEligibleSql('to_process_digest_state.account_id')}
        ORDER BY account_id`,
      [localDate, DIGEST_MAX_ATTEMPTS_PER_DAY] as never[]);
    for (const { account_id: accountId } of reprises) {
      if (Date.now() >= deadline) break;
      try { await processAccount(accountId, localDate, now, totals, toDispatch); } catch (err) { console.error('[to-process-digest] reprise du compte', accountId, err); }
      accountsProcessed += 1;
    }
  }

  // Envoi immédiat de ce qui a été préparé (sinon : tâche `notifications-dispatch`).
  if (toDispatch.length) {
    try {
      const { processOutboxIds } = await import('@/lib/notifications');
      await processOutboxIds(toDispatch);
    } catch (e) {
      console.error('[to-process-digest] envoi immédiat différé :', (e as Error).message);
    }
  }
  if (totals.emitted) {
    await pgClient.unsafe(`UPDATE to_process_digest_runs SET emitted = emitted + $2, updated_at = now() WHERE local_date = $1::date`,
      [localDate, totals.emitted] as never[]).catch(() => undefined);
  }

  return { accountsProcessed, emitted: totals.emitted, capped: !completed, unchanged: totals.unchanged, inFlight: totals.inFlight, completed };
}
