/**
 * Brouillons détaillés pour le tableau de bord IA — CDC BO IA DRF-01 (SCR-01).
 *
 * « Label, base, stale, date, auteur ; ouvrir/créer. » Une seule requête :
 * la version de base (vN) et l'auteur sont joints, pour que l'écran n'ait
 * pas à croiser la liste des versions (limitée) ni celle des utilisateurs.
 */
import { pgClient } from '@/db';
import { getAiEnvironment, type AiEnvironment } from './environment';

export interface DraftSummary {
  id: number;
  uid: string;
  label: string | null;
  isStale: boolean;
  createdAt: string;
  /** Version de base : id, vN et libellé, `null` pour un premier brouillon. */
  base: { id: number; visibleNumber: number | null; label: string | null } | null;
  /** Nom de l'auteur (prénom nom, sinon e-mail), `null` si inconnu. */
  author: string | null;
}

type Row = Record<string, unknown>;

/** Nom d'auteur lisible (pur). */
export function authorName(r: { first_name?: unknown; last_name?: unknown; email?: unknown }): string | null {
  const full = [r.first_name, r.last_name].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
  if (full) return full;
  return typeof r.email === 'string' && r.email ? r.email : null;
}

export function toDraftSummary(r: Row): DraftSummary {
  return {
    id: Number(r.id),
    uid: String(r.uid),
    label: (r.label as string | null) ?? null,
    isStale: Boolean(r.is_stale),
    createdAt: new Date(String(r.created_at)).toISOString(),
    base: r.base_version_id == null
      ? null
      : {
          id: Number(r.base_version_id),
          visibleNumber: r.base_visible_number == null ? null : Number(r.base_visible_number),
          label: (r.base_label as string | null) ?? null,
        },
    author: authorName(r),
  };
}

export async function listDraftSummaries(
  environment: AiEnvironment = getAiEnvironment(),
  limit = 20,
): Promise<DraftSummary[]> {
  const rows = await pgClient.unsafe(
    `SELECT v.id, v.uid, v.label, v.is_stale, v.created_at, v.base_version_id,
            b.visible_number AS base_visible_number, b.label AS base_label,
            u.first_name, u.last_name, u.email
       FROM ai_config_versions v
       LEFT JOIN ai_config_versions b ON b.id = v.base_version_id
       LEFT JOIN users u ON u.id = v.created_by
      WHERE v.environment = $1 AND v.status = 'DRAFT'
      ORDER BY v.created_at DESC
      LIMIT $2`,
    [environment, limit] as never[],
  );
  return (rows as unknown as Row[]).map(toDraftSummary);
}
