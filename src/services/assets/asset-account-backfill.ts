/**
 * Rattrapage AUTOMATIQUE des biens déplacés AVANT le lot 40 (volet B) : leurs
 * données (documents, analyses, agenda, « À traiter »…) sont restées dans
 * l'ancien compte. Aucune commande à lancer :
 *
 *   · tâche planifiée interne `asset-account-backfill` (au démarrage, puis
 *     toutes les heures TANT QU'il reste des incohérences) ;
 *   · BO › Exploitation › Rattrapages : « Simuler » (exécution réelle dans une
 *     transaction ANNULÉE : rapport exact, aucune écriture) et « Appliquer ».
 *
 * Détection : un bien dont une donnée qui le cite (document, lien, pièce,
 * événement, échéance, preuve, élément d'agenda, action « À traiter ») porte
 * un autre `account_id` que lui. Le téléversement exige que le bien soit dans
 * le compte courant : un tel écart ne peut venir que d'un déplacement.
 *
 * Correction : `transferAssetOperationsInTx` (lot 39) puis
 * `transferAssetDataInTx` (même règle qu'un déplacement d'aujourd'hui), une
 * transaction par couple (bien, ancien compte). Idempotent : un couple traité
 * ne réapparaît plus ; deux exécutions simultanées se sérialisent sur le
 * verrou de ligne du bien.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { transferAssetOperationsInTx } from '@/services/business-operations/asset-lifecycle';
import { publishBusinessOperationEvents } from '@/services/business-operations/events';
import { afterAssetDataTransfer, transferAssetDataInTx, type AssetDataTransferResult } from './asset-account-transfer.service';

export interface MisplacedAssetData {
  assetId: number;
  /** Compte actuel du bien. */
  toAccountId: number;
  /** Compte où des données du bien sont restées. */
  fromAccountId: number;
}

export interface AssetAccountBackfillReport {
  mode: 'simulate' | 'apply';
  /** Couples (bien, ancien compte) détectés dans ce passage. */
  detected: number;
  processed: number;
  failed: Array<{ assetId: number; fromAccountId: number; error: string }>;
  /** Il reste des couples (lot borné ou délai atteint). */
  more: boolean;
  results: Array<Omit<AssetDataTransferResult, 'events' | 't3'>>;
}

const BATCH = 50;
class Simulation extends Error {}

/** Couples (bien, ancien compte) dont des données sont restées dans l'ancien compte. */
export async function findMisplacedAssetData(limit = BATCH): Promise<MisplacedAssetData[]> {
  const r = (await db.execute(sql`
    SELECT DISTINCT a.id AS asset_id, a.account_id AS to_account, x.account_id AS from_account
      FROM assets a
      JOIN LATERAL (
        SELECT af.account_id FROM asset_files af WHERE (af.asset_id = a.id OR af.linked_asset_id = a.id) AND af.account_id <> a.account_id
        UNION SELECT l.account_id FROM document_asset_links l WHERE l.asset_id = a.id AND l.status = 'ACTIVE' AND l.account_id <> a.account_id
        UNION SELECT r.account_id FROM rooms r WHERE r.asset_id = a.id AND r.account_id <> a.account_id
        UNION SELECT e.account_id FROM events e WHERE e.asset_id = a.id AND e.account_id <> a.account_id
        UNION SELECT d.account_id FROM deadlines d WHERE d.asset_id = a.id AND d.account_id <> a.account_id
        UNION SELECT fe.account_id FROM field_evidence fe WHERE fe.asset_id = a.id AND fe.account_id <> a.account_id
        UNION SELECT ai.account_id FROM agenda_asset_links al JOIN agenda_items ai ON ai.id = al.agenda_item_id
               WHERE al.asset_id = a.id AND ai.account_id <> a.account_id
        UNION SELECT t.account_id FROM to_process_actions t
               WHERE t.target_type = 'ASSET' AND t.target_id = a.id AND t.account_id <> a.account_id
      ) x ON true
     WHERE a.account_id IS NOT NULL
     ORDER BY a.id, x.account_id
     LIMIT ${limit}`)) as unknown as Array<{ asset_id: number; to_account: number; from_account: number }>;
  return r.map((x) => ({ assetId: Number(x.asset_id), toAccountId: Number(x.to_account), fromAccountId: Number(x.from_account) }));
}

/** Transfert d'un couple dans SA transaction (annulée en simulation). */
async function traiter(c: MisplacedAssetData, apply: boolean): Promise<AssetDataTransferResult> {
  let resultat: AssetDataTransferResult | null = null;
  const events: Parameters<typeof publishBusinessOperationEvents>[0][number][] = [];
  try {
    await db.transaction(async (tx) => {
      const ops = await transferAssetOperationsInTx(tx, {
        assetId: c.assetId, fromAccountId: c.fromAccountId, toAccountId: c.toAccountId, reasonCode: 'ASSET_TRANSFER_BACKFILL',
      });
      events.push(...ops.events);
      resultat = await transferAssetDataInTx(tx, {
        assetId: c.assetId, fromAccountId: c.fromAccountId, toAccountId: c.toAccountId, reasonCode: 'ASSET_TRANSFER_BACKFILL',
      });
      events.push(...resultat.events);
      if (!apply) throw new Simulation();
    });
  } catch (e) {
    if (!(e instanceof Simulation)) throw e;
  }
  if (apply) {
    await publishBusinessOperationEvents(events);
    await afterAssetDataTransfer([resultat!], null);
  }
  return resultat!;
}

/**
 * Un passage borné (lot, délai). Simulation : chaque couple est réellement
 * transféré puis ANNULÉ — le rapport est celui de l'application.
 */
export async function runAssetAccountBackfill(p: {
  apply: boolean; deadline?: number; batchSize?: number;
  onProgress?: (x: { processed: number; detected: number; assetId: number }) => void;
}): Promise<AssetAccountBackfillReport> {
  const couples = await findMisplacedAssetData(p.batchSize ?? BATCH);
  const report: AssetAccountBackfillReport = {
    mode: p.apply ? 'apply' : 'simulate', detected: couples.length, processed: 0, failed: [], more: false, results: [],
  };
  for (const c of couples) {
    if (p.deadline && Date.now() > p.deadline) { report.more = true; break; }
    try {
      const { events: _e, t3: _t, ...r } = await traiter(c, p.apply);
      void _e; void _t;
      report.results.push(r);
      report.processed++;
    } catch (e) {
      report.failed.push({ assetId: c.assetId, fromAccountId: c.fromAccountId, error: (e as Error).message.slice(0, 300) });
    }
    p.onProgress?.({ processed: report.processed, detected: couples.length, assetId: c.assetId });
  }
  // Lot plein : d'autres couples peuvent attendre (une simulation ne les fait pas avancer).
  if (couples.length >= (p.batchSize ?? BATCH) && p.apply) report.more = true;
  return report;
}
