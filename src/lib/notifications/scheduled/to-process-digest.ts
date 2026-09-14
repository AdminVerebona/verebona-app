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
 * ══════════════════════════════════════════════════════════════════════════
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, toProcessActions } from '@/db/schema';
import { emit } from '@/lib/notifications';
import { todayParisDateStr } from '../time-paris';

export interface DigestRunResult { accountsProcessed: number; emitted: number; capped: boolean }

export async function runToProcessDigest(now: Date = new Date(), limit = 1000): Promise<DigestRunResult> {
  const localDate = todayParisDateStr(now);
  const accountList = await db.select({ id: accounts.id }).from(accounts).limit(limit + 1);
  const capped = accountList.length > limit;
  const toScan = capped ? accountList.slice(0, limit) : accountList;

  let emitted = 0;
  for (const acc of toScan) {
    try {
      // Actions ACTIVES uniquement : `resolved_at IS NULL`. Il n'existe plus
      // d'état intermédiaire — « mis de côté » a disparu avec la V1 (§7.1).
      const rows = await db
        .select({
          actionKind: toProcessActions.actionKind,
          priority: toProcessActions.priority,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(toProcessActions)
        .where(and(eq(toProcessActions.accountId, acc.id), isNull(toProcessActions.resolvedAt)))
        .groupBy(toProcessActions.actionKind, toProcessActions.priority);

      const total = rows.reduce((sum, r) => sum + r.count, 0);
      if (total === 0) continue; // pas de récapitulatif vide (§7.3.2)

      const byKind = { ARBITRATE: 0, COMPLETE: 0 };
      const byPriority = { DO_FIRST: 0, DO_NEXT: 0, CAN_WAIT: 0 };
      for (const row of rows) {
        byKind[row.actionKind as keyof typeof byKind] += row.count;
        byPriority[row.priority as keyof typeof byPriority] += row.count;
      }

      await emit({
        type: 'TO_PROCESS_DAILY_DIGEST',
        accountId: acc.id,
        entityType: 'to_process_digest',
        entityId: localDate,
        payload: { total, byKind, byPriority },
        dedupeKey: `to-process:digest:${localDate}`,
        scheduledFor: now,
      });
      emitted++;
    } catch (err) {
      console.error('[to-process-digest] compte', acc.id, err);
    }
  }

  return { accountsProcessed: toScan.length, emitted, capped };
}
