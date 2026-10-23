/**
 * Migration C14.3 de l'ancien formulaire Sinistre (`asset_additional_infos.
 * claim_json`, un seul sinistre par bien) vers l'Opération CLAIM — lot 44, O5
 * (CDC Opérations V1 C14.3, C23, C23.1, C24 ; décisions PO Q2, Q11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN BIEN, UNE TRANSACTION, LE VERROU DU COMPTE — SANS COMMANDE
 *
 * Tâche interne `operations-claim-migration` (au démarrage puis toutes les
 * heures, une seule requête s'il n'y a rien à faire) et BO › Exploitation ›
 * Rattrapages (Simuler = exécution réelle dans une transaction ANNULÉE).
 * L'utilisateur n'a rien à lancer.
 *
 * Pour chaque bien dont le JSON n'a jamais été examiné dans cette version (ou
 * a changé depuis — repère `business_operation_claim_migration_marks`,
 * empreinte md5) :
 *
 *   · JSON vide                    → EMPTY (repère seul) ;
 *   · déjà migré, puis modifié par un ANCIEN client (retour arrière, cache)
 *                                  → RESYNCED : la saisie est reportée sur le
 *                                    sinistre qu'elle reflétait (source
 *                                    CLAIM_FORM : l'utilisateur l'a écrite) ;
 *   · sous le seuil (ni type, ni date, ni référence, ni montant)
 *                                  → BELOW_THRESHOLD : rien n'est créé,
 *                                    l'ancienne saisie reste lisible ;
 *   · « trouver avant de créer » (P04, C14.3 étape 21) :
 *       source MIGRATION déjà posée          → LINKED ;
 *       même référence de dossier (M1), même élément d'agenda lié, ou un
 *       seul sinistre DOCUMENTAIRE du bien à la même date de survenue
 *                                            → MATCHED (la saisie enrichit,
 *                                              ses valeurs priment) ;
 *       plusieurs possibles                  → HOLD_AMBIGUOUS (rien créé,
 *                                              EXH-004) ;
 *       aucun                                → CREATED ;
 *   · source MIGRATION (clé stable compte × bien × champ × version, C23.1),
 *     détails, listes, indemnité (INDEMNITY, étape 25), élément d'agenda lié
 *     (étape 23, JAMAIS d'élément créé), pièces et photos des dommages et
 *     factures des actions rattachées (étape 24, aucun document réanalysé) ;
 *   · repère, puis miroir (Q11).
 *
 * Rejouée sans changement : aucune écriture (repère à jour, NFR-OP-005).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { sanitizeSection, type AdditionalInfoSectionData } from '@/lib/assets/additional-infos';
import { isBusinessOperationIntegrityError } from '../errors';
import type { DbTx } from '../lock';
import { normalizeBusinessReference } from '../model';
import { withBusinessOperationWrite, withBusinessOperationWriteInTx, type WriteSession } from '../write';
import {
  CLAIM_MIGRATION_VERSION, claimMigrationSourceKey, claimToSection, hasClaimContent, meetsClaimMigrationThreshold, sectionToClaimWrite,
} from '../claims/model';
import { loadClaimRecords } from '../claims/read';
import { emptyCardNeeds, type OperationCardNeeds } from './card-needs';
import { ClaimFormError, applyClaimSection, syncClaimMirror } from './claim-form';
import { Changes, syncCards } from './consolidator';

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];

export type ClaimMigrationOutcome =
  | 'CREATED' | 'MATCHED' | 'LINKED' | 'RESYNCED' | 'BELOW_THRESHOLD' | 'HOLD_AMBIGUOUS' | 'EMPTY' | 'UNCHANGED';

export interface ClaimMigrationResult {
  assetId: number;
  accountId: number;
  outcome: ClaimMigrationOutcome;
  operationId: number | null;
  reason: string | null;
  changes: number;
  error?: string;
}

interface LegacyRow { claim: AdditionalInfoSectionData; fp: string; markVersion: string | null; markFp: string | null; markAccount: number | null; markOp: number | null; markOutcome: string | null }

async function loadLegacy(tx: DbTx, accountId: number, assetId: number): Promise<LegacyRow | null> {
  const [r] = await rows<Row>(tx, sql`
    SELECT ai.claim_json AS claim, md5(ai.claim_json::text) AS fp, m.migration_version, m.data_fingerprint, m.account_id AS mark_account,
           m.operation_id AS mark_op, m.outcome AS mark_outcome
      FROM assets a JOIN asset_additional_infos ai ON ai.asset_id = a.id
      LEFT JOIN business_operation_claim_migration_marks m ON m.asset_id = a.id
     WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL
       FOR UPDATE OF ai`);
  if (!r) return null;
  const raw = typeof r.claim === 'string' ? JSON.parse(r.claim) : r.claim;
  return {
    claim: sanitizeSection('claim', raw), fp: String(r.fp),
    markVersion: (r.migration_version as string | null) ?? null, markFp: (r.data_fingerprint as string | null) ?? null,
    markAccount: r.mark_account == null ? null : Number(r.mark_account), markOp: r.mark_op == null ? null : Number(r.mark_op),
    markOutcome: (r.mark_outcome as string | null) ?? null,
  };
}

async function writeMark(tx: DbTx, accountId: number, assetId: number, outcome: string, operationId: number | null, detail: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`
    INSERT INTO business_operation_claim_migration_marks (asset_id, account_id, migration_version, data_fingerprint, operation_id, outcome, detail, processed_at)
    SELECT ${assetId}, ${accountId}, ${CLAIM_MIGRATION_VERSION}, md5(ai.claim_json::text), ${operationId}::bigint, ${outcome}, ${JSON.stringify(detail)}::jsonb, now()
      FROM asset_additional_infos ai WHERE ai.asset_id = ${assetId}
    ON CONFLICT (asset_id) DO UPDATE SET account_id = EXCLUDED.account_id, migration_version = EXCLUDED.migration_version,
      data_fingerprint = EXCLUDED.data_fingerprint, operation_id = EXCLUDED.operation_id, outcome = EXCLUDED.outcome,
      detail = EXCLUDED.detail, processed_at = EXCLUDED.processed_at`);
}

/** Date de l'événement lié (agenda ou historique) — compte pour le seuil. */
async function linkedEventDate(tx: DbTx, accountId: number, key: string | null): Promise<string | null> {
  const m = key ? /^(agenda|event):([1-9]\d{0,9})$/.exec(key) : null;
  if (!m) return null;
  const [r] = m[1] === 'agenda'
    ? await rows<{ d: string | null }>(tx, sql`SELECT start_date::text AS d FROM agenda_items WHERE id = ${Number(m[2])} AND account_id = ${accountId}`)
    : await rows<{ d: string | null }>(tx, sql`SELECT date_evenement::text AS d FROM events WHERE id = ${Number(m[2])} AND account_id = ${accountId}`);
  return r?.d ?? null;
}

/** Sinistre existant représentant l'ancienne saisie (C14.3 étape 21). */
async function findExistingClaim(tx: DbTx, accountId: number, assetId: number, s: AdditionalInfoSectionData): Promise<{ ids: number[]; reason: string }> {
  const actifs = sql.raw(`o.type_code = 'CLAIM' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`);
  const migree = await rows<{ id: string }>(tx, sql`
    SELECT DISTINCT o.id FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id
     WHERE s.account_id = ${accountId} AND s.source_kind = 'MIGRATION' AND s.source_entity_key = ${claimMigrationSourceKey(accountId, assetId)}
       AND o.account_id = ${accountId} AND ${actifs}`);
  if (migree.length) return { ids: migree.map((x) => Number(x.id)), reason: 'SAME_MIGRATION_SOURCE' };
  const w = sectionToClaimWrite(s);
  const ref = w.details.insurerClaimRef ? normalizeBusinessReference(w.details.insurerClaimRef) : '';
  if (ref) {
    const r = await rows<{ id: string }>(tx, sql`
      SELECT DISTINCT o.id FROM business_operations o
        JOIN business_operation_references r ON r.operation_id = o.id AND r.active AND r.reference_kind = 'CLAIM' AND r.normalized_value = ${ref}
       WHERE o.account_id = ${accountId} AND ${actifs} ORDER BY o.id`);
    if (r.length) return { ids: r.map((x) => Number(x.id)), reason: 'SAME_CLAIM_REFERENCE' };
  }
  const agenda = w.claimEventKey && /^agenda:/.test(w.claimEventKey) ? Number(w.claimEventKey.slice(7)) : null;
  if (agenda) {
    const r = await rows<{ id: string }>(tx, sql`
      SELECT o.id FROM agenda_items ai JOIN business_operations o ON o.id = ai.business_operation_id
       WHERE ai.id = ${agenda} AND ai.account_id = ${accountId} AND o.account_id = ${accountId} AND ${actifs}`);
    if (r.length) return { ids: r.map((x) => Number(x.id)), reason: 'SAME_AGENDA_EVENT' };
  }
  if (w.occurredOn) {
    const r = await rows<{ id: string }>(tx, sql`
      SELECT DISTINCT o.id FROM business_operations o
        JOIN business_operation_asset_links l ON l.operation_id = o.id AND l.active AND l.asset_id = ${assetId}
       WHERE o.account_id = ${accountId} AND ${actifs} AND o.realized_date = ${w.occurredOn}::date
         AND NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active AND s.source_kind IN ('CLAIM_FORM', 'MIGRATION'))
       ORDER BY o.id`);
    if (r.length) return { ids: r.map((x) => Number(x.id)), reason: 'SAME_ASSET_SAME_DATE' };
  }
  return { ids: [], reason: 'NO_EXISTING_CLAIM' };
}

/** Ancienne saisie superposée à un sinistre existant : ses valeurs (et listes non vides) priment. */
function overlay(base: AdditionalInfoSectionData, legacy: AdditionalInfoSectionData): AdditionalInfoSectionData {
  return sanitizeSection('claim', { ...base, ...legacy });
}

/**
 * Migration (ou resynchronisation) de l'ancienne saisie d'UN bien, dans une
 * session d'écriture ouverte (verrou du compte détenu). `force` : reprise
 * demandée par l'utilisateur (« Reprendre ») — sans seuil, une ambiguïté
 * crée un nouveau sinistre (décision de l'utilisateur).
 */
export async function migrateAssetClaimInSession(
  session: WriteSession, accountId: number, assetId: number, opts: { force?: boolean; today?: string; cards?: OperationCardNeeds } = {},
): Promise<ClaimMigrationResult> {
  const repo = session.repository(accountId);
  const tx = session.tx;
  const changes = new Changes();
  const cards = opts.cards ?? emptyCardNeeds();
  const res = (outcome: ClaimMigrationOutcome, operationId: number | null, reason: string | null): ClaimMigrationResult =>
    ({ assetId, accountId, outcome, operationId, reason, changes: changes.n });
  const legacy = await loadLegacy(tx, accountId, assetId);
  if (!legacy) return res('EMPTY', null, 'NO_LEGACY_ROW');
  if (!opts.force && legacy.markVersion === CLAIM_MIGRATION_VERSION && legacy.markFp === legacy.fp && legacy.markAccount === accountId) {
    return res('UNCHANGED', legacy.markOp, null);
  }
  const s = legacy.claim;
  if (!hasClaimContent(s)) {
    // Vidé par un ancien client : le sinistre n'est pas supprimé pour autant (suppression explicite seulement).
    await writeMark(tx, accountId, assetId, 'EMPTY', legacy.markOp, {});
    return res('EMPTY', null, null);
  }

  // Déjà migré puis modifié hors du nouveau formulaire (ancien client) : report sur le sinistre reflété.
  if (legacy.markOp !== null && legacy.markOutcome !== 'BELOW_THRESHOLD' && legacy.markOutcome !== 'HOLD_AMBIGUOUS' && !opts.force) {
    const [rec] = await loadClaimRecords(tx, accountId, { ids: [legacy.markOp] });
    if (rec && rec.assets.some((a) => a.assetId === assetId)) {
      const sourceId = await repo.addSource(rec.id, {
        kind: 'CLAIM_FORM', entityKey: assetId, locator: { form: 'claim' }, authority: 'USER', confidence: 'certain', matchReason: 'LEGACY_CLAIM_FORM_RESYNC',
      }, 'CLAIM_FORM_SOURCE');
      const assetIds = rec.assets.map((a) => a.assetId);
      const primary = rec.assets.find((a) => a.role === 'PRIMARY')?.assetId ?? assetId;
      await applyClaimSection(session, accountId, rec.id, s, { sourceId, assetIds, primaryAssetId: primary, today: opts.today, changes, cards });
      await writeMark(tx, accountId, assetId, 'RESYNCED', rec.id, { reason: 'LEGACY_WRITE_AFTER_MIGRATION' });
      await syncClaimMirror(tx, accountId, assetIds);
      return res('RESYNCED', rec.id, 'LEGACY_WRITE_AFTER_MIGRATION');
    }
  }

  const eventDate = await linkedEventDate(tx, accountId, (s.claimEventKey as string | undefined) ?? null);
  if (!opts.force && !meetsClaimMigrationThreshold(s, eventDate)) {
    await writeMark(tx, accountId, assetId, 'BELOW_THRESHOLD', null, { keys: Object.keys(s).sort() });
    return res('BELOW_THRESHOLD', null, 'BELOW_THRESHOLD');
  }

  const found = await findExistingClaim(tx, accountId, assetId, s);
  if (found.ids.length > 1 && !opts.force) {
    await writeMark(tx, accountId, assetId, 'HOLD_AMBIGUOUS', null, { reason: found.reason, candidates: found.ids });
    return res('HOLD_AMBIGUOUS', null, found.reason);
  }
  const migrationSource = {
    kind: 'MIGRATION' as const, entityKey: claimMigrationSourceKey(accountId, assetId),
    locator: { assetId, field: 'claim_json', version: CLAIM_MIGRATION_VERSION }, authority: 'USER' as const, confidence: 'certain' as const,
  };
  let claimId: number;
  let sourceId: number;
  let outcome: ClaimMigrationOutcome;
  let section = s;
  if (found.ids.length === 1 && !(opts.force && found.reason !== 'SAME_MIGRATION_SOURCE' && found.reason !== 'SAME_CLAIM_REFERENCE' && found.reason !== 'SAME_AGENDA_EVENT')) {
    claimId = found.ids[0];
    outcome = found.reason === 'SAME_MIGRATION_SOURCE' ? 'LINKED' : 'MATCHED';
    const avant = await rows<{ id: string }>(tx, sql`SELECT id FROM business_operation_sources WHERE operation_id = ${claimId} AND active`);
    sourceId = await repo.addSource(claimId, { ...migrationSource, matchMethod: found.reason === 'SAME_CLAIM_REFERENCE' ? 'M1' : 'M2', matchReason: `MIGRATION_${CLAIM_MIGRATION_VERSION}:${found.reason}` }, 'CLAIM_MIGRATION_MATCH');
    changes.track(!avant.some((x) => Number(x.id) === sourceId));
    changes.track(await repo.linkAsset(claimId, { assetId, authority: 'USER', sourceId }, 'CLAIM_MIGRATION_ASSET'));
    const [rec] = await loadClaimRecords(tx, accountId, { ids: [claimId] });
    if (rec) section = overlay(claimToSection(rec), s);
  } else {
    const w = sectionToClaimWrite(s);
    const created = await repo.create({
      type: { code: 'CLAIM' }, status: 'REALIZED', realizedDate: w.occurredOn,
      source: { ...migrationSource, matchReason: `MIGRATION_${CLAIM_MIGRATION_VERSION}:${opts.force ? 'USER_RESUMED' : found.reason}` },
      assets: [{ assetId, role: 'PRIMARY', authority: 'USER' }],
      reasonCode: 'CLAIM_MIGRATION_CREATE',
    });
    changes.track(true);
    claimId = created.id;
    sourceId = created.sourceId;
    outcome = 'CREATED';
  }
  const [rec] = await loadClaimRecords(tx, accountId, { ids: [claimId] });
  const assetIds = rec?.assets.map((a) => a.assetId) ?? [assetId];
  const primary = rec?.assets.find((a) => a.role === 'PRIMARY')?.assetId ?? assetId;
  try {
    await applyClaimSection(session, accountId, claimId, section, { sourceId, assetIds, primaryAssetId: primary, today: opts.today, changes, cards });
  } catch (e) {
    // Événement lié devenu introuvable ou déjà rattaché ailleurs : migré sans ce lien (jamais bloquant).
    if (!(e instanceof ClaimFormError) || (e.code !== 'EVENT_NOT_FOUND' && e.code !== 'EVENT_ALREADY_LINKED')) throw e;
    const { claimEventKey: _k, ...sans } = section;
    void _k;
    await applyClaimSection(session, accountId, claimId, sans, { sourceId, assetIds, primaryAssetId: primary, today: opts.today, changes, cards });
  }
  await writeMark(tx, accountId, assetId, outcome, claimId, { reason: found.reason });
  await syncClaimMirror(tx, accountId, assetIds);
  return res(outcome, claimId, found.reason);
}

/** Migration d'un bien, transaction propre (tâche, route, reprise). Erreur d'intégrité : journalisée, tracée. */
export async function migrateAssetClaim(accountId: number, assetId: number, opts: { force?: boolean; today?: string } = {}): Promise<ClaimMigrationResult> {
  let cards = emptyCardNeeds();
  try {
    const r = await withBusinessOperationWrite(accountId, (_repo, session) => {
      cards = emptyCardNeeds();
      return migrateAssetClaimInSession(session, accountId, assetId, { ...opts, cards });
    }, { correlationId: `claim-migration:${assetId}` });
    if (cards.reviewedOperations.length) await syncCards(accountId, cards);
    return r;
  } catch (e) {
    if (!isBusinessOperationIntegrityError(e)) throw e;
    console.error(`[claim-migration] bien ${assetId} (compte ${accountId}) : ${e.message}`);
    await db.transaction(async (tx) => {
      const [a] = await rows(tx, sql`SELECT 1 FROM asset_additional_infos WHERE asset_id = ${assetId} AND account_id = ${accountId}`);
      if (a) await writeMark(tx, accountId, assetId, 'ERROR', null, { error: e.code });
    });
    return { assetId, accountId, outcome: 'UNCHANGED', operationId: null, reason: null, changes: 0, error: e.code };
  }
}

export interface AssetToMigrate { assetId: number; accountId: number }

/** Biens à examiner (curseur stable) : JSON jamais examiné dans cette version, modifié depuis, ou bien déplacé de compte. */
export async function listAssetsWithLegacyClaim(limit: number, afterAssetId = 0, accountId: number | null = null): Promise<AssetToMigrate[]> {
  const r = (await db.execute(sql`
    SELECT a.id, a.account_id FROM assets a
      JOIN asset_additional_infos ai ON ai.asset_id = a.id
      LEFT JOIN business_operation_claim_migration_marks m ON m.asset_id = a.id
     WHERE a.deleted_at IS NULL AND a.account_id IS NOT NULL AND a.id > ${afterAssetId}
       AND (${accountId}::int IS NULL OR a.account_id = ${accountId}::int)
       -- Lot 82A (C-Q10, §3.3) : comptes éligibles seulement (repère conservé : repris à la réactivation).
       AND ${sql.raw(processingEligibleSql('a.account_id'))}
       AND (ai.claim_json <> '{}'::jsonb OR m.asset_id IS NOT NULL)
       AND (m.asset_id IS NULL OR m.migration_version <> ${CLAIM_MIGRATION_VERSION} OR m.account_id <> a.account_id
            OR m.data_fingerprint <> md5(ai.claim_json::text))
     ORDER BY a.id
     LIMIT ${limit}`)) as unknown as Array<{ id: number; account_id: number }>;
  return r.map((x) => ({ assetId: Number(x.id), accountId: Number(x.account_id) }));
}

export interface ClaimMigrationReport {
  mode: 'simulate' | 'apply';
  version: string;
  scanned: number;
  processed: number;
  failed: Array<{ assetId: number; accountId: number; error: string }>;
  more: boolean;
  /** Écritures métier — 0 si rejouée sans changement. */
  changes: number;
  outcomes: Partial<Record<ClaimMigrationOutcome, number>>;
  /** Biens laissés sans sinistre (sous le seuil, ambiguïté) — échantillon. */
  holds: Array<{ assetId: number; accountId: number; outcome: ClaimMigrationOutcome; reason: string | null }>;
}

class Simulation extends Error {}

async function simulerBien(c: AssetToMigrate, today?: string): Promise<ClaimMigrationResult> {
  let res: ClaimMigrationResult | null = null;
  try {
    await db.transaction(async (tx) => {
      const { result } = await withBusinessOperationWriteInTx(tx, [c.accountId], (session) =>
        migrateAssetClaimInSession(session, c.accountId, c.assetId, { today }));
      res = result;
      throw new Simulation();
    });
  } catch (e) {
    if (!(e instanceof Simulation)) throw e;
  }
  return res!;
}

/**
 * Passage borné de la migration (tâche interne, BO). Simulation : chaque bien
 * est réellement migré puis ANNULÉ — rapport exact, aucune écriture.
 */
export async function runClaimMigration(p: {
  apply: boolean; deadline?: number; batchSize?: number; maxAssets?: number; accountId?: number | null; today?: string;
  onProgress?: (x: { processed: number; assetId: number }) => void;
}): Promise<ClaimMigrationReport> {
  const batch = Math.max(1, Math.min(p.batchSize ?? 200, 1000));
  const max = p.maxAssets ?? Number.POSITIVE_INFINITY;
  const report: ClaimMigrationReport = {
    mode: p.apply ? 'apply' : 'simulate', version: CLAIM_MIGRATION_VERSION, scanned: 0, processed: 0, failed: [], more: false, changes: 0, outcomes: {}, holds: [],
  };
  let curseur = 0;
  for (;;) {
    const lot = await listAssetsWithLegacyClaim(batch, curseur, p.accountId ?? null);
    if (!lot.length) break;
    for (const c of lot) {
      if ((p.deadline && Date.now() > p.deadline) || report.scanned >= max) { report.more = true; return report; }
      report.scanned++;
      curseur = c.assetId;
      try {
        const r = p.apply ? await migrateAssetClaim(c.accountId, c.assetId, { today: p.today }) : await simulerBien(c, p.today);
        if (r.error) { report.failed.push({ assetId: c.assetId, accountId: c.accountId, error: r.error }); continue; }
        report.processed++;
        report.changes += r.changes;
        report.outcomes[r.outcome] = (report.outcomes[r.outcome] ?? 0) + 1;
        if ((r.outcome === 'BELOW_THRESHOLD' || r.outcome === 'HOLD_AMBIGUOUS') && report.holds.length < 200) {
          report.holds.push({ assetId: c.assetId, accountId: c.accountId, outcome: r.outcome, reason: r.reason });
        }
      } catch (e) {
        report.failed.push({ assetId: c.assetId, accountId: c.accountId, error: (e as Error).message.slice(0, 300) });
      }
      p.onProgress?.({ processed: report.processed, assetId: c.assetId });
    }
    if (lot.length < batch) break;
  }
  return report;
}
