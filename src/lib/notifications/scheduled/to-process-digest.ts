/**
 * Récapitulatif quotidien « À traiter » à 8 h 30 Europe/Paris.
 * CDC Notifications §7.3.2, adapté par le CDC V2.0 §14.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX NATURES AU LIEU DE QUATRE FAMILLES
 *
 * Le §14 est explicite : « Remplacer toute référence aux quatre familles
 * historiques arbitrer / rattacher / confirmer / compléter par les deux
 * natures V2 À arbitrer / À compléter » et « supprimer toute logique liée à
 * mis de côté / snoozed ».
 *
 * Le décompte vient désormais de `to_process_actions`, déjà dédupliquée
 * (§13.4). L'ancien calcul lisait la vue V1 et comptait des éléments par
 * objet : un document posant trois problèmes comptait pour un, et le
 * récapitulatif annonçait moins de travail qu'il n'y en avait.
 *
 * ── L'ORDRE DU RÉCAPITULATIF, ET CE QU'IL NE FAIT PAS ─────────────────────
 *
 * Le §14 autorise à « présenter d'abord les actions À faire d'abord, puis À
 * faire ensuite et Peut attendre, sans créer de sous-structure supplémentaire
 * dans la page ». La charge utile porte donc un décompte par priorité, et
 * aucune notion de section : la page reste une file continue (§8.3).
 *
 * Rien n'est ajouté à la cloche — la page « À traiter » reste le point
 * d'accès interne (§14, premier alinéa).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 79C — FACULTATIF, ET JAMAIS RÉPÉTÉ À CONTENU INCHANGÉ
 *
 *   · désactivé par défaut (catalogue) : émis seulement pour les membres qui
 *     l'ont activé (préférence enregistrée « récapitulatif » push ou e-mail) ;
 *     une activation volontaire existante est conservée ;
 *   · nouveauté = au moins une action (identifiant public × cycle) absente
 *     du dernier récapitulatif émis à ce destinataire
 *     (`to_process_digest_state`, migration 0621). Le compteur n'est PAS le
 *     critère : des actions seulement résolues (total en baisse) ne
 *     déclenchent rien ; une action remplacée par une autre (total égal) est
 *     une nouveauté.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { accounts, toProcessActions } from '@/db/schema';
import { emit } from '@/lib/notifications';
import { getCatalogEntry } from '../catalog';
import { getPreference } from '../preferences';
import { resolveActiveAccountMembers } from '../recipient-resolver';
import { todayParisDateStr } from '../time-paris';

export interface DigestRunResult {
  accountsProcessed: number;
  emitted: number;
  capped: boolean;
  /** Lot 79C : destinataires sans nouveauté depuis leur dernier récapitulatif. */
  unchanged: number;
}

/** Clé de contenu d'une action : identifiant public × cycle (une réapparition est nouvelle). */
export function digestItemKey(publicId: string, cycleNumber: number | null | undefined): string {
  return `${publicId}:c${cycleNumber ?? 1}`;
}

/** Nouveauté réelle : au moins une action absente du dernier récapitulatif (pure). */
export function digestHasNews(current: readonly string[], previous: readonly string[] | null | undefined): boolean {
  if (!previous) return current.length > 0;
  const before = new Set(previous);
  return current.some((k) => !before.has(k));
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

export async function runToProcessDigest(now: Date = new Date(), limit = 1000): Promise<DigestRunResult> {
  const localDate = todayParisDateStr(now);
  const accountList = await db.select({ id: accounts.id }).from(accounts).limit(limit + 1);
  const capped = accountList.length > limit;
  const toScan = capped ? accountList.slice(0, limit) : accountList;

  let emitted = 0;
  let unchanged = 0;
  for (const acc of toScan) {
    try {
      // Actions ACTIVES uniquement : `resolved_at IS NULL`. Il n'existe plus
      // d'état intermédiaire — « mis de côté » a disparu avec la V1 (§7.1).
      const actions = await db
        .select({
          publicId: toProcessActions.publicId,
          cycleNumber: toProcessActions.cycleNumber,
          actionKind: toProcessActions.actionKind,
          priority: toProcessActions.priority,
        })
        .from(toProcessActions)
        .where(and(eq(toProcessActions.accountId, acc.id), isNull(toProcessActions.resolvedAt)));

      const total = actions.length;
      if (total === 0) continue; // pas de récapitulatif vide (§7.3.2)

      const byKind = { ARBITRATE: 0, COMPLETE: 0 };
      const byPriority = { DO_FIRST: 0, DO_NEXT: 0, CAN_WAIT: 0 };
      for (const a of actions) {
        if (a.actionKind in byKind) byKind[a.actionKind as keyof typeof byKind] += 1;
        if (a.priority in byPriority) byPriority[a.priority as keyof typeof byPriority] += 1;
      }
      const keys = actions.map((a) => digestItemKey(a.publicId, a.cycleNumber)).sort();

      for (const userId of await resolveActiveAccountMembers(acc.id)) {
        if (!(await digestEnabledFor(userId))) continue;
        const [prev] = await pgClient.unsafe<{ item_keys: string[] }[]>(
          `SELECT item_keys FROM to_process_digest_state WHERE account_id = $1 AND user_id = $2`,
          [acc.id, userId] as never[],
        );
        if (!digestHasNews(keys, prev?.item_keys ?? null)) { unchanged++; continue; }

        await emit({
          type: 'TO_PROCESS_DAILY_DIGEST',
          recipientUserIds: [userId],
          accountId: acc.id,
          entityType: 'to_process_digest',
          entityId: localDate,
          payload: { total, byKind, byPriority },
          dedupeKey: `to-process:digest:${localDate}:a${acc.id}`,
          scheduledFor: now,
        });
        await pgClient.unsafe(
          `INSERT INTO to_process_digest_state (account_id, user_id, item_keys, total, last_emitted_at)
           VALUES ($1, $2, $3::text[], $4, $5::timestamptz)
           ON CONFLICT (account_id, user_id)
           DO UPDATE SET item_keys = EXCLUDED.item_keys, total = EXCLUDED.total, last_emitted_at = EXCLUDED.last_emitted_at`,
          [acc.id, userId, `{${keys.map((k) => `"${k.replace(/["\\]/g, '')}"`).join(',')}}`, total, now.toISOString()] as never[],
        );
        emitted++;
      }
    } catch (err) {
      console.error('[to-process-digest] compte', acc.id, err);
    }
  }

  return { accountsProcessed: toScan.length, emitted, capped, unchanged };
}
