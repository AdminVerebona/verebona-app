/**
 * État CANONIQUE du rattachement Document → Bien (lot 31B, T3 DOCUMENT_ASSET).
 *
 * Lu au début du travail T3 ET juste avant chaque écriture (ticket T3, §11 :
 * « choix utilisateur > décision IA ») : un rattachement posé par
 * l'utilisateur pendant que T3 réfléchissait l'emporte toujours.
 *
 * Ce qui compte comme RATTACHEMENT PRINCIPAL (ticket T3, §6) :
 *   · une colonne historique `asset_id` / `linked_asset_id` (dépôt sur un
 *     bien, déplacement, tiroir — reflétée en lien LEGACY_COLUMN par la 0221) ;
 *   · un lien N-N ACTIF de rôle PRIMARY vers un bien, quelle que soit son
 *     origine (USER, AI, MIGRATION, LEGACY_COLUMN).
 * Un lien MENTIONED (bien seulement cité) n'en est PAS un ; SECONDARY non
 * plus (document multi-biens sans bien principal).
 *
 * Ce qui compte comme DÉCISION UTILISATEUR DÉFINITIVE :
 *   · un lien ACTIF d'origine USER (quel que soit son rôle) ;
 *   · `user_edited_fields.assetId = true` — rattachement choisi ou RETIRÉ
 *     depuis un écran : l'IA ne rattache pas un document que l'utilisateur a
 *     détaché.
 */
import { pgClient } from '@/db';

export interface AttachmentState {
  /** Document présent, non supprimé, non regroupé dans un autre. */
  exists: boolean;
  /** Ni brouillon, ni écarté par l'utilisateur, dépôt terminé. */
  open: boolean;
  analysisState: string | null;
  /** Propriétaire du document (utilisateur des projections T3). */
  userId: number | null;
  /** Colonne historique (`asset_id`, sinon `linked_asset_id`). */
  columnAssetId: number | null;
  /**
   * La colonne `asset_id` a été posée AUTOMATIQUEMENT (marque
   * `user_edited_fields.assetIdAuto` égale à la colonne, aucun choix
   * utilisateur depuis) : une décision automatique certaine peut la déplacer.
   */
  columnIsAutomatic: boolean;
  /** Biens liés en PRIMARY (liens ACTIFS, toutes origines). */
  primaryAssetIds: number[];
  /** Biens liés en SECONDARY (liens ACTIFS). */
  secondaryAssetIds: number[];
  /** Biens seulement CITÉS (MENTIONED, liens ACTIFS) — jamais un rattachement. */
  mentionedAssetIds: number[];
  /** Biens liés par un lien USER ACTIF (tous rôles). */
  userLinkAssetIds: number[];
  /** `user_edited_fields.assetId` : choix ou retrait explicite de l'utilisateur. */
  userEdited: boolean;
}

export const NO_DOCUMENT: AttachmentState = {
  exists: false, open: false, analysisState: null, userId: null, columnAssetId: null, columnIsAutomatic: false,
  primaryAssetIds: [], secondaryAssetIds: [], mentionedAssetIds: [], userLinkAssetIds: [], userEdited: false,
};

/** Le document a-t-il un rattachement principal valide ? (pure) */
export function hasPrimaryAttachment(s: AttachmentState): boolean {
  return s.columnAssetId !== null || s.primaryAssetIds.length > 0;
}

/** L'utilisateur a-t-il décidé du rattachement de ce document ? (pure) */
export function hasUserDecision(s: AttachmentState): boolean {
  return s.userEdited || s.userLinkAssetIds.length > 0;
}

/** Relecture canonique, bornée au compte. */
export async function readAttachmentState(accountId: number, fileId: number): Promise<AttachmentState> {
  const rows = (await pgClient.unsafe(
    `SELECT f.id, f.user_id, f.analysis_state, f.asset_id, f.linked_asset_id,
            (f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL) AS visible,
            (COALESCE(f.is_draft, false) = false AND COALESCE(f.is_ignored, false) = false
              AND COALESCE(f.upload_status, 'COMPLETED') = 'COMPLETED') AS open,
            COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) AS user_edited,
            (f.asset_id IS NOT NULL AND f.asset_id = (f.user_edited_fields ->> 'assetIdAuto')::int) AS column_auto,
            COALESCE((SELECT json_agg(json_build_object('a', l.asset_id, 'r', l.link_role, 'o', l.origin))
                        FROM document_asset_links l
                       WHERE l.file_id = f.id AND l.account_id = f.account_id
                         AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL), '[]'::json) AS links
       FROM asset_files f
      WHERE f.id = $1 AND f.account_id = $2`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{
    user_id: number | null; analysis_state: string | null; asset_id: number | null; linked_asset_id: number | null;
    visible: boolean; open: boolean; user_edited: boolean; column_auto: boolean | null; links: Array<{ a: number; r: string; o: string }> | string;
  }>;
  const r = rows[0];
  if (!r || !r.visible) return NO_DOCUMENT;
  const links = (typeof r.links === 'string' ? JSON.parse(r.links) : r.links) as Array<{ a: number; r: string; o: string }>;
  const ids = (pred: (l: { a: number; r: string; o: string }) => boolean) =>
    [...new Set(links.filter(pred).map((l) => Number(l.a)))].sort((a, b) => a - b);
  return {
    exists: true,
    open: r.open,
    analysisState: r.analysis_state,
    userId: r.user_id == null ? null : Number(r.user_id),
    columnAssetId: r.asset_id != null ? Number(r.asset_id) : r.linked_asset_id != null ? Number(r.linked_asset_id) : null,
    columnIsAutomatic: r.column_auto === true && !r.user_edited,
    primaryAssetIds: ids((l) => l.r === 'PRIMARY'),
    secondaryAssetIds: ids((l) => l.r === 'SECONDARY'),
    mentionedAssetIds: ids((l) => l.r === 'MENTIONED'),
    userLinkAssetIds: ids((l) => l.o === 'USER'),
    userEdited: r.user_edited,
  };
}

/**
 * Bien choisi par l'utilisateur via un lien N-N USER PRIMARY ACTIF (sans
 * colonne historique). KNOWN_TARGET de T1 au même titre que la colonne.
 */
export async function userChosenAssetOf(accountId: number, fileId: number): Promise<number | null> {
  const rows = (await pgClient.unsafe(
    `SELECT l.asset_id FROM document_asset_links l
       JOIN assets a ON a.id = l.asset_id AND a.account_id = l.account_id AND a.deleted_at IS NULL
      WHERE l.file_id = $1 AND l.account_id = $2 AND l.status = 'ACTIVE'
        AND l.origin = 'USER' AND l.link_role = 'PRIMARY' AND l.asset_id IS NOT NULL
      ORDER BY l.id LIMIT 1`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ asset_id: number }>;
  return rows[0] ? Number(rows[0].asset_id) : null;
}

/**
 * Colonne `asset_id` posée automatiquement (lot 31B) : son bien, sinon null.
 * Une telle colonne n'est PAS un KNOWN_TARGET pour T1 (ce n'est pas un choix
 * de l'utilisateur) — une nouvelle analyse certaine peut la déplacer.
 */
export async function automaticColumnAssetOf(accountId: number, fileId: number): Promise<number | null> {
  const s = await readAttachmentState(accountId, fileId);
  return s.exists && s.columnIsAutomatic ? s.columnAssetId : null;
}
