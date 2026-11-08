/**
 * Périmètre d'une transmission de bien par jeton — correctif de sécurité du
 * lot 113Z (isolation des comptes, règle permanente).
 *
 * Faille corrigée : les identifiants choisis par l'émetteur
 * (`selectedDocIds`, `selectedPhotoIds`, `selectedEventIds`,
 * `selectedEquipmentIds`) étaient enregistrés tels quels à la création, puis
 * relus à l'acceptation par simple `id IN (…)` : un émetteur pouvait faire
 * copier chez le destinataire les fichiers et métadonnées d'un AUTRE compte
 * (ou d'un autre bien).
 *
 * Règle : un élément n'est transmis que s'il appartient au COMPTE émetteur ET
 * au BIEN transmis — même périmètre que la liste proposée à l'émetteur
 * (`GET /api/files?assetId=…` : document du bien, de l'une de ses pièces ou
 * de l'un de ses équipements) et que l'instantané (`buildAssetSnapshot`).
 * Le reste est IGNORÉ SILENCIEUSEMENT (anti-énumération : aucune réponse ne
 * révèle l'existence d'un identifiant étranger) ; une trace serveur indique
 * seulement des NOMBRES (jamais d'identifiant étranger, de titre ni de contenu).
 *
 * Appliqué deux fois : à la création (sélection enregistrée déjà filtrée) et
 * à l'acceptation (défense principale : couvre les transmissions déjà en base).
 */
import { pgClient } from '@/db';

export type ScopeKind = 'documents' | 'photos' | 'events' | 'equipments';

/** Identifiants entiers positifs, dédoublonnés (une entrée mal formée est écartée). Pure. */
export function cleanIds(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<number>();
  for (const x of v) {
    const n = typeof x === 'number' ? x : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : NaN;
    if (Number.isSafeInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

/**
 * Sélection après filtrage (pure) : identifiants demandés ∩ autorisés, dans
 * l'ordre demandé. `include` passe à faux quand une sélection NON vide ne
 * garde rien — sinon une liste vide signifierait « tout l'instantané ».
 */
export function restrictSelection(include: boolean, requested: number[], allowed: ReadonlySet<number>): { include: boolean; ids: number[]; dropped: number } {
  const ids = requested.filter((id) => allowed.has(id));
  const dropped = requested.length - ids.length;
  return { include: include && !(requested.length > 0 && ids.length === 0), ids, dropped };
}

const rows = async (text: string, params: unknown[]) =>
  (await pgClient.unsafe(text, params as never[])) as unknown as Array<{ id: number }>;

/**
 * Fichiers (documents ou photos) du compte émetteur rattachés au bien :
 * colonne bien, pièce du bien, équipement du bien. Lecture seule.
 */
async function allowedFiles(accountId: number, assetId: number, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const r = await rows(
    `SELECT f.id FROM asset_files f
       JOIN assets a ON a.id = $2 AND a.account_id = $1
      WHERE f.account_id = $1 AND f.id = ANY($3::int[]) AND f.deleted_at IS NULL
        AND (f.asset_id = a.id
          OR f.substructure_id IN (SELECT s.id FROM substructures s WHERE s.asset_id = a.id)
          OR f.equipment_id IN (SELECT e.id FROM equipments e WHERE e.asset_id = a.id))`,
    [accountId, assetId, ids],
  );
  return new Set(r.map((x) => Number(x.id)));
}

/** Éléments d'agenda du compte liés au bien. */
async function allowedEvents(accountId: number, assetId: number, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const r = await rows(
    `SELECT DISTINCT i.id FROM agenda_items i
       JOIN agenda_asset_links l ON l.agenda_item_id = i.id AND l.asset_id = $2
       JOIN assets a ON a.id = l.asset_id AND a.account_id = $1
      WHERE i.account_id = $1 AND i.id = ANY($3::int[])`,
    [accountId, assetId, ids],
  );
  return new Set(r.map((x) => Number(x.id)));
}

/** Équipements du bien (compte émetteur). */
async function allowedEquipments(accountId: number, assetId: number, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const r = await rows(
    `SELECT e.id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1
      WHERE e.asset_id = $2 AND e.id = ANY($3::int[])`,
    [accountId, assetId, ids],
  );
  return new Set(r.map((x) => Number(x.id)));
}

export interface TransmissionSelection {
  includeDocuments: boolean; selectedDocIds: number[];
  includeEquipments: boolean; selectedEquipmentIds: number[];
  includePhotos: boolean; selectedPhotoIds: number[];
  includeEvents: boolean; selectedEventIds: number[];
}

/**
 * Restreint une sélection au compte émetteur et au bien transmis. Rend la
 * sélection filtrée et le nombre d'identifiants écartés par liste (trace).
 */
export async function scopeTransmissionSelection<T extends TransmissionSelection>(
  accountId: number, assetId: number, s: T, where: 'creation' | 'acceptation',
): Promise<{ selection: T; dropped: Record<ScopeKind, number> }> {
  const docs = cleanIds(s.selectedDocIds), photos = cleanIds(s.selectedPhotoIds);
  const events = cleanIds(s.selectedEventIds), equips = cleanIds(s.selectedEquipmentIds);
  const [fa, ea, qa] = await Promise.all([
    allowedFiles(accountId, assetId, [...new Set([...docs, ...photos])]),
    allowedEvents(accountId, assetId, events),
    allowedEquipments(accountId, assetId, equips),
  ]);
  const d = restrictSelection(s.includeDocuments !== false, docs, fa);
  const p = restrictSelection(s.includePhotos !== false, photos, fa);
  const ev = restrictSelection(s.includeEvents !== false, events, ea);
  const eq = restrictSelection(s.includeEquipments !== false, equips, qa);
  const dropped = { documents: d.dropped, photos: p.dropped, events: ev.dropped, equipments: eq.dropped };
  const total = d.dropped + p.dropped + ev.dropped + eq.dropped;
  if (total > 0) {
    // Nombres seulement : jamais d'identifiant étranger, de titre ni de contenu.
    console.warn(`[transmission] ${where} : ${total} élément(s) hors du bien ou du compte émetteur ignoré(s) `
      + `(documents ${d.dropped}, photos ${p.dropped}, agenda ${ev.dropped}, équipements ${eq.dropped}).`);
  }
  return {
    selection: {
      ...s,
      includeDocuments: d.include, selectedDocIds: d.ids,
      includePhotos: p.include, selectedPhotoIds: p.ids,
      includeEvents: ev.include, selectedEventIds: ev.ids,
      includeEquipments: eq.include, selectedEquipmentIds: eq.ids,
    },
    dropped,
  };
}
