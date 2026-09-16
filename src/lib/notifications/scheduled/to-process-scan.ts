/**
 * Scan « À traiter » — notification à l'apparition d'une action.
 * CDC Notifications §7.3.1, adapté par le CDC V2.0 §14.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA TABLE D'ÉTAT N'A PLUS LIEU D'ÊTRE
 *
 * La V1 comparait une vue RECALCULÉE à chaque passage avec une table
 * `to_process_item_state`, seule à savoir ce qui avait déjà été notifié. Il
 * fallait cette table parce que les éléments n'existaient nulle part : ils
 * étaient dérivés à la volée, et disparaissaient entre deux exécutions.
 *
 * En V2, les actions sont PERSISTANTES (§13.3) et portent déjà tout ce qu'il
 * faut : `active_since` dit quand le problème est apparu, `cycle_number` le
 * distingue d'une réapparition (§7.3), `public_id` l'identifie de façon
 * stable. La table d'état dupliquerait ces trois informations — et finirait
 * par en diverger.
 *
 * ── LE CRITÈRE DEVIENT « APPARUE DEPUIS LE DERNIER PASSAGE » ──────────────
 *
 * Plutôt qu'une comparaison d'ensembles, une fenêtre temporelle : les actions
 * dont `active_since` tombe après le passage précédent. La déduplication par
 * `public_id` + cycle empêche toute double notification si deux passages se
 * chevauchent.
 *
 * ── PLUS D'ÉTAT « MIS DE CÔTÉ » ───────────────────────────────────────────
 *
 * §14 : « Supprimer toute logique liée à mis de côté / snoozed. » Une action
 * est active ou résolue, il n'y a plus de troisième cas à filtrer.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, toProcessActions } from '@/db/schema';
import { emit } from '@/lib/notifications';

export interface ScanRunResult {
  accountsProcessed: number;
  created: number;
  resolved: number;
  capped: boolean;
}

/**
 * Fenêtre de rattrapage par défaut.
 *
 * Généreuse à dessein : mieux vaut réexaminer des actions déjà notifiées — la
 * déduplication les écarte — que d'en manquer parce qu'un passage a sauté.
 */
const DEFAULT_WINDOW_MS = 2 * 60 * 60_000;

export async function runToProcessScan(
  now: Date = new Date(),
  limit = 1000,
  windowMs = DEFAULT_WINDOW_MS,
): Promise<ScanRunResult> {
  const depuis = new Date(now.getTime() - windowMs);

  const accountList = await db.select({ id: accounts.id }).from(accounts).limit(limit + 1);
  const capped = accountList.length > limit;
  const toScan = capped ? accountList.slice(0, limit) : accountList;

  let created = 0;

  for (const acc of toScan) {
    try {
      const nouvelles = await db
        .select({
          publicId: toProcessActions.publicId,
          actionKind: toProcessActions.actionKind,
          priority: toProcessActions.priority,
          cycleNumber: toProcessActions.cycleNumber,
          question: toProcessActions.question,
        })
        .from(toProcessActions)
        .where(
          and(
            eq(toProcessActions.accountId, acc.id),
            isNull(toProcessActions.resolvedAt),
            gt(toProcessActions.activeSince, depuis),
          ),
        );

      for (const action of nouvelles) {
        await emit({
          type: 'TO_PROCESS_ITEM_CREATED',
          accountId: acc.id,
          entityType: 'to_process_action',
          entityId: action.publicId,
          payload: {
            // Colonnes en `text` côté base, énumérations côté contrat : la
            // contrainte CHECK de la table garantit déjà les valeurs.
            actionKind: action.actionKind as 'ARBITRATE' | 'COMPLETE',
            priority: action.priority as 'DO_FIRST' | 'DO_NEXT' | 'CAN_WAIT',
            itemKey: action.publicId,
          },
          // Le cycle permet de re-notifier un problème résolu puis réapparu
          // (§7.3) : la même action, deux cycles, deux notifications.
          dedupeKey: `to-process:action-created:${action.publicId}:c${action.cycleNumber}`,
          scheduledFor: now,
        });
        created++;
      }
    } catch (err) {
      console.error('[to-process-scan] compte', acc.id, err);
    }
  }

  // `resolved` est conservé pour ne pas casser les appelants, mais n'a plus de
  // sens : la résolution est portée par `resolved_at` sur l'action elle-même,
  // au moment où elle survient. Il n'y a plus de sorties à détecter après coup.
  return { accountsProcessed: toScan.length, created, resolved: 0, capped };
}
