/**
 * INDEX DE RAPPROCHEMENT d'un compte (lot 34E — ticket « T3 — réconciliation
 * continue des documents non résolus », §« Performance »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Construit UNE fois par compte et réutilisé pour tous les documents de ce
 * compte pendant un balayage (cache de page `MatchingIndexCache`) : jamais
 * « chaque document × tous les biens × toutes les heures » en requêtes.
 *
 * Valeurs indexées (normalisées, comme `identifiers.ts`) :
 *   · biens : identifiant, nom, alias, famille, sous-type, identifiants
 *     canoniques (adresse, cadastre, immatriculation, VIN, série), marque /
 *     modèle, ville / code postal ;
 *   · équipements (non archivés) : nom, numéro de série, marque / modèle,
 *     bien porteur ;
 *   · pièces (sous-structures) : nom, bien porteur ;
 *   · références discriminantes (n° de contrat, de police, ADEME…) lues dans
 *     les faits ACTIFS des documents DÉJÀ rattachés à un bien.
 *
 * AUCUNE limite de découverte : TOUS les biens actifs du compte sont lus, par
 * pages techniques transparentes (`INDEX_PAGE_SIZE`). La borne de 60 biens
 * n'existe que pour le prompt T3 (`DOCUMENT_ASSET_PROMPT_MAX_CANDIDATES`).
 *
 * Les valeurs SENSIBLES (adresse) restent côté serveur : l'index n'est jamais
 * transmis à un modèle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { parseKc } from '@/services/canonical/asset-state';
import { readCanonicalValue, type AssetRowJson } from '@/services/canonical/asset-state/canonical-asset-view';
import { buildCanonicalEntityState } from '@/services/canonical/entity-state/entity-view';
import type { CanonicalEntityType } from '@/services/canonical/entity-state/types';
import { identifierRecordOf } from './asset-identifiers.repository';
import { normalizeCode, normalizePostalCode, normalizeText, type AssetIdentifierRecord } from './identifiers';

/** Pagination technique de la lecture des biens (transparente). */
export const INDEX_PAGE_SIZE = 500;
/** Références lues au plus (documents rattachés du compte). */
const MAX_REFERENCES = 5000;

/** Clés de faits dont la valeur désigne un contrat / un dossier propre à UN bien. */
export const REFERENCE_KEYS = ['insuranceContractNumber', 'contractNumber', 'dpeAdemeNumber'] as const;

/** Clés de fiche lues comme ALIAS d'un bien (tolérant : texte ou liste). */
export const ASSET_ALIAS_KEYS = ['aliases', 'alias', 'nickname', 'usualName', 'surnom', 'nomUsuel'] as const;

export interface IndexedAsset {
  assetId: number;
  name: string;
  /** Nom normalisé (`normalizeText`). */
  normalizedName: string;
  aliases: string[];
  family: AssetIdentifierRecord['family'];
  category: string | null;
  subtype: string | null;
  /** Identifiants canoniques (sensibles compris — serveur seulement). */
  record: AssetIdentifierRecord;
  /** « marque modèle » normalisé (véhicule, objet), si les deux sont connus. */
  brandModel: string | null;
  city: string | null;
  postalCode: string | null;
}

export interface IndexedEntity {
  type: CanonicalEntityType;
  id: number;
  assetId: number;
  name: string;
  normalizedName: string;
  /** Numéro de série normalisé (`normalizeCode`) — équipement. */
  serial: string | null;
  brandModel: string | null;
}

export interface AccountMatchingIndex {
  accountId: number;
  assets: IndexedAsset[];
  byId: Map<number, IndexedAsset>;
  /** Identifiants des biens, pour `resolveAssetByIdentifiers`. */
  records: AssetIdentifierRecord[];
  entities: IndexedEntity[];
  /** Référence normalisée → bien → documents rattachés qui la portent. */
  references: Map<string, Map<number, Set<number>>>;
  /** Signature de l'index (diagnostic ; jamais une empreinte de décision). */
  signature: string;
}

const txt = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const inner = (v as { value?: unknown }).value;
    return inner === undefined ? null : txt(inner);
  }
  const s = String(v).trim();
  return s ? s : null;
};

const valueOf = (row: AssetRowJson, key: string): string | null => {
  const st = readCanonicalValue(row, key);
  return st ? txt(st.value) : null;
};

/** Alias lus dans la fiche (texte, liste, ou valeur canonique `{ value }`). */
export function aliasesOf(kc: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ASSET_ALIAS_KEYS) {
    const raw = kc[k];
    const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { value?: unknown }).value : raw;
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[;,|]/) : [];
    for (const a of list) {
      const n = normalizeText(a);
      if (n.length >= 3 && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

/** Ligne de bien → entrée d'index (pure). */
export function indexAsset(row: AssetRowJson): IndexedAsset {
  const record = identifierRecordOf(row);
  const family = record.family;
  const brand = family === 'VEHICULE' ? valueOf(row, 'make') : valueOf(row, 'brand');
  const model = family === 'VEHICULE' ? valueOf(row, 'model') : valueOf(row, 'modelName');
  const name = String(row.name ?? `Bien ${row.id}`);
  return {
    assetId: Number(row.id),
    name,
    normalizedName: normalizeText(name),
    aliases: aliasesOf(parseKc(row.key_characteristics)),
    family,
    category: (row.category as string | null) ?? null,
    subtype: ((row as { subtype?: string | null }).subtype) ?? null,
    record,
    brandModel: brand && model ? normalizeText(`${brand} ${model}`) : null,
    city: family === 'IMMOBILIER' ? (valueOf(row, 'city') ? normalizeText(valueOf(row, 'city')) : null) : null,
    postalCode: family === 'IMMOBILIER' ? (normalizePostalCode(valueOf(row, 'postalCode')) || null) : null,
  };
}

async function loadAssetRows(accountId: number): Promise<AssetRowJson[]> {
  const out: AssetRowJson[] = [];
  let after = 0;
  for (;;) {
    const rows = (await pgClient.unsafe(
      `SELECT a.id, row_to_json(a.*) AS r FROM assets a
        WHERE a.account_id = $1 AND a.deleted_at IS NULL AND a.id > $2
        ORDER BY a.id LIMIT ${INDEX_PAGE_SIZE}`,
      [accountId, after] as never[],
    )) as unknown as Array<{ id: number; r: AssetRowJson | string }>;
    for (const { r } of rows) out.push(typeof r === 'string' ? JSON.parse(r) as AssetRowJson : r);
    if (rows.length < INDEX_PAGE_SIZE) return out;
    after = Number(rows[rows.length - 1].id);
  }
}

async function loadEntities(accountId: number): Promise<IndexedEntity[]> {
  const rows = (await pgClient.unsafe(
    `SELECT 'EQUIPMENT' AS type, x.id, x.asset_id AS "assetId", x.name, x.key_characteristics AS kc,
            jsonb_build_object('equipment_cil_specs.brand', s.brand, 'equipment_cil_specs.model', s.model,
                               'equipment_cil_specs.serial_number', s.serial_number) AS cols
       FROM equipments x
       JOIN assets a ON a.id = x.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
       LEFT JOIN equipment_cil_specs s ON s.equipment_id = x.id
      WHERE x.archived_at IS NULL
     UNION ALL
     SELECT 'ROOM', x.id, x.asset_id, x.name, x.key_characteristics, '{}'::jsonb
       FROM substructures x
       JOIN assets a ON a.id = x.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
      ORDER BY 1, 2`,
    [accountId] as never[],
  )) as unknown as Array<{ type: CanonicalEntityType; id: number; assetId: number; name: string | null; kc: unknown; cols: unknown }>;
  return rows.map((r) => {
    const state = buildCanonicalEntityState({
      target: { type: r.type, id: Number(r.id) }, assetId: Number(r.assetId), accountId, name: r.name ?? null,
      archived: false, kc: parseKc(r.kc), columns: parseKc(r.cols), hasSpecs: false,
    } as Parameters<typeof buildCanonicalEntityState>[0]);
    const f = (k: string) => txt(state.fields[k]?.value);
    const serial = f('serialNumber') ? normalizeCode(f('serialNumber')) : '';
    const brand = f('brand');
    const model = f('modelName');
    const name = r.name ?? (r.type === 'EQUIPMENT' ? `Équipement ${r.id}` : `Pièce ${r.id}`);
    return {
      type: r.type, id: Number(r.id), assetId: Number(r.assetId), name, normalizedName: normalizeText(name),
      serial: serial.length >= 5 && /\d/.test(serial) ? serial : null,
      brandModel: brand && model ? normalizeText(`${brand} ${model}`) : null,
    };
  });
}

/** Références discriminantes des documents DÉJÀ rattachés (bien principal connu). */
async function loadReferences(accountId: number): Promise<Map<string, Map<number, Set<number>>>> {
  const rows = (await pgClient.unsafe(
    `SELECT d.file_id, COALESCE(f.asset_id, f.linked_asset_id, l.asset_id) AS asset_id,
            COALESCE(d.normalized_value, d.value_text) AS v
       FROM document_facts d
       JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
       LEFT JOIN LATERAL (SELECT l.asset_id FROM document_asset_links l
                           WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.link_role = 'PRIMARY' AND l.asset_id IS NOT NULL
                           ORDER BY l.id LIMIT 1) l ON true
      WHERE d.account_id = $1 AND d.status = 'active' AND d.canonical_key = ANY($2::text[])
        AND COALESCE(f.asset_id, f.linked_asset_id, l.asset_id) IS NOT NULL
      LIMIT ${MAX_REFERENCES}`,
    [accountId, [...REFERENCE_KEYS]] as never[],
  ).catch(() => [])) as unknown as Array<{ file_id: number; asset_id: number; v: string | null }>;
  const out = new Map<string, Map<number, Set<number>>>();
  for (const r of rows) {
    const ref = normalizeCode(r.v);
    if (!isDiscriminantReference(ref)) continue;
    const parBien = out.get(ref) ?? new Map<number, Set<number>>();
    const docs = parBien.get(Number(r.asset_id)) ?? new Set<number>();
    docs.add(Number(r.file_id));
    parBien.set(Number(r.asset_id), docs);
    out.set(ref, parBien);
  }
  return out;
}

/** Une référence assez longue et mêlant chiffres pour désigner UN dossier. */
export function isDiscriminantReference(normalized: string): boolean {
  return normalized.length >= 6 && /\d/.test(normalized) && /[0-9]{3,}/.test(normalized);
}

/** Construit l'index de rapprochement d'un compte (lectures groupées, sans borne de découverte). */
export async function loadAccountMatchingIndex(accountId: number): Promise<AccountMatchingIndex> {
  const [rows, entities, references] = await Promise.all([
    loadAssetRows(accountId), loadEntities(accountId), loadReferences(accountId),
  ]);
  return buildMatchingIndex(accountId, rows.map(indexAsset), entities, references);
}

/** Assemblage pur (tests). */
export function buildMatchingIndex(
  accountId: number,
  assets: IndexedAsset[],
  entities: IndexedEntity[] = [],
  references: Map<string, Map<number, Set<number>>> = new Map(),
): AccountMatchingIndex {
  const sorted = [...assets].sort((a, b) => a.assetId - b.assetId);
  const signature = createHash('sha256').update(JSON.stringify([
    sorted.map((a) => [a.assetId, a.normalizedName, a.aliases, a.subtype, a.record.values]),
    entities.map((e) => [e.type, e.id, e.assetId, e.normalizedName, e.serial]),
    [...references.keys()].sort(),
  ])).digest('hex');
  return {
    accountId, assets: sorted, byId: new Map(sorted.map((a) => [a.assetId, a])), records: sorted.map((a) => a.record),
    entities, references, signature,
  };
}

/** Cache d'index par compte, le temps d'une page de balayage ou d'une réconciliation compte. */
export class MatchingIndexCache {
  private readonly cache = new Map<number, Promise<AccountMatchingIndex>>();
  get(accountId: number): Promise<AccountMatchingIndex> {
    let p = this.cache.get(accountId);
    if (!p) {
      p = loadAccountMatchingIndex(accountId);
      this.cache.set(accountId, p);
      p.catch(() => this.cache.delete(accountId));
    }
    return p;
  }
  /** Invalide un compte (après une écriture qui change sa connaissance). */
  forget(accountId: number): void {
    this.cache.delete(accountId);
  }
}
