/**
 * `CanonicalAccountDataRepository` — couche de lecture commune de
 * l'assistant (CDC 15 T2-01, T2-02, T2-18, T2-22 à T2-26, T2-40 ; lot 15).
 *
 * Implémente le port de données de `data-answer.service` (AccountDataPort)
 * en lisant l'ÉTAT CANONIQUE, et l'étend (lectures nouvelles, optionnelles
 * dans le port) :
 *   · biens : date d'achat = `acquisitionDate` canonique (T2-23), jamais la
 *     colonne `purchase_date` seule ;
 *   · documents d'un bien : relation N-N `document_asset_links` (T2-18),
 *     repli sur les colonnes historiques ;
 *   · faits T1 : chaque fait qui porte une clé du registre est accompagné de
 *     la valeur canonique du bien, de son origine et du conflit ouvert (T2-02) ;
 *   · agenda : HISTORICAL exclu des échéances (D-14), fenêtre (T2-15) ;
 *   · dépenses qualifiées (T2-24), informations manquantes (T2-04),
 *     lecture d'un champ (T2-22, T2-32).
 * Sélectionné par `accountDataRepository` quand ASSISTANT_CANONICAL_READ =
 * enabled ; sinon la lecture historique s'applique, inchangée.
 *
 * Les commandes (écriture) passent par la même couche : même registre
 * (`asset-fields.ts`, vue de `assistantWritable`), même lecture de la valeur
 * courante (`readCanonicalField`) — T2-40.
 */
import { pgClient } from '@/db';
import { buildCanonicalAssetState, type AssetRowJson } from '@/services/canonical/asset-state';
import type { AccountDataPort, AgendaRow, AssetRow, DocumentHit, FactHit } from '../core/data-answer.service';
import { EntityReadCache, canonicalKeyOf, readCanonicalField, openFieldConflicts, ORIGIN_LABELS, formatCanonicalValue } from './field-reader';
import { getField } from '@/services/canonical/registry';
import { listUpcomingAgenda, countUpcomingAgenda } from './agenda';
import { sumQualifiedExpenses } from './expenses';
import { listMissingInformation } from './completeness';

type LegacyPort = AccountDataPort & Required<Pick<AccountDataPort, 'listDocuments' | 'findDocument' | 'listExports' | 'searchTableCells'>>;

/** Dates d'achat CANONIQUES (`acquisitionDate`) d'une liste de biens du compte. */
export async function canonicalAcquisitionDates(accountId: number, assetIds: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  if (assetIds.length === 0) return out;
  const rows = (await pgClient.unsafe(
    `SELECT row_to_json(a.*) AS r FROM assets a WHERE a.account_id = $1 AND a.id = ANY($2::int[]) AND a.deleted_at IS NULL`,
    [accountId, assetIds] as never[],
  )) as unknown as Array<{ r: AssetRowJson | string }>;
  for (const x of rows) {
    const row = (typeof x.r === 'string' ? JSON.parse(x.r) : x.r) as AssetRowJson;
    const v = buildCanonicalAssetState(row).fields.acquisitionDate?.value;
    out.set(Number(row.id), typeof v === 'string' ? v.slice(0, 10) : null);
  }
  return out;
}

async function withCanonicalPurchase(accountId: number, list: AssetRow[]): Promise<AssetRow[]> {
  const dates = await canonicalAcquisitionDates(accountId, list.map((a) => a.id));
  return list.map((a) => ({ ...a, purchaseDate: dates.has(a.id) ? dates.get(a.id)! : null }));
}

/** Condition « document lié à l'un des biens $n » : N-N, repli colonnes historiques (T2-18). */
export const DOC_OF_ASSETS = (alias: string, param: string) =>
  `(EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = ${alias}.account_id AND l.file_id = ${alias}.id
             AND l.status = 'ACTIVE' AND l.asset_id = ANY(${param}::int[]))
    OR ${alias}.asset_id = ANY(${param}::int[]) OR ${alias}.linked_asset_id = ANY(${param}::int[]))`;

/**
 * Faits enrichis de l'état canonique (T2-02, pure sur ses entrées) : un fait
 * dont la clé est au registre reçoit la valeur canonique du bien visé.
 */
export function attachCanonical(
  facts: FactHit[],
  readings: Map<string, Awaited<ReturnType<typeof readCanonicalField>>>,
): FactHit[] {
  return facts.map((f) => {
    const k = canonicalKeyOf(f.factKey);
    const r = k ? readings.get(k) : undefined;
    if (!r) return f;
    return {
      ...f,
      canonical: {
        assetId: r.assetId, key: r.key, label: r.label, value: r.sensitive ? null : r.display,
        origin: r.origin, originLabel: r.originLabel, openConflict: r.openConflict?.question ?? null,
      },
    };
  });
}

export function createCanonicalAccountDataRepository(legacy: LegacyPort): AccountDataPort {
  return {
    today: () => legacy.today(),

    async findAssets(accountId, words) {
      return withCanonicalPurchase(accountId, await legacy.findAssets(accountId, words));
    },

    async listAssets(accountId, opts = {}) {
      return withCanonicalPurchase(accountId, await legacy.listAssets(accountId, opts));
    },

    async countDocuments(accountId, opts = {}) {
      const ids = opts.assetIds?.length ? opts.assetIds : null;
      const r = (await pgClient.unsafe(
        `SELECT count(*)::int AS n FROM asset_files f
          WHERE f.account_id = $1 AND f.deleted_at IS NULL AND ($2::int[] IS NULL OR ${DOC_OF_ASSETS('f', '$2')})`,
        [accountId, ids] as never[],
      )) as unknown as Array<{ n: number }>;
      return r[0]?.n ?? 0;
    },

    async countAgenda(accountId, opts = {}) {
      if (!opts.futureOnly) return legacy.countAgenda(accountId, opts);
      // Échéances à venir : HISTORICAL exclu (D-14), même règle que la liste.
      return countUpcomingAgenda(accountId, { assetIds: opts.assetIds });
    },

    async upcomingAgenda(accountId, opts = {}) {
      const rows = await listUpcomingAgenda(accountId, {
        assetIds: opts.assetIds, terms: opts.terms, limit: opts.limit ?? 3, windowDays: null,
      });
      return rows.map<AgendaRow>((r) => ({ id: r.id, title: r.title, date: r.date, assetNames: r.assetNames, forecast: r.forecast }));
    },

    async sumDocumentAmounts(accountId, opts = {}) {
      // Jamais une somme brute : dépenses QUALIFIÉES seulement (T2-24).
      const q = await sumQualifiedExpenses(accountId, { assetIds: opts.assetIds, year: opts.year });
      return { sumCents: q.qualifiedSumCents, count: q.qualifiedCount };
    },

    async searchFacts(accountId, terms, assetId) {
      const facts = await legacy.searchFacts(accountId, terms, assetId);
      if (!assetId) return facts;
      const keys = [...new Set(facts.map((f) => canonicalKeyOf(f.factKey)).filter((k): k is string => !!k))].slice(0, 10);
      const readings = new Map<string, Awaited<ReturnType<typeof readCanonicalField>>>();
      // Fiches d'équipements / pièces chargées une fois pour la demande (lot 18).
      const entityCache = new EntityReadCache();
      for (const k of keys) readings.set(k, await readCanonicalField(accountId, assetId, k, { entityCache }));
      return attachCanonical(facts, readings);
    },

    searchTableCells: (accountId, terms, assetId) => legacy.searchTableCells(accountId, terms, assetId),

    async searchDocuments(accountId, terms, assetId) {
      if (!assetId) return legacy.searchDocuments(accountId, terms, assetId);
      // Documents liés au bien par la relation N-N (T2-18) : la recherche du
      // compte est filtrée ensuite sur ces documents.
      const hits = await legacy.searchDocuments(accountId, terms, null);
      if (hits.length === 0) return hits;
      const lies = (await pgClient.unsafe(
        `SELECT f.id FROM asset_files f WHERE f.account_id = $1 AND f.id = ANY($2::int[]) AND ${DOC_OF_ASSETS('f', '$3')}`,
        [accountId, hits.map((h) => h.fileId), [assetId]] as never[],
      )) as unknown as Array<{ id: number }>;
      const ok = new Set(lies.map((r) => Number(r.id)));
      return hits.filter((h) => ok.has(h.fileId));
    },

    async listDocuments(accountId, { assetIds, limit = 10 }) {
      if (assetIds.length === 0) return [];
      const r = await pgClient.unsafe(
        `SELECT f.id AS "fileId", coalesce(f.retained_title, f.original_filename, 'Document') AS title,
                to_char(f.document_date, 'YYYY-MM-DD') AS date,
                (SELECT a.name FROM assets a WHERE a.id = ANY($2::int[]) AND a.account_id = $1 ORDER BY a.id LIMIT 1) AS "assetName",
                1 AS "matchedTerms", f.analysis_state AS "analysisState"
           FROM asset_files f
          WHERE f.account_id = $1 AND f.deleted_at IS NULL AND ${DOC_OF_ASSETS('f', '$2')}
          ORDER BY f.document_date DESC NULLS LAST, f.id DESC
          LIMIT $3`,
        [accountId, assetIds, Math.min(limit, 50)] as never[],
      );
      return r as unknown as DocumentHit[];
    },

    findDocument: (accountId, fileId) => legacy.findDocument(accountId, fileId),
    listExports: (accountId, opts) => legacy.listExports(accountId, opts),

    // ── Lectures nouvelles (lot 15) ────────────────────────────────────────
    readAssetField: (accountId, assetId, key) => readCanonicalField(accountId, assetId, key),
    sumQualifiedExpenses: (accountId, opts) => sumQualifiedExpenses(accountId, opts),
    listMissingInformation: (accountId, opts) => listMissingInformation(accountId, opts),
    listUpcomingAgenda: (accountId, opts) => listUpcomingAgenda(accountId, opts),
  };
}

/** Valeurs canoniques d'un bien pour une liste de clés (conflits compris), en une passe. */
export async function readCanonicalFields(accountId: number, assetId: number, keys: string[]) {
  const conflicts = await openFieldConflicts(accountId, assetId);
  const entityCache = new EntityReadCache();
  const out = [];
  for (const k of keys) {
    const r = await readCanonicalField(accountId, assetId, k, { entityCache });
    if (r) out.push({ ...r, openConflict: conflicts.get(r.key) ?? r.openConflict });
  }
  return out;
}

export { ORIGIN_LABELS, formatCanonicalValue, getField };
