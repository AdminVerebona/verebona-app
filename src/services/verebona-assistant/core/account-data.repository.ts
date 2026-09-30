/**
 * Accès aux données du compte pour les réponses exactes de T2 (niveaux 1 et 2).
 *
 * Toutes les requêtes sont paramétrées et bornées à `account_id` (§13.2) ;
 * les documents et biens supprimés sont exclus. Rien n'est sérialisé en masse
 * (§26.2) : chaque requête rend un agrégat ou quelques lignes.
 */
import { pgClient } from '@/db';
import { SQL_IS_RENTED } from '@/lib/assets/occupancy';
import type { AccountDataPort, AgendaRow, AssetRow, DocumentHit, ExportRow, FactHit } from './data-answer.service';
import { searchDocumentFacts, searchDocumentText, searchTableCells } from '@/services/ai/knowledge/document-knowledge.service';
import { canonicalReadEnabled } from '../canonical/mode';
import { createCanonicalAccountDataRepository } from '../canonical/repository';

const rows = <T>(r: unknown) => r as unknown as T[];

/** Mots de famille → code de famille (recherche d'un bien par « ma voiture »). */
const FAMILY_BY_WORD: Record<string, string> = {
  voiture: 'VEHICULE', voitures: 'VEHICULE', vehicule: 'VEHICULE', vehicules: 'VEHICULE',
  moto: 'VEHICULE', velo: 'VEHICULE', bateau: 'VEHICULE', camion: 'VEHICULE',
  maison: 'IMMOBILIER', appartement: 'IMMOBILIER', logement: 'IMMOBILIER', immeuble: 'IMMOBILIER',
  terrain: 'IMMOBILIER', garage: 'IMMOBILIER',
};

function todayParis(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // « 2026-09-25 »
}

const ASSET_COLS = `a.id, a.name, a.category, a.subtype, to_char(a.purchase_date, 'YYYY-MM-DD') AS "purchaseDate", ${SQL_IS_RENTED('a')} AS "isRented",
  a.city, a.address, a.registration_number AS "registrationNumber"`;

/** Lecture HISTORIQUE (ASSISTANT_CANONICAL_READ=legacy), inchangée. */
export const legacyAccountDataRepository: AccountDataPort & Required<Pick<AccountDataPort, 'listDocuments' | 'findDocument' | 'listExports' | 'searchTableCells'>> = {
  today: todayParis,

  async findAssets(accountId, words) {
    const clean = [...new Set(words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3))].slice(0, 6);
    if (clean.length === 0) return [];
    // Un mot vaut 2 s'il apparaît dans le nom ou EST la catégorie (sous-type),
    // 1 s'il désigne seulement la famille du bien (« ma voiture » pour un
    // véhicule sans sous-type) : un « Appartement Lyon » l'emporte ainsi sur
    // une maison pour « mon appartement ».
    const score = clean.map((w, i) => {
      const fam = FAMILY_BY_WORD[w];
      return `(CASE WHEN unaccent(lower(a.name)) LIKE unaccent(lower($${i * 2 + 2}))
                  OR unaccent(lower(coalesce(a.subtype,''))) = unaccent(lower($${i * 2 + 3})) THEN 2
                  ${fam ? `WHEN a.category = '${fam}' THEN 1` : ''}
                  ELSE 0 END)`;
    }).join(' + ');
    const params: unknown[] = [accountId];
    for (const w of clean) params.push(`%${w}%`, w);
    const r = await pgClient.unsafe(
      `SELECT * FROM (
         SELECT ${ASSET_COLS}, (${score}) AS matched
           FROM assets a
          WHERE a.account_id = $1 AND a.deleted_at IS NULL
       ) s WHERE s.matched > 0 ORDER BY s.matched DESC, s.name LIMIT 10`,
      params as never[],
    );
    return rows<AssetRow>(r).map((a) => ({ ...a, matched: Number(a.matched) }));
  },

  async listAssets(accountId, opts = {}) {
    const r = await pgClient.unsafe(
      `SELECT ${ASSET_COLS} FROM assets a
        WHERE a.account_id = $1 AND a.deleted_at IS NULL
          AND ($2::text IS NULL OR a.category = $2)
          AND ($3::boolean IS NULL OR ${SQL_IS_RENTED('a')} = $3)
          AND coalesce(a.status, 'EN_SERVICE') NOT IN ('ARCHIVED', 'TRANSMIS')
        ORDER BY a.name LIMIT 200`,
      [accountId, opts.family ?? null, opts.rented ?? null] as never[],
    );
    return rows<AssetRow>(r);
  },

  async countDocuments(accountId, opts = {}) {
    const ids = opts.assetIds?.length ? opts.assetIds : null;
    const r = await pgClient.unsafe(
      `SELECT count(*)::int AS n FROM asset_files f
        WHERE f.account_id = $1 AND f.deleted_at IS NULL
          AND ($2::int[] IS NULL OR f.asset_id = ANY($2::int[]) OR f.linked_asset_id = ANY($2::int[]))`,
      [accountId, ids] as never[],
    );
    return rows<{ n: number }>(r)[0]?.n ?? 0;
  },

  async countAgenda(accountId, opts = {}) {
    const ids = opts.assetIds?.length ? opts.assetIds : null;
    const r = await pgClient.unsafe(
      `SELECT count(DISTINCT i.id)::int AS n FROM agenda_items i
         LEFT JOIN agenda_asset_links l ON l.agenda_item_id = i.id
        WHERE i.account_id = $1 AND i.manual_status IS NULL
          AND ($2::boolean IS NOT TRUE OR i.start_date >= $3::date)
          AND ($4::int[] IS NULL OR l.asset_id = ANY($4::int[]))`,
      [accountId, opts.futureOnly ?? false, todayParis(), ids] as never[],
    );
    return rows<{ n: number }>(r)[0]?.n ?? 0;
  },

  async upcomingAgenda(accountId, opts = {}) {
    const ids = opts.assetIds?.length ? opts.assetIds : null;
    const terms = (opts.terms ?? []).filter((t) => t.length >= 3).slice(0, 6);
    const termSql = terms.map((_, i) => `unaccent(lower(i.title || ' ' || coalesce(i.description,''))) LIKE unaccent(lower($${i + 5}))`).join(' AND ');
    const r = await pgClient.unsafe(
      `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date,
              (i.occurrence_nature = 'FORECAST') AS forecast,
              coalesce(array_remove(array_agg(DISTINCT a.name), NULL), '{}') AS "assetNames"
         FROM agenda_items i
         LEFT JOIN agenda_asset_links l ON l.agenda_item_id = i.id
         LEFT JOIN assets a ON a.id = l.asset_id AND a.deleted_at IS NULL
        WHERE i.account_id = $1 AND i.manual_status IS NULL
          AND i.start_date >= $2::date
          AND ($3::int[] IS NULL OR l.asset_id = ANY($3::int[]))
          ${termSql ? `AND ${termSql}` : ''}
        GROUP BY i.id
        ORDER BY i.start_date ASC, i.id ASC
        LIMIT $4`,
      [accountId, todayParis(), ids, Math.min(opts.limit ?? 3, 20), ...terms.map((t) => `%${t}%`)] as never[],
    );
    return rows<AgendaRow>(r);
  },

  async sumDocumentAmounts(accountId, opts = {}) {
    const ids = opts.assetIds?.length ? opts.assetIds : null;
    const r = await pgClient.unsafe(
      `SELECT coalesce(sum(f.amount_cents), 0)::bigint AS s, count(f.amount_cents)::int AS n
         FROM asset_files f
        WHERE f.account_id = $1 AND f.deleted_at IS NULL AND f.amount_cents IS NOT NULL
          AND ($2::int[] IS NULL OR f.asset_id = ANY($2::int[]) OR f.linked_asset_id = ANY($2::int[]))
          AND ($3::int IS NULL OR extract(year FROM f.document_date) = $3)`,
      [accountId, ids, opts.year ?? null] as never[],
    );
    const row = rows<{ s: string; n: number }>(r)[0];
    return { sumCents: Number(row?.s ?? 0), count: row?.n ?? 0 };
  },

  async searchFacts(accountId, terms, assetId) {
    const hits = await searchDocumentFacts(accountId, terms, { assetId: assetId ?? null, limit: 20 });
    return hits.map<FactHit>((h) => ({
      id: Number(h.id), fileId: h.fileId, factKey: h.factKey, subject: h.subject, attribute: h.attribute,
      label: h.label, valueText: h.valueText, valueNumber: h.valueNumber, valueUnit: h.valueUnit,
      confidence: h.confidence, excerpt: h.excerpt ?? '', documentTitle: h.documentTitle, matchedTerms: Number(h.matchedTerms),
      evidenceOrigin: h.evidenceOrigin ?? 'TEXT_EXTRACTION',
      visualDescription: h.visualEvidence?.description ?? null,
      page: typeof h.location?.page === 'number' ? h.location.page : null,
    }));
  },

  async searchTableCells(accountId, terms, assetId) {
    return searchTableCells(accountId, terms, { assetId: assetId ?? null });
  },

  async listDocuments(accountId, { assetIds, limit = 10 }) {
    if (assetIds.length === 0) return [];
    const r = await pgClient.unsafe(
      `SELECT f.id AS "fileId", coalesce(f.retained_title, f.original_filename, 'Document') AS title,
              to_char(f.document_date, 'YYYY-MM-DD') AS date, a.name AS "assetName", 1 AS "matchedTerms",
              f.analysis_state AS "analysisState"
         FROM asset_files f
         LEFT JOIN assets a ON a.id = coalesce(f.asset_id, f.linked_asset_id)
        WHERE f.account_id = $1 AND f.deleted_at IS NULL
          AND (f.asset_id = ANY($2::int[]) OR f.linked_asset_id = ANY($2::int[]))
        ORDER BY f.document_date DESC NULLS LAST, f.id DESC
        LIMIT $3`,
      [accountId, assetIds, Math.min(limit, 50)] as never[],
    );
    return rows<DocumentHit>(r);
  },

  // Statut d'un document désigné (§12.2) : borné au compte, non supprimé.
  async findDocument(accountId, fileId) {
    const r = rows<DocumentHit>(await pgClient.unsafe(
      `SELECT f.id AS "fileId", coalesce(f.retained_title, f.original_filename, 'Document') AS title,
              to_char(f.document_date, 'YYYY-MM-DD') AS date, a.name AS "assetName", 1 AS "matchedTerms",
              f.analysis_state AS "analysisState"
         FROM asset_files f
         LEFT JOIN assets a ON a.id = coalesce(f.asset_id, f.linked_asset_id)
        WHERE f.id = $1 AND f.account_id = $2 AND f.deleted_at IS NULL
        LIMIT 1`,
      [fileId, accountId] as never[],
    ));
    return r[0] ?? null;
  },

  // Exports et dossiers générés (§12.1) : ceux des biens du compte, hors
  // supprimés et annulés, les plus récents d'abord.
  async listExports(accountId, { assetIds = [], limit = 10 } = {}) {
    const r = await pgClient.unsafe(
      `SELECT e.id, e.asset_id AS "assetId", a.name AS "assetName", e.export_type AS "exportType", e.status,
              to_char(coalesce(e.completed_at, e.created_at) AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS date
         FROM export_generation e
         JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
        WHERE e.account_id = $1 AND e.status NOT IN ('deleted', 'cancelled')
          AND (cardinality($2::int[]) = 0 OR e.asset_id = ANY($2::int[]))
        ORDER BY coalesce(e.completed_at, e.created_at) DESC, e.id DESC
        LIMIT $3`,
      [accountId, assetIds, Math.min(limit, 50)] as never[],
    );
    return rows<ExportRow>(r);
  },

  async searchDocuments(accountId, terms, assetId) {
    // Deux sources : les métadonnées du document (titre, fournisseur,
    // description) et le contenu extrait par T1 (texte intégral).
    const clean = terms.filter((t) => t.length >= 3).slice(0, 8);
    if (clean.length === 0) return [];
    const hay = `unaccent(lower(coalesce(f.retained_title,'') || ' ' || coalesce(f.original_filename,'') || ' ' || coalesce(f.supplier,'') || ' ' || coalesce(f.description,'')))`;
    const score = clean.map((_, i) => `(CASE WHEN ${hay} LIKE unaccent(lower($${i + 3})) THEN 1 ELSE 0 END)`).join(' + ');
    const meta = rows<DocumentHit & { matchedTerms: number }>(await pgClient.unsafe(
      `SELECT * FROM (
         SELECT f.id AS "fileId", coalesce(f.retained_title, f.original_filename, 'Document') AS title,
                to_char(f.document_date, 'YYYY-MM-DD') AS date, a.name AS "assetName", (${score}) AS "matchedTerms",
                f.analysis_state AS "analysisState"
           FROM asset_files f
           LEFT JOIN assets a ON a.id = coalesce(f.asset_id, f.linked_asset_id)
          WHERE f.account_id = $1 AND f.deleted_at IS NULL
            AND ($2::int IS NULL OR f.asset_id = $2 OR f.linked_asset_id = $2)
       ) s WHERE s."matchedTerms" > 0 ORDER BY s."matchedTerms" DESC LIMIT 10`,
      [accountId, assetId ?? null, ...clean.map((t) => `%${t}%`)] as never[],
    ));
    const text = await searchDocumentText(accountId, clean, { assetId: assetId ?? null, limit: 10 }).catch(() => []);

    // Fusion par document : on retient le meilleur des deux scores.
    const byFile = new Map<number, DocumentHit>();
    for (const m of meta) byFile.set(m.fileId, { ...m, matchedTerms: Number(m.matchedTerms) });
    for (const t of text) {
      const cur = byFile.get(t.fileId);
      if (!cur || t.matchedTerms > cur.matchedTerms) {
        byFile.set(t.fileId, { fileId: t.fileId, title: cur?.title ?? t.title ?? 'Document', date: cur?.date ?? null, assetName: cur?.assetName ?? null, matchedTerms: t.matchedTerms, snippet: t.snippet });
      } else if (cur && !cur.snippet) {
        cur.snippet = t.snippet;
      }
    }
    // État d'analyse (§12.4, §23) des documents issus du texte intégral :
    // une requête pour tous, bornée au compte.
    const sansEtat = [...byFile.values()].filter((d) => d.analysisState === undefined).map((d) => d.fileId);
    if (sansEtat.length) {
      const etats = rows<{ id: number; analysisState: string | null }>(await pgClient.unsafe(
        `SELECT id, analysis_state AS "analysisState" FROM asset_files
          WHERE account_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL`,
        [accountId, sansEtat] as never[],
      ).catch(() => []));
      for (const e of etats) { const d = byFile.get(e.id); if (d) d.analysisState = e.analysisState; }
    }
    return [...byFile.values()].sort((a, b) => b.matchedTerms - a.matchedTerms);
  },
};

// ══════════════════════════════════════════════════════════════════════════
// CDC 15 §9 (lot 15) — LECTURE CANONIQUE, COMMUTATEUR ASSISTANT_CANONICAL_READ
//
// `accountDataRepository` choisit, À CHAQUE APPEL, la lecture historique
// (legacy, défaut ; `shadow` = legacy, l'assistant n'a pas de mode
// observation) ou la couche canonique (`canonical/repository.ts` : fiche
// canonique, documents N-N, agenda sans historique, dépenses qualifiées…).
// Les lectures nouvelles n'existent qu'en enabled (méthodes optionnelles du
// port : `data-answer` ne les appelle que si elles sont présentes).
// ══════════════════════════════════════════════════════════════════════════
const canonicalRepository = createCanonicalAccountDataRepository(legacyAccountDataRepository);

const choisir = (): AccountDataPort => (canonicalReadEnabled() ? canonicalRepository : legacyAccountDataRepository);

export const accountDataRepository: AccountDataPort = {
  today: () => choisir().today(),
  findAssets: (...a) => choisir().findAssets(...a),
  listAssets: (...a) => choisir().listAssets(...a),
  countDocuments: (...a) => choisir().countDocuments(...a),
  countAgenda: (...a) => choisir().countAgenda(...a),
  upcomingAgenda: (...a) => choisir().upcomingAgenda(...a),
  sumDocumentAmounts: (...a) => choisir().sumDocumentAmounts(...a),
  searchFacts: (...a) => choisir().searchFacts(...a),
  searchTableCells: (...a) => choisir().searchTableCells!(...a),
  searchDocuments: (...a) => choisir().searchDocuments(...a),
  listDocuments: (...a) => choisir().listDocuments!(...a),
  findDocument: (...a) => choisir().findDocument!(...a),
  listExports: (...a) => choisir().listExports!(...a),
  // Lectures canoniques : appelées par `data-answer` seulement en enabled.
  readAssetField: (...a) => canonicalRepository.readAssetField!(...a),
  sumQualifiedExpenses: (...a) => canonicalRepository.sumQualifiedExpenses!(...a),
  listMissingInformation: (...a) => canonicalRepository.listMissingInformation!(...a),
  listUpcomingAgenda: (...a) => canonicalRepository.listUpcomingAgenda!(...a),
};

/**
 * Port selon le mode courant — les lectures canoniques optionnelles
 * (`readAssetField`, `sumQualifiedExpenses`…) n'y figurent qu'en enabled.
 */
export function accountDataPortForMode(): AccountDataPort {
  return choisir();
}
