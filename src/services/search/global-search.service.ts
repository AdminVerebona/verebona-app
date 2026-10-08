/**
 * Recherche globale T2 (barre de recherche, « Correspondances ») — lot 33,
 * ticket « T2 Recherche : empêcher les faux positifs ».
 *
 * Trois étapes STRICTEMENT séparées (`lib/search/match-engine.ts`) :
 *   1. GÉNÉRATION DE CANDIDATS — SQL large, borné au compte : un mot (ou son
 *      singulier, un alias, ses 3 premières lettres pour une faute) apparaît
 *      dans un champ AUTORISÉ. Aucune valeur de preuve : `LIKE '%polo%'`
 *      trouve aussi « Apolon » ;
 *   2. ÉLIGIBILITÉ — le moteur vérifie, champ par champ, une correspondance
 *      explicable (mot entier ou début de mot, faute encadrée, alias,
 *      identifiant normalisé) ; catégorie et relation ne font que compléter ;
 *   3. RANKING — sur les seuls éligibles.
 *
 * Chaque résultat porte `match` (matchedField, matchedValue, matchType,
 * rawScore, normalizedScore, retrievalStrategy, eligibilityDecision,
 * eligibilityReason, rank). Les rejets sont tracés (`debug`, et en journal
 * quand `SEARCH_TRACE=1`).
 */
import { displayDocumentTitle } from '@/lib/documents/document-title-rules';
import { pgClient } from '@/db';
import { drawerHref } from '@/lib/drawers';
import { getField } from '@/services/canonical/registry';
import { parseKc } from '@/services/canonical/asset-state';
import { vehicleIdentifiersIn } from '@/services/verebona-assistant/core/vehicle-identifiers';
import { findVehiclesByIdentifier } from '@/services/verebona-assistant/core/target-lookup.repository';
import { normalizedText, searchExprMode } from '@/services/verebona-assistant/core/search-sql';
import {
  candidatePatterns, parseSearchQuery, runSearchPipeline,
  type ParsedQuery, type RankedResult, type SearchCandidate, type SearchPolicy, type SearchTraceEntry,
} from '@/lib/search/match-engine';

/** Barre de recherche : TOUS les mots de la requête doivent être retrouvés. */
export const GLOBAL_SEARCH_POLICY: SearchPolicy = { requireAllTokens: true, allowSemantic: false };

const LIMITES = { asset: 5, document: 8, agenda_item: 5 } as const;
const CANDIDATS_MAX = 100;

export interface SearchMatchInfo {
  matchedField: string;
  matchedValue: string | null;
  matchType: string;
  rawScore: number;
  normalizedScore: number;
  retrievalStrategy: string;
  eligibilityDecision: 'ELIGIBLE';
  eligibilityReason: string;
  rank: number;
}

export interface GlobalSearchRow {
  id: string;
  category: 'Bien' | 'Document' | 'Agenda';
  label: string;
  sublabel?: string;
  href: string;
  docId?: number;
  drawer?: { kind: 'document' | 'echeance'; id: number };
  mimeType?: string;
  match: SearchMatchInfo;
}

export interface GlobalSearchOutput {
  results: GlobalSearchRow[];
  /** Traces complètes (retenus puis rejetés) — seulement sur demande (`debug`). */
  trace?: SearchTraceEntry[];
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

/** Paramètres positionnels d'une requête `unsafe`. */
class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

/** « au moins un mot dans au moins une colonne » (génération, sans valeur de preuve). */
function anyTokenLike(mode: Awaited<ReturnType<typeof searchExprMode>>, p: Params, q: ParsedQuery, cols: string[], fuzzyCols: string[] = []): string {
  const parts: string[] = [];
  for (const t of q.tokens) {
    for (const forme of candidatePatterns(t)) {
      const ph = p.add(`%${forme}%`);
      for (const c of cols) parts.push(`${normalizedText(mode, c)} LIKE ${ph}`);
    }
    // Faute de frappe : préfixe court, sur les noms seulement.
    const court = candidatePatterns(t, { fuzzy: true }).filter((f) => !candidatePatterns(t).includes(f));
    for (const f of fuzzyCols.length ? court : []) {
      const ph = p.add(`%${f}%`);
      for (const c of fuzzyCols) parts.push(`${normalizedText(mode, c)} LIKE ${ph}`);
    }
  }
  return parts.length ? `(${parts.join(' OR ')})` : 'false';
}

/** Valeurs d'un champ canonique de la fiche (clé et alias du registre). */
function kcValues(kc: Record<string, unknown>, key: string): string[] {
  const def = getField(key);
  const cles = def ? [def.key, ...def.aliases] : [key];
  return cles.map((k) => kc[k]).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map(String);
}

/** Extraits « début de mot » du contenu indexé, un par mot de la requête (SQL). */
function contentSnippets(mode: Awaited<ReturnType<typeof searchExprMode>>, p: Params, q: ParsedQuery, col: string): string {
  return q.tokens.map((t, i) => {
    const formes = candidatePatterns(t).map((f) => f.replace(/[^a-z0-9]/g, '')).filter(Boolean);
    const re = p.add(`.{0,60}(?:^|[^a-z0-9])(?:${formes.join('|')})[a-z0-9]*.{0,60}`);
    return `substring(${normalizedText(mode, col)} from ${re}) AS "snip${i}"`;
  }).join(', ');
}

// ── Génération des candidats ─────────────────────────────────────────────

async function assetCandidates(accountId: number, q: ParsedQuery, mode: Awaited<ReturnType<typeof searchExprMode>>): Promise<SearchCandidate[]> {
  const ident = vehicleIdentifiersIn(q.raw);
  const exacts = ident.plates.length || ident.vins.length
    ? await findVehiclesByIdentifier(accountId, ident, { includeArchived: true }).catch(() => [])
    : [];
  const p = new Params();
  const acc = p.add(accountId);
  const ids = p.add(exacts.map((v) => v.id));
  const cols = ['a.name', 'a.registration_number', 'a.address', 'a.city', 'a.postal_code', 'a.key_characteristics::text'];
  const cond = anyTokenLike(mode, p, q, cols, ['a.name', 'a.key_characteristics::text']);
  // Requête de catégorie (« voitures ») : tous les biens sont candidats, le
  // référentiel décide ensuite (catégorie précise, jamais élargie).
  const categorie = q.categoryQuery ? 'true' : 'false';
  const rows = (await pgClient.unsafe(
    `SELECT a.id, a.name, a.category, a.subtype, a.object_category AS "objectCategory", a.city, a.address,
            a.postal_code AS "postalCode", a.registration_number AS "registrationNumber", a.key_characteristics AS kc
       FROM assets a
      WHERE a.account_id = ${acc} AND a.deleted_at IS NULL
        AND (${cond} OR ${categorie} OR a.id = ANY(${ids}::int[]))
      ORDER BY a.name, a.id
      LIMIT ${CANDIDATS_MAX}`,
    p.values as never[],
  )) as unknown as Row[];
  const exactIds = new Set(exacts.map((v) => v.id));
  const lus = new Set(rows.map((r) => Number(r.id)));
  // Véhicule trouvé par identifiant EXACT mais absent de la lecture
  // (fiche relue entre-temps) : candidat construit sur ce que la recherche
  // exacte a établi — plaque de la fiche, ou VIN demandé (égalité vérifiée
  // par `findVehiclesByIdentifier`).
  const complements: SearchCandidate[] = exacts.filter((v) => !lus.has(v.id)).map((v) => {
    const plaque = !!v.registrationNumber && ident.plates.some((p0) => p0.replace(/[^a-z0-9]/gi, '').toUpperCase() === String(v.registrationNumber).replace(/[^a-z0-9]/gi, '').toUpperCase());
    return {
      entityType: 'asset' as const, entityId: v.id, displayName: v.name,
      fields: { name: v.name, registrationNumber: v.registrationNumber ?? null, vin: plaque ? [] : ident.vins },
      assetTaxonomy: { family: v.category ?? null, subtype: v.subtype ?? null },
      retrievalStrategy: 'sql.vehicle_identifier_exact',
      _subExact: [v.subtype, v.registrationNumber].filter(Boolean).join(' · ') || v.category || undefined,
    } as SearchCandidate & { _subExact?: string };
  });
  return [...complements, ...rows.map((r) => {
    const kc = parseKc(r.kc);
    const id = Number(r.id);
    return {
      entityType: 'asset' as const,
      entityId: id,
      displayName: String(r.name ?? ''),
      fields: {
        name: str(r.name),
        make: kcValues(kc, 'make'),
        model: kcValues(kc, 'model'),
        brand: kcValues(kc, 'brand'),
        registrationNumber: [str(r.registrationNumber), ...kcValues(kc, 'registrationNumber')],
        vin: kcValues(kc, 'vin'),
        serialNumber: kcValues(kc, 'serialNumber'),
        address: [str(r.address), ...kcValues(kc, 'address1')],
        city: [str(r.city), ...kcValues(kc, 'city')],
        postalCode: [str(r.postalCode), ...kcValues(kc, 'postalCode')],
      },
      assetTaxonomy: { family: str(r.category), subtype: str(r.subtype), objectCategory: str(r.objectCategory) },
      retrievalStrategy: exactIds.has(id) ? 'sql.vehicle_identifier_exact' : q.categoryQuery ? 'sql.category_scan' : 'sql.token_like',
      // Champs d'affichage (non matchés).
      _sub: [str(r.subtype), str(r.city)].filter(Boolean).join(' · ') || str(r.category) || undefined,
      _subExact: [str(r.subtype), str(r.registrationNumber)].filter(Boolean).join(' · ') || str(r.category) || undefined,
    } as SearchCandidate & { _sub?: string; _subExact?: string };
  })];
}

async function documentCandidates(accountId: number, q: ParsedQuery, mode: Awaited<ReturnType<typeof searchExprMode>>): Promise<SearchCandidate[]> {
  const p = new Params();
  const acc = p.add(accountId);
  const cols = ['af.retained_title', 'af.web_link_title', 'af.original_filename', 'af.supplier', 'af.description', 'af.notes',
    'af.document_type', 'af.document_type_code', 'af.extracted_text', 'a.name'];
  const cond = anyTokenLike(mode, p, q, cols, ['af.retained_title', 'af.web_link_title', 'af.original_filename']);
  const snippets = contentSnippets(mode, p, q, 'af.extracted_text');
  const rows = (await pgClient.unsafe(
    `SELECT af.id, af.retained_title AS "retainedTitle", af.web_link_title AS "webLinkTitle", af.original_filename AS "originalFilename",
            af.filename, af.mime_type AS "mimeType", af.document_type AS "documentType", af.document_type_code AS "documentTypeCode",
            af.supplier, af.description, af.notes, af.asset_id AS "assetId", a.name AS "assetName"${snippets ? `, ${snippets}` : ''}
       FROM asset_files af
       LEFT JOIN assets a ON a.id = af.asset_id AND a.account_id = af.account_id
      WHERE af.account_id = ${acc}
        AND af.deleted_at IS NULL
        AND af.upload_status = 'COMPLETED'
        AND af.is_draft = false
        AND ${cond}
      ORDER BY af.created_at DESC, af.id DESC
      LIMIT ${CANDIDATS_MAX}`,
    p.values as never[],
  )) as unknown as Row[];
  return rows.map((r) => {
    const label = displayDocumentTitle({ retainedTitle: str(r.retainedTitle), webLinkTitle: str(r.webLinkTitle), originalFilename: str(r.originalFilename), filename: str(r.filename) }, 'Document');
    return {
      entityType: 'document' as const,
      entityId: Number(r.id),
      displayName: label,
      fields: {
        title: [str(r.retainedTitle), str(r.webLinkTitle)],
        originalFilename: str(r.originalFilename),
        documentType: [str(r.documentTypeCode), str(r.documentType)],
        supplier: str(r.supplier),
        description: str(r.description),
        notes: str(r.notes),
        content: q.tokens.map((_, i) => str(r[`snip${i}`])),
        assetName: str(r.assetName),
      },
      retrievalStrategy: 'sql.token_like',
      _label: label,
      _sub: str(r.assetName) ?? str(r.documentType) ?? undefined,
      _mime: str(r.mimeType) ?? undefined,
    } as SearchCandidate & { _label: string; _sub?: string; _mime?: string };
  });
}

async function agendaCandidates(accountId: number, q: ParsedQuery, mode: Awaited<ReturnType<typeof searchExprMode>>): Promise<SearchCandidate[]> {
  const p = new Params();
  const acc = p.add(accountId);
  const cond = anyTokenLike(mode, p, q, ['ai.title', 'ai.description'], ['ai.title']);
  // Bien lié : candidat seulement pour TRACER le rejet RELATION_ONLY — jamais un match seul.
  const condLien = anyTokenLike(mode, p, q, ['a.name']);
  const rows = (await pgClient.unsafe(
    `SELECT ai.id, ai.title, ai.description, ai.start_date AS "startDate",
            (SELECT array_agg(DISTINCT a.name) FROM agenda_asset_links aal JOIN assets a ON a.id = aal.asset_id
              WHERE aal.agenda_item_id = ai.id AND a.account_id = ai.account_id) AS "assetNames"
       FROM agenda_items ai
      WHERE ai.account_id = ${acc}
        AND (${cond} OR EXISTS (SELECT 1 FROM agenda_asset_links aal JOIN assets a ON a.id = aal.asset_id
                                 WHERE aal.agenda_item_id = ai.id AND a.account_id = ai.account_id AND ${condLien}))
      ORDER BY ai.start_date ASC NULLS LAST, ai.id
      LIMIT ${CANDIDATS_MAX}`,
    p.values as never[],
  )) as unknown as Row[];
  return rows.map((r) => {
    const noms = Array.isArray(r.assetNames) ? (r.assetNames as unknown[]).map(str).filter((x): x is string => !!x) : [];
    const start = str(r.startDate);
    return {
      entityType: 'agenda_item' as const,
      entityId: Number(r.id),
      displayName: String(r.title ?? ''),
      fields: { title: str(r.title), description: str(r.description), assetNames: noms },
      retrievalStrategy: 'sql.token_like',
      _start: start ? start.slice(0, 10) : null,
      _assets: noms.join(', '),
    } as SearchCandidate & { _start: string | null; _assets: string };
  });
}

// ── Pipeline ─────────────────────────────────────────────────────────────

function matchInfo(r: RankedResult): SearchMatchInfo {
  return {
    matchedField: r.matchedField!, matchedValue: r.matchedValue, matchType: r.matchType!,
    rawScore: r.rawScore, normalizedScore: r.normalizedScore, retrievalStrategy: r.candidate.retrievalStrategy,
    eligibilityDecision: 'ELIGIBLE', eligibilityReason: r.eligibilityReason, rank: r.rank,
  };
}

/** Recherche globale du compte (biens, documents, échéances). */
export async function globalSearch(accountId: number, rawQuery: string, opts: { debug?: boolean } = {}): Promise<GlobalSearchOutput> {
  const q = parseSearchQuery(rawQuery);
  if (q.tokens.length === 0) return { results: [], ...(opts.debug ? { trace: [] } : {}) };
  const mode = await searchExprMode();
  const [assets, docs, agenda] = await Promise.all([
    assetCandidates(accountId, q, mode),
    documentCandidates(accountId, q, mode),
    agendaCandidates(accountId, q, mode),
  ]);
  const ra = runSearchPipeline(q, assets, GLOBAL_SEARCH_POLICY);
  const rd = runSearchPipeline(q, docs, GLOBAL_SEARCH_POLICY);
  const rg = runSearchPipeline(q, agenda, GLOBAL_SEARCH_POLICY);
  const retenus = { asset: ra.results.slice(0, LIMITES.asset), document: rd.results.slice(0, LIMITES.document), agenda: rg.results.slice(0, LIMITES.agenda_item) };

  const results: GlobalSearchRow[] = [
    ...retenus.asset.map((r) => {
      const c = r.candidate as SearchCandidate & { _sub?: string; _subExact?: string };
      const id = Number(c.entityId);
      const sub = c.retrievalStrategy === 'sql.vehicle_identifier_exact' ? c._subExact : c._sub;
      return { id: `asset-${id}`, category: 'Bien' as const, label: c.displayName, ...(sub ? { sublabel: sub } : {}), href: `/assets/${id}`, match: matchInfo(r) };
    }),
    ...retenus.document.map((r) => {
      const c = r.candidate as SearchCandidate & { _label: string; _sub?: string; _mime?: string };
      const id = Number(c.entityId);
      return {
        id: `doc-${id}`, category: 'Document' as const, label: c._label, ...(c._sub ? { sublabel: c._sub } : {}),
        // Lien profond : le document s'ouvre en tiroir (src/lib/drawers.ts).
        href: drawerHref({ kind: 'document', id }, '/documents'),
        docId: id, drawer: { kind: 'document' as const, id }, ...(c._mime ? { mimeType: c._mime } : {}), match: matchInfo(r),
      };
    }),
    ...retenus.agenda.map((r) => {
      const c = r.candidate as SearchCandidate & { _start: string | null; _assets: string };
      const id = Number(c.entityId);
      const dateLabel = c._start ? new Date(`${c._start}T12:00:00`).toLocaleDateString('fr-FR') : null;
      const parts = [c._assets || null, dateLabel].filter(Boolean);
      return {
        id: `agenda-${id}`, category: 'Agenda' as const, label: c.displayName, ...(parts.length ? { sublabel: parts.join(' · ') } : {}),
        href: drawerHref({ kind: 'echeance', id }, '/agenda'), drawer: { kind: 'echeance' as const, id }, match: matchInfo(r),
      };
    }),
  ];

  const trace = [...ra.trace, ...rd.trace, ...rg.trace];
  if (process.env.SEARCH_TRACE === '1') {
    console.info('[search] trace', JSON.stringify({ query: q.raw, accountId, entries: trace }));
  }
  return { results, ...(opts.debug ? { trace } : {}) };
}

