/**
 * Lectures SQL de la résolution des cibles T2 — tickets 8b, 13, 14 (lot 29).
 *
 * « SQL et les référentiels retrouvent tout ce qui peut l'être de façon
 * déterministe » : biens (nom, catégorie, famille), véhicule par VIN ou
 * immatriculation EXACTS, équipements et pièces par leur nom. Toutes les
 * requêtes sont paramétrées, bornées au compte et à la règle de
 * disponibilité unique (`asset-availability`) : un bien archivé ou transmis
 * n'est jamais candidat, ni un équipement ou une pièce qu'il porte.
 *
 * Équipements : mêmes règles que leur fiche (`GET /api/assets/[id]/equipments`) —
 * bien du compte, équipement non archivé. Pièce = sous-structure (D-G).
 *
 * Rien n'est transmis à un modèle ici : le résultat est un ensemble BORNÉ de
 * candidats (≤ 500 biens, ≤ 50 entités), jamais le contenu du compte.
 */
import { pgClient } from '@/db';
import { getField } from '@/services/canonical/registry';
import { parseKc } from '@/services/canonical/asset-state';
import { assistantAssetAvailability, type AvailabilityOptions } from './asset-availability';
import { normalizePlate, normalizeVin } from './vehicle-identifiers';

/** Bien candidat (catalogue du compte, biens DISPONIBLES). */
export interface AssetCandidate {
  id: number;
  name: string;
  category?: string | null;
  subtype?: string | null;
  city?: string | null;
  address?: string | null;
  registrationNumber?: string | null;
  status?: string | null;
}

export type NestedEntityKind = 'equipment' | 'room';

/** Équipement ou pièce candidat, avec son bien parent. */
export interface EntityCandidate {
  kind: NestedEntityKind;
  id: number;
  name: string;
  assetId: number;
  assetName: string | null;
  /** Type libre de l'équipement (`equipments.type`), si renseigné. */
  entityType?: string | null;
}

/** Lectures injectables (tests) de la résolution des cibles. */
export interface TargetLookup {
  /** Biens disponibles du compte (≤ 500). */
  assets(accountId: number): Promise<AssetCandidate[]>;
  /** Équipements / pièces dont le nom (ou le type) contient l'un des termes, bornés au compte. */
  entities?(accountId: number, kind: NestedEntityKind, terms: string[], opts?: { assetIds?: number[] | null }): Promise<EntityCandidate[]>;
  /** Un équipement / une pièce par identifiant (revalidation : clarification, fil). */
  entityById?(accountId: number, kind: NestedEntityKind, id: number): Promise<EntityCandidate | null>;
  /** Véhicules dont la plaque ou le VIN est EXACTEMENT celui donné (normalisé). */
  vehiclesByIdentifier?(accountId: number, ident: { plates: string[]; vins: string[] }, opts?: AvailabilityOptions): Promise<AssetCandidate[]>;
}

const rows = <T>(r: unknown) => r as unknown as T[];

const ASSET_COLS = `a.id, a.name, a.category, a.subtype, a.city, a.address, a.registration_number AS "registrationNumber", a.status`;

/** Clés canoniques et alias du VIN (registre, source unique). */
function vinKeys(): string[] {
  const def = getField('vin');
  return def ? [def.key, ...def.aliases] : ['vin'];
}

export async function listAvailableAssets(accountId: number): Promise<AssetCandidate[]> {
  const r = rows<AssetCandidate>(await pgClient.unsafe(
    `SELECT ${ASSET_COLS} FROM assets a
      WHERE a.account_id = $1 AND ${assistantAssetAvailability.sql('a')}
      ORDER BY a.id LIMIT 500`,
    [accountId] as never[],
  ));
  return r.filter((x) => x.name).map((x) => ({ ...x, id: Number(x.id) }));
}

export async function findEntitiesByTerms(
  accountId: number,
  kind: NestedEntityKind,
  terms: string[],
  opts: { assetIds?: number[] | null } = {},
): Promise<EntityCandidate[]> {
  const motifs = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3))].slice(0, 8).map((t) => `%${t}%`);
  if (motifs.length === 0) return [];
  const ids = opts.assetIds?.length ? opts.assetIds : null;
  const sql = kind === 'equipment'
    ? `SELECT e.id, e.name, e.type AS "entityType", e.asset_id AS "assetId", a.name AS "assetName"
         FROM equipments e
         JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND ${assistantAssetAvailability.sql('a')}
        WHERE e.archived_at IS NULL
          AND ($2::int[] IS NULL OR e.asset_id = ANY($2::int[]))
          AND (unaccent(lower(coalesce(e.name, ''))) LIKE ANY($3::text[])
               OR unaccent(lower(coalesce(e.type, ''))) LIKE ANY($3::text[]))
        ORDER BY e.id LIMIT 50`
    : `SELECT x.id, x.name, NULL::text AS "entityType", x.asset_id AS "assetId", a.name AS "assetName"
         FROM substructures x
         JOIN assets a ON a.id = x.asset_id AND a.account_id = $1 AND ${assistantAssetAvailability.sql('a')}
        WHERE ($2::int[] IS NULL OR x.asset_id = ANY($2::int[]))
          AND unaccent(lower(coalesce(x.name, ''))) LIKE ANY($3::text[])
        ORDER BY x.id LIMIT 50`;
  const r = rows<Omit<EntityCandidate, 'kind'>>(await pgClient.unsafe(sql, [accountId, ids, motifs] as never[]));
  return r.filter((x) => x.name).map((x) => ({ ...x, kind, id: Number(x.id), assetId: Number(x.assetId) }));
}

export async function findEntityById(accountId: number, kind: NestedEntityKind, id: number): Promise<EntityCandidate | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const sql = kind === 'equipment'
    ? `SELECT e.id, e.name, e.type AS "entityType", e.asset_id AS "assetId", a.name AS "assetName"
         FROM equipments e
         JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND ${assistantAssetAvailability.sql('a')}
        WHERE e.id = $2 AND e.archived_at IS NULL`
    : `SELECT x.id, x.name, NULL::text AS "entityType", x.asset_id AS "assetId", a.name AS "assetName"
         FROM substructures x
         JOIN assets a ON a.id = x.asset_id AND a.account_id = $1 AND ${assistantAssetAvailability.sql('a')}
        WHERE x.id = $2`;
  const [r] = rows<Omit<EntityCandidate, 'kind'>>(await pgClient.unsafe(sql, [accountId, id] as never[]));
  return r ? { ...r, kind, id: Number(r.id), assetId: Number(r.assetId) } : null;
}

/**
 * Véhicules du compte par identifiant EXACT (8b §D) : plaque normalisée
 * (colonne miroir `registration_number`), VIN de la fiche canonique (clé
 * `vin` et ses alias du registre). Le filtre SQL sur la fiche n'est qu'un
 * présélecteur : l'égalité exacte est vérifiée sur la valeur lue.
 */
export async function findVehiclesByIdentifier(
  accountId: number,
  ident: { plates: string[]; vins: string[] },
  opts: AvailabilityOptions = {},
): Promise<AssetCandidate[]> {
  const plates = [...new Set(ident.plates.map(normalizePlate).filter((p) => p.length >= 5))].slice(0, 4);
  const vins = [...new Set(ident.vins.map(normalizeVin).filter((v) => v.length === 17))].slice(0, 4);
  if (plates.length === 0 && vins.length === 0) return [];
  const r = rows<AssetCandidate & { kc: unknown }>(await pgClient.unsafe(
    `SELECT ${ASSET_COLS}, a.key_characteristics AS kc FROM assets a
      WHERE a.account_id = $1 AND ${assistantAssetAvailability.sql('a', opts)}
        AND (regexp_replace(upper(coalesce(a.registration_number, '')), '[^A-Z0-9]', '', 'g') = ANY($2::text[])
             OR (cardinality($3::text[]) > 0 AND upper(coalesce(a.key_characteristics::text, '')) LIKE ANY($3::text[])))
      ORDER BY a.id LIMIT 20`,
    [accountId, plates, vins.map((v) => `%${v}%`)] as never[],
  ));
  const cles = vinKeys();
  return r.filter((a) => {
    if (plates.includes(normalizePlate(a.registrationNumber))) return true;
    const kc = parseKc(a.kc);
    const plaqueFiche = normalizePlate(String(kc.registrationNumber ?? ''));
    if (plaqueFiche && plates.includes(plaqueFiche)) return true;
    return cles.some((k) => typeof kc[k] === 'string' && vins.includes(normalizeVin(kc[k] as string)));
  }).map(({ kc: _kc, ...a }) => ({ ...a, id: Number(a.id) }));
}

/** Implémentation SQL par défaut. */
export const sqlTargetLookup: TargetLookup = {
  assets: listAvailableAssets,
  entities: findEntitiesByTerms,
  entityById: findEntityById,
  vehiclesByIdentifier: findVehiclesByIdentifier,
};
