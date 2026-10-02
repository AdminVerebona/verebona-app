/**
 * Rattrapage §14.8 — reconstituer `document_asset_links` (CDC 15 §14 point 8,
 * X-01 ; plan D-11, HC-03).
 *
 *   1. COLONNES : pour chaque document, `document_asset_links_sync_file(id)`
 *      — la fonction même du déclencheur — pose les liens LEGACY_COLUMN
 *      depuis asset_id / linked_asset_id / linked_room_id / equipment_id ;
 *   2. RATTACHEMENTS CONFIRMÉS : propositions de lien T1 acceptées telles
 *      quelles par l'utilisateur (`document_analysis_proposals`,
 *      proposal_type = 'link', status = 'kept') → lien MIGRATION, SECONDARY,
 *      si la cible existe dans le même compte. Pièce (D-G, lot 20) : une
 *      proposition ANTÉRIEURE à la migration 0229 porte un identifiant
 *      `rooms` — lien vers la sous-structure reprise (`legacy_room_id`), sinon
 *      vers la pièce historique (`room_id`, reprise plus tard par
 *      `scripts/merge-rooms-into-substructures.ts`) ; une proposition
 *      postérieure porte un identifiant de sous-structure.
 *
 * Tout ce qui ne se tranche pas sans hypothèse va au RAPPORT, sans écriture :
 * cible introuvable ou d'un autre compte, proposition « modifiée » (la valeur
 * finale n'est pas celle proposée), code illisible, pièce dont le bien
 * diffère du bien du document (information).
 *
 * Par lots bornés (chaque lot est sa propre transaction courte : aucun verrou
 * long), reprenable par curseur, idempotent : relancé, il ne crée rien de
 * plus. Lancé À LA MAIN (`scripts/backfill-document-asset-links.ts`, HC-03),
 * pas au démarrage : le volume est inconnu, plusieurs instances démarrent en
 * même temps, et rien ne presse — le déclencheur couvre toute écriture
 * nouvelle dès la migration, et aucun écran ni export ne lit la table avant
 * les lots 15 et 16.
 */
import type postgres from 'postgres';

export interface BackfillOptions {
  batchSize?: number;
  /** Pause entre deux lots (ms), pour ne pas monopoliser la base. */
  pauseMs?: number;
  /** Reprise : identifiants déjà traités (exclus). */
  fromFileId?: number;
  fromProposalId?: number;
  onProgress?: (p: { phase: 'columns' | 'proposals'; cursor: number; done: number }) => void;
}

export type AmbiguityReason =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_OTHER_ACCOUNT'
  | 'PROPOSAL_MODIFIED'
  | 'UNREADABLE_CODE'
  | 'ROOM_OF_OTHER_ASSET';

export interface BackfillReport {
  filesScanned: number;
  proposalsScanned: number;
  /** Liens LEGACY_COLUMN ACTIFS avant / après (les deux phases). */
  legacyLinksBefore: number;
  legacyLinksAfter: number;
  migrationLinksCreated: number;
  ambiguous: Array<{ reason: AmbiguityReason; fileId: number; proposalId?: number; detail: string }>;
  lastFileId: number;
  lastProposalId: number;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CONFIANCE: Record<string, number> = { certain: 1, probable: 0.6, conflictual: 0.3 };

export async function backfillDocumentAssetLinks(sql: postgres.Sql, opts: BackfillOptions = {}): Promise<BackfillReport> {
  const batch = Math.max(1, Math.min(opts.batchSize ?? 500, 5000));
  const pauseMs = opts.pauseMs ?? 0;

  const [fn] = await sql<{ ok: boolean }[]>`SELECT to_regproc('document_asset_links_sync_file') IS NOT NULL AS ok`;
  if (!fn?.ok) throw new Error('Migration 0221 (déclencheur) non appliquée : document_asset_links_sync_file absente.');

  const compte = async () => Number((await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM document_asset_links WHERE origin = 'LEGACY_COLUMN' AND status = 'ACTIVE'`)[0].n);

  const report: BackfillReport = {
    filesScanned: 0, proposalsScanned: 0, legacyLinksBefore: await compte(), legacyLinksAfter: 0,
    migrationLinksCreated: 0, ambiguous: [], lastFileId: opts.fromFileId ?? 0, lastProposalId: opts.fromProposalId ?? 0,
  };

  // ── 1. Colonnes historiques (même fonction que le déclencheur) ──────────
  for (;;) {
    const ids = (await sql<{ id: number }[]>`
      SELECT id FROM asset_files WHERE id > ${report.lastFileId} ORDER BY id LIMIT ${batch}`).map((r) => r.id);
    if (ids.length === 0) break;
    await sql`SELECT document_asset_links_sync_file(x) FROM unnest(${sql.array(ids)}::int[]) AS x`;
    // Colonne pointant un bien d'un AUTRE compte : ignorée par la
    // synchronisation (aucun lien), signalée ici.
    const etrangers = await sql<{ id: number; target: number }[]>`
      SELECT f.id, a.id AS target FROM asset_files f
        JOIN assets a ON a.id IN (f.asset_id, f.linked_asset_id)
       WHERE f.id = ANY(${sql.array(ids)}::int[]) AND a.account_id <> f.account_id AND f.deleted_at IS NULL`;
    for (const r of etrangers) {
      report.ambiguous.push({ reason: 'TARGET_OTHER_ACCOUNT', fileId: r.id, detail: `colonne vers le bien ${r.target} d’un autre compte : aucun lien posé` });
    }
    // Information : pièce rattachée dont le bien diffère du bien du document.
    const incoherents = await sql<{ id: number; asset_id: number; room_asset: number }[]>`
      SELECT f.id, f.asset_id, r.asset_id AS room_asset
        FROM asset_files f JOIN rooms r ON r.id = f.linked_room_id
       WHERE f.id = ANY(${sql.array(ids)}::int[]) AND f.asset_id IS NOT NULL AND r.asset_id <> f.asset_id AND f.deleted_at IS NULL`;
    for (const r of incoherents) {
      report.ambiguous.push({ reason: 'ROOM_OF_OTHER_ASSET', fileId: r.id,
        detail: `pièce du bien ${r.room_asset}, document du bien ${r.asset_id} : deux liens posés, à vérifier` });
    }
    report.filesScanned += ids.length;
    report.lastFileId = ids[ids.length - 1];
    opts.onProgress?.({ phase: 'columns', cursor: report.lastFileId, done: report.filesScanned });
    if (pauseMs) await pause(pauseMs);
  }

  // ── 2. Rattachements confirmés (propositions de lien acceptées) ─────────
  // Bascule D-G : date d'application de 0229 (absente : tout est historique).
  const [bascule] = await sql<{ at: Date | null }[]>`
    SELECT (SELECT applied_at FROM _migrations WHERE filename = '0229_rooms_to_substructures.sql') AS at`.catch(() => [{ at: null }]);
  const pieceSousStructure = (cree: Date) => bascule?.at != null && cree >= bascule.at;
  for (;;) {
    const props = await sql<{
      id: number; file_id: number; account_id: number; deleted_at: Date | null;
      target_key: string; code: string | null; status: string; confidence: string | null; created_at: Date;
    }[]>`
      SELECT p.id, p.asset_file_id AS file_id, f.account_id, f.deleted_at, p.target_key,
             p.canonical_code AS code, p.status, p.confidence, p.created_at
        FROM document_analysis_proposals p
        JOIN asset_files f ON f.id = p.asset_file_id
       WHERE p.proposal_type = 'link' AND p.status IN ('kept', 'modified') AND p.id > ${report.lastProposalId}
       ORDER BY p.id LIMIT ${batch}`;
    if (props.length === 0) break;

    for (const p of props) {
      const flag = (reason: AmbiguityReason, detail: string) =>
        report.ambiguous.push({ reason, fileId: p.file_id, proposalId: p.id, detail });
      if (p.deleted_at) continue; // document supprimé : rien à relier.
      if (p.status === 'modified') { flag('PROPOSAL_MODIFIED', `lien ${p.target_key} ${p.code ?? '?'} modifié par l’utilisateur`); continue; }
      const entityId = Number(p.code);
      if (!Number.isInteger(entityId) || entityId <= 0 || !['asset', 'room', 'equipment'].includes(p.target_key)) {
        flag('UNREADABLE_CODE', `cible « ${p.target_key} » / « ${p.code ?? ''} »`); continue;
      }
      type Cible = { asset_id: number; account_id: number; sub_id?: number | null };
      const [cible] = p.target_key === 'asset'
        ? await sql<Cible[]>`SELECT id AS asset_id, account_id FROM assets WHERE id = ${entityId} AND deleted_at IS NULL`
        : p.target_key === 'room'
          ? pieceSousStructure(p.created_at)
            ? await sql<Cible[]>`SELECT a.id AS asset_id, a.account_id, s.id AS sub_id FROM substructures s JOIN assets a ON a.id = s.asset_id WHERE s.id = ${entityId} AND a.deleted_at IS NULL`
            // Identifiant `rooms` (proposition antérieure à D-G) : sous-structure reprise si elle existe.
            : await sql<Cible[]>`SELECT a.id AS asset_id, a.account_id,
                  (SELECT s.id FROM substructures s WHERE s.legacy_room_id = r.id) AS sub_id
                FROM rooms r JOIN assets a ON a.id = r.asset_id WHERE r.id = ${entityId} AND a.deleted_at IS NULL`
          : await sql<Cible[]>`SELECT a.id AS asset_id, a.account_id FROM equipments e JOIN assets a ON a.id = e.asset_id WHERE e.id = ${entityId} AND a.deleted_at IS NULL`;
      if (!cible) { flag('TARGET_NOT_FOUND', `${p.target_key} ${entityId} introuvable`); continue; }
      if (cible.account_id !== p.account_id) { flag('TARGET_OTHER_ACCOUNT', `${p.target_key} ${entityId} d’un autre compte`); continue; }

      const substructureId = p.target_key === 'room' && cible.sub_id != null ? Number(cible.sub_id) : null;
      const roomId = p.target_key === 'room' && substructureId === null ? entityId : null;
      const equipmentId = p.target_key === 'equipment' ? entityId : null;
      const created = await sql`
        INSERT INTO document_asset_links (account_id, file_id, asset_id, room_id, equipment_id, substructure_id, link_role, origin, confidence, status)
        SELECT ${p.account_id}, ${p.file_id}, ${cible.asset_id}, ${roomId}, ${equipmentId}, ${substructureId}, 'SECONDARY', 'MIGRATION',
               ${CONFIANCE[p.confidence ?? ''] ?? null}, 'ACTIVE'
         WHERE NOT EXISTS (
           SELECT 1 FROM document_asset_links l
            WHERE l.file_id = ${p.file_id} AND l.status = 'ACTIVE'
              AND COALESCE(l.asset_id, 0) = ${cible.asset_id}
              AND COALESCE(l.room_id, 0) = ${roomId ?? 0}
              AND COALESCE(l.equipment_id, 0) = ${equipmentId ?? 0}
              AND COALESCE(l.substructure_id, 0) = ${substructureId ?? 0})
        ON CONFLICT DO NOTHING`;
      report.migrationLinksCreated += created.count;
    }
    report.proposalsScanned += props.length;
    report.lastProposalId = props[props.length - 1].id;
    opts.onProgress?.({ phase: 'proposals', cursor: report.lastProposalId, done: report.proposalsScanned });
    if (pauseMs) await pause(pauseMs);
  }

  report.legacyLinksAfter = await compte();
  return report;
}
