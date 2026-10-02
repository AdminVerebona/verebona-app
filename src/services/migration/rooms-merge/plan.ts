/**
 * Reprise des pièces `rooms` dans `substructures` (D-G, lot 20) — règles
 * PURES (testées unitairement) : rapprochement par nom, ordre de
 * restauration, comparaison des valeurs journalisées.
 */

/** Nom normalisé d'une pièce : casse, accents, ponctuation légère, espaces. */
export function normalizeRoomName(name: string | null | undefined): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`_\-.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SubstructureCandidate {
  id: number;
  name: string;
  legacyRoomId: number | null;
}

export type SubstructureChoice =
  /** Sous-structure déjà reprise pour cette pièce (relance). */
  | { kind: 'existing'; substructureId: number }
  /** Une seule sous-structure libre du même bien porte le même nom. */
  | { kind: 'map'; substructureId: number }
  /** Aucune (ou plusieurs : `ambiguous`) : une sous-structure est créée. */
  | { kind: 'create'; ambiguous: boolean; candidates: number[] };

/**
 * Sous-structure d'une pièce. Les candidates sont celles du MÊME bien.
 * Une sous-structure déjà associée à une autre pièce n'est jamais reprise
 * (correspondance un pour un : `substructures_legacy_room_uidx`).
 */
export function chooseSubstructure(room: { id: number; name: string }, candidates: SubstructureCandidate[]): SubstructureChoice {
  const deja = candidates.find((c) => c.legacyRoomId === room.id);
  if (deja) return { kind: 'existing', substructureId: deja.id };
  const cle = normalizeRoomName(room.name);
  const memeNom = cle ? candidates.filter((c) => c.legacyRoomId === null && normalizeRoomName(c.name) === cle) : [];
  if (memeNom.length === 1) return { kind: 'map', substructureId: memeNom[0].id };
  return { kind: 'create', ambiguous: memeNom.length > 1, candidates: memeNom.map((c) => c.id) };
}

/**
 * Colonnes de la pièce recopiées sur une sous-structure RAPPROCHÉE : seules
 * celles encore vides sont remplies (une saisie de l'écran n'est jamais
 * écrasée). Fiche canonique : reprise si celle de la sous-structure est vide.
 */
export function fillFromRoom(
  sub: { room_type: unknown; area: unknown; description: unknown; key_characteristics: unknown },
  room: { room_type: unknown; area: unknown; description: unknown; key_characteristics: unknown },
): Record<string, unknown> {
  const vide = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  const kcVide = (v: unknown) => vide(v) || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
  const out: Record<string, unknown> = {};
  for (const c of ['room_type', 'area', 'description'] as const) {
    if (vide(sub[c]) && !vide(room[c])) out[c] = room[c];
  }
  if (kcVide(sub.key_characteristics) && !kcVide(room.key_characteristics)) out.key_characteristics = room.key_characteristics;
  return out;
}

/** Ordre de restauration : liens N-N d'abord (voir l'en-tête du runner), sous-structures en dernier. */
export function restorePriority(table: string): number {
  if (table === 'document_asset_links') return 0;
  if (table === 'substructures') return 2;
  return 1;
}

/** Changements à restaurer, dans l'ordre (priorité de table, puis du plus récent au plus ancien). */
export function restoreOrder<T extends { id: number | string; table_name: string }>(changes: T[]): T[] {
  return [...changes].sort((a, b) =>
    restorePriority(a.table_name) - restorePriority(b.table_name) || Number(b.id) - Number(a.id));
}

/** Égalité de valeurs JSON (ordre des clés indifférent). */
export function sameJson(a: unknown, b: unknown): boolean {
  return canon(a) === canon(b);
}

function canon(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

/** Sous-ensemble de colonnes d'une ligne `to_jsonb`. */
export function pick(row: Record<string, unknown>, cols: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));
}
