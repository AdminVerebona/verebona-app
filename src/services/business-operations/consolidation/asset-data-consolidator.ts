/**
 * Réconciliation T3 des données STRUCTURÉES d'un bien en Opérations (sources
 * ASSET_DATA) et migration structurée de l'existant — lot 43, O4 (CDC
 * Opérations V1 ch. 14, 26, B13.1, B13.3, B13.6, B24, C2, C4 TRG-008 à
 * TRG-010, C5, C7.1, C7.3, C7.6, C23.1, C27 ; décisions PO Q5, Q6, Q12).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNITÉ DE TRAVAIL : UN BIEN, UNE TRANSACTION, LE VERROU DU COMPTE
 *
 *   1. relire le bien (compte, non supprimé) et ses sources ASSET_DATA ;
 *   2. pour chaque nature (ACQUISITION, DISPOSAL, CONTRACT), la réalité que
 *      la fiche établit (`asset-data.ts`, garde anti-blanchiment : saisie
 *      humaine seulement) :
 *        · plus établie → la source est retirée (TRG-010 : un retour depuis
 *          VENDU retire la donnée, jamais une vente prouvée par un document :
 *          l'Opération survit si une autre source la justifie) ;
 *        · déjà liée → version de la source suivie, Opération reconsolidée ;
 *        · sinon RECHERCHE AVANT CRÉATION (P04) par la machine C5 / C6 / C7
 *          des documents (`decideCandidate`) : même cycle de possession
 *          (C7.1, C7.6), même police (C7.3, M1) → la source enrichit
 *          l'Opération documentaire existante, JAMAIS de doublon document +
 *          donnée structurée (C7.1, C7.6) ; aucune → CREATE_NEW (C5 : « le
 *          champ sémantique suffit ») ; ambiguïté → rien (P06) ;
 *   3. chaque Opération touchée est reconsolidée depuis TOUTES ses sources
 *      (la saisie prime pour le fait qu'elle porte, `applyStructuredAuthority`) ;
 *   4. repère du bien (`business_operation_asset_data_marks`, clé stable
 *      bien × version de migration) : empreinte et issues par nature.
 *
 * Périmètre (C5, lot 41 point 7) : un bien ARCHIVÉ ne reçoit aucune création ;
 * VENDU / TRANSMIS : la Cession et l'Acquisition (historique du cycle) oui,
 * un Contrat non (« relation actuelle certaine » requise, C23.1).
 *
 * Déclencheurs : `asset_updated` / `asset_disposed` (TRG-008 à TRG-010) mis
 * en file par la fiche, « À traiter » ASSET-STATUS, la transmission, l'API
 * historique ; filet horaire et migration de l'existant : tâche interne
 * `operations-structured-migration` (biens jamais examinés, ou modifiés
 * depuis — `assets.operations_data_changed_at`, 0322) et BO › Exploitation ›
 * Rattrapages (Simuler = exécution réelle dans une transaction ANNULÉE).
 *
 * Aucune réécriture de la fiche (B1 : le bien reste la source de vérité de
 * ses champs ; pas de boucle fiche ↔ Opération) ; aucun document réanalysé
 * (P19) ; rien de visible pour l'utilisateur (P09).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { isBusinessOperationIntegrityError } from '../errors';
import type { DbTx } from '../lock';
import { withBusinessOperationWrite, withBusinessOperationWriteInTx, type WriteSession } from '../write';
import {
  ASSET_DATA_MIGRATION_VERSION, ASSET_DATA_NATURES, assetDataFactVersion, assetDataFacts, assetDataFingerprint, assetDataIdentity,
  type AssetDataNature,
} from './asset-data';
import { emptyCardNeeds, type OperationCardNeeds } from './card-needs';
import {
  Changes, loadAssetDataRow, loadMatchableOperations, reconsolidateOperation, syncCards, typeInput, type ConsolidationOptions,
} from './consolidator';
import { decideCandidate, type T3Outcome } from './matching';

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];
const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Issue par nature (diagnostic, repère, rapport BO). */
export type AssetDataOutcome =
  | 'NONE'              // la fiche n'établit pas cette réalité, aucune source
  | 'LINKED'            // source déjà liée : version suivie, Opération reconsolidée
  | 'WITHDRAWN'         // la fiche ne l'établit plus : source retirée
  | Extract<T3Outcome, 'CREATE_NEW' | 'MATCH_AND_ENRICH' | 'HOLD_UNRESOLVED' | 'ARBITRATION_REQUIRED'>;

export interface AssetDataNatureResult {
  nature: AssetDataNature;
  outcome: AssetDataOutcome;
  reason: string | null;
  operationId: number | null;
}

export interface AssetDataResult {
  assetId: number;
  accountId: number;
  /** Écritures métier (historisées). */
  changes: number;
  natures: AssetDataNatureResult[];
  /** Bien introuvable dans ce compte (supprimé, déplacé) : sources retirées. */
  gone?: boolean;
  error?: string;
}

/** Statut du bien vu par le périmètre de création, selon la nature (voir l'en-tête). */
function perimeterStatus(nature: AssetDataNature, status: string | null | undefined): string {
  const s = String(status ?? 'EN_SERVICE').toUpperCase();
  if (nature === 'ACQUISITION' && (s === 'VENDU' || s === 'TRANSMIS')) return 'EN_SERVICE';
  return s;
}

interface AssetDataSourceRow { id: number; operationId: number; active: boolean; nature: string; merged: boolean }

async function loadAssetDataSources(tx: DbTx, accountId: number, assetId: number): Promise<AssetDataSourceRow[]> {
  const r = await rows<Row>(tx, sql`
    SELECT s.id, s.operation_id, s.active, s.locator->>'nature' AS nature, o.merged_into_operation_id IS NOT NULL AS merged
      FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
     WHERE s.account_id = ${accountId} AND s.source_kind = 'ASSET_DATA' AND s.source_entity_key = ${String(assetId)}
       AND s.locator ? 'nature'
     ORDER BY s.id`);
  return r.map((x) => ({ id: Number(x.id), operationId: Number(x.operation_id), active: Boolean(x.active), nature: String(x.nature), merged: Boolean(x.merged) }));
}

/**
 * Réconciliation d'UN bien dans une session d'écriture Opération ouverte
 * (verrou du compte détenu). Utilisée par l'événement, la tâche et la
 * simulation BO (transaction annulée par l'appelant).
 */
export async function reconcileAssetDataInSession(
  session: WriteSession, accountId: number, assetId: number,
  opts: { today?: string; cards?: OperationCardNeeds; origin?: 'EVENT' | 'MIGRATION'; onMergeStep?: ConsolidationOptions['onMergeStep'] } = {},
): Promise<AssetDataResult> {
  const repo = session.repository(accountId);
  const tx = session.tx;
  const today = opts.today ?? todayUtc();
  const cards = opts.cards ?? emptyCardNeeds();
  const changes = new Changes();
  const result: AssetDataResult = { assetId, accountId, changes: 0, natures: [] };
  const row = await loadAssetDataRow(tx, accountId, assetId);
  const sources = await loadAssetDataSources(tx, accountId, assetId);
  const touched = new Set<number>();

  if (!row) {
    // Bien supprimé ou parti dans un autre compte : la donnée ne prouve plus rien ici.
    for (const s of sources.filter((x) => x.active && !x.merged)) {
      changes.track(await repo.deactivateSource(s.id, 'ASSET_DATA_WITHDRAWN'));
      touched.add(s.operationId);
    }
    for (const id of [...touched].sort((a, b) => a - b)) await reconsolidateOperation(repo, tx, id, today, changes, cards);
    result.gone = true;
    result.changes = changes.n;
    return result;
  }

  const facts = assetDataFacts(row);
  for (const nature of ASSET_DATA_NATURES) {
    const fact = facts[nature];
    const actives = sources.filter((s) => s.nature === nature && s.active && !s.merged);
    if (!fact) {
      for (const s of actives) {
        changes.track(await repo.deactivateSource(s.id, 'ASSET_DATA_WITHDRAWN'));
        touched.add(s.operationId);
      }
      result.natures.push({ nature, outcome: actives.length ? 'WITHDRAWN' : 'NONE', reason: null, operationId: actives[0]?.operationId ?? null });
      continue;
    }
    const version = assetDataFactVersion(fact);
    if (actives.length) {
      await repo.refreshSourceVersion(actives[0].id, version);
      touched.add(actives[0].operationId);
      result.natures.push({ nature, outcome: 'LINKED', reason: null, operationId: actives[0].operationId });
      continue;
    }

    // Recherche AVANT création (P04) : mêmes règles fermées que les documents.
    const identity = assetDataIdentity(assetId, fact, { forMatching: true });
    // Une source de cette nature retirée puis rétablie retrouve son Opération (même source, M2).
    const anciennes = [...new Set(sources.filter((s) => s.nature === nature && !s.active && !s.merged).map((s) => s.operationId))];
    const ops = (await loadMatchableOperations(tx, accountId, identity, anciennes))
      .map((o) => ({ ...o, sameSource: anciennes.includes(o.id) }));
    const d = decideCandidate(identity, {
      operations: ops, confirmed: new Set(), rejected: new Set(),
      assetStatus: new Map([[assetId, perimeterStatus(nature, row.status)]]),
    });
    const source = {
      kind: 'ASSET_DATA' as const, entityKey: assetId, version, role: null,
      locator: { nature }, authority: 'USER' as const, confidence: 'certain' as const,
    };
    // Trace de la migration structurée (C23.1) : source du lot de migration, même autorité que la donnée.
    const migration = opts.origin === 'MIGRATION' ? `MIGRATION_${ASSET_DATA_MIGRATION_VERSION}:` : '';

    if (d.outcome === 'CREATE_NEW') {
      const created = await repo.create({
        type: typeInput(nature), status: 'REALIZED',
        realizedDate: nature === 'CONTRACT' ? null : fact.date,
        provider: fact.provider, technicalLabel: identity.summary,
        source: { ...source, matchMethod: null, matchReason: `${migration}${d.reason}` },
        assets: [{ assetId, role: 'PRIMARY', authority: 'USER' }],
        reasonCode: opts.origin === 'MIGRATION' ? 'ASSET_DATA_MIGRATION_CREATE' : 'ASSET_DATA_CREATE',
      });
      changes.track(true);
      touched.add(created.id);
      result.natures.push({ nature, outcome: 'CREATE_NEW', reason: d.reason, operationId: created.id });
    } else if (d.outcome === 'MATCH_AND_ENRICH' && d.operationId !== null) {
      const opId = d.operationId;
      for (const absorbee of d.mergeIds ?? []) {
        if (await repo.mergeOperations(absorbee, opId, 'T3_MERGE_COMMON_REFERENCE', { onStep: opts.onMergeStep })) changes.track(true);
        touched.delete(absorbee);
        cards.reviewedOperations.push(absorbee);
      }
      const avant = await rows<{ id: string }>(tx, sql`SELECT id FROM business_operation_sources WHERE operation_id = ${opId} AND active`);
      const sourceId = await repo.addSource(opId, { ...source, matchMethod: d.matchMethod, matchReason: `${migration}${d.reason}` },
        opts.origin === 'MIGRATION' ? 'ASSET_DATA_MIGRATION_MATCH' : 'ASSET_DATA_MATCH');
      if (!avant.some((x) => Number(x.id) === sourceId)) changes.track(true);
      await repo.refreshSourceVersion(sourceId, version);
      touched.add(opId);
      result.natures.push({ nature, outcome: 'MATCH_AND_ENRICH', reason: d.reason, operationId: opId });
    } else {
      // Ambiguïté (plusieurs Opérations possibles), périmètre : rien n'est créé (P06).
      result.natures.push({
        nature, outcome: d.outcome === 'ARBITRATION_REQUIRED' ? 'ARBITRATION_REQUIRED' : 'HOLD_UNRESOLVED', reason: d.reason, operationId: null,
      });
    }
  }

  for (const id of [...touched].sort((a, b) => a - b)) await reconsolidateOperation(repo, tx, id, today, changes, cards);
  result.changes = changes.n;
  await writeMark(tx, accountId, assetId, assetDataFingerprint(facts, row.status), result.natures);
  return result;
}

/** Repère du bien (idempotent : réécrit la même ligne). */
async function writeMark(tx: DbTx, accountId: number, assetId: number, fingerprint: string, natures: AssetDataNatureResult[] | { error: string }): Promise<void> {
  const outcomes = Array.isArray(natures)
    ? Object.fromEntries(natures.map((n) => [n.nature, { outcome: n.outcome, reason: n.reason, operationId: n.operationId }]))
    : natures;
  await tx.execute(sql`
    INSERT INTO business_operation_asset_data_marks (asset_id, account_id, migration_version, data_fingerprint, outcomes, processed_at)
    VALUES (${assetId}, ${accountId}, ${ASSET_DATA_MIGRATION_VERSION}, ${fingerprint}, ${JSON.stringify(outcomes)}::jsonb, now())
    ON CONFLICT (asset_id) DO UPDATE SET account_id = EXCLUDED.account_id, migration_version = EXCLUDED.migration_version,
      data_fingerprint = EXCLUDED.data_fingerprint, outcomes = EXCLUDED.outcomes, processed_at = EXCLUDED.processed_at`);
}

/**
 * Réconciliation d'un bien, transaction propre (événement, tâche). Événements
 * Opération et cartes « À traiter » APRÈS commit. Erreur d'intégrité
 * (NFR-OP-008) : journalisée, tracée sur le repère (pas de reprise en boucle).
 */
export async function consolidateAssetData(
  accountId: number, assetId: number, opts: ConsolidationOptions & { origin?: 'EVENT' | 'MIGRATION' } = {},
): Promise<AssetDataResult> {
  await opts.beforeWrite?.('réconciliation des données structurées d\'un bien');
  let cards = emptyCardNeeds();
  try {
    const r = await withBusinessOperationWrite(accountId, async (_repo, session) => {
      cards = emptyCardNeeds();
      return reconcileAssetDataInSession(session, accountId, assetId, { today: opts.today, cards, origin: opts.origin, onMergeStep: opts.onMergeStep });
    }, { correlationId: opts.correlationId });
    if (opts.syncCards !== false && (cards.reviewedOperations.length || cards.reviewedFiles.length)) await syncCards(accountId, cards);
    return r;
  } catch (e) {
    if (!isBusinessOperationIntegrityError(e)) throw e;
    console.error(`[t3-operations] données structurées du bien ${assetId} (compte ${accountId}) : ${e.message}`);
    await db.transaction(async (tx) => {
      const [a] = await rows(tx, sql`SELECT 1 FROM assets WHERE id = ${assetId} AND account_id = ${accountId}`);
      if (a) await writeMark(tx, accountId, assetId, `error:${e.code}`, { error: e.code });
    });
    return { assetId, accountId, changes: 0, natures: [], error: e.code };
  }
}

// ── Migration structurée de l'existant (C23.1) ─────────────────────────────

export interface AssetToReconcile { assetId: number; accountId: number }

/**
 * Biens à examiner (curseur stable par identifiant) : jamais examinés dans
 * la version courante, déplacés de compte depuis, ou dont une donnée
 * structurée a changé depuis le dernier passage (filet d'un événement perdu).
 */
export async function listAssetsToReconcile(limit: number, afterAssetId = 0, accountId: number | null = null): Promise<AssetToReconcile[]> {
  const r = (await db.execute(sql`
    SELECT a.id, a.account_id FROM assets a
      LEFT JOIN business_operation_asset_data_marks m ON m.asset_id = a.id
     WHERE a.deleted_at IS NULL AND a.account_id IS NOT NULL AND a.id > ${afterAssetId}
       AND (${accountId}::int IS NULL OR a.account_id = ${accountId}::int)
       -- Lot 82A (C-Q10, §3.3) : comptes éligibles seulement (repère conservé : repris à la réactivation).
       AND ${sql.raw(processingEligibleSql('a.account_id'))}
       AND (m.asset_id IS NULL OR m.migration_version <> ${ASSET_DATA_MIGRATION_VERSION} OR m.account_id <> a.account_id
            OR (a.operations_data_changed_at IS NOT NULL AND a.operations_data_changed_at > m.processed_at))
     ORDER BY a.id
     LIMIT ${limit}`)) as unknown as Array<{ id: number; account_id: number }>;
  return r.map((x) => ({ assetId: Number(x.id), accountId: Number(x.account_id) }));
}

export interface StructuredMigrationReport {
  mode: 'simulate' | 'apply';
  version: string;
  /** Biens examinés dans ce passage. */
  scanned: number;
  processed: number;
  failed: Array<{ assetId: number; accountId: number; error: string }>;
  /** D'autres biens restent à examiner (lot ou délai atteint). */
  more: boolean;
  /** Écritures métier (Opérations, sources, composantes…) — 0 si rejouée sans changement. */
  changes: number;
  /** Issues par nature : CREATE_NEW, MATCH_AND_ENRICH, LINKED, WITHDRAWN, HOLD_UNRESOLVED… */
  outcomes: Record<AssetDataNature, Partial<Record<AssetDataOutcome, number>>>;
  /** Cas laissés sans Opération (ambiguïté, périmètre) — échantillon. */
  holds: Array<{ assetId: number; accountId: number; nature: AssetDataNature; reason: string | null }>;
}

class Simulation extends Error {}

/** Un bien en simulation : exécution réelle dans une transaction ANNULÉE (rapport exact, aucune écriture). */
async function simulerBien(c: AssetToReconcile, today?: string): Promise<AssetDataResult> {
  let res: AssetDataResult | null = null;
  try {
    await db.transaction(async (tx) => {
      const { result } = await withBusinessOperationWriteInTx(tx, [c.accountId], (session) =>
        reconcileAssetDataInSession(session, c.accountId, c.assetId, { today, origin: 'MIGRATION' }));
      res = result;
      throw new Simulation();
    });
  } catch (e) {
    if (!(e instanceof Simulation)) throw e;
  }
  return res!;
}

/**
 * Passage borné de la migration structurée (tâche interne, BO). Simulation :
 * chaque bien est réellement réconcilié puis ANNULÉ — le rapport est celui de
 * l'application, rien n'est écrit (ni Opération, ni événement, ni repère).
 */
export async function runStructuredOperationsMigration(p: {
  apply: boolean; deadline?: number; batchSize?: number; maxAssets?: number; accountId?: number | null; today?: string;
  onProgress?: (x: { processed: number; assetId: number }) => void;
}): Promise<StructuredMigrationReport> {
  const batch = Math.max(1, Math.min(p.batchSize ?? 200, 1000));
  const max = p.maxAssets ?? Number.POSITIVE_INFINITY;
  const report: StructuredMigrationReport = {
    mode: p.apply ? 'apply' : 'simulate', version: ASSET_DATA_MIGRATION_VERSION, scanned: 0, processed: 0, failed: [], more: false, changes: 0,
    outcomes: { ACQUISITION: {}, DISPOSAL: {}, CONTRACT: {} }, holds: [],
  };
  let curseur = 0;
  for (;;) {
    const lot = await listAssetsToReconcile(batch, curseur, p.accountId ?? null);
    if (!lot.length) break;
    for (const c of lot) {
      if ((p.deadline && Date.now() > p.deadline) || report.scanned >= max) { report.more = true; return report; }
      report.scanned++;
      curseur = c.assetId;
      try {
        const r = p.apply
          ? await consolidateAssetData(c.accountId, c.assetId, { origin: 'MIGRATION', today: p.today })
          : await simulerBien(c, p.today);
        if (r.error) { report.failed.push({ assetId: c.assetId, accountId: c.accountId, error: r.error }); continue; }
        report.processed++;
        report.changes += r.changes;
        for (const n of r.natures) {
          report.outcomes[n.nature][n.outcome] = (report.outcomes[n.nature][n.outcome] ?? 0) + 1;
          if ((n.outcome === 'HOLD_UNRESOLVED' || n.outcome === 'ARBITRATION_REQUIRED') && report.holds.length < 200) {
            report.holds.push({ assetId: c.assetId, accountId: c.accountId, nature: n.nature, reason: n.reason });
          }
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
