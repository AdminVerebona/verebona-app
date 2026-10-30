/**
 * Recherche globale T2 (barre de recherche, « Correspondances ») — lot 33,
 * ticket « T2 Recherche : empêcher les faux positifs » ; lot 71 : équipements
 * et pièces (sous-structures), avec leur bien parent, et résolution
 * nominative de T2 sans IA (`findNamedEntities`).
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
import { documentTitleColumnsSql, documentTitleOf, type DocumentTitleColumns } from '@/lib/documents/document-title-source';
import { documentTypeLabelOrNull } from '@/lib/referential/user-facing-labels';
import { pgClient } from '@/db';
import { drawerHref } from '@/lib/drawers';
import { getField } from '@/services/canonical/registry';
import { parseKc } from '@/services/canonical/asset-state';
import { vehicleIdentifiersIn } from '@/services/verebona-assistant/core/vehicle-identifiers';
import { findVehiclesByIdentifier } from '@/services/verebona-assistant/core/target-lookup.repository';
import { normalizedText, searchExprMode } from '@/services/verebona-assistant/core/search-sql';
import { hrefEntite } from '@/services/verebona-assistant/core/entity-ref';
import { assistantAssetAvailability } from '@/services/verebona-assistant/core/asset-availability';
import {
  candidatePatterns, isExactNameMatch, parseSearchQuery, runSearchPipeline,
  type ParsedQuery, type RankedResult, type SearchCandidate, type SearchPolicy, type SearchTraceEntry,
} from '@/lib/search/match-engine';

/** Barre de recherche : TOUS les mots de la requête doivent être retrouvés. */
const GLOBAL_SEARCH_POLICY: SearchPolicy = { requireAllTokens: true, allowSemantic: false };

const LIMITES = { asset: 5, document: 8, agenda_item: 5, equipment: 5, room: 5 } as const;
const CANDIDATS_MAX = 100;

interface SearchMatchInfo {
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

interface GlobalSearchRow {
  id: string;
  /** Lot 71 : « Équipement » et « Pièce » (sous-structure), bien parent en `sublabel`. */
  category: 'Bien' | 'Document' | 'Agenda' | 'Équipement' | 'Pièce';
  label: string;
  sublabel?: string;
  href: string;
  docId?: number;
  drawer?: { kind: 'document' | 'echeance' | 'equipement' | 'piece'; id: number };
  /** Équipement / pièce : bien PARENT (contexte, homonymes) — jamais substitué à l'entité. */
  assetId?: number;
  mimeType?: string;
  /**
   * Lot 71 : le libellé EST la requête, à la normalisation près
   * (`isExactNameMatch`) — prioritaire dans les suggestions, jamais masqué
   * par le plafond d'affichage.
   */
  exact?: true;
  match: SearchMatchInfo;
}

interface GlobalSearchOutput {
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
        // Lot 101A (E) : série et référence commerciale du produit, propriétés distinctes.
        productSeries: kcValues(kc, 'productSeries'),
        productReference: kcValues(kc, 'productReference'),
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

/**
 * Lot 87D — libellé d'un document dans la recherche ET ses suggestions : la
 * règle UNIQUE du titre affiché (`documentTitleOf`), la même que la liste et la
 * fiche (aucun index ni libellé propre à la recherche : le titre enregistré
 * est lu en direct).
 */
export function documentSearchLabel(row: DocumentTitleColumns): string {
  return documentTitleOf(row, 'Document');
}

/**
 * Lot 87D (ticket « type technique ») — sous-titre d'un document : bien
 * associé, sinon libellé français du Type V2 enregistré ; jamais un code.
 */
export function documentSearchSublabel(row: { assetName?: unknown; documentTypeCode?: unknown }): string | undefined {
  return str(row.assetName) ?? documentTypeLabelOrNull(str(row.documentTypeCode)) ?? undefined;
}

/** Références de facture indexées (données de nommage persistées, lot 87D). */
function invoiceReferencesOf(basis: unknown): string[] {
  const b = (typeof basis === 'string' ? (() => { try { return JSON.parse(basis); } catch { return null; } })() : basis) as { invoiceReferences?: unknown } | null;
  return Array.isArray(b?.invoiceReferences) ? (b!.invoiceReferences as unknown[]).filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Lot 97C — génération EXHAUSTIVE pour les listes (« Mes documents », « Mon
 * agenda » et les onglets d'un bien) : mêmes champs, mêmes motifs, même
 * éligibilité que la barre de recherche, mais ni plafond de candidats
 * (`CANDIDATS_MAX`) ni ordre d'aperçu. La visibilité (brouillons, dépôts en
 * cours) reste décidée par la liste elle-même, qui croise ensuite son propre
 * périmètre avec ces identifiants.
 */
interface CandidateOptions { exhaustive?: boolean }

async function documentCandidates(
  accountId: number, q: ParsedQuery, mode: Awaited<ReturnType<typeof searchExprMode>>, opts: CandidateOptions = {},
): Promise<SearchCandidate[]> {
  const p = new Params();
  const acc = p.add(accountId);
  // Lot 87D : numéro de facture recherchable (données de nommage persistées), même absent du titre.
  const cols = ['af.retained_title', 'af.web_link_title', 'af.original_filename', 'af.supplier', 'af.description', 'af.notes',
    'af.document_type', 'af.document_type_code', 'af.extracted_text', 'a.name', "(af.title_basis ->> 'invoiceReferences')"];
  const cond = anyTokenLike(mode, p, q, cols, ['af.retained_title', 'af.web_link_title', 'af.original_filename']);
  const snippets = contentSnippets(mode, p, q, 'af.extracted_text');
  const rows = (await pgClient.unsafe(
    `SELECT af.id, ${documentTitleColumnsSql('af')},
            af.mime_type AS "mimeType", af.document_type AS "documentType", af.document_type_code AS "documentTypeCode",
            af.supplier, af.description, af.notes, af.asset_id AS "assetId", a.name AS "assetName", af.title_basis AS "titleBasis"${snippets ? `, ${snippets}` : ''}
       FROM asset_files af
       LEFT JOIN assets a ON a.id = af.asset_id AND a.account_id = af.account_id
      WHERE af.account_id = ${acc}
        AND af.deleted_at IS NULL
        ${opts.exhaustive ? '' : `AND af.upload_status = 'COMPLETED'
        AND af.is_draft = false`}
        AND ${cond}
      ${opts.exhaustive ? '' : `ORDER BY af.created_at DESC, af.id DESC
      LIMIT ${CANDIDATS_MAX}`}`,
    p.values as never[],
  )) as unknown as Row[];
  return rows.map((r) => {
    const label = documentSearchLabel(r);
    return {
      entityType: 'document' as const,
      entityId: Number(r.id),
      displayName: label,
      fields: {
        title: [str(r.titleRetained), str(r.titleWebLink)],
        originalFilename: str(r.titleOriginal),
        documentType: [str(r.documentTypeCode), str(r.documentType)],
        supplier: str(r.supplier),
        reference: invoiceReferencesOf(r.titleBasis),
        description: str(r.description),
        notes: str(r.notes),
        content: q.tokens.map((_, i) => str(r[`snip${i}`])),
        assetName: str(r.assetName),
      },
      retrievalStrategy: 'sql.token_like',
      _label: label,
      _sub: documentSearchSublabel(r),
      _mime: str(r.mimeType) ?? undefined,
    } as SearchCandidate & { _label: string; _sub?: string; _mime?: string };
  });
}

async function agendaCandidates(
  accountId: number, q: ParsedQuery, mode: Awaited<ReturnType<typeof searchExprMode>>, opts: CandidateOptions = {},
): Promise<SearchCandidate[]> {
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
      ${opts.exhaustive ? '' : `ORDER BY ai.start_date ASC NULLS LAST, ai.id
      LIMIT ${CANDIDATS_MAX}`}`,
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

/**
 * Lot 71 — équipements et pièces (ticket « T2 : rechercher et proposer les
 * équipements et les pièces sans IA »). Ils ne portent pas `account_id` : la
 * JOINTURE sur le bien parent est le contrôle de périmètre (compte courant),
 * avec la règle UNIQUE de disponibilité (`asset-availability` : bien ni
 * supprimé, ni archivé, ni transmis, ni vendu) et, pour un équipement, la
 * fiche non archivée — mêmes règles que la résolution des cibles T2
 * (`target-lookup.repository`). Chaque ligne est recontrôlée (compte) avant
 * d'être servie. Pièce = sous-structure (D-G, lot 20).
 *
 * Champs autorisés (`SEARCH_FIELDS`) : nom, type d'équipement (catégorie :
 * complément seulement), bien parent (relation : jamais un match seul — un
 * équipement ne remonte pas parce que son bien porte le mot, et
 * réciproquement un bien ne remonte jamais par ses équipements).
 */
type NestedKind = 'equipment' | 'room';

/** Lot 101A : propriétés d'identité produit d'un équipement cherchées par la barre de recherche. */
const EQUIPMENT_IDENTITY_SEARCH_KEYS = ['brand', 'productSeries', 'modelName', 'productReference', 'serialNumber'] as const;

async function nestedCandidates(
  kind: NestedKind, accountId: number, q: ParsedQuery, mode: Awaited<ReturnType<typeof searchExprMode>>,
  opts: { assetIds?: number[] | null } = {},
): Promise<SearchCandidate[]> {
  const p = new Params();
  const acc = p.add(accountId);
  const ids = p.add(opts.assetIds?.length ? opts.assetIds : null);
  const dispo = assistantAssetAvailability.sql('a');
  // AC12 : le plafond SQL ne coupe jamais un nom EXACTEMENT égal à la requête
  // (même normalisation que `normalizeSearchText`, à la ponctuation près).
  const norm = p.add(q.normalized);
  const exactEnTete = (col: string) => `(trim(regexp_replace(${normalizedText(mode, col)}, '[^a-z0-9]+', ' ', 'g')) = ${norm}) DESC`;
  const sqlText = kind === 'equipment'
    ? (() => {
        // Lot 101A (E) : identité produit de la fiche canonique de l'équipement
        // (marque, série, modèle, référence, n° de série) — « MG23K3515AK »
        // retrouve le micro-onde. Colonnes historiques comprises.
        const ident = [...EQUIPMENT_IDENTITY_SEARCH_KEYS.map((k) => `(e.key_characteristics->>'${k}')`), 's.brand', 's.model', 's.serial_number'];
        const cond = anyTokenLike(mode, p, q, ['e.name', 'e.type', ...ident], ['e.name']);
        return `SELECT e.id, e.name, e.type, e.asset_id AS "assetId", a.name AS "assetName", a.account_id AS "accountId",
                  e.key_characteristics AS kc, s.brand AS "specBrand", s.model AS "specModel", s.serial_number AS "specSerial"
           FROM equipments e
           LEFT JOIN equipment_cil_specs s ON s.equipment_id = e.id
           JOIN assets a ON a.id = e.asset_id
          WHERE a.account_id = ${acc} AND ${dispo} AND e.archived_at IS NULL
            AND (${ids}::int[] IS NULL OR e.asset_id = ANY(${ids}::int[]))
            AND ${cond}
          ORDER BY ${exactEnTete('e.name')}, e.name, e.id
          LIMIT ${CANDIDATS_MAX}`;
      })()
    : (() => {
        const cond = anyTokenLike(mode, p, q, ['x.name'], ['x.name']);
        return `SELECT x.id, x.name, NULL::text AS type, x.asset_id AS "assetId", a.name AS "assetName", a.account_id AS "accountId"
           FROM substructures x
           JOIN assets a ON a.id = x.asset_id
          WHERE a.account_id = ${acc} AND ${dispo}
            AND (${ids}::int[] IS NULL OR x.asset_id = ANY(${ids}::int[]))
            AND ${cond}
          ORDER BY ${exactEnTete('x.name')}, x.name, x.id
          LIMIT ${CANDIDATS_MAX}`;
      })();
  const rows = (await pgClient.unsafe(sqlText, p.values as never[])) as unknown as Row[];
  return rows
    // Défense en profondeur : une ligne d'un autre compte n'est jamais servie.
    .filter((r) => Number(r.accountId) === accountId && str(r.name))
    .map((r) => ({
      entityType: kind,
      entityId: Number(r.id),
      displayName: String(r.name),
      fields: kind === 'equipment'
        ? (() => {
            const kc = parseKc(r.kc);
            return {
              name: str(r.name), type: str(r.type), assetName: str(r.assetName),
              brand: [...kcValues(kc, 'brand'), str(r.specBrand)].filter(Boolean) as string[],
              productSeries: kcValues(kc, 'productSeries'),
              modelName: [...kcValues(kc, 'modelName'), str(r.specModel)].filter(Boolean) as string[],
              productReference: kcValues(kc, 'productReference'),
              serialNumber: [...kcValues(kc, 'serialNumber'), str(r.specSerial)].filter(Boolean) as string[],
            };
          })()
        : { name: str(r.name), assetName: str(r.assetName) },
      retrievalStrategy: 'sql.token_like',
      _assetId: Number(r.assetId),
      _assetName: str(r.assetName),
    } as SearchCandidate & { _assetId: number; _assetName: string | null }));
}

// ── Pipeline ─────────────────────────────────────────────────────────────

/** Classement stable : correspondances EXACTES du nom d'abord (AC12), puis l'ordre du moteur. */
function exactsDabord(q: ParsedQuery, liste: RankedResult[]): RankedResult[] {
  const exacts = liste.filter((r) => isExactNameMatch(q, r.candidate.displayName));
  return exacts.length ? [...exacts, ...liste.filter((r) => !exacts.includes(r))] : liste;
}

function matchInfo(r: RankedResult): SearchMatchInfo {
  return {
    matchedField: r.matchedField!, matchedValue: r.matchedValue, matchType: r.matchType!,
    rawScore: r.rawScore, normalizedScore: r.normalizedScore, retrievalStrategy: r.candidate.retrievalStrategy,
    eligibilityDecision: 'ELIGIBLE', eligibilityReason: r.eligibilityReason, rank: r.rank,
  };
}

/**
 * Lien profond (tiroir) d'un équipement / d'une pièce, sur l'onglet de son bien
 * parent — convention UNIQUE de `core/entity-ref` (`hrefEntite`).
 */
function nestedHref(kind: NestedKind, id: number, assetId: number | null): string {
  return hrefEntite({ kind, id, sourceId: `${kind}:${id}` }, assetId ? { assetId } : null)
    ?? drawerHref({ kind: kind === 'room' ? 'piece' : 'equipement', id });
}

/** Recherche globale du compte (biens, documents, échéances, équipements, pièces). */
export async function globalSearch(accountId: number, rawQuery: string, opts: { debug?: boolean } = {}): Promise<GlobalSearchOutput> {
  const q = parseSearchQuery(rawQuery);
  if (q.tokens.length === 0) return { results: [], ...(opts.debug ? { trace: [] } : {}) };
  const mode = await searchExprMode();
  const [assets, docs, agenda, equips, rooms] = await Promise.all([
    assetCandidates(accountId, q, mode),
    documentCandidates(accountId, q, mode),
    agendaCandidates(accountId, q, mode),
    nestedCandidates('equipment', accountId, q, mode),
    nestedCandidates('room', accountId, q, mode),
  ]);
  const ra = runSearchPipeline(q, assets, GLOBAL_SEARCH_POLICY);
  const rd = runSearchPipeline(q, docs, GLOBAL_SEARCH_POLICY);
  const rg = runSearchPipeline(q, agenda, GLOBAL_SEARCH_POLICY);
  const re = runSearchPipeline(q, equips, GLOBAL_SEARCH_POLICY);
  const rr = runSearchPipeline(q, rooms, GLOBAL_SEARCH_POLICY);
  const retenus = {
    asset: ra.results.slice(0, LIMITES.asset), document: rd.results.slice(0, LIMITES.document), agenda: rg.results.slice(0, LIMITES.agenda_item),
    equipment: exactsDabord(q, re.results).slice(0, LIMITES.equipment), room: exactsDabord(q, rr.results).slice(0, LIMITES.room),
  };
  // Correspondance EXACTE (libellé = requête normalisée) : marquée pour être
  // présentée en premier par les suggestions (lot 71, AC12).
  const exact = (label: string) => (isExactNameMatch(q, label) ? { exact: true as const } : {});

  const results: GlobalSearchRow[] = [
    ...retenus.asset.map((r) => {
      const c = r.candidate as SearchCandidate & { _sub?: string; _subExact?: string };
      const id = Number(c.entityId);
      const sub = c.retrievalStrategy === 'sql.vehicle_identifier_exact' ? c._subExact : c._sub;
      return { id: `asset-${id}`, category: 'Bien' as const, label: c.displayName, ...(sub ? { sublabel: sub } : {}), href: `/assets/${id}`, ...exact(c.displayName), match: matchInfo(r) };
    }),
    ...retenus.document.map((r) => {
      const c = r.candidate as SearchCandidate & { _label: string; _sub?: string; _mime?: string };
      const id = Number(c.entityId);
      return {
        id: `doc-${id}`, category: 'Document' as const, label: c._label, ...(c._sub ? { sublabel: c._sub } : {}),
        // Lien profond : le document s'ouvre en tiroir (src/lib/drawers.ts).
        href: drawerHref({ kind: 'document', id }, '/documents'),
        docId: id, drawer: { kind: 'document' as const, id }, ...(c._mime ? { mimeType: c._mime } : {}), ...exact(c._label), match: matchInfo(r),
      };
    }),
    ...retenus.agenda.map((r) => {
      const c = r.candidate as SearchCandidate & { _start: string | null; _assets: string };
      const id = Number(c.entityId);
      const dateLabel = c._start ? new Date(`${c._start}T12:00:00`).toLocaleDateString('fr-FR') : null;
      const parts = [c._assets || null, dateLabel].filter(Boolean);
      return {
        id: `agenda-${id}`, category: 'Agenda' as const, label: c.displayName, ...(parts.length ? { sublabel: parts.join(' · ') } : {}),
        href: drawerHref({ kind: 'echeance', id }, '/agenda'), drawer: { kind: 'echeance' as const, id }, ...exact(c.displayName), match: matchInfo(r),
      };
    }),
    // Lot 71 : équipements et pièces — libellé réel, bien parent en sous-titre
    // (« Pompe à chaleur » / « Équipement · Maison Lyon »), ouverture en tiroir.
    ...([['equipment', retenus.equipment], ['room', retenus.room]] as const).flatMap(([kind, liste]) => liste.map((r) => {
      const c = r.candidate as SearchCandidate & { _assetId: number; _assetName: string | null };
      const id = Number(c.entityId);
      return {
        id: `${kind}-${id}`, category: kind === 'equipment' ? 'Équipement' as const : 'Pièce' as const, label: c.displayName,
        ...(c._assetName ? { sublabel: c._assetName } : {}),
        href: nestedHref(kind, id, c._assetId), drawer: { kind: kind === 'room' ? 'piece' as const : 'equipement' as const, id },
        assetId: c._assetId, ...exact(c.displayName), match: matchInfo(r),
      };
    })),
  ];

  const trace = [...ra.trace, ...rd.trace, ...rg.trace, ...re.trace, ...rr.trace];
  if (process.env.SEARCH_TRACE === '1') {
    console.info('[search] trace', JSON.stringify({ query: q.raw, accountId, entries: trace }));
  }
  return { results, ...(opts.debug ? { trace } : {}) };
}

// ── Recherche locale des listes (lot 97C) ────────────────────────────────

/** Listes consultables par une recherche locale. */
export type ListSearchKind = 'document' | 'agenda_item';

/**
 * Lot 97C (ticket « recherche locale réactive », arbitrages PO Q1-B, Q2-A,
 * Q3-B) — identifiants de TOUS les éléments du compte qui correspondent à
 * la saisie, selon les règles de la barre de recherche (`runSearchPipeline`,
 * politique globale : tous les mots retrouvés, catégorie et relation ne
 * faisant que compléter, sauf le « bien concerné » d'une échéance).
 *
 * Aucun nouveau moteur, aucun plafond d'aperçu (8 documents / 5 échéances
 * pour `globalSearch`) : l'ensemble est EXHAUSTIF, puis croisé par l'écran
 * appelant avec son périmètre (bien, filtres) AVANT pagination et compteurs.
 * Lecture seule, SQL seul : aucun appel IA, aucune réanalyse.
 *
 * `null` : la saisie ne contient aucun mot exploitable (vide, mots outils
 * seuls) — la liste n'est alors pas restreinte. `[]` : aucune correspondance.
 */
export async function matchingIdsForList(accountId: number, rawQuery: string, kind: ListSearchKind): Promise<number[] | null> {
  const q = parseSearchQuery(rawQuery);
  if (q.tokens.length === 0) return null;
  const mode = await searchExprMode();
  const candidats = kind === 'document'
    ? await documentCandidates(accountId, q, mode, { exhaustive: true })
    : await agendaCandidates(accountId, q, mode, { exhaustive: true });
  const { results } = runSearchPipeline(q, candidats, GLOBAL_SEARCH_POLICY);
  return [...new Set(results.map((r) => Number(r.candidate.entityId)))];
}

// ── Résolution nominative de T2, AVANT toute IA (lot 71) ─────────────────

/** Équipement / pièce dont le nom EST la saisie (normalisée), bien parent compris. */
interface NamedEntityMatch {
  kind: NestedKind;
  id: number;
  name: string;
  assetId: number;
  assetName: string | null;
}

interface NamedEntityLookup {
  /** Correspondances EXACTES (≤ 6), équipements puis pièces, dans l'ordre du classement. */
  entities: NamedEntityMatch[];
  /** Un bien (non supprimé) du compte porte aussi exactement ce nom. */
  assetHomonym: boolean;
}

/**
 * Saisie nominative soumise à T2 (« Pompe à chaleur », « Cuisine ») : MÊME
 * génération de candidats et MÊME éligibilité que la barre de recherche
 * (`runSearchPipeline`, politique globale), puis seules les correspondances
 * EXACTES du nom (`isExactNameMatch`) sont retenues — un rapprochement
 * approximatif (« pompe » → « Pompe à chaleur ») n'est jamais une cible
 * certaine. Lecture seule, bornée au compte. `assetIds` : restreint au(x)
 * bien(s) donné(s) (contexte de page, revalidation d'un choix).
 */
export async function findNamedEntities(
  accountId: number, rawQuery: string, opts: { assetIds?: number[] | null } = {},
): Promise<NamedEntityLookup> {
  const q = parseSearchQuery(rawQuery);
  if (q.tokens.length === 0 || q.tokens.length > 6) return { entities: [], assetHomonym: false };
  const mode = await searchExprMode();
  const [equips, rooms, assets] = await Promise.all([
    nestedCandidates('equipment', accountId, q, mode, opts),
    nestedCandidates('room', accountId, q, mode, opts),
    opts.assetIds?.length ? Promise.resolve([] as SearchCandidate[]) : assetCandidates(accountId, q, mode),
  ]);
  const exacts = (cands: SearchCandidate[]) => runSearchPipeline(q, cands, GLOBAL_SEARCH_POLICY).results
    .filter((r) => isExactNameMatch(q, r.candidate.displayName));
  const entities = [...exacts(equips), ...exacts(rooms)].map((r) => {
    const c = r.candidate as SearchCandidate & { _assetId: number; _assetName: string | null };
    return { kind: c.entityType as NestedKind, id: Number(c.entityId), name: c.displayName, assetId: c._assetId, assetName: c._assetName };
  });
  return { entities: entities.slice(0, 6), assetHomonym: exacts(assets).length > 0 };
}
