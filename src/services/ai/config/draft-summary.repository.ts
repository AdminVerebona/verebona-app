/**
 * Versions NON actives pour le tableau de bord IA — CDC BO IA DRF-01 ; lot 54 :
 * plus de « brouillons », les versions non actives (non supprimées) les
 * remplacent. Une seule requête : version d'origine (vN) et auteur joints.
 */
import { pgClient } from '@/db';
import { getAiEnvironment, type AiEnvironment } from './environment';

interface DraftSummary {
  id: number;
  uid: string;
  /** Lot 54 : numéro de la version (attribué à la création). */
  visibleNumber?: number | null;
  /** Lot 54 : révision courante. */
  revisionNumber?: number | null;
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

function toDraftSummary(r: Row): DraftSummary {
  return {
    id: Number(r.id),
    uid: String(r.uid),
    visibleNumber: r.visible_number == null ? null : Number(r.visible_number),
    revisionNumber: r.current_revision_number == null ? null : Number(r.current_revision_number),
    label: (r.label as string | null) ?? null,
    // Lot 54 : plus de brouillon obsolète.
    isStale: false,
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
    `SELECT v.id, v.uid, v.visible_number, v.current_revision_number, v.label, v.created_at, v.base_version_id,
            b.visible_number AS base_visible_number, b.label AS base_label,
            u.first_name, u.last_name, u.email
       FROM ai_config_versions v
       LEFT JOIN ai_config_versions b ON b.id = v.base_version_id
       LEFT JOIN users u ON u.id = v.created_by
      WHERE v.environment = $1 AND v.status <> 'ACTIVE' AND v.deleted_at IS NULL
      ORDER BY COALESCE(v.updated_at, v.created_at) DESC
      LIMIT $2`,
    [environment, limit] as never[],
  );
  return (rows as unknown as Row[]).map(toDraftSummary);
}
