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
 * Lot 54 (ticket SEC-P0-CORR, variante PRUDENTE — risque signalé par 53B) :
 * « un tel écart ne peut venir que d'un déplacement » est une HYPOTHÈSE, pas
 * une preuve. Une relation intercomptes héritée (document du compte B
 * rattaché à tort au bien du compte A) aurait été traitée comme un
 * déplacement et ses données transférées de B vers A, chaque heure, sans
 * validation. Le rattrapage AUTOMATIQUE ne traite plus que les couples
 * PROUVÉS : une demande de déplacement ACCEPTÉE (`asset_move_requests`) du
 * bien vers son compte actuel, dans un Duo auquel l'ancien compte est relié
 * (compte titulaire `duo_account_id`, titulaire payeur ou membre du Duo).
 * Les autres couples sont seulement COMPTÉS (`unproven`) : ils restent des
 * anomalies d'isolation (BO › Exploitation › Isolation des comptes), traitées
 * par la correction contrôlée (détachement, jamais un transfert) ou en
 * attente de décision (Duo, D3 ouvert).
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

interface MisplacedAssetData {
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
  /** Lot 54 : couples SANS preuve de déplacement — jamais transférés (anomalies d'isolation). */
  unproven: number;
  processed: number;
  failed: Array<{ assetId: number; fromAccountId: number; error: string }>;
  /** Il reste des couples (lot borné ou délai atteint). */
  more: boolean;
  results: Array<Omit<AssetDataTransferResult, 'events' | 't3'>>;
}

const BATCH = 50;
class Simulation extends Error {}

/**
 * Preuve d'un déplacement légitime (lot 54) : demande ACCEPTÉE du bien vers
 * son compte actuel, dans un Duo relié à l'ancien compte — ou (lot 74B)
 * déplacement volontaire journalisé dans `asset_space_moves`. SQL partagé.
 */
const PROVEN_MOVE_SQL = (asset: string, to: string, from: string) => `(EXISTS (
  SELECT 1 FROM asset_move_requests m
   WHERE m.asset_id = ${asset} AND m.status = 'ACCEPTED' AND m.target_account_id = ${to}
     AND (EXISTS (SELECT 1 FROM accounts fa WHERE fa.id = ${from} AND fa.duo_account_id = m.duo_id)
       OR EXISTS (SELECT 1 FROM accounts fa JOIN duo_accounts d ON d.billing_owner_user_id = fa.owner_user_id
                   WHERE fa.id = ${from} AND d.id = m.duo_id)
       OR EXISTS (SELECT 1 FROM accounts fa JOIN duo_memberships dm ON dm.user_id = fa.owner_user_id
                   WHERE fa.id = ${from} AND dm.duo_id = m.duo_id)))
  /* Lot 74B : déplacement volontaire vers l espace Duo, journalisé (0536). */
  OR EXISTS (SELECT 1 FROM asset_space_moves v
              WHERE v.asset_id = ${asset} AND v.to_account_id = ${to} AND v.from_account_id = ${from}))`;

/** Couples (bien, ancien compte) dont des données sont restées dans l'ancien compte. */
export async function findMisplacedAssetData(
  limit = BATCH,
  /** `true` (défaut) : couples prouvés ; `false` : sans preuve ; `null` : tous. */
  opts: { proven?: boolean | null } = {},
): Promise<MisplacedAssetData[]> {
  const preuve = opts.proven === undefined ? true : opts.proven;
  const filtre = preuve === null ? sql`` : preuve
    ? sql.raw(` AND ${PROVEN_MOVE_SQL('a.id', 'a.account_id', 'x.account_id')}`)
    : sql.raw(` AND NOT ${PROVEN_MOVE_SQL('a.id', 'a.account_id', 'x.account_id')}`);
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
     WHERE a.account_id IS NOT NULL${filtre}
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
  const couples = await findMisplacedAssetData(p.batchSize ?? BATCH, { proven: true });
  // Sans preuve : comptés, jamais transférés (lot 54, variante prudente).
  const sansPreuve = await findMisplacedAssetData(Math.max(p.batchSize ?? BATCH, 500), { proven: false });
  const report: AssetAccountBackfillReport = {
    mode: p.apply ? 'apply' : 'simulate', detected: couples.length, unproven: sansPreuve.length, processed: 0, failed: [], more: false, results: [],
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
