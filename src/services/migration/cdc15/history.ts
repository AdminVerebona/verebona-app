/**
 * Historique des écritures d'un champ de bien, pour établir l'origine d'une
 * valeur (MIG-03) et l'absence de modification humaine (MIG-02).
 *
 * Sources :
 *   · `ai_field_updates` — écritures AUTOMATIQUES (T3 `applyDecision`, puis
 *     `writeCanonicalAssetField` d'origine automatique) ;
 *   · `canonical_field_writes` (journal 0216) — toutes les écritures de la
 *     primitive, dont la fiche (`source_type = asset_details`), l'assistant,
 *     l'administration ; seules les lignes `written` hors simulation comptent.
 * Il n'existe pas d'autre historique de la fiche (`asset_details`) en base.
 */
import type postgres from 'postgres';
import { isHumanOrigin } from '@/services/ai/reconciliation/field-origin';
import type { FieldOrigin } from '@/services/ai/evidence/evidence.types';
import { sameCanonicalValue } from '@/services/canonical/asset-state';
import { getField, resolveAlias } from '@/services/canonical/registry';

export interface FieldWriteEvent {
  /** Clé canonique. */
  key: string;
  value: unknown;
  origin: FieldOrigin;
  at: number;
  source: 'ai_field_updates' | 'canonical_field_writes';
  /** Document source de l'écriture (`ai_field_updates.asset_file_id`, ou journal 0216 `source_type = document`). */
  fileId?: number | null;
  /** Preuve ayant justifié l'écriture automatique (`ai_field_updates.evidence_id`, colonne 0103). */
  evidenceId?: number | null;
}

/** Historique par bien → clé canonique → écritures (ordre chronologique). */
export type AssetHistory = Map<number, Map<string, FieldWriteEvent[]>>;

const canon = (k: string) => (getField(k) ? k : resolveAlias(k) ?? k);

const parse = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

export async function loadHistory(sql: postgres.Sql, assetIds: number[]): Promise<AssetHistory> {
  const out: AssetHistory = new Map();
  if (assetIds.length === 0) return out;
  const push = (assetId: number, e: FieldWriteEvent) => {
    const m = out.get(assetId) ?? new Map<string, FieldWriteEvent[]>();
    out.set(assetId, m);
    m.set(e.key, [...(m.get(e.key) ?? []), e]);
  };
  const auto = await sql<Array<{ assetId: number; fieldKey: string; newValue: string; at: Date; fileId: number | null; evidenceId: number | null }>>`
    SELECT asset_id AS "assetId", field_key AS "fieldKey", new_value AS "newValue", created_at AS at, asset_file_id AS "fileId",
           evidence_id AS "evidenceId"
      FROM ai_field_updates WHERE asset_id = ANY(string_to_array(${assetIds.join(',')}, ',')::int[]) ORDER BY created_at, id`;
  for (const r of auto) {
    push(Number(r.assetId), { key: canon(r.fieldKey), value: parse(r.newValue), origin: 'RECONCILIATION', at: new Date(r.at).getTime(), source: 'ai_field_updates',
      fileId: r.fileId == null ? null : Number(r.fileId), evidenceId: r.evidenceId == null ? null : Number(r.evidenceId) });
  }
  // Lignes d'un équipement ou d'une pièce (0227, lot 18) : pas des écritures du bien.
  const [cible] = await sql<Array<{ has: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                     AND table_name = 'canonical_field_writes' AND column_name = 'target_type') AS has`;
  const journal = await sql<Array<{ assetId: number; key: string; newValue: unknown; origin: FieldOrigin; at: Date; sourceType: string | null; sourceId: string | null }>>`
    SELECT asset_id AS "assetId", canonical_key AS key, new_value AS "newValue", origin, created_at AS at,
           source_type AS "sourceType", source_id AS "sourceId"
      FROM canonical_field_writes
     WHERE asset_id = ANY(string_to_array(${assetIds.join(',')}, ',')::int[]) AND outcome = 'written' AND dry_run = false
       ${cible?.has ? sql`AND target_type IS NULL` : sql``}
     ORDER BY created_at, id`;
  for (const r of journal) push(Number(r.assetId), { key: canon(r.key), value: r.newValue, origin: r.origin, at: new Date(r.at).getTime(), source: 'canonical_field_writes',
    fileId: r.sourceType === 'document' && /^\d+$/.test(r.sourceId ?? '') ? Number(r.sourceId) : null });
  // Même instant : l'écriture du journal 0216 d'abord, puis sa trace `ai_field_updates` (même transaction).
  const rang = (e: FieldWriteEvent) => (e.source === 'canonical_field_writes' ? 0 : 1);
  for (const m of out.values()) for (const l of m.values()) l.sort((a, b) => a.at - b.at || rang(a) - rang(b));
  return out;
}

/**
 * Provenance ÉTABLIE d'une valeur par une preuve (pure, testée) : la
 * DERNIÈRE écriture du champ a produit exactement cette valeur ET vient de
 * cette preuve — `evidence_id` de la trace, ou document source de
 * l'écriture = document de la preuve.
 */
export function writtenFromEvidence(
  events: FieldWriteEvent[] | undefined, key: string, value: unknown, evidence: { id: number; sourceId: number | null },
): boolean {
  const last = events?.at(-1);
  if (!last || !sameCanonicalValue(key, last.value, value)) return false;
  if (last.evidenceId != null) return last.evidenceId === evidence.id;
  return last.fileId != null && evidence.sourceId != null && last.fileId === evidence.sourceId;
}

/**
 * Preuve d'origine de la valeur EN PLACE (pure, testée) : la DERNIÈRE
 * écriture connue du champ a produit exactement cette valeur. Rend son
 * origine (humaine ou automatique), ou null si l'historique ne l'établit pas
 * (aucune écriture, ou dernière écriture d'une autre valeur).
 */
export function provenOrigin(events: FieldWriteEvent[] | undefined, key: string, value: unknown): FieldWriteEvent | null {
  const last = events?.at(-1);
  if (!last) return null;
  return sameCanonicalValue(key, last.value, value) ? last : null;
}

/** Une écriture humaine est-elle postérieure à `since` (ms) ? (pure, testée) */
export function humanWriteSince(events: FieldWriteEvent[] | undefined, since: number): boolean {
  return (events ?? []).some((e) => isHumanOrigin(e.origin) && e.at > since);
}
