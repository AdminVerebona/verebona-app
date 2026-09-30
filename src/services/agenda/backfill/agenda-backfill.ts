/**
 * Rattrapages de l'agenda — CDC 15 §14 points 5 et 6 (lot 14, volet B).
 * Lancés À LA MAIN (`scripts/agenda-backfill.ts`), jamais au démarrage :
 * volume inconnu, aucune urgence (les écritures nouvelles passent par la
 * primitive), et la règle §14 : « aucune migration automatique ne doit
 * écraser une valeur USER/ADMIN ni trancher un conflit non résolu ; les cas
 * ambigus vont dans un rapport ».
 *
 *  · §14.5 `backfillAgendaSourceLinks` : liens agenda ↔ document manquants,
 *    reconstruits depuis `origin_ref` (élément automatique dont la source
 *    est un document du même compte, non supprimé) → `agenda_file_links`
 *    et trace `agenda_item_sources` (SOURCE, 'linked') si la 0223 est là.
 *    Référence vers un document absent, supprimé ou d'un autre compte : au
 *    rapport, rien d'écrit.
 *  · §14.6 `dedupeAutomaticAgendaItems` : doublons d'éléments AUTOMATIQUES
 *    (même compte, même bien, même source, même champ d'origine — à défaut
 *    même titre — même date). Un élément manuel n'est jamais lu ; un
 *    élément automatique modifié par l'utilisateur est toujours conservé.
 *    Par groupe : conservés = les éléments modifiés par l'utilisateur, ou à
 *    défaut le plus ancien ; les autres sont retirés. Rapport seul par
 *    défaut ; `apply` pour retirer.
 * Idempotents, par lots, reprenables (curseur).
 */
import type postgres from 'postgres';
import { removeAgendaItemsTraced } from '../agenda-removal-trace';

type Sql = postgres.Sql;

// ── §14.6 Dédoublonnage ─────────────────────────────────────────────────────

export interface DedupeRow {
  id: number;
  accountId: number;
  assetId: number;
  sourceFileId: number | null;
  originFieldKey: string | null;
  title: string;
  startDate: string;
  isAutomaticModified: boolean;
  manualStatus: string | null;
}

export interface DedupeGroup {
  accountId: number;
  assetId: number;
  sourceFileId: number | null;
  originFieldKey: string | null;
  date: string;
  keep: number[];
  remove: number[];
  /** Éléments modifiés par l'utilisateur (conservés). */
  protected: number[];
}

const normTitre = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const touche = (r: Pick<DedupeRow, 'isAutomaticModified' | 'manualStatus'>) =>
  r.isAutomaticModified || (r.manualStatus !== null && r.manualStatus !== '');

/** Plan de dédoublonnage (pur, testé). Un élément gardé dans un groupe n'est retiré nulle part. */
export function planAgendaDedupe(rows: DedupeRow[]): { groups: DedupeGroup[]; remove: number[] } {
  const groupes = new Map<string, DedupeRow[]>();
  for (const r of rows) {
    const k = [r.accountId, r.assetId, r.sourceFileId ?? '-', r.originFieldKey ?? `t:${normTitre(r.title)}`, r.startDate].join('|');
    groupes.set(k, [...(groupes.get(k) ?? []), r]);
  }
  const groups: DedupeGroup[] = [];
  const gardes = new Set<number>();
  const retires = new Set<number>();
  for (const g of groupes.values()) {
    const uniques = [...new Map(g.map((r) => [r.id, r])).values()].sort((a, b) => a.id - b.id);
    if (uniques.length < 2) continue;
    const proteges = uniques.filter(touche).map((r) => r.id);
    const keep = proteges.length > 0 ? proteges : [uniques[0].id];
    const remove = uniques.filter((r) => !keep.includes(r.id) && !touche(r)).map((r) => r.id);
    keep.forEach((id) => gardes.add(id));
    remove.forEach((id) => retires.add(id));
    const t = uniques[0];
    groups.push({
      accountId: t.accountId, assetId: t.assetId, sourceFileId: t.sourceFileId, originFieldKey: t.originFieldKey,
      date: t.startDate, keep, remove, protected: proteges,
    });
  }
  return { groups, remove: [...retires].filter((id) => !gardes.has(id)).sort((a, b) => a - b) };
}

export interface DedupeReport {
  accountsScanned: number;
  itemsScanned: number;
  groups: DedupeGroup[];
  removed: number[];
  applied: boolean;
  lastAccountId: number;
}

/** §14.6 — rapport (et retrait si `apply`) des doublons automatiques, compte par compte. */
export async function dedupeAutomaticAgendaItems(sql: Sql, opts: {
  apply?: boolean; fromAccountId?: number; onProgress?: (p: { accountId: number; groups: number }) => void;
} = {}): Promise<DedupeReport> {
  const report: DedupeReport = { accountsScanned: 0, itemsScanned: 0, groups: [], removed: [], applied: !!opts.apply, lastAccountId: opts.fromAccountId ?? 0 };
  const comptes = await sql<{ id: number }[]>`
    SELECT DISTINCT account_id AS id FROM agenda_items
     WHERE is_automatic AND account_id > ${opts.fromAccountId ?? 0} ORDER BY account_id`;
  for (const { id: accountId } of comptes) {
    const rows = await sql<DedupeRow[]>`
      SELECT i.id, i.account_id AS "accountId", l.asset_id AS "assetId",
             CASE WHEN i.origin_ref_type = 'asset_file' THEN i.origin_ref_id END AS "sourceFileId",
             i.origin_field_key AS "originFieldKey", i.title, i.start_date::text AS "startDate",
             i.is_automatic_modified AS "isAutomaticModified", i.manual_status AS "manualStatus"
        FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
       WHERE i.account_id = ${accountId} AND i.is_automatic AND i.start_date IS NOT NULL`;
    report.accountsScanned += 1;
    report.itemsScanned += rows.length;
    const plan = planAgendaDedupe(rows.map((r) => ({ ...r, id: Number(r.id) })));
    report.groups.push(...plan.groups);
    if (opts.apply && plan.remove.length > 0) {
      // Retrait TRACÉ (agenda_item_removals, rattrapable), gardes dans le
      // DELETE : jamais un élément manuel ou modifié par l'utilisateur.
      report.removed.push(...await removeAgendaItemsTraced(sql, { accountId, ids: plan.remove, reason: 'DEDUPE_14_6' }));
    }
    report.lastAccountId = accountId;
    opts.onProgress?.({ accountId, groups: plan.groups.length });
  }
  return report;
}

// ── §14.5 Liens agenda ↔ document ───────────────────────────────────────────

export interface SourceLinksReport {
  scanned: number;
  fileLinksCreated: number;
  sourceTracesCreated: number;
  /** Référence `origin_ref` inexploitable : document absent, supprimé ou d'un autre compte. */
  orphans: Array<{ agendaItemId: number; accountId: number; originRefId: number; reason: 'MISSING' | 'DELETED' | 'OTHER_ACCOUNT' }>;
  applied: boolean;
  lastItemId: number;
}

/** §14.5 — liens manquants reconstruits depuis `origin_ref` (rapport seul sans `apply`). */
export async function backfillAgendaSourceLinks(sql: Sql, opts: {
  apply?: boolean; batchSize?: number; fromItemId?: number; onProgress?: (p: { cursor: number; done: number }) => void;
} = {}): Promise<SourceLinksReport> {
  const taille = Math.max(1, Math.min(opts.batchSize ?? 500, 5000));
  const report: SourceLinksReport = {
    scanned: 0, fileLinksCreated: 0, sourceTracesCreated: 0, orphans: [], applied: !!opts.apply, lastItemId: opts.fromItemId ?? 0,
  };
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'agenda_item_sources' AND column_name = 'source_role'`;
  const traces = Number(n) === 1;

  for (;;) {
    const rows = await sql<{ id: number; accountId: number; refId: number; fileAccount: number | null; deletedAt: Date | null; linked: boolean }[]>`
      SELECT i.id, i.account_id AS "accountId", i.origin_ref_id AS "refId",
             f.account_id AS "fileAccount", f.deleted_at AS "deletedAt",
             EXISTS (SELECT 1 FROM agenda_file_links x WHERE x.agenda_item_id = i.id AND x.asset_file_id = i.origin_ref_id) AS linked
        FROM agenda_items i LEFT JOIN asset_files f ON f.id = i.origin_ref_id
       WHERE i.is_automatic AND i.origin_ref_type = 'asset_file' AND i.origin_ref_id IS NOT NULL AND i.id > ${report.lastItemId}
       ORDER BY i.id LIMIT ${taille}`;
    if (rows.length === 0) break;
    for (const r of rows) {
      report.scanned += 1;
      const id = Number(r.id);
      if (r.fileAccount === null) { report.orphans.push({ agendaItemId: id, accountId: r.accountId, originRefId: r.refId, reason: 'MISSING' }); continue; }
      if (Number(r.fileAccount) !== Number(r.accountId)) { report.orphans.push({ agendaItemId: id, accountId: r.accountId, originRefId: r.refId, reason: 'OTHER_ACCOUNT' }); continue; }
      if (r.deletedAt) { report.orphans.push({ agendaItemId: id, accountId: r.accountId, originRefId: r.refId, reason: 'DELETED' }); continue; }
      if (!r.linked) {
        if (opts.apply) {
          const ins = await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${id}, ${r.refId}) ON CONFLICT DO NOTHING RETURNING id`;
          report.fileLinksCreated += ins.length;
        } else {
          report.fileLinksCreated += 1;
        }
      }
      if (traces && opts.apply) {
        const t = await sql`
          INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, run_id, effect_type, source_role)
          SELECT ${id}, ${r.refId},
                 (SELECT d.id FROM document_analysis_runs d WHERE d.asset_file_id = ${r.refId} ORDER BY d.id DESC LIMIT 1),
                 'linked', 'SOURCE'
           WHERE NOT EXISTS (SELECT 1 FROM agenda_item_sources s
                              WHERE s.agenda_item_id = ${id} AND s.asset_file_id = ${r.refId} AND s.source_role = 'SOURCE')
          ON CONFLICT DO NOTHING RETURNING id`;
        report.sourceTracesCreated += t.length;
      }
    }
    report.lastItemId = Number(rows[rows.length - 1].id);
    opts.onProgress?.({ cursor: report.lastItemId, done: report.scanned });
  }
  return report;
}
